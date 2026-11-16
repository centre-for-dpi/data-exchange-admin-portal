#!/usr/bin/env node
// SPIKE S-6: the gateway's signed assertion to the provider (JWS ES256), for non-repudiation.
// Run with the stack up (APISIX with the rid-assertion plugin of infra/apisix/plugins):
//   node docs/spikes/S-6/run-spike.mjs
// It creates a temporary route and the plugin's metadata (a fresh P-256 key), a provider on the
// host that verifies the assertion as a real one would (JWKS, signature, claims), and removes
// everything at the end. OPA's request headers are simulated with proxy-rewrite: the plugin reads
// whatever X-RID-* headers stand after OPA, which rid-header-guard already cleaned of a client's.
import { createHash, createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { createServer } from 'node:http';

if (process.env.APISIX_ADMIN_KEY === undefined) {
  try {
    process.loadEnvFile('.env');
  } catch {
    // .env is optional: the defaults below are the development ones.
  }
}

const ADMIN = `http://localhost:${process.env.APISIX_ADMIN_PORT ?? 9180}/apisix/admin`;
const GATEWAY = `http://127.0.0.1:${process.env.APISIX_HTTP_PORT ?? 9080}`;
const ROUTE = 'spike-s6-assertion';
const PLAIN = 'spike-s6-plain';
const BASE = '/__rid_s6__/afiliacion/v1';
const ISSUER = 'https://gateway.rid.example';

const admin = (path, init = {}) =>
  fetch(`${ADMIN}${path}`, {
    ...init,
    headers: { 'x-api-key': process.env.APISIX_ADMIN_KEY, 'content-type': 'application/json' },
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

/** A signing key as the portal would make it: P-256, kid = RFC 7638 thumbprint of the JWK. */
function signingKey() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const kid = createHash('sha256')
    .update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }))
    .digest('base64url');
  return {
    kid,
    pem: privateKey.export({ format: 'pem', type: 'pkcs8' }),
    jwk: { ...jwk, kid, use: 'sig', alg: 'ES256' },
  };
}

// --- The provider: verifies X-RID-Assertion with the JWKS it fetched from the portal ----------

