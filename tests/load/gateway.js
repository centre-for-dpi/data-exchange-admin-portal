// Load test of the gateway (M6-03): RATE requests per second for DURATION through the full chain
// of a production route — mTLS, a token bound to the certificate, OPA, rate limit, access log —
// to the provider's test service. Run by scripts/load-test.mjs, which prepares the application,
// its certificate and its subscription, and measures the gateway's own latency in Prometheus.
//
// k6 (AGPL-3.0) runs in its own container (grafana/k6), never linked into our code (CLAUDE.md,
// rule 1). Every input comes from the environment:
//   GATEWAY      https://host:port of the gateway, as the application sees it
//   GATEWAY_IP   the address of that host from inside the container (k6 `hosts`)
//   CLIENT_ID, CLIENT_SECRET, CERT_FILE, KEY_FILE   the application's credentials
//   PATH_TEMPLATE  the call's path, with {n} for a varying identifier
//   PURPOSE, RATE, DURATION, WARMUP
/* global __ENV, __VU, open -- provided by k6 */
import { check } from 'k6';
import encoding from 'k6/encoding';
import http from 'k6/http';
import { Counter } from 'k6/metrics';

const env = (name, fallback) => __ENV[name] ?? fallback;
// k6 has no URL global: scheme://host[:port] by hand.
const [, scheme, host, port] = /^(https?):\/\/([^:/]+)(?::(\d+))?/.exec(
  env('GATEWAY', 'https://localhost:9443'),
);
const gateway = { hostname: host, origin: `${scheme}://${host}${port ? `:${port}` : ''}` };
const RATE = Number(env('RATE', '500'));
const DURATION = env('DURATION', '5m');
const WARMUP = env('WARMUP', '30s');
const denied = new Counter('den_denied');

export const options = {
  hosts: env('GATEWAY_IP', '') ? { [gateway.hostname]: env('GATEWAY_IP') } : {},
  // The gateway's certificate is issued by the network CA, which k6 cannot be given as a root:
  // the server is not verified here; the client certificate is what the test is about.
  insecureSkipTLSVerify: true,
  tlsAuth: [
    {
      // k6 warns that `domains` may go away, but without it k6 matches the certificate's own
      // names (its CN is the client id), never presents it, and mTLS refuses the session.
      domains: [gateway.hostname],
      cert: open(env('CERT_FILE', '/load/app.crt')),
      key: open(env('KEY_FILE', '/load/app.key')),
    },
  ],
  discardResponseBodies: true,
  scenarios: {
    warmup: {
      executor: 'constant-arrival-rate',
      rate: Math.max(1, Math.round(RATE / 5)),
      timeUnit: '1s',
      duration: WARMUP,
      preAllocatedVUs: 20,
      maxVUs: 200,
      tags: { phase: 'warmup' },
    },
    sustained: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: DURATION,
      startTime: WARMUP,
      preAllocatedVUs: 100,
      maxVUs: 1000,
      tags: { phase: 'sustained' },
    },
  },
  // What the client sees includes the host's port forwarding and the provider: the gateway's
  // own share is measured in Prometheus by scripts/load-test.mjs.
  thresholds: {
    'http_req_failed{phase:sustained}': ['rate<0.01'],
    'checks{phase:sustained}': ['rate>0.99'],
    'dropped_iterations{scenario:sustained}': [`count<${Math.ceil(RATE * 0.01)}`],
    // Not a limit: puts the calls of the sustained phase in the summary, for the achieved rate.
    'http_reqs{phase:sustained,name:call}': ['count>0'],
  },
  summaryTrendStats: ['avg', 'p(50)', 'p(95)', 'p(99)', 'max'],
};

// DEBUG=1: the first failures of each VU, to tell the gateway's answers from network errors.
let failuresShown = 0;
const showFailure = (what, res) => {
  if (!env('DEBUG', '') || failuresShown >= 3) return;
  failuresShown += 1;
  console.warn(`${what}: status ${res.status} error_code ${res.error_code} ${res.error}`);
};

// One token per VU, renewed before its 5 minutes are up.
let token = '';
let tokenAt = 0;
const TOKEN_TTL_MS = 4 * 60 * 1000;

function currentToken() {
  if (token && Date.now() - tokenAt < TOKEN_TTL_MS) return token;
  const basic = encoding.b64encode(`${env('CLIENT_ID')}:${env('CLIENT_SECRET')}`);
  const res = http.post(`${gateway.origin}/oauth/token`, 'grant_type=client_credentials', {
    headers: {
      authorization: `Basic ${basic}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    responseType: 'text',
    tags: { name: 'token' },
  });
  if (res.status !== 200) {
    showFailure('token', res);
    throw new Error(`token: ${res.status}`);
  }
  token = res.json('access_token');
  tokenAt = Date.now();
  return token;
}

export default function () {
  // A different person per call, as in real traffic: one of the 1,000 people the provider's test
  // service has (infra/mock-providers: FIRST_ID and PERSON_COUNT).
  const n = String(Number(env('FIRST_PERSON', '1000000001')) + Math.floor(Math.random() * 1000));
  const res = http.get(`${gateway.origin}${env('PATH_TEMPLATE').replace('{n}', n)}`, {
    headers: {
      authorization: `Bearer ${currentToken()}`,
      'x-den-purpose': env('PURPOSE', 'eligibility_check'),
      'x-den-end-user': `funcionario-carga-${__VU}`,
    },
    tags: { name: 'call' },
  });
  // A denial of the gateway carries X-DEN-Deny-Reason.
  const reason = res.headers['X-Den-Deny-Reason'];
  if (reason) denied.add(1, { reason });
  if (res.status !== 200) showFailure('call', res);
  check(res, { 'allowed and answered': (r) => !reason && r.status === 200 });
}

export function handleSummary(data) {
  return { [env('SUMMARY_FILE', '/load/summary.json')]: JSON.stringify(data) };
}
