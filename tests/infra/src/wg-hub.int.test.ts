import { execFileSync, spawnSync } from 'node:child_process';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The WireGuard hub (M4-03, ADR-0023) in disposable containers, apart from the development stack
 * (whose portal reconciles the real hub every minute): a hub on its own Docker network and a
 * peer playing a node. The image is the one `pnpm infra:up` builds (den/wg-hub:dev).
 */
const RUN = randomUUID().slice(0, 8);
const NETWORK = `den-test-wg-${RUN}`;
const HUB = `den-test-wg-hub-${RUN}`;
const PEER = `den-test-wg-peer-${RUN}`;
const TOKEN = `hub-agent-token-${RUN}`;
const NODE_ID = randomUUID();
const NODE_NAME = `den-node-${NODE_ID}`;
const NODE_ADDRESS = '10.77.0.2';

const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8' }).trim();
const keyPair = () => {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  const raw = (v: string | undefined) => Buffer.from(v ?? '', 'base64url').toString('base64');
  return {
    publicKey: raw(publicKey.export({ format: 'jwk' }).x),
    privateKey: raw(privateKey.export({ format: 'jwk' }).d),
  };
};
const hubKeys = keyPair();
const nodeKeys = keyPair();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Runs a command in a container; the exit status and output, never a throw. */
const inside = (container: string, script: string) => {
  const res = spawnSync('docker', ['exec', container, 'sh', '-c', script], { encoding: 'utf8' });
  return { status: res.status, out: `${res.stdout}${res.stderr}`.trim() };
};

