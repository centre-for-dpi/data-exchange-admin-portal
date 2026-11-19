import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  type AccessRecord,
  inclusionProof,
  type Receipt,
  recordLeafHash,
  toHex,
} from '@den/transparency-verifier';
import { type CryptoKey, exportJWK, generateKeyPair, type JWK, SignJWT } from 'jose';
import { Webhook } from 'standardwebhooks';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CitizenAppConfig } from './config.js';
import { type Mailer, buildServer } from './server.js';
import { AlertStore } from './store.js';

/** A sealed and stamped batch, signed by a test key and stamped by the development TSA's chain. */
const fixture = JSON.parse(
  readFileSync(
    resolve(
      import.meta.dirname,
      '../../../packages/transparency-verifier/src/__fixtures__/receipt-fixture.json',
    ),
    'utf8',
  ),
) as {
  privateJwk: JWK;
  records: AccessRecord[];
  checkpoint: string;
  timestamp: string;
  tsaRoot: string;
};
const { d: _private, ...operatorKey } = fixture.privateJwk;
const leaves = fixture.records.map((r) => recordLeafHash(r));
const receiptFor = (index: number): Receipt => ({
  v: 1,
  record: fixture.records[index] as AccessRecord,
  leafIndex: index,
  proof: inclusionProof(leaves, index).map(toHex),
  checkpoint: fixture.checkpoint,
  timestamp: fixture.timestamp,
});

const issuer = 'https://identity.test/realms/den-citizens';
const secret = `whsec_${randomBytes(32).toString('base64')}`;
const config: CitizenAppConfig = {
  publicUrl: 'https://citizen-app.test/citizen-app',
  basePath: '/citizen-app',
  port: 0,
  name: { es: 'Aplicación de prueba', en: 'Test app' },
  oidc: { issuer, internalUrl: issuer, clientId: 'citizen-app', clientSecret: 'secret' },
  portal: {
    apiUrl: 'https://portal.test',
    jwksUrl: 'https://portal.test/api/v1/transparency/jwks',
    tsaRootUrl: 'https://tsa.test/api/v1/timestamp/certchain',
    tsaRootsFile: null,
  },
  webhookSecret: secret,
  smtp: { host: 'localhost', port: 1025, from: 'avisos@citizen-app.test' },
  dataFile: '',
};

/**
 * B-20: a receipt the app calls valid must be the receipt of the consultation the citizen asked
 * about, and a notice is not lost when the mail server fails.
 */
describe('reference citizen app: receipts and notices (B-20)', () => {
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  /** Which receipt the portal hands over, whatever was asked. */
  let served = receiptFor(0);
  let signer: CryptoKey;
  let identityJwks: { keys: JWK[] };
  let nonce = '';
  const urlOf = (input: string | URL | Request) =>
    typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const portalFetch: typeof fetch = async (input) => {
    const url = urlOf(input);
    if (url.endsWith('/protocol/openid-connect/token')) {
      const idToken = await new SignJWT({ nonce })
        .setProtectedHeader({ alg: 'RS256', kid: 'identity' })
        .setIssuer(issuer)
        .setAudience('citizen-app')
        .setSubject('citizen-1')
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(signer);
      return json({ access_token: 'access', id_token: idToken, expires_in: 300 });
    }
    if (url === config.portal.jwksUrl) return json({ keys: [operatorKey] });
    if (url === config.portal.tsaRootUrl) return new Response(fixture.tsaRoot);
    if (/\/data-subjects\/me\/accesses\/[^/]+\/receipt$/.test(url)) return json(served);
    return new Response('not found', { status: 404 });
  };

  const sent: string[] = [];
  let failures = 0;
  const mailer: Mailer = {
    send: (m) => {
      if (failures > 0) {
        failures--;
        return Promise.reject(new Error('SMTP down'));
      }
      sent.push(m.to);
      return Promise.resolve();
    },
  };
  const store = new AlertStore(null);
  const app = buildServer(config, { store, mailer, fetch: portalFetch });
  let session = '';

  beforeAll(async () => {
    process.env.DEN_COUNTRY ??= 'co';
    const keys = await generateKeyPair('RS256');
    signer = keys.privateKey;
    identityJwks = {
      keys: [{ ...(await exportJWK(keys.publicKey)), kid: 'identity', alg: 'RS256' }],
    };
    // The identity provider's keys, which jose fetches itself.
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) =>
      urlOf(input).endsWith('/openid-connect/certs')
        ? Promise.resolve(json(identityJwks))
        : realFetch(input, init),
    );
    await app.ready();
    const login = await app.inject({ url: '/citizen-app/login' });
    const target = new URL(login.headers.location ?? '');
    nonce = target.searchParams.get('nonce') ?? '';
    const state = target.searchParams.get('state') ?? '';
    const callback = await app.inject({
      url: `/citizen-app/auth/callback?state=${state}&code=code`,
      cookies: { citizen_login: state },
    });
    expect(callback.headers.location).toBe('/citizen-app/consultas');
    session = callback.cookies.find((c) => c.name === 'citizen_session')?.value ?? '';
    expect(session).not.toBe('');
  });
  afterAll(() => vi.unstubAllGlobals());

  const receiptPage = async (id: string) => {
    const res = await app.inject({
      url: `/citizen-app/consultas/${id}/comprobante`,
      cookies: { citizen_session: session },
    });
    expect(res.statusCode, res.body).toBe(200);
    return /data-testid="receipt-status">\s*([^<]+?)\s*</.exec(res.body)?.[1];
  };

  it('calls valid the receipt of the consultation asked about', async () => {
    served = receiptFor(0);
    expect(await receiptPage(fixture.records[0]?.id ?? '')).toBe('Comprobante válido');
  });

  it('does not call valid the valid receipt of another consultation', async () => {
    // The portal answers with another record's receipt: genuine, signed and stamped, but not
    // the consultation the citizen opened.
    served = receiptFor(1);
    expect(await receiptPage(fixture.records[0]?.id ?? '')).toBe(
      'El comprobante no corresponde a esta consulta',
    );
  });

  const notice = (id: string, alertId: string) => {
    const body = JSON.stringify({
      type: 'subject_access.created',
      timestamp: new Date().toISOString(),
      data: { alertId, accessId: randomUUID(), occurredAt: '2026-11-13T15:00:00.000Z' },
    });
    const now = new Date();
    return app.inject({
      method: 'POST',
      url: '/citizen-app/api/den/alerts',
      headers: {
        'content-type': 'application/json',
        'webhook-id': id,
        'webhook-timestamp': String(Math.floor(now.getTime() / 1000)),
        'webhook-signature': new Webhook(secret).sign(id, now, body),
      },
      payload: body,
    });
  };

  it('sends a notice on the retry when the mail server failed the first time', async () => {
    const alertId = randomUUID();
    store.set(alertId, { sub: 'citizen-1', email: 'valentina@example.test' });
    const id = `msg_${randomUUID()}`;
    sent.length = 0;
    failures = 1;
    // Not 2xx: the portal retries the same message.
    expect((await notice(id, alertId)).statusCode).toBe(500);
    expect(sent).toEqual([]);
    expect((await notice(id, alertId)).statusCode).toBe(204);
    expect(sent).toEqual(['valentina@example.test']);
    // Sent once: a further retry sends nothing.
    expect((await notice(id, alertId)).statusCode).toBe(204);
    expect(sent).toHaveLength(1);
  });
});