let jwks = [];
let seen = [];
/** What a provider does with the assertion: verify, then check it is for this very request. */
function verifyAssertion(jws, request, audience) {
  const [h, p, s] = (jws ?? '').split('.');
  if (!h || !p || !s) return { valid: false, reason: 'not a compact JWS' };
  const header = JSON.parse(Buffer.from(h, 'base64url').toString());
  const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
  const jwk = jwks.find((k) => k.kid === header.kid);
  if (header.alg !== 'ES256' || !jwk) return { valid: false, reason: `unknown kid ${header.kid}` };
  const signatureOk = verify(
    'sha256',
    Buffer.from(`${h}.${p}`),
    { key: createPublicKey({ key: jwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' },
    Buffer.from(s, 'base64url'),
  );
  if (!signatureOk) return { valid: false, reason: 'bad signature', header, claims };
  const now = Math.floor(Date.now() / 1000);
  const uri = createHash('sha256').update(request.url).digest('hex');
  const problems = [
    claims.iss !== ISSUER && 'iss',
    claims.aud !== audience && 'aud',
    !(claims.iat <= now + 5 && claims.exp > now) && 'time',
    claims.req?.method !== request.method && 'method',
    claims.req?.uri_sha256 !== uri && 'uri',
    claims.rid?.subscription !== request.headers['x-rid-subscription'] && 'subscription',
  ].filter(Boolean);
  return { valid: problems.length === 0, reason: problems.join(','), header, claims };
}

const provider = createServer((req, res) => {
  seen.push({ url: req.url, method: req.method, headers: req.headers });
  res.setHeader('content-type', 'application/json');
  res.end('{"regimen":"contributivo"}');
});
await new Promise((resolve) => provider.listen(0, '0.0.0.0', resolve));
const port = provider.address().port;

// --- The gateway: the plugin's metadata (the key) and a route -------------------------------

const OPA_HEADERS = {
  'X-RID-Consumer-Entity': 'programas-sociales',
  'X-RID-Consumer-App': 'rid-app-spike-s6',
  'X-RID-Subscription': '0190d0c4-0000-7000-8000-0000000000s6'.replace('s6', '56'),
  'X-RID-Purpose': 'eligibility_check',
  'X-RID-Operation': 'getAfiliado',
  'X-RID-End-User-Hash': createHash('sha256').update('funcionario-42').digest('hex'),
};
const route = (id, withAssertion) =>
  admin(`/routes/${id}`, {
    method: 'PUT',
    body: JSON.stringify({
      uri: `${withAssertion ? BASE : `${BASE}-plain`}/*`,
      upstream: { type: 'roundrobin', nodes: { [`host.docker.internal:${port}`]: 1 } },
      plugins: {
        'rid-header-guard': {},
        'proxy-rewrite': {
          regex_uri: [`^${withAssertion ? BASE : `${BASE}-plain`}/(.*)$`, '/servicio/$1'],
          headers: { set: OPA_HEADERS },
        },
        ...(withAssertion ? { 'rid-assertion': { audience: 'salud', ttl: 60 } } : {}),
      },
    }),
  });

let key = signingKey();
jwks = [key.jwk];
const setKey = (k) =>
  admin('/plugin_metadata/rid-assertion', {
    method: 'PUT',
    body: JSON.stringify({ issuer: ISSUER, kid: k.kid, private_key: k.pem }),
  });

try {
  const metadata = await setKey(key);
  check('plugin metadata with the key accepted by APISIX', [200, 201].includes(metadata.status));
  for (const [id, withAssertion] of [
    [ROUTE, true],
    [PLAIN, false],
  ]) {
    const res = await route(id, withAssertion);
    if (![200, 201].includes(res.status)) throw new Error(`route ${id}: ${await res.text()}`);
  }
  for (let i = 0; i < 40; i += 1) {
    if ((await fetch(`${GATEWAY}${BASE}/x`)).status !== 404) break;
    await sleep(250);
  }

  const call = async (path, headers = {}) => {
    seen = [];
    const res = await fetch(`${GATEWAY}${path}`, { headers });
    await res.arrayBuffer();
    return { status: res.status, at: seen[0] };
  };

  // 1. The assertion reaches the provider and verifies.
  const one = await call(`${BASE}/afiliados/1000000001?campos=regimen`);
  const result = verifyAssertion(one.at?.headers['x-rid-assertion'], one.at, 'salud');
  check(
    'the provider receives X-RID-Assertion and verifies it with the JWKS',
    result.valid,
    result.reason,
  );
  check(
    'signed claims: consumer, app, subscription, purpose, operation, official hash',
    result.claims?.rid?.consumer_app === OPA_HEADERS['X-RID-Consumer-App'] &&
      result.claims?.rid?.purpose === 'eligibility_check' &&
      result.claims?.rid?.operation === 'getAfiliado' &&
      result.claims?.rid?.end_user_hash === OPA_HEADERS['X-RID-End-User-Hash'],
  );
  check(
    'bound to the request: method and hash of the path the provider got, never the path itself',
    result.claims?.req?.method === 'GET' &&
      !JSON.stringify(result.claims).includes('1000000001') &&
      one.at?.url === '/servicio/afiliados/1000000001?campos=regimen',
  );
  check(
    'expires in 60 s; jti is the gateway request id',
    result.claims?.exp - result.claims?.iat === 60 &&
      /^[0-9a-f]{32}$/.test(result.claims?.jti ?? ''),
  );

  // 2. A consumer cannot bring its own assertion.
  const forged = await call(`${BASE}/afiliados/1000000001`, {
    'X-RID-Assertion': 'eyJmYWxzbyI6dHJ1ZX0.e30.AAAA',
  });
  check(
    'a forged X-RID-Assertion of the client is replaced',
    forged.at?.headers['x-rid-assertion'] !== 'eyJmYWxzbyI6dHJ1ZX0.e30.AAAA' &&
      verifyAssertion(forged.at?.headers['x-rid-assertion'], forged.at, 'salud').valid,
  );

  // 3. Tampering and replay against another request or provider are detected.
  const jws = one.at.headers['x-rid-assertion'];
  const [h, p, s] = jws.split('.');
  const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
  claims.rid.purpose = 'statistics';
  const tampered = `${h}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.${s}`;
  check('a changed claim breaks the signature', !verifyAssertion(tampered, one.at, 'salud').valid);
  check(
    'replayed on another request it does not match',
    verifyAssertion(jws, { ...one.at, url: '/servicio/afiliados/2000000002' }, 'salud').reason ===
      'uri',
  );
  check(
    'another provider rejects it (aud)',
    verifyAssertion(jws, one.at, 'socioeconomico').reason === 'aud',
  );

  // 4. Rotation: a new key and kid; providers keep the old public key while it may still verify.
  const old = key;
  key = signingKey();
  jwks = [old.jwk, key.jwk];
  await setKey(key);
  await sleep(1500);
  const rotated = await call(`${BASE}/afiliados/1000000001`);
  const after = verifyAssertion(rotated.at?.headers['x-rid-assertion'], rotated.at, 'salud');
  check(
    'after a rotation the new kid signs, and the JWKS with both keys verifies',
    after.valid && after.header?.kid === key.kid,
  );
  jwks = [key.jwk];
  check(
    'an assertion of the old key no longer verifies once its key leaves the JWKS',
    !verifyAssertion(jws, one.at, 'salud').valid,
  );

  // 5. Fail closed without a key.
  await admin('/plugin_metadata/rid-assertion', { method: 'DELETE' });
  await sleep(1500);
  const nokey = await call(`${BASE}/afiliados/1000000001`);
  check(
    'without the key the gateway answers 503 and the provider gets nothing',
    nokey.status === 503 && nokey.at === undefined,
  );
  await setKey(key);
  await sleep(1500);

  // 6. The cost of signing: the same route with and without the plugin.
  const time = async (path, n) => {
    const start = process.hrtime.bigint();
    for (let i = 0; i < n; i += 1) {
      const r = await fetch(`${GATEWAY}${path}`);
      await r.arrayBuffer();
    }
    return Number(process.hrtime.bigint() - start) / 1e6 / n;
  };
  await time(`${BASE}/afiliados/1`, 50);
  await time(`${BASE}-plain/afiliados/1`, 50);
  const signed = await time(`${BASE}/afiliados/1`, 400);
  const plain = await time(`${BASE}-plain/afiliados/1`, 400);
  console.log(
    `     mean per call: ${signed.toFixed(2)} ms signed, ${plain.toFixed(2)} ms plain (${(signed - plain).toFixed(2)} ms added)`,
  );
  check('signing adds well under a millisecond per call', signed - plain < 1);
  console.log(`     assertion size: ${jws.length} bytes`);
} finally {
  await admin(`/routes/${ROUTE}`, { method: 'DELETE' });
  await admin(`/routes/${PLAIN}`, { method: 'DELETE' });
  await admin('/plugin_metadata/rid-assertion', { method: 'DELETE' });
  provider.close();
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exitCode = failed ? 1 : 0;