describe('WireGuard hub: peers, SNI routing and isolation (M4-03)', () => {
  let agent = '';

  const call = async (method: 'GET' | 'PUT', body?: unknown, token = TOKEN) => {
    const res = await fetch(`${agent}/v1/state`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  beforeAll(async () => {
    docker('network', 'create', NETWORK);
    docker(
      'run',
      '-d',
      '--name',
      HUB,
      '--network',
      NETWORK,
      '--cap-add',
      'NET_ADMIN',
      '--device',
      '/dev/net/tun',
      '--sysctl',
      'net.ipv4.ip_forward=0',
      '-e',
      `DEN_WG_HUB_PRIVATE_KEY=${hubKeys.privateKey}`,
      '-e',
      `DEN_WG_HUB_AGENT_TOKEN=${TOKEN}`,
      '-e',
      'DEN_WG_SUBNET=10.77.0.0/16',
      '-p',
      '127.0.0.1::8090',
      'den/wg-hub:dev',
    );
    agent = `http://${docker('port', HUB, '8090/tcp').split('\n')[0]}`;
    for (let i = 0; i < 60; i += 1) {
      const ok = await fetch(`${agent}/health`).then(
        (r) => r.ok,
        () => false,
      );
      if (ok) break;
      await sleep(500);
    }

    // The peer: a node with its tunnel and an HTTPS listener on its tunnel address.
    docker(
      'run',
      '-d',
      '--name',
      PEER,
      '--network',
      NETWORK,
      '--cap-add',
      'NET_ADMIN',
      '--device',
      '/dev/net/tun',
      // The hub's image has the tools a node needs; not its agent.
      '--entrypoint',
      'sleep',
      'den/wg-hub:dev',
      'infinity',
    );
  }, 120_000);

  afterAll(() => {
    spawnSync('docker', ['rm', '-f', HUB, PEER]);
    spawnSync('docker', ['network', 'rm', NETWORK]);
  });

  it('answers only with its token', async () => {
    expect((await call('GET', undefined, 'otro-token-cualquiera')).status).toBe(401);
    const { status, body } = await call('GET');
    expect(status).toBe(200);
    expect(body).toMatchObject({ publicKey: hubKeys.publicKey, address: '10.77.0.1', peers: [] });
  });

  it('refuses a state with routes outside the tunnel or malformed peers', async () => {
    const bad = [
      { peers: [{ publicKey: 'no-es-una-clave', address: NODE_ADDRESS }], routes: [] },
      { peers: [{ publicKey: nodeKeys.publicKey, address: '10.78.0.2' }], routes: [] },
      { peers: [], routes: [{ name: NODE_NAME, address: NODE_ADDRESS, port: 8443 }] },
      {
        peers: [{ publicKey: nodeKeys.publicKey, address: NODE_ADDRESS }],
        routes: [{ name: 'otro.example.org', address: NODE_ADDRESS, port: 8443 }],
      },
    ];
    for (const state of bad) expect((await call('PUT', state)).status).toBe(400);
  });

  it('takes the desired state whole, the node handshakes and the SNI router reaches it', async () => {
    const state = {
      peers: [{ publicKey: nodeKeys.publicKey, address: NODE_ADDRESS }],
      routes: [{ name: NODE_NAME, address: NODE_ADDRESS, port: 8443 }],
    };
    const put = await call('PUT', state);
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(put.body.routes).toEqual(state.routes);

    // The peer joins as a node would (the configuration its enrollment returns).
    const conf = [
      '[Interface]',
      `PrivateKey = ${nodeKeys.privateKey}`,
      `Address = ${NODE_ADDRESS}/32`,
      '[Peer]',
      `PublicKey = ${hubKeys.publicKey}`,
      `Endpoint = ${HUB}:51820`,
      'AllowedIPs = 10.77.0.1/32',
      'PersistentKeepalive = 1',
    ].join('\n');
    const up = inside(
      PEER,
      `mkdir -p /etc/wireguard && printf '%s\\n' '${conf}' > /etc/wireguard/wg0.conf && ` +
        'WG_QUICK_USERSPACE_IMPLEMENTATION=wireguard-go wg-quick up wg0 >/dev/null 2>&1 && ' +
        // A TLS listener on the tunnel address, standing in for the node's services.
        'apk add -q openssl >/dev/null 2>&1; ' +
        'openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 1 ' +
        `-subj /CN=${NODE_NAME} -keyout /tmp/k -out /tmp/c >/dev/null 2>&1 && ` +
        `(openssl s_server -quiet -accept ${NODE_ADDRESS}:8443 -cert /tmp/c -key /tmp/k -www ` +
        '>/dev/null 2>&1 &) && echo up',
    );
    expect(up.out).toContain('up');

    let handshake: unknown = null;
    for (let i = 0; i < 40 && !handshake; i += 1) {
      const peers = (await call('GET')).body.peers as Array<{ latestHandshake: string | null }>;
      handshake = peers[0]?.latestHandshake ?? null;
      if (!handshake) await sleep(500);
    }
    expect(handshake).not.toBeNull();

    // From the platform side, a TLS connection with the node's name as SNI reaches the node.
    let reached = '';
    for (let i = 0; i < 20 && !reached.includes(NODE_NAME); i += 1) {
      reached = inside(
        HUB,
        `apk add -q openssl >/dev/null 2>&1; echo | timeout 5 openssl s_client -connect 127.0.0.1:8443 ` +
          `-servername ${NODE_NAME} 2>/dev/null | grep subject=`,
      ).out;
      if (!reached.includes(NODE_NAME)) await sleep(500);
    }
    expect(reached).toContain(NODE_NAME);
  });

  it('an unknown name goes nowhere', () => {
    const res = inside(
      HUB,
      `echo | timeout 5 openssl s_client -connect 127.0.0.1:8443 -servername den-node-${randomUUID()} 2>&1`,
    );
    expect(res.out).not.toContain('subject=');
  });

  it('a node cannot open anything towards the hub, nor reach other networks', () => {
    // New connections from the tunnel are dropped: the SNI router and the agent are not reachable.
    for (const port of [8443, 8090]) {
      const res = inside(
        PEER,
        `timeout 3 nc -z -w 2 10.77.0.1 ${port} && echo open || echo closed`,
      );
      expect(res.out, `port ${port}`).toContain('closed');
    }
    expect(inside(HUB, 'cat /proc/sys/net/ipv4/ip_forward').out).toBe('0');
  });

  it('a removed node loses its peer and its route', async () => {
    const put = await call('PUT', { peers: [], routes: [] });
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({ peers: [], routes: [] });
  });
});
