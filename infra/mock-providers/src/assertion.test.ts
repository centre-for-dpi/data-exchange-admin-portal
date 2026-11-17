import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { FIRST_ID } from './data.js';
import { buildServer } from './server.js';

const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const KID = 'rid-gw-test';
const JWKS = {
  keys: [{ ...publicKey.export({ format: 'jwk' }), kid: KID, use: 'sig', alg: 'ES256' }],
};
const fetchJwks = (() => Promise.resolve(new Response(JSON.stringify(JWKS)))) as typeof fetch;
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const b64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

/** An assertion as the gateway's rid-assertion plugin signs it. */
function assertion(
  req: { method: string; uri: string; body?: string },
  overrides: Record<string, unknown> = {},
): string {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: 'https://gateway.rid.example',
    aud: 'salud',
    iat: now,
    exp: now + 60,
    jti: 'req-1',
    rid: { consumer_entity: 'programas-sociales', purpose: 'eligibility_check' },
    req: {
      method: req.method,
      uri_sha256: sha256(req.uri),
      ...(req.body !== undefined ? { body_sha256: sha256(req.body) } : {}),
    },
    ...overrides,
  };
  const input = `${b64url({ alg: 'ES256', typ: 'JWT', kid: KID })}.${b64url(claims)}`;
  const signature = sign('sha256', Buffer.from(input), {
    key: privateKey,
    dsaEncoding: 'ieee-p1363',
  });
  return `${input}.${signature.toString('base64url')}`;
}

function server(required = false) {
  const lines: string[] = [];
  const logStream = new Writable({
    write(chunk: Buffer, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  const app = buildServer('salud', {
    logStream,
    assertion: { jwksUrl: 'http://portal/jwks', audience: 'salud', required, fetchFn: fetchJwks },
  });
  const results = () =>
    lines
      .map((l) => JSON.parse(l) as { assertion?: string })
      .filter((l) => l.assertion !== undefined)
      .map((l) => l.assertion);
  return { app, results };
}

const URI = `/salud/afiliados/${FIRST_ID}`;
const BODY = JSON.stringify({ numeroIdentificacion: String(FIRST_ID) });

describe("the gateway's signed assertion (M6-10)", () => {
  it('verifies the assertion bound to the request it came with', async () => {
    const { app, results } = server();
    const ok = await app.inject({
      method: 'GET',
      url: URI,
      headers: { 'x-rid-assertion': assertion({ method: 'GET', uri: URI }) },
    });
    expect(ok.statusCode).toBe(200);
    expect(results()).toEqual(['verified']);
  });

  it('refuses one moved to another request, provider or time, or tampered with', async () => {
    const { app, results } = server();
    const other = `/salud/afiliados/${FIRST_ID + 1}`;
    const cases: Array<[string, string]> = [
      [assertion({ method: 'GET', uri: other }), 'invalid: uri'],
      [assertion({ method: 'GET', uri: URI }, { aud: 'socioeconomico' }), 'invalid: audience'],
      [
        assertion({ method: 'GET', uri: URI }, { exp: Math.floor(Date.now() / 1000) - 120 }),
        'invalid: expired',
      ],
      [assertion({ method: 'POST', uri: URI }), 'invalid: method'],
      [`${assertion({ method: 'GET', uri: URI }).slice(0, -4)}AAAA`, 'invalid: signature'],
      ['not-a-jws', 'invalid: not a compact JWS'],
    ];
    for (const [header] of cases) {
      await app.inject({ method: 'GET', url: URI, headers: { 'x-rid-assertion': header } });
    }
    await app.inject({ method: 'GET', url: URI });
    expect(results()).toEqual([...cases.map(([, result]) => result), 'absent']);
  });

  it('binds the body of a request that has one', async () => {
    const { app, results } = server();
    const url = '/salud/afiliados/verificaciones';
    const headers = { 'content-type': 'application/json' };
    await app.inject({
      method: 'POST',
      url,
      payload: BODY,
      headers: {
        ...headers,
        'x-rid-assertion': assertion({ method: 'POST', uri: url, body: BODY }),
      },
    });
    const otherBody = JSON.stringify({ numeroIdentificacion: String(FIRST_ID + 1) });
    await app.inject({
      method: 'POST',
      url,
      payload: otherBody,
      headers: {
        ...headers,
        'x-rid-assertion': assertion({ method: 'POST', uri: url, body: BODY }),
      },
    });
    expect(results()).toEqual(['verified', 'invalid: body']);
  });

  it('refuses the call without a valid assertion when the provider requires it', async () => {
    const { app } = server(true);
    const refused = await app.inject({ method: 'GET', url: URI });
    expect(refused.statusCode).toBe(401);
    expect(refused.json()).toMatchObject({ status: 401, detail: 'absent' });
    const allowed = await app.inject({
      method: 'GET',
      url: URI,
      headers: { 'x-rid-assertion': assertion({ method: 'GET', uri: URI }) },
    });
    expect(allowed.statusCode).toBe(200);
  });
});
