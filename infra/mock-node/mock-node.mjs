#!/usr/bin/env node
// Simulated kit node (M4-03). TEST FIXTURE ONLY (ADR-0011): it exercises the portal side of the
// contract (ARCHITECTURE.md §10) end to end in Compose. The real kit is another product.
//
//   1. Waits for an enrollment token (RID_ENROLLMENT_TOKEN, or the file /var/lib/mock-node/token).
//   2. Enrolls: key and CSR with openssl (CN=rid-node), WireGuard keys with wg.
//   3. Brings up wg0 with the configuration it received.
//   4. Serves HTTPS on its tunnel address (servicePort): only the gateway's client certificate
//      for its entity (gatewayClientName, from the network CA) gets in; requests are forwarded
//      to a mock provider (MOCK_NODE_BACKEND).
//   5. Sends a heartbeat every heartbeatIntervalSeconds over the control channel (mTLS).
// State (keys, certificate, tunnel) lives in /var/lib/mock-node, so a restart keeps the node.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { createServer, request as httpsRequest } from 'node:https';

const DIR = '/var/lib/mock-node';
const STATE = `${DIR}/state.json`;
const PORTAL = (process.env.RID_PORTAL_URL ?? 'http://host.docker.internal:4000').replace(
  /\/+$/,
  '',
);
const BACKEND = new URL(process.env.MOCK_NODE_BACKEND ?? 'http://mock-salud:8000');
const SERVICE_PORT = Number(process.env.MOCK_NODE_SERVICE_PORT ?? 8443);
const KIT_VERSION = process.env.MOCK_NODE_KIT_VERSION ?? '0.1.0-mock';
// "afiliacion=/salud,hogares=/socioeconomico"
const SERVICES = (process.env.MOCK_NODE_SERVICES ?? 'afiliacion=/salud')
  .split(',')
  .filter(Boolean)
  .map((s) => {
    const [name, path] = s.split('=');
    return { name, path };
  });
// Where the control channel's host is reachable from this container (the TLS name stays the
// controlUrl's): in development the gateway's certificate is for localhost.
const CONTROL_HOST = process.env.MOCK_NODE_CONTROL_HOST;

const log = (...args) => console.error(new Date().toISOString(), '[mock-node]', ...args);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd, args, input) => execFileSync(cmd, args, { input }).toString().trim();

async function token() {
  for (;;) {
    const value =
      process.env.RID_ENROLLMENT_TOKEN ||
      (existsSync(`${DIR}/token`) ? readFileSync(`${DIR}/token`, 'utf8').trim() : '');
    if (value) return value;
    await sleep(2000);
  }
}

async function enroll() {
  const enrollmentToken = await token();
  sh('openssl', ['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', `${DIR}/node.key`]);
  const csr = sh('openssl', ['req', '-new', '-key', `${DIR}/node.key`, '-subj', '/CN=rid-node']);
  const wgPrivate = sh('wg', ['genkey']);
  const wgPublic = sh('wg', ['pubkey'], wgPrivate);
  const res = await fetch(`${PORTAL}/api/v1/nodes/enroll`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      token: enrollmentToken,
      csr,
      wireguardPublicKey: wgPublic,
      kitVersion: KIT_VERSION,
      servicePort: SERVICE_PORT,
    }),
  });
  const body = await res.json();
  if (res.status !== 201)
    throw new Error(`enrollment failed: ${res.status} ${JSON.stringify(body)}`);
  const state = { ...body, wgPrivate, key: readFileSync(`${DIR}/node.key`, 'utf8') };
  writeFileSync(STATE, JSON.stringify(state), { mode: 0o600 });
  log(`enrolled as ${body.nodeName} at ${body.wireguard.address}`);
  return state;
}

function tunnelUp(state) {
  const w = state.wireguard;
  mkdirSync('/etc/wireguard', { recursive: true });
  writeFileSync(
    '/etc/wireguard/wg0.conf',
    [
      '[Interface]',
      `PrivateKey = ${state.wgPrivate}`,
      `Address = ${w.address}`,
      '',
      '[Peer]',
      `PublicKey = ${w.hubPublicKey}`,
      `Endpoint = ${w.hubEndpoint}`,
      `AllowedIPs = ${w.allowedIps.join(', ')}`,
      `PersistentKeepalive = ${w.persistentKeepaliveSeconds}`,
      '',
    ].join('\n'),
    { mode: 0o600 },
  );
  spawnSync('wg-quick', ['down', 'wg0'], { stdio: 'ignore' });
  const up = spawnSync('wg-quick', ['up', 'wg0'], {
    env: { ...process.env, WG_QUICK_USERSPACE_IMPLEMENTATION: 'wireguard-go' },
    encoding: 'utf8',
  });
  if (up.status !== 0) throw new Error(`wg-quick up failed: ${up.stderr}`);
}

function serve(state) {
  const address = state.wireguard.address.replace(/\/\d+$/, '');
  createServer(
    {
      cert: state.certificate,
      key: state.key,
      ca: state.caCertificate,
      requestCert: true,
      rejectUnauthorized: true,
    },
    (req, res) => {
      // Only the gateway's certificate for this node's entity (M3-03).
      const peer = req.socket.getPeerCertificate();
      if (peer?.subject?.CN !== state.gatewayClientName) {
        res.writeHead(403, { 'content-type': 'application/json' });
        res.end('{"error":"not the gateway"}');
        return;
      }
      // Only the request id, so tests can see the call went through the tunnel; never content.
      log(`forwarding ${req.method} request ${req.headers['x-request-id'] ?? '-'}`);
      const headers = { ...req.headers, host: BACKEND.host };
      const upstream = httpRequest(
        { host: BACKEND.hostname, port: BACKEND.port, path: req.url, method: req.method, headers },
        (answer) => {
          res.writeHead(answer.statusCode ?? 502, answer.headers);
          answer.pipe(res);
        },
      );
      upstream.on('error', () => {
        res.writeHead(502);
        res.end();
      });
      req.pipe(upstream);
    },
  ).listen(SERVICE_PORT, address, () => log(`serving on https://${address}:${SERVICE_PORT}`));
}

function heartbeat(state) {
  const control = new URL(state.controlUrl);
  const body = JSON.stringify({
    kitVersion: KIT_VERSION,
    servicePort: SERVICE_PORT,
    services: SERVICES,
    health: { status: 'ok' },
  });
  return new Promise((resolve) => {
    const req = httpsRequest(
      {
        host: CONTROL_HOST ?? control.hostname,
        servername: control.hostname,
        port: control.port || 443,
        path: `${control.pathname.replace(/\/+$/, '')}/api/v1/nodes/${state.nodeId}/heartbeat`,
        method: 'POST',
        cert: state.certificate,
        key: state.key,
        ca: state.caCertificate,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      },
      (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => {
          log(`heartbeat: ${res.statusCode} ${text}`);
          resolve();
        });
      },
    );
    req.on('error', (error) => {
      log(`heartbeat failed: ${error.message}`);
      resolve();
    });
    req.end(body);
  });
}

mkdirSync(DIR, { recursive: true });
const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : await enroll();
tunnelUp(state);
serve(state);
const every = Number(
  process.env.MOCK_NODE_HEARTBEAT_SECONDS ?? state.heartbeatIntervalSeconds ?? 60,
);
for (;;) {
  await heartbeat(state);
  await sleep(every * 1000);
}
