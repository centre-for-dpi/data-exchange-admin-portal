import { createHash, randomUUID, type webcrypto, X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { request } from 'node:https';
import { Logger } from '@nestjs/common';
import { compactDecrypt, importJWK, type JWK, SignJWT } from 'jose';
import { ServiceUnavailableError } from '../common/errors.js';

/** Signs certificate requests (ARCHITECTURE.md §4.4). Injected so tests can use a fake CA. */
export interface CertificateAuthority {
  /**
   * Issues a certificate for `commonName` from a CSR already checked by the portal. Returns the
   * certificate followed by its issuing chain, PEM.
   */
  sign(request: SignRequest): Promise<string>;
  /** The CA's root certificate (PEM), verified against the configured trust anchor. */
  rootCertificate(): Promise<string>;
}

export const CERTIFICATE_AUTHORITY = Symbol('CERTIFICATE_AUTHORITY');

/**
 * Which provisioner signs (infra/step-ca/configure.sh): `application` certificates for TLS client
 * authentication (den-portal, M3-01), the gateway's TLS `server` certificate (M3-02), or a kit
 * `node` certificate, for server and client authentication (den-nodes, M4-02).
 */
export type CertificateProfile = 'application' | 'gateway-server' | 'node';

export interface SignRequest {
  csrPem: string;
  commonName: string;
  /** Subject alternative names (DNS); the common name alone by default. */
  sans?: string[];
  profile?: CertificateProfile;
  /** Public key of the CSR (SPKI, DER): the issued certificate must carry it. */
  publicKey?: Buffer;
  validityHours: number;
}

export interface StepCaSettings {
  url: string;
  provisioner: string;
  /** Provisioner of the gateway's server certificate. */
  gatewayProvisioner: string;
  /** Provisioner of kit node certificates (M4-02). */
  nodeProvisioner: string;
  password: string;
  /** PEM file with the CA's root certificate. */
  rootFile?: string;
  /** SHA-256 of the root certificate (DER), hexadecimal: the CA's `step ca bootstrap` pin. */
  rootFingerprint?: string;
  /** Development only: trust the root the CA serves, when neither of the above is set. */
  trustOnFirstUse: boolean;
}

export function stepCaSettings(env: NodeJS.ProcessEnv = process.env): StepCaSettings {
  return {
    url: (env.DEN_STEP_CA_URL ?? 'https://localhost:9000').replace(/\/+$/, ''),
    provisioner: env.DEN_STEP_CA_PROVISIONER ?? 'den-portal',
    gatewayProvisioner: env.DEN_STEP_CA_GATEWAY_PROVISIONER ?? 'den-gateway-tls',
    nodeProvisioner: env.DEN_STEP_CA_NODE_PROVISIONER ?? 'den-nodes',
    password: env.DEN_STEP_CA_PROVISIONER_PASSWORD ?? '',
    rootFile: env.DEN_STEP_CA_ROOT_FILE || undefined,
    rootFingerprint: env.DEN_STEP_CA_ROOT_FINGERPRINT?.toLowerCase().replace(/:/g, '') || undefined,
    trustOnFirstUse: env.NODE_ENV !== 'production',
  };
}

const TIMEOUT_MS = 10_000;
const TOKEN_TTL_SECONDS = 300;
/** step-ca encrypts provisioner keys with PBES2 and 600,000 iterations (step CLI 0.30). */
const MAX_PBES2_COUNT = 1_000_000;

type SigningKey = webcrypto.CryptoKey | Uint8Array;

interface HttpResult {
  status: number;
  body: string;
}

class CaUnreachable extends Error {}

const fingerprintOf = (pem: string): string =>
  createHash('sha256').update(new X509Certificate(pem).raw).digest('hex');

function call(
  url: string,
  options: { method?: string; body?: unknown; ca?: string; insecure?: boolean },
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: options.method ?? 'GET',
        ca: options.ca,
        rejectUnauthorized: !options.insecure,
        timeout: TIMEOUT_MS,
        headers: { 'content-type': 'application/json', accept: 'application/json' },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
        );
        res.on('error', (error) => reject(new CaUnreachable(error.message)));
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (error) => reject(new CaUnreachable(error.message)));
    if (options.body !== undefined) req.write(JSON.stringify(options.body));
    req.end();
  });
}

