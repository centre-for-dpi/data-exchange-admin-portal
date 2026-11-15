import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TLSSocket } from 'node:tls';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeKeyAndCsr } from '../../../test/csr.js';
import { createTestApp, createTestIssuer } from '../../../test/test-auth.js';
import { CERTIFICATE_AUTHORITY, StepCaClient } from '../../credentials/step-ca.client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { HttpApisixAdmin } from './apisix-admin.js';
import { APISIX_SETTINGS, ApisixReconciler } from './apisix.reconciler.js';
import {
  desiredGateway,
  GATEWAY_CLIENT_SSL_ID,
  type GatewaySettings,
  parseDevNodes,
} from './desired-state.js';

const HTTP_PORT = Number(process.env.APISIX_HTTP_PORT ?? 9080);
// Outside the reconciler's rid- prefix: its orphan cleanup leaves them alone.
const ROUTE = 'test-m3-03-upstream';
const UPSTREAM = 'test-m3-03-upstream';
const PATH = '/__rid_m3_03__';
// How APISIX, in its container, reaches a server on the host.
const HOST = 'host.docker.internal';

interface Seen {
  cn?: string;
  host?: string;
  path?: string;
}

/** A provider's service on the host that requires a client certificate of the network CA. */
function mtlsServer(options: { cert: string; key: string; ca: string }): Promise<Server> {
  const server = createServer(
    { ...options, requestCert: true, rejectUnauthorized: true },
    (req, res) => {
      const peer = (req.socket as TLSSocket).getPeerCertificate();
      const body: Seen = {
        cn: [peer.subject?.CN].flat()[0],
        host: req.headers.host,
        path: req.url,
      };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(body));
    },
  );
  return new Promise((resolve) => server.listen(0, '0.0.0.0', () => resolve(server)));
}

const portOf = (server: Server) => (server.address() as AddressInfo).port;

/**
 * The gateway towards upstreams with mTLS (M3-03), against the real APISIX and step-ca: the
 * gateway presents its client certificate (CN=rid-gateway) and verifies the node's certificate
 * against the network CA, for the node's name.
 */
