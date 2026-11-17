import { createHash, randomBytes, randomUUID, X509Certificate } from 'node:crypto';
import { request as httpsRequest } from 'node:https';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeKeyAndCsr } from '../../../test/csr.js';
import { createTestApp, createTestIssuer } from '../../../test/test-auth.js';
import { CERTIFICATE_AUTHORITY, StepCaClient } from '../../credentials/step-ca.client.js';
import {
  BOUND_TOKENS_ATTRIBUTE,
  KEYCLOAK_ADMIN,
  type KeycloakGatewayAdmin,
} from '../keycloak/keycloak-admin.js';
import { APISIX_SETTINGS, ApisixReconciler } from './apisix.reconciler.js';
import { type GatewaySettings, parseDevNodes } from './desired-state.js';

const HTTPS_PORT = Number(process.env.APISIX_HTTPS_PORT ?? 9443);
const HTTP_PORT = Number(process.env.APISIX_HTTP_PORT ?? 9080);
const KEYCLOAK = process.env.KEYCLOAK_URL ?? 'http://localhost:8080';

interface TokenAnswer {
  status: number;
  body: { access_token?: string; error?: string };
}

const basic = (id: string, secret: string) =>
  `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`;
const thumbprint = (pem: string) =>
  createHash('sha256').update(new X509Certificate(pem).raw).digest('base64url');
const cnfOf = (token: string | undefined) =>
  (
    JSON.parse(Buffer.from(token?.split('.')[1] ?? '', 'base64url').toString('utf8')) as {
      cnf?: Record<string, string>;
    }
  ).cnf;

/**
 * The gateway's token route (S-4, ADR-0022, M3-10) against the real APISIX, Keycloak (x509
 * provider nginx, trust-proxy-verification) and step-ca: an application authenticates with its
 * secret, over the TLS where APISIX verified its certificate, and gets a token bound to it. No
 * header the client sends changes which certificate that is.
 */