const json = <T>(result: HttpResult, what: string): T => {
  if (result.status < 200 || result.status >= 300) {
    throw new Error(`step-ca ${what}: HTTP ${result.status}`);
  }
  return JSON.parse(result.body) as T;
};

interface Provisioner {
  type: string;
  name: string;
  key?: JWK;
  encryptedKey?: string;
}

/**
 * Client of step-ca (ARCHITECTURE.md §4.4): signs CSRs through the portal's JWK provisioner. For
 * each request the backend signs a one-time token (OTT: subject, SANs, root fingerprint, 5
 * minutes, unique jti) with the provisioner key, and posts it with the CSR to `/1.0/sign`.
 *
 * The provisioner key travels encrypted (JWE, PBES2) in the CA's public provisioner list; the
 * API decrypts it once with DEN_STEP_CA_PROVISIONER_PASSWORD. The CA's TLS is verified against
 * its root: DEN_STEP_CA_ROOT_FILE, or the root the CA serves pinned by
 * DEN_STEP_CA_ROOT_FINGERPRINT, or (development only) the root it serves on first use.
 */
export class StepCaClient implements CertificateAuthority {
  private readonly logger = new Logger(StepCaClient.name);
  private root?: Promise<string>;
  private readonly keys = new Map<string, Promise<{ key: SigningKey; kid: string }>>();

  constructor(private readonly settings: StepCaSettings = stepCaSettings()) {}

  /** The CA's root certificate (PEM), checked against the configured trust anchor. */
  rootCertificate(): Promise<string> {
    this.root ??= this.loadRoot().catch((error: unknown) => {
      this.root = undefined;
      throw error;
    });
    return this.root;
  }

  private async loadRoot(): Promise<string> {
    const { rootFile, rootFingerprint, url } = this.settings;
    if (rootFile) {
      const pem = readFileSync(rootFile, 'utf8');
      if (rootFingerprint && fingerprintOf(pem) !== rootFingerprint) {
        throw new Error(
          'step-ca: DEN_STEP_CA_ROOT_FILE does not match DEN_STEP_CA_ROOT_FINGERPRINT',
        );
      }
      return pem;
    }
    if (rootFingerprint) {
      // Like `step ca bootstrap`: the pin, not the TLS connection, makes the root trusted.
      const { ca } = json<{ ca: string }>(
        await call(`${url}/root/${rootFingerprint}`, { insecure: true }),
        'root',
      );
      if (fingerprintOf(ca) !== rootFingerprint) {
        throw new Error('step-ca: the root served does not match DEN_STEP_CA_ROOT_FINGERPRINT');
      }
      return ca;
    }
    if (!this.settings.trustOnFirstUse) {
      throw new Error('step-ca: set DEN_STEP_CA_ROOT_FILE or DEN_STEP_CA_ROOT_FINGERPRINT');
    }
    const { crts } = json<{ crts: string[] }>(
      await call(`${url}/roots`, { insecure: true }),
      'roots',
    );
    const pem = crts[0];
    if (!pem) throw new Error('step-ca: no root certificate');
    this.logger.warn(
      `Development: trusting the step-ca root served at ${url} (SHA-256 ${fingerprintOf(pem)}). ` +
        'Set DEN_STEP_CA_ROOT_FILE or DEN_STEP_CA_ROOT_FINGERPRINT outside development.',
    );
    return pem;
  }

  private provisionerKey(name: string): Promise<{ key: SigningKey; kid: string }> {
    let key = this.keys.get(name);
    if (!key) {
      key = this.loadKey(name).catch((error: unknown) => {
        this.keys.delete(name);
        throw error;
      });
      this.keys.set(name, key);
    }
    return key;
  }

