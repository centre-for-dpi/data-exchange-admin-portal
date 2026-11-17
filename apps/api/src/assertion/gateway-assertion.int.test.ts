import { createHash, createPublicKey, verify } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { loadCountryConfig } from '@rid/config';
import { gatewayJwksSchema, gatewaySigningKeyRotatedSchema } from '@rid/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, createTestIssuer, type TestIssuer } from '../../test/test-auth.js';
import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { HttpApisixAdmin } from '../reconcilers/apisix/apisix-admin.js';
import { ApisixReconciler } from '../reconcilers/apisix/apisix.reconciler.js';
import { readRealmUsers } from '../seed/realm.js';
import { runSeed } from '../seed/seed.js';
import { GatewaySigningKeysService } from './gateway-signing-keys.service.js';

const GATEWAY = `http://127.0.0.1:${process.env.APISIX_HTTP_PORT ?? 9080}`;
const ROUTE = 'test-m6-10-assertion';
const BASE = '/__rid_m6_10__/afiliacion/v1';
const ISSUER = process.env.RID_GATEWAY_PUBLIC_URL ?? 'https://localhost:9443';
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

type Jwks = ReturnType<typeof gatewayJwksSchema.parse>;

/** What a provider does with X-RID-Assertion (docs/guias/entidades.md): verify, then read. */
function verifyAssertion(token: string, jwks: Jwks) {
  const [h = '', c = '', s = ''] = token.split('.');
  const header = JSON.parse(Buffer.from(h, 'base64url').toString()) as { kid: string; alg: string };
  const jwk = jwks.keys.find((k) => k.kid === header.kid);
  if (!jwk || header.alg !== 'ES256') return undefined;
  const ok = verify(
    'sha256',
    Buffer.from(`${h}.${c}`),
    { key: createPublicKey({ key: jwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' },
    Buffer.from(s, 'base64url'),
  );
  return ok
    ? (JSON.parse(Buffer.from(c, 'base64url').toString()) as {
        kid?: string;
        iss: string;
        aud: string;
        exp: number;
        iat: number;
        jti: string;
        req: { method: string; uri_sha256: string; body_sha256?: string };
      } & { header: typeof header })
    : undefined;
}

/**
 * The gateway's signed assertion (ADR-0024, M6-10) against the real APISIX of the stack: the
 * portal's key in rid-assertion's metadata through the reconciler, a route that signs for the
 * provider, a provider on the host that verifies with the portal's JWKS, and the operator's
 * rotation. The route is the test's own (outside the reconciler's rid- prefix); the plugin's
 * metadata is shared by the gateway, so a development portal pushes its own key back on its next
 * pass.
 */
describe("the gateway's signed assertion to providers (M6-10)", () => {
  const prisma = new PrismaService();
  const realmUsers = readRealmUsers();
  const subOf = (username: string) => realmUsers.find((u) => u.username === username)?.id ?? '';
  const admin = new HttpApisixAdmin({
    baseUrl: process.env.APISIX_ADMIN_URL ?? 'http://localhost:9180',
    apiKey: process.env.APISIX_ADMIN_KEY ?? '',
  });
  let app: NestFastifyApplication;
  let issuer: TestIssuer;
  let provider: Server;
  const received: Array<{ method: string; url: string; body: string; assertion?: string }> = [];

  const reconciler = () => {
    const r = app.get(ApisixReconciler);
    // The country's flag decides in production; the test turns it on for this reconciler.
    Object.defineProperty(r['settings'], 'assertion', {
      value: { issuer: ISSUER },
      configurable: true,
    });
    return r;
  };
  const jwks = async () =>
    gatewayJwksSchema.parse(
      (await app.inject({ method: 'GET', url: '/api/v1/gateway/jwks' })).json(),
    );
  const call = (path: string, init: RequestInit = {}) =>
    fetch(`${GATEWAY}${BASE}${path}`, init).then(async (r) => ({
      status: r.status,
      text: await r.text(),
    }));

  beforeAll(async () => {
    await runSeed(prisma, new AuditService(), {
      config: loadCountryConfig({ code: 'co' }),
      realmUsers,
    });
    issuer = await createTestIssuer();
    app = await createTestApp(issuer);
    provider = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        received.push({
          method: req.method ?? '',
          url: req.url ?? '',
          body: Buffer.concat(chunks).toString(),
          assertion: req.headers['x-rid-assertion'] as string | undefined,
        });
        res.setHeader('content-type', 'application/json');
        res.end('{"ok":true}');
      });
    });
    await new Promise<void>((resolve) => provider.listen(0, '0.0.0.0', resolve));
    const port = (provider.address() as AddressInfo).port;
    // The plugin's code from the repository (a running gateway may hold an older copy).
    await fetch(
      `${process.env.APISIX_ADMIN_URL ?? 'http://localhost:9180'}/apisix/admin/plugins/reload`,
      {
        method: 'PUT',
        headers: { 'x-api-key': process.env.APISIX_ADMIN_KEY ?? '' },
      },
    );
    await admin.put('routes', ROUTE, {
      uri: `${BASE}/*`,
      methods: ['GET', 'POST', 'DELETE'],
      plugins: {
        'request-id': { header_name: 'X-Request-Id', include_in_response: true },
        'rid-header-guard': {},
        'proxy-rewrite': { regex_uri: [`^${BASE}/(.*)$`, '/salud/$1'] },
        'rid-assertion': { audience: 'salud' },
      },
      upstream: { type: 'roundrobin', nodes: { [`host.docker.internal:${port}`]: 1 } },
    });
  });
  afterAll(async () => {
    await admin.delete('routes', ROUTE).catch(() => undefined);
    provider.close();
    await app.close();
    await prisma.$disconnect();
  });

  it('signs each call for the provider with the key the portal publishes, bound to the request', async () => {
    await reconciler().reconcileAssertionKey();
    const { kid } = await app.get(GatewaySigningKeysService).current();
    const published = await jwks();
    expect(published.keys[0]).toMatchObject({
      kty: 'EC',
      crv: 'P-256',
      alg: 'ES256',
      use: 'sig',
      kid,
    });

    // APISIX applies the metadata within a moment.
    let res = { status: 0, text: '' };
    for (let i = 0; i < 20 && res.status !== 200; i += 1) {
      res = await call('/afiliados/1000000001?campos=regimen');
      if (res.status !== 200) await new Promise((r) => setTimeout(r, 250));
    }
    expect(res.status, res.text).toBe(200);
    const got = received.at(-1);
    const claims = verifyAssertion(got?.assertion ?? '', published);
    expect(claims).toMatchObject({ iss: ISSUER, aud: 'salud', req: { method: 'GET' } });
    expect(claims?.req.uri_sha256).toBe(sha256(got?.url ?? ''));
    expect(got?.url).toBe('/salud/afiliados/1000000001?campos=regimen');
    // The identification number is in the URI, never in the token.
    expect(
      Buffer.from((got?.assertion ?? '').split('.')[1] ?? '', 'base64url').toString(),
    ).not.toContain('1000000001');
    expect((claims?.exp ?? 0) - (claims?.iat ?? 0)).toBe(60);

    // A client's own X-RID-Assertion never reaches the provider.
    await call('/afiliados/1000000001', { headers: { 'X-RID-Assertion': 'forged' } });
    expect(received.at(-1)?.assertion).not.toBe('forged');
  });

  it('binds a body on any method: a DELETE that carries one too', async () => {
    const body = 'cuerpo de un DELETE';
    const res = await call('/afiliados/1000000001', { method: 'DELETE', body });
    expect(res.status, res.text).toBe(200);
    const got = received.at(-1);
    expect(got?.body).toBe(body);
    const claims = verifyAssertion(got?.assertion ?? '', await jwks());
    expect(claims?.req).toMatchObject({ method: 'DELETE', body_sha256: sha256(body) });
    // Without a body, a GET binds none.
    await call('/afiliados/1000000001');
    const plain = verifyAssertion(received.at(-1)?.assertion ?? '', await jwks());
    expect(plain?.req.body_sha256).toBeUndefined();
  });

  it('binds the body of a request with one', async () => {
    const body = JSON.stringify({ numeroIdentificacion: '1000000001' });
    const res = await call('/afiliados/verificaciones', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    expect(res.status, res.text).toBe(200);
    const got = received.at(-1);
    const claims = verifyAssertion(got?.assertion ?? '', await jwks());
    expect(claims?.req).toMatchObject({ method: 'POST', body_sha256: sha256(got?.body ?? '') });
    expect(got?.body).toBe(body);
  });

  it('rotates: the new key signs, the old one stays published unless it was compromised', async () => {
    const asOperator = async (who: string, payload: unknown) =>
      app.inject({
        method: 'POST',
        url: '/api/v1/admin/gateway-signing-keys/rotate',
        headers: { authorization: `Bearer ${await issuer.token(subOf(who))}` },
        payload: payload as object,
      });
    for (const who of ['ana.operadora', 'marta.regulador', 'carlos.dev']) {
      expect((await asOperator(who, { reason: 'Rotación de prueba' })).statusCode, who).toBe(403);
    }
    const first = gatewaySigningKeyRotatedSchema.parse(
      (await asOperator('pablo.plataforma', { reason: 'Rotación programada de prueba' })).json(),
    );
    await reconciler().reconcileAssertionKey();
    const kids = (await jwks()).keys.map((k) => k.kid);
    expect(kids[0]).toBe(first.kid);
    expect(kids).toContain(first.previous);

    let header = '';
    for (let i = 0; i < 20 && header !== first.kid; i += 1) {
      await call('/afiliados/1000000001');
      header = (
        JSON.parse(
          Buffer.from(
            (received.at(-1)?.assertion ?? '').split('.')[0] ?? '',
            'base64url',
          ).toString(),
        ) as {
          kid: string;
        }
      ).kid;
      if (header !== first.kid) await new Promise((r) => setTimeout(r, 250));
    }
    expect(header).toBe(first.kid);

    const second = gatewaySigningKeyRotatedSchema.parse(
      (
        await asOperator('pablo.plataforma', {
          reason: 'La clave anterior se filtró',
          compromised: true,
        })
      ).json(),
    );
    const after = (await jwks()).keys.map((k) => k.kid);
    expect(after).toContain(second.kid);
    expect(after).not.toContain(first.kid);
    const audited = await prisma.auditEvent.findFirstOrThrow({
      where: {
        action: 'gateway_signing_key.created',
        after: { path: ['kid'], equals: second.kid },
      },
    });
    expect(audited.after).toMatchObject({
      reason: 'La clave anterior se filtró',
      previousCompromised: true,
    });
    await reconciler().reconcileAssertionKey();
  });

  it('fails closed without a key in the gateway', async () => {
    await admin.delete('plugin_metadata', 'rid-assertion');
    let status = 0;
    for (let i = 0; i < 20 && status !== 503; i += 1) {
      status = (await call('/afiliados/1000000001')).status;
      if (status !== 503) await new Promise((r) => setTimeout(r, 250));
    }
    expect(status).toBe(503);
    await reconciler().reconcileAssertionKey();
  });

  it('publishes the keys to anyone, cacheable', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/gateway/jwks' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=300');
  });
});
