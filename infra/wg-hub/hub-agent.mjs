#!/usr/bin/env node
// Agent of the WireGuard hub (M4-03, ADR-0023). Brings up wg0 on the first address of
// RID_WG_SUBNET, closes the tunnel to anything new coming from the nodes, routes TLS connections
// to the nodes by SNI with nginx stream, and serves the desired-state API the portal's reconciler
// uses (internal network only, bearer RID_WG_HUB_AGENT_TOKEN):
//   GET  /health           liveness, no token
//   GET  /v1/state         { publicKey, listenPort, peers: [...], routes: [...] }
//   PUT  /v1/state         { peers: [{ publicKey, address }], routes: [{ name, address, port }] }
// PUT replaces the whole state (wg syncconf + nginx reload): idempotent. The last applied state is
// kept in /var/lib/wg-hub so a restart serves the nodes before the next reconcile.
import { execFileSync, spawnSync } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { isIPv4 } from 'node:net';

const STATE_DIR = '/var/lib/wg-hub';
const STATE_FILE = `${STATE_DIR}/state.json`;
const WG_CONF = '/etc/wireguard/wg0.conf';
const NGINX_CONF = '/etc/nginx/nginx.conf';
const ROUTES_MAP = '/etc/nginx/rid-nodes.map';
const LISTEN_PORT = Number(process.env.RID_WG_LISTEN_PORT ?? 51820);
const AGENT_PORT = Number(process.env.RID_WG_HUB_AGENT_PORT ?? 8090);
const SNI_PORT = Number(process.env.RID_WG_HUB_SNI_PORT ?? 8443);
const TOKEN = process.env.RID_WG_HUB_AGENT_TOKEN ?? '';
const PRIVATE_KEY = process.env.RID_WG_HUB_PRIVATE_KEY ?? '';

const KEY = /^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/;
const NODE_NAME = /^rid-node-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// The container log (stderr): no content, only what the hub did.
const log = (...args) => console.error(new Date().toISOString(), ...args);
const run = (cmd, args, input) =>
  execFileSync(cmd, args, { input, stdio: ['pipe', 'pipe', 'pipe'] }).toString();
/** nginx keeps the container's stderr for its own log once it daemonizes. */
const nginx = (args) => execFileSync('nginx', args, { stdio: ['ignore', 'inherit', 'inherit'] });

// --- Subnet -------------------------------------------------------------------------------------

const toInt = (ip) => ip.split('.').reduce((acc, o) => acc * 256 + Number(o), 0);
const toIp = (n) => [24, 16, 8, 0].map((s) => Math.floor(n / 2 ** s) % 256).join('.');
const [subnetIp, subnetBits] = (process.env.RID_WG_SUBNET ?? '10.77.0.0/16').split('/');
const prefix = Number(subnetBits);
const size = 2 ** (32 - prefix);
const network = toInt(subnetIp) - (toInt(subnetIp) % size);
const hubAddress = toIp(network + 1);
const inSubnet = (ip) => isIPv4(ip) && toInt(ip) > network + 1 && toInt(ip) < network + size - 1;

// --- Validation of the desired state ------------------------------------------------------------

function parseState(body) {
  const problems = [];
  const peers = Array.isArray(body?.peers) ? body.peers : (problems.push('peers'), []);
  const routes = Array.isArray(body?.routes) ? body.routes : (problems.push('routes'), []);
  const seenKeys = new Set();
  const seenAddresses = new Set();
  for (const p of peers) {
    if (!KEY.test(p?.publicKey ?? '') || seenKeys.has(p.publicKey)) problems.push('peer key');
    if (!inSubnet(p?.address ?? '') || seenAddresses.has(p.address)) problems.push('peer address');
    seenKeys.add(p?.publicKey);
    seenAddresses.add(p?.address);
  }
  for (const r of routes) {
    if (!NODE_NAME.test(r?.name ?? '')) problems.push('route name');
    // A route only to a node that is a peer: the SNI never leads outside the tunnel.
    if (!seenAddresses.has(r?.address)) problems.push('route address');
    if (!Number.isInteger(r?.port) || r.port < 1 || r.port > 65535) problems.push('route port');
  }
  if (problems.length) throw new Error(`invalid state: ${[...new Set(problems)].join(', ')}`);
  const sortBy = (k) => (a, b) => (a[k] < b[k] ? -1 : a[k] > b[k] ? 1 : 0);
  return {
    peers: peers
      .map((p) => ({ publicKey: p.publicKey, address: p.address }))
      .sort(sortBy('publicKey')),
    routes: routes
      .map((r) => ({ name: r.name, address: r.address, port: r.port }))
      .sort(sortBy('name')),
  };
}

// --- WireGuard, firewall, nginx -----------------------------------------------------------------

function interfaceConf(peers) {
  const lines = ['[Interface]', `PrivateKey = ${PRIVATE_KEY}`, `ListenPort = ${LISTEN_PORT}`, ''];
  for (const p of peers)
    lines.push('[Peer]', `PublicKey = ${p.publicKey}`, `AllowedIPs = ${p.address}/32`, '');
  return lines.join('\n');
}