  private async loadKey(provisioner: string): Promise<{ key: SigningKey; kid: string }> {
    const { url, password } = this.settings;
    if (!password) throw new Error('step-ca: set DEN_STEP_CA_PROVISIONER_PASSWORD');
    const ca = await this.rootCertificate();
    let found: Provisioner | undefined;
    let cursor = '';
    do {
      const page = json<{ provisioners: Provisioner[]; nextCursor?: string }>(
        await call(`${url}/provisioners?limit=100${cursor ? `&cursor=${cursor}` : ''}`, { ca }),
        'provisioners',
      );
      found = page.provisioners.find((p) => p.type === 'JWK' && p.name === provisioner);
      cursor = page.nextCursor ?? '';
    } while (!found && cursor);
    if (!found?.encryptedKey || !found.key?.kid) {
      throw new Error(`step-ca: no JWK provisioner named ${provisioner}`);
    }
    const { plaintext } = await compactDecrypt(
      found.encryptedKey,
      new TextEncoder().encode(password),
      { keyManagementAlgorithms: ['PBES2-HS256+A128KW'], maxPBES2Count: MAX_PBES2_COUNT },
    );
    const jwk = JSON.parse(new TextDecoder().decode(plaintext)) as JWK;
    return { key: await importJWK(jwk, jwk.alg ?? 'ES256'), kid: found.key.kid };
  }

  async sign(input: SignRequest): Promise<string> {
    let result: HttpResult;
    let ca: string;
    try {
      ca = await this.rootCertificate();
      const provisioner =
        input.profile === 'gateway-server'
          ? this.settings.gatewayProvisioner
          : input.profile === 'node'
            ? this.settings.nodeProvisioner
            : this.settings.provisioner;
      const { key, kid } = await this.provisionerKey(provisioner);
      const audience = `${this.settings.url}/1.0/sign`;
      const sans = input.sans?.length ? input.sans : [input.commonName];
      const ott = await new SignJWT({ sans, sha: fingerprintOf(ca) })
        .setProtectedHeader({ alg: 'ES256', kid, typ: 'JWT' })
        .setIssuer(provisioner)
        .setSubject(input.commonName)
        .setAudience(audience)
        .setIssuedAt()
        .setNotBefore('0s')
        .setExpirationTime(`${TOKEN_TTL_SECONDS}s`)
        .setJti(randomUUID())
        .sign(key);
      result = await call(audience, {
        method: 'POST',
        ca,
        body: { csr: input.csrPem, ott, notAfter: `${input.validityHours}h` },
      });
    } catch (error) {
      this.logger.error(
        `step-ca unreachable: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw new ServiceUnavailableError('The certificate authority is not available');
    }
    if (result.status !== 201 && result.status !== 200) {
      // The portal already checked the CSR: a refusal here is a CA policy or configuration issue.
      this.logger.error(`step-ca refused to sign: HTTP ${result.status} ${result.body}`);
      throw new ServiceUnavailableError(
        'The certificate authority could not issue the certificate',
      );
    }
    const {
      certChain,
      crt,
      ca: issuer,
    } = JSON.parse(result.body) as {
      crt: string;
      ca: string;
      certChain?: string[];
    };
    const chain = certChain?.length ? certChain : [crt, issuer];
    checkIssued(chain, ca, input);
    return chain.map((pem) => `${pem.trim()}\n`).join('');
  }
}

/**
 * The CA's answer must be a certificate for this subject that chains to the trusted root: the
 * portal never stores or hands out a certificate it could not verify itself.
 */
export function checkIssued(
  chain: string[],
  rootPem: string,
  expected: { commonName: string; sans?: string[]; publicKey?: Buffer },
): void {
  const certs = chain.map((pem) => new X509Certificate(pem));
  const root = new X509Certificate(rootPem);
  const [leaf] = certs;
  if (!leaf || leaf.subject !== `CN=${expected.commonName}`) {
    throw new ServiceUnavailableError('The certificate authority returned another subject');
  }
  // When the names were given (kit nodes, M4-02): exactly those DNS names, nothing else.
  if (expected.sans?.length) {
    const names = (leaf.subjectAltName ?? '').split(', ').filter(Boolean).sort();
    if (
      names.join(',') !==
      expected.sans
        .map((n) => `DNS:${n}`)
        .sort()
        .join(',')
    ) {
      throw new ServiceUnavailableError('The certificate authority returned other names');
    }
  }
  if (
    expected.publicKey &&
    !leaf.publicKey.export({ type: 'spki', format: 'der' }).equals(expected.publicKey)
  ) {
    throw new ServiceUnavailableError('The certificate authority returned another key');
  }
  for (let i = 0; i < certs.length; i += 1) {
    const cert = certs[i] as X509Certificate;
    const issuer = certs[i + 1] ?? root;
    if (!cert.checkIssued(issuer) || !cert.verify(issuer.publicKey)) {
      throw new ServiceUnavailableError('The certificate authority returned an unverifiable chain');
    }
  }
}