describe('token route of the gateway: tokens bound to the client certificate (M3-10)', () => {
  const settings: GatewaySettings = {
    keycloakDiscoveryUrl:
      'http://keycloak:8080/realms/den-gateway/.well-known/openid-configuration',
    audience: 'den-gateway',
    opaUrl: 'http://opa:8181',
    accessLogUrl: 'http://fluent-bit:9880/',
    transparencyLog: { host: 'fluent-bit-transparency', port: 5170 },
    devNodes: parseDevNodes('salud=mock-salud:8000'),
    resolveHost: () => Promise.resolve([]),
    tls: { hosts: ['localhost'], mtlsRequired: true, clientName: 'den-gateway' },
  };
  const ca = new StepCaClient();
  const clientId = `den-app-m3-10-${randomUUID()}`;
  const secret = randomBytes(32).toString('base64url');
  let app: NestFastifyApplication;
  let root = '';
  let mine: { cert: string; key: string };
  let other: { cert: string; key: string };

  const issue = async (cn: string) => {
    const { csr, keyPem } = await makeKeyAndCsr(cn);
    return { cert: await ca.sign({ csrPem: csr, commonName: cn, validityHours: 1 }), key: keyPem };
  };

  /** POST /oauth/token over TLS, with the given client certificate and extra headers. */
  const tokenOverTls = (
    client: { cert: string; key: string } | undefined,
    headers: Record<string, string> = {},
    clientSecret = secret,
  ): Promise<TokenAnswer> =>
    new Promise((resolve, reject) => {
      const req = httpsRequest(
        {
          host: '127.0.0.1',
          port: HTTPS_PORT,
          servername: 'localhost',
          path: '/oauth/token',
          method: 'POST',
          ca: root,
          agent: false,
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            authorization: basic(clientId, clientSecret),
            ...headers,
          },
          ...(client ?? {}),
        },
        (res) => {
          let text = '';
          res.on('data', (chunk: Buffer) => (text += chunk.toString()));
          res.on('end', () =>
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(text || '{}') as never }),
          );
        },
      );
      req.on('error', reject);
      req.end('grant_type=client_credentials');
    });

  const tokenOverHttp = async (url: string, headers: Record<string, string> = {}) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: basic(clientId, secret),
        ...headers,
      },
      body: 'grant_type=client_credentials',
    });
    return { status: res.status, body: (await res.json()) as TokenAnswer['body'] };
  };

  const masterToken = async () => {
    const res = await fetch(`${KEYCLOAK}/realms/master/protocol/openid-connect/token`, {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'password',
        client_id: 'admin-cli',
        username: process.env.KEYCLOAK_ADMIN_USER ?? '',
        password: process.env.KEYCLOAK_ADMIN_PASSWORD ?? '',
      }),
    });
    return ((await res.json()) as { access_token: string }).access_token;
  };

  beforeAll(async () => {
    app = await createTestApp(await createTestIssuer(), [
      { token: APISIX_SETTINGS, value: settings },
      { token: CERTIFICATE_AUTHORITY, value: ca },
    ]);
    const reconciler = app.get(ApisixReconciler);
    await reconciler.reconcileTls();
    await reconciler.reconcileTokenRoute();
    root = await ca.rootCertificate();
    mine = await issue(clientId);
    other = await issue(`den-app-m3-10-other-${randomUUID()}`);
    // The client as the Keycloak reconciler makes it with features.mtls.required.
    await app.get<KeycloakGatewayAdmin>(KEYCLOAK_ADMIN).createClient({
      clientId,
      name: 'M3-10 token route',
      description: 'Integration test',
      enabled: true,
      publicClient: false,
      serviceAccountsEnabled: true,
      standardFlowEnabled: false,
      directAccessGrantsEnabled: false,
      implicitFlowEnabled: false,
      attributes: { 'den.managed': 'true', [BOUND_TOKENS_ATTRIBUTE]: 'true' },
      secret,
    });
    // APISIX applies what etcd says within moments.
    for (
      let i = 0;
      i < 40 && (await tokenOverTls(mine).catch(() => undefined))?.status !== 200;
      i += 1
    ) {
      await new Promise((r) => setTimeout(r, 250));
    }
  });

  afterAll(async () => {
    const token = await masterToken();
    const admin = `${KEYCLOAK}/admin/realms/den-gateway/clients`;
    const found = (await (
      await fetch(`${admin}?clientId=${clientId}`, {
        headers: { authorization: `Bearer ${token}` },
      })
    ).json()) as Array<{ id: string }>;
    for (const c of found) {
      await fetch(`${admin}/${c.id}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${token}` },
      });
    }
    await app.close();
  });

  it('issues a token bound to the certificate verified in the handshake', async () => {
    const answer = await tokenOverTls(mine);
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    expect(cnfOf(answer.body.access_token)?.['x5t#S256']).toBe(thumbprint(mine.cert));
  });

  it('ignores a certificate the client puts in the headers, in any spelling', async () => {
    const forged = encodeURIComponent(other.cert);
    const answer = await tokenOverTls(mine, {
      SSL_CLIENT_CERT: forged,
      'SSL-CLIENT-CERT': forged,
      'ssl-client-verify': 'SUCCESS',
      ssl_client_verify: 'SUCCESS',
    });
    expect(answer.status).toBe(200);
    expect(cnfOf(answer.body.access_token)?.['x5t#S256']).toBe(thumbprint(mine.cert));
  });

  it('without a verified certificate there is no bound token: plain HTTP, or Keycloak itself', async () => {
    // The gateway's plain-HTTP listener sets the headers empty: no certificate to bind.
    const overHttp = await tokenOverHttp(`http://127.0.0.1:${HTTP_PORT}/oauth/token`, {
      SSL_CLIENT_CERT: encodeURIComponent(mine.cert),
      'ssl-client-verify': 'SUCCESS',
    });
    expect(overHttp.status).toBe(400);
    expect(overHttp.body.access_token).toBeUndefined();
    // Straight to Keycloak without a certificate: refused as well.
    const direct = await tokenOverHttp(
      `${KEYCLOAK}/realms/den-gateway/protocol/openid-connect/token`,
    );
    expect(direct.status).toBe(400);
    expect(direct.body.access_token).toBeUndefined();
  });

  it('a valid certificate does not replace the secret', async () => {
    const answer = await tokenOverTls(mine, {}, 'not-the-secret');
    expect(answer.status).toBe(401);
    expect(answer.body.access_token).toBeUndefined();
  });

  it('without a client certificate the gateway refuses the TLS session', async () => {
    await expect(tokenOverTls(undefined)).rejects.toThrow();
  });
});