function bringUp() {
  if (!KEY.test(PRIVATE_KEY)) {
    throw new Error('RID_WG_HUB_PRIVATE_KEY must be a WireGuard private key (base64, 32 bytes)');
  }
  if (!TOKEN || TOKEN.length < 16)
    throw new Error('RID_WG_HUB_AGENT_TOKEN must be set (16+ chars)');
  mkdirSync('/etc/wireguard', { recursive: true });
  writeFileSync(
    WG_CONF,
    [
      `[Interface]`,
      `PrivateKey = ${PRIVATE_KEY}`,
      `Address = ${hubAddress}/${prefix}`,
      `ListenPort = ${LISTEN_PORT}`,
      '',
    ].join('\n'),
    { mode: 0o600 },
  );
  spawnSync('wg-quick', ['down', 'wg0'], { stdio: 'ignore' });
  // Kernel WireGuard when the host has it; wireguard-go otherwise (wg-quick picks it).
  const up = spawnSync('wg-quick', ['up', 'wg0'], {
    env: { ...process.env, WG_QUICK_USERSPACE_IMPLEMENTATION: 'wireguard-go' },
    encoding: 'utf8',
  });
  if (up.status !== 0) throw new Error(`wg-quick up failed: ${up.stderr}`);
  // Nothing new from the nodes: they only answer connections the hub opened (ADR-0023).
  for (const args of [
    ['-P', 'FORWARD', 'DROP'],
    [
      '-A',
      'INPUT',
      '-i',
      'wg0',
      '-m',
      'conntrack',
      '--ctstate',
      'ESTABLISHED,RELATED',
      '-j',
      'ACCEPT',
    ],
    ['-A', 'INPUT', '-i', 'wg0', '-j', 'DROP'],
  ]) {
    run('iptables', args);
  }
  const forwarding = readFileSync('/proc/sys/net/ipv4/ip_forward', 'utf8').trim();
  if (forwarding !== '0') log('warning: net.ipv4.ip_forward is not 0; the hub never forwards');
  writeFileSync(
    NGINX_CONF,
    `# Generated by hub-agent.mjs (ADR-0023). No http block: only the SNI router.
include /etc/nginx/modules/*.conf;
worker_processes 1;
pid /run/nginx.pid;
error_log stderr warn;
events { worker_connections 4096; }
stream {
  map $ssl_preread_server_name $rid_node {
    include ${ROUTES_MAP};
    default 127.0.0.1:9;
  }
  server {
    listen ${SNI_PORT};
    ssl_preread on;
    proxy_pass $rid_node;
    proxy_connect_timeout 5s;
  }
}
`,
  );
  writeFileSync(ROUTES_MAP, '');
  mkdirSync('/run/nginx', { recursive: true });
  nginx([]);
}

function apply(state) {
  const tmp = '/tmp/wg0.sync.conf';
  writeFileSync(tmp, interfaceConf(state.peers), { mode: 0o600 });
  run('wg', ['syncconf', 'wg0', tmp]);
  const map = state.routes.map((r) => `${r.name} ${r.address}:${r.port};`).join('\n');
  writeFileSync(ROUTES_MAP, map ? `${map}\n` : '');
  nginx(['-s', 'reload']);
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state));
}

function actual() {
  const lines = run('wg', ['show', 'wg0', 'dump']).trim().split('\n');
  const [iface, ...rest] = lines;
  const publicKey = iface?.split('\t')[1] ?? '';
  const peers = rest.filter(Boolean).map((line) => {
    const [key, , endpoint, allowed, handshake, rx, tx] = line.split('\t');
    return {
      publicKey: key,
      address: (allowed ?? '').split(',')[0]?.replace('/32', '') ?? '',
      endpoint: endpoint === '(none)' ? null : endpoint,
      latestHandshake:
        Number(handshake) > 0 ? new Date(Number(handshake) * 1000).toISOString() : null,
      rxBytes: Number(rx),
      txBytes: Number(tx),
    };
  });
  const routes = readFileSync(ROUTES_MAP, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name, target] = line.replace(/;$/, '').split(' ');
      const [address, port] = (target ?? '').split(':');
      return { name, address, port: Number(port) };
    });
  return { publicKey, address: hubAddress, listenPort: LISTEN_PORT, peers, routes };
}

// --- HTTP API -----------------------------------------------------------------------------------

const authorized = (req) => {
  const given = Buffer.from((req.headers.authorization ?? '').replace(/^Bearer /, ''));
  const expected = Buffer.from(TOKEN);
  return given.length === expected.length && timingSafeEqual(given, expected);
};

const send = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};

function serve() {
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') return send(res, 200, { status: 'ok' });
    if (!authorized(req)) return send(res, 401, { error: 'unauthorized' });
    if (req.method === 'GET' && req.url === '/v1/state') return send(res, 200, actual());
    if (req.method === 'PUT' && req.url === '/v1/state') {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
        if (raw.length > 4_000_000) req.destroy();
      });
      req.on('end', () => {
        try {
          const state = parseState(JSON.parse(raw));
          apply(state);
          log(`applied ${state.peers.length} peers, ${state.routes.length} routes`);
          send(res, 200, actual());
        } catch (error) {
          send(res, 400, { error: String(error.message ?? error) });
        }
      });
      return undefined;
    }
    return send(res, 404, { error: 'not found' });
  });
  // Longer than the clients' idle sockets, so a reused connection is never closed under them.
  server.keepAliveTimeout = 65_000;
  server.listen(AGENT_PORT, '0.0.0.0', () => log(`hub agent on :${AGENT_PORT}`));
}

bringUp();
if (existsSync(STATE_FILE)) {
  try {
    apply(parseState(JSON.parse(readFileSync(STATE_FILE, 'utf8'))));
    log('restored the last applied state');
  } catch (error) {
    log(`could not restore the last state: ${error.message}`);
  }
}
log(`wg0 up at ${hubAddress}/${prefix}, UDP ${LISTEN_PORT}; SNI router on :${SNI_PORT}`);
serve();