describe('mTLS towards upstreams (M3-03)', () => {
  const prisma = new PrismaService();
  const admin = new HttpApisixAdmin({
    baseUrl: process.env.APISIX_ADMIN_URL ?? 'http://localhost:9180',
    apiKey: process.env.APISIX_ADMIN_KEY ?? '',
  });
  const ca = new StepCaClient();
  const servers: Server[] = [];
  let settings: GatewaySettings;
  let app: NestFastifyApplication;
  let reconciler: ApisixReconciler;
  let root = '';
  let chain = '';

  const serverCertificate = async () => {
    const { csr, keyPem } = await makeKeyAndCsr(HOST, { dnsNames: [HOST] });
    const cert = await ca.sign({
      csrPem: csr,
      commonName: HOST,
      sans: [HOST],
      profile: 'gateway-server',
      validityHours: 1,
    });
    return { cert, key: keyPem };
  };

  /** Puts the upstream the reconciler would build for a node at `port`, and a route to it. */
  const route = async (port: number, change?: (upstream: Record<string, unknown>) => void) => {
    const nodeSettings = { ...settings, devNodes: parseDevNodes(`salud=https://${HOST}:${port}`) };
    const pki = await reconciler.reconcileClientTls();
    const { upstream } = desiredGateway(
      {
        id: randomUUID(),
        basePath: '/salud/m3-03/v1',
        upstream: { type: 'node', servicePath: '/servicio' },
        methods: ['GET'],
        bodySubjects: [],
        hasDataSubjects: false,
        entitySlug: 'salud',
        apiName: 'M3-03',
        version: '1.0',
      },
      nodeSettings,
      pki,
    );
    change?.(upstream);
    await admin.put('upstreams', UPSTREAM, { ...upstream, labels: {} });
    await admin.put('routes', ROUTE, {
      uri: `${PATH}/*`,
      methods: ['GET'],
      upstream_id: UPSTREAM,
      plugins: { 'proxy-rewrite': { regex_uri: [`^${PATH}/(.*)$`, '/servicio/$1'] } },
    });
  };

  const call = async (): Promise<{ status: number; seen?: Seen }> => {
    // APISIX applies the configuration from etcd within moments.
    let last = { status: 0 } as { status: number; seen?: Seen };
    for (let i = 0; i < 20; i += 1) {
      const res = await fetch(`http://127.0.0.1:${HTTP_PORT}${PATH}/consulta`);
      last = {
        status: res.status,
        ...(res.status === 200 ? { seen: (await res.json()) as Seen } : {}),
      };
      if (res.status !== 404) return last;
      await new Promise((r) => setTimeout(r, 250));
    }
    return last;
  };

  beforeAll(async () => {
    settings = {
      keycloakDiscoveryUrl:
        'http://keycloak:8080/realms/rid-gateway/.well-known/openid-configuration',
      audience: 'rid-gateway',
      opaUrl: 'http://opa:8181',
      accessLogUrl: 'http://fluent-bit:9880/',
      transparencyLog: { host: 'fluent-bit-transparency', port: 5170 },
      devNodes: parseDevNodes(''),
      resolveHost: () => Promise.resolve(['93.184.215.14']),
      tls: { hosts: ['localhost'], mtlsRequired: false, clientName: 'rid-gateway' },
    };
    app = await createTestApp(await createTestIssuer(), [
      { token: APISIX_SETTINGS, value: settings },
      { token: CERTIFICATE_AUTHORITY, value: ca },
    ]);
    reconciler = app.get(ApisixReconciler);
    root = await ca.rootCertificate();
    const { networkCaPem } = await reconciler.reconcileClientTls();
    chain = networkCaPem;
    expect(chain).toContain(root.trim());
  });

  afterAll(async () => {
    await admin.delete('routes', ROUTE);
    await admin.delete('upstreams', UPSTREAM).catch(() => undefined);
    for (const server of servers) server.close();
    await app.close();
    await prisma.$disconnect();
  });

  it('keeps the gateway client certificate in an SSL object of type client', async () => {
    await reconciler.reconcileClientTls();
    const ssl = await admin.get('ssls', GATEWAY_CLIENT_SSL_ID);
    expect(ssl).toMatchObject({ type: 'client' });
    const row = await prisma.gatewayCertificate.findFirstOrThrow({
      where: { purpose: 'upstream_client' },
      orderBy: { createdAt: 'desc' },
    });
    expect(row.hosts).toEqual(['rid-gateway']);
    expect(
      await prisma.auditEvent.count({
        where: { targetId: row.id, action: 'gateway_certificate.issued' },
      }),
    ).toBe(1);
  });

  it('presents CN=rid-gateway to a node that requires mTLS, with the node name as Host', async () => {
    const server = await mtlsServer({ ...(await serverCertificate()), ca: chain });
    servers.push(server);
    await route(portOf(server));
    const outcome = await call();
    expect(outcome.status).toBe(200);
    expect(outcome.seen).toEqual({
      cn: 'rid-gateway',
      host: HOST,
      path: '/servicio/consulta',
    });
  });

  it('without the client certificate the node refuses the gateway (502)', async () => {
    const server = await mtlsServer({ ...(await serverCertificate()), ca: chain });
    servers.push(server);
    await route(portOf(server), (upstream) => {
      const tls = upstream.tls as Record<string, unknown>;
      delete tls.client_cert_id;
    });
    expect((await call()).status).toBe(502);
  });

  it('refuses a node whose certificate the network CA did not issue (502)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rid-m3-03-'));
    try {
      const { keyPem } = await makeKeyAndCsr(HOST);
      writeFileSync(join(dir, 'key.pem'), keyPem);
      const selfSigned = execFileSync(
        'openssl',
        [
          'req',
          '-x509',
          '-key',
          join(dir, 'key.pem'),
          '-subj',
          `/CN=${HOST}`,
          '-addext',
          `subjectAltName=DNS:${HOST}`,
          '-days',
          '1',
        ],
        { encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' } },
      );
      const server = await mtlsServer({ cert: selfSigned, key: keyPem, ca: chain });
      servers.push(server);
      await route(portOf(server));
      expect((await call()).status).toBe(502);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
