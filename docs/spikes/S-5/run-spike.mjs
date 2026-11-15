#!/usr/bin/env node
// SPIKE S-5: X-Road REST (PR-REST 1.0.4) as an upstream of the gateway, and how the real consumer
// travels to the provider. Run with the stack up:
//   node docs/spikes/S-5/run-spike.mjs
// There is no real Security Server here (it needs a Central Server and a registered member): a
// simulated consumer Security Server on the host implements the parts of PR-REST the gateway
// depends on (URL, X-Road-Client, header filtering, X-Road-* response headers). The script creates
// a temporary APISIX route and OPA policy and removes them at the end.
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
const OPA = `http://localhost:${process.env.OPA_PORT ?? 8181}`;
const ROUTE = 'spike-s5-xroad';
const PACKAGE = 'ridspikes5';
const BASE = '/__rid_s5__/registro/v1';

/** The operator's client subsystem: the gateway is one X-Road client for the whole network. */
const OPERATOR_CLIENT = 'DEV/GOV/9000000001/RID-GATEWAY';
/** The provider's service; one part with a space and a non-ASCII letter, to see the encoding. */
const SERVICE = ['DEV', 'GOV', '8999999999', 'REGISTRO SOCIAL-Ñ', 'consultaHogar'];

const HOP_BY_HOP = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
];
const admin = (path, init = {}) =>
  fetch(`${ADMIN}${path}`, {
    ...init,
    headers: { 'x-api-key': process.env.APISIX_ADMIN_KEY, 'content-type': 'application/json' },
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const token = (azp) =>
  [{ alg: 'none', typ: 'JWT' }, { azp }]
    .map((part) => Buffer.from(JSON.stringify(part)).toString('base64url'))
    .join('.')
    .concat('.');

// --- 1. Simulated consumer Security Server --------------------------------------------------------
// What the provider's information system would receive after both Security Servers (PR-REST §4):
// user-defined headers unchanged, hop-by-hop and origin-revealing headers removed, the X-Road
// request headers the consumer is allowed to send, and the ones the Security Servers add.

let lastSeen;
const securityServer = createServer((req, res) => {
  const reply = (status, body, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  };
  const url = new URL(req.url, 'http://ss');
  const parts = url.pathname.split('/').slice(1);
  if (parts[0] !== 'r1' || parts.length < 6) {
    return reply(400, {
      type: 'Client.BadRequest',
      message: `not a PR-REST r1 URL: ${url.pathname}`,
    });
  }
  const client = req.headers['x-road-client'];
  if (client !== OPERATOR_CLIENT) {
    return reply(
      400,
      { type: 'Client.InvalidClient', message: `unknown client ${client}` },
      { 'x-road-error': 'Client.InvalidClient' },
    );
  }
  const serviceId = parts.slice(1, 6).map(decodeURIComponent);
  const servicePath = `/${parts.slice(6).join('/')}`;
  const forwarded = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (HOP_BY_HOP.includes(name) || ['host', 'user-agent', 'server'].includes(name)) continue;
    forwarded[name] = value;
  }
  lastSeen = { serviceId, servicePath, query: url.search, headers: forwarded };
  reply(
    200,
    { hogar: 'sintetico' },
    {
      'x-road-client': client,
      'x-road-service': serviceId.join('/'),
      'x-road-id': req.headers['x-road-id'] ?? 'generated-by-ss',
      'x-road-request-id': 'req-1',
      'x-road-request-hash': 'hash-of-request',
    },
  );
});

// --- 2. Gateway route -----------------------------------------------------------------------------

async function setup(port) {
  // A minimal policy that allows one client and returns the X-Road headers that only the gateway
  // decides (the real policy would compute them from the bundle).
  const policy = `package ${PACKAGE}.authz
import rego.v1
default allow := false
token := io.jwt.decode(trim_prefix(input.request.headers.authorization, "Bearer "))[1]
allow if token.azp == "rid-app-s5"
headers := {
  "X-RID-Subscription": "sub-s5",
  "X-RID-Consumer-Entity": "programas-sociales",
  "X-RID-Purpose": input.request.headers["x-rid-purpose"],
  "X-Road-UserId": "hash-del-funcionario",
  "X-Road-Issue": "rid:subscription:sub-s5",
} if allow
reason := "no_subscription" if not allow
result := {"allow": allow, "headers": headers} if allow
result := {"allow": false, "status_code": 403, "reason": reason} if not allow
`;
  let res = await fetch(`${OPA}/v1/policies/${PACKAGE}`, { method: 'PUT', body: policy });
  if (res.status !== 200) throw new Error(`OPA policy: ${res.status} ${await res.text()}`);

  // Literal characters: APISIX percent-encodes upstream_uri itself, so an already encoded part
  // (%20) would arrive double-encoded (%2520). S5_ENCODED=1 shows it.
  const serviceId = process.env.S5_ENCODED
    ? SERVICE.map(encodeURIComponent).join('/')
    : SERVICE.join('/');
  res = await admin(`/routes/${ROUTE}`, {
    method: 'PUT',
    body: JSON.stringify({
      uri: `${BASE}/*`,
      methods: ['GET'],
      upstream: {
        type: 'roundrobin',
        scheme: 'http',
        nodes: { [`host.docker.internal:${port}`]: 1 },
      },
      plugins: {
        'rid-header-guard': {},
        'proxy-rewrite': {
          regex_uri: [`^${BASE}/(.*)$`, `/r1/${serviceId}/$1`],
          headers: {
            // The operator's subsystem, always; whatever the consumer sent is replaced.
            set: { 'X-Road-Client': OPERATOR_CLIENT },
            // X-Road request headers the consumer could use to steer the Security Server.
            remove: [
              'X-Road-Security-Server',
              'X-Road-Represented-Party',
              'X-Road-Id',
              'X-Road-Request-Hash',
            ],
          },
        },
        opa: {
          host: 'http://opa:8181',
          policy: `${PACKAGE}/authz/result`,
          send_headers_upstream: [
            'X-RID-Subscription',
            'X-RID-Consumer-Entity',
            'X-RID-Purpose',
            'X-Road-UserId',
            'X-Road-Issue',
          ],
        },
      },
    }),
  });
  if (res.status >= 300) throw new Error(`APISIX route: ${res.status} ${await res.text()}`);
  for (let i = 0; i < 40 && (await fetch(`${GATEWAY}${BASE}/x`)).status === 404; i += 1) {
    await sleep(250);
  }
}

async function cleanup() {
  await admin(`/routes/${ROUTE}`, { method: 'DELETE' });
  await fetch(`${OPA}/v1/policies/${PACKAGE}`, { method: 'DELETE' });
  securityServer.close();
}

// --- 3. Checks ------------------------------------------------------------------------------------

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

async function call(path, headers = {}) {
  lastSeen = undefined;
  const res = await fetch(`${GATEWAY}${BASE}${path}`, {
    headers: {
      authorization: `Bearer ${token('rid-app-s5')}`,
      'x-rid-purpose': 'benefit_targeting',
      ...headers,
    },
  });
  return { res, body: await res.text(), seen: lastSeen };
}

async function run() {
  await new Promise((r) => securityServer.listen(0, '0.0.0.0', r));
  const { port } = securityServer.address();
  await setup(port);
  try {
    let { res, seen } = await call('/hogares/1000000001?campos=basico');
    check('call through the gateway reaches the Security Server', res.status === 200);
    check(
      'serviceId arrives decoded part by part (space included)',
      JSON.stringify(seen?.serviceId) === JSON.stringify(SERVICE),
      JSON.stringify(seen?.serviceId),
    );
    check(
      'the service path and query follow the serviceId',
      seen?.servicePath === '/hogares/1000000001' && seen?.query === '?campos=basico',
      `${seen?.servicePath}${seen?.query}`,
    );
    check(
      'X-Road-Client is the operator subsystem',
      seen?.headers['x-road-client'] === OPERATOR_CLIENT,
    );
    check(
      'X-RID-* trace headers set by OPA travel as user-defined headers',
      seen?.headers['x-rid-subscription'] === 'sub-s5' &&
        seen?.headers['x-rid-consumer-entity'] === 'programas-sociales',
    );
    check(
      'X-Road-UserId and X-Road-Issue come from the policy',
      seen?.headers['x-road-userid'] === 'hash-del-funcionario' &&
        seen?.headers['x-road-issue'] === 'rid:subscription:sub-s5',
    );
    check(
      'X-Road-* response headers reach the consumer',
      res.headers.get('x-road-service') === SERVICE.join('/') &&
        res.headers.get('x-road-request-hash') !== null,
    );

    ({ res, seen } = await call('/hogares/1000000001', {
      'X-Road-Client': 'DEV/GOV/666/INTRUSO',
      'X-Road-Security-Server': 'DEV/GOV/666/SS-INTRUSO',
      'X-Road-Represented-Party': 'GOV/666',
      'X-Road-UserId': 'usuario-falso',
      'X-Road-Issue': 'falso',
      'X-Road-Id': 'id-falso',
    }));
    check('a forged X-Road-Client is replaced', seen?.headers['x-road-client'] === OPERATOR_CLIENT);
    check(
      'forged X-Road-Security-Server, -Represented-Party and -Id are removed',
      !seen?.headers['x-road-security-server'] &&
        !seen?.headers['x-road-represented-party'] &&
        !seen?.headers['x-road-id'],
    );
    check(
      'forged X-Road-UserId and X-Road-Issue are replaced by the policy values',
      seen?.headers['x-road-userid'] === 'hash-del-funcionario' &&
        seen?.headers['x-road-issue'] === 'rid:subscription:sub-s5',
    );

    ({ res, seen } = await call('/hogares/..%2F..%2F..%2FOTHER%2FSERVICE%2Fx'));
    check(
      'an encoded traversal in the service path cannot change the serviceId',
      seen === undefined
        ? res.status >= 400
        : JSON.stringify(seen.serviceId) === JSON.stringify(SERVICE),
      `status ${res.status}${seen ? `, serviceId ${seen.serviceId.join('/')}, path ${seen.servicePath}` : ''}`,
    );

    const denied = await fetch(`${GATEWAY}${BASE}/hogares/1`, {
      headers: { authorization: `Bearer ${token('otra-app')}`, 'x-rid-purpose': 'x' },
    });
    check('a denied call never reaches the Security Server', denied.status === 403);
  } finally {
    await cleanup();
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exitCode = failed ? 1 : 0;
}

run().catch(async (error) => {
  console.error(error);
  await cleanup().catch(() => {});
  process.exitCode = 1;
});
