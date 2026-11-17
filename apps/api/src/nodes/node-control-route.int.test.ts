import { generateKeyPairSync, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { request as httpsRequest } from 'node:https';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { issuedEnrollmentTokenSchema, nodeEnrollmentSchema } from '@rid/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeKeyAndCsr } from '../../test/csr.js';
import { createTestApp, createTestIssuer, type TestIssuer } from '../../test/test-auth.js';
import { MAIL_TRANSPORT } from '../mail/mail.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { HttpApisixAdmin } from '../reconcilers/apisix/apisix-admin.js';
import { ApisixReconciler } from '../reconcilers/apisix/apisix.reconciler.js';
import {
  desiredNodeControlRoute,
  type GatewaySettings,
  parseDevNodes,
} from '../reconcilers/apisix/desired-state.js';
import { StepCaClient } from '../credentials/step-ca.client.js';

const HTTPS_PORT = Number(process.env.APISIX_HTTPS_PORT ?? 9443);
const HTTP_PORT = Number(process.env.APISIX_HTTP_PORT ?? 9080);
const CONTROL_TOKEN = `m4-02-route-${randomUUID()}`;
// Outside the reconciler's ids; a higher priority than the real control route on the same path.
const ROUTE = 'test-m4-02-node-control';

const wireguardKey = (): string => {
  const { x } = generateKeyPairSync('x25519').publicKey.export({ format: 'jwk' });
  return Buffer.from(x ?? '', 'base64url').toString('base64');
};

interface Answer {
  status: number;
  body: Record<string, unknown>;
}

/**
 * The control channel of kit nodes through the real APISIX (M4-02): TLS with the node's
 * certificate ends at the gateway's control route, which hands the portal the verified
 * thumbprint and the control token. The portal here is the API under test, listening on the
 * host; the node certificate comes from the real step-ca through enrollment.
 */
describe('node control route of the gateway (M4-02)', () => {
  const prisma = new PrismaService();
  const admin = new HttpApisixAdmin({
    baseUrl: process.env.APISIX_ADMIN_URL ?? 'http://localhost:9180',
    apiKey: process.env.APISIX_ADMIN_KEY ?? '',
  });
  let app: NestFastifyApplication;
  let issuer: TestIssuer;
  let root = '';
  let node: { id: string; cert: string; key: string };
  const saved: Record<string, string | undefined> = {};

  const settings = (portalUrl: string): GatewaySettings => ({
    keycloakDiscoveryUrl:
      'http://keycloak:8080/realms/rid-gateway/.well-known/openid-configuration',
    audience: 'rid-gateway',
    opaUrl: 'http://opa:8181',
    accessLogUrl: 'http://fluent-bit:9880/',
    transparencyLog: { host: 'fluent-bit-transparency', port: 5170 },
    devNodes: parseDevNodes(''),
    resolveHost: () => Promise.resolve([]),
    tls: { hosts: ['localhost'], mtlsRequired: true, clientName: 'rid-gateway' },
    nodeControl: { portalUrl, token: CONTROL_TOKEN },
  });

  beforeAll(async () => {
    for (const [k, v] of Object.entries({
      RID_WG_HUB_PUBLIC_KEY: wireguardKey(),
      RID_WG_HUB_ENDPOINT: 'wg-hub:51820',
      RID_NODE_CONTROL_TOKEN: CONTROL_TOKEN,
    })) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
    issuer = await createTestIssuer();
    app = await createTestApp(issuer, [
      { token: MAIL_TRANSPORT, value: { send: () => Promise.resolve() } },
    ]);
    await app.listen(0, '0.0.0.0');
    const port = (app.getHttpServer().address() as AddressInfo).port;
    root = await new StepCaClient().rootCertificate();

    // The gateway's SSL object as the country wants it (co.yaml: network-wide mTLS), whatever an
    // earlier test file left in the shared APISIX.
    await app.get(ApisixReconciler).reconcileTls();

    const route = desiredNodeControlRoute(settings(`http://host.docker.internal:${port}`));
    await admin.put('routes', ROUTE, { ...route, priority: 10, name: 'M4-02 test' });

    // A node of a new entity, enrolled with its token.
    const id = randomUUID().slice(0, 8);
    const entity = await prisma.entity.create({
      data: {
        legalName: `Entidad ruta ${id}`,
        shortName: `R ${id}`,
        slug: `ruta-${id}`,
        taxIdType: 'NIT',
        taxId: `4${id}`,
        kind: 'national',
        sector: 'salud',
        status: 'active',
        contactEmail: `c.${id}@example.org`,
        dpoName: 'Dora',
        dpoEmail: `d.${id}@example.org`,
        createdBy: 'test',
      },
    });
    const who = { sub: randomUUID(), email: `admin.${id}@example.org` };
    const bearer = `Bearer ${await issuer.token(who.sub, { email: who.email, name: who.email, emailVerified: true })}`;
    await app.inject({ method: 'GET', url: '/api/v1/me', headers: { authorization: bearer } });
    const user = await prisma.user.findUniqueOrThrow({ where: { keycloakSub: who.sub } });
    await prisma.membership.create({
      data: {
        userId: user.id,
        entityId: entity.id,
        roles: ['entity_admin'],
        status: 'active',
        createdBy: 'test',
      },
    });
    const created = issuedEnrollmentTokenSchema.parse(
      (
        await app.inject({
          method: 'POST',
          url: `/api/v1/entities/${entity.id}/nodes`,
          headers: { authorization: bearer },
          payload: { name: 'nodo-ruta' },
        })
      ).json(),
    );
    const { csr, keyPem } = await makeKeyAndCsr('rid-node');
    const enrolled = await app.inject({
      method: 'POST',
      url: '/api/v1/nodes/enroll',
      payload: {
        token: created.token,
        csr,
        wireguardPublicKey: wireguardKey(),
        kitVersion: '1.0.0',
      },
    });
    expect(enrolled.statusCode, enrolled.body).toBe(201);
    const body = nodeEnrollmentSchema.parse(enrolled.json());
    node = { id: body.nodeId, cert: body.certificate, key: keyPem };

    // APISIX applies the route within a second or two.
    for (let i = 0; i < 40; i += 1) {
      const res = await fetch(`http://127.0.0.1:${HTTP_PORT}/api/v1/nodes/${node.id}/config`);
      if (res.status !== 404) break;
      await new Promise((r) => setTimeout(r, 250));
    }
  });

  afterAll(async () => {
    await admin.delete('routes', ROUTE);
    await app.close();
    await prisma.$disconnect();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  const overTls = (
    path: string,
    client: { cert: string; key: string } | undefined,
    options: { method?: string; body?: object; headers?: Record<string, string> } = {},
  ): Promise<Answer> =>
    new Promise((resolve, reject) => {
      const payload = options.body ? JSON.stringify(options.body) : undefined;
      const req = httpsRequest(
        {
          host: '127.0.0.1',
          port: HTTPS_PORT,
          servername: 'localhost',
          path,
          method: options.method ?? 'GET',
          ca: root,
          agent: false,
          headers: {
            ...(payload ? { 'content-type': 'application/json' } : {}),
            ...options.headers,
          },
          ...(client ?? {}),
        },
        (res) => {
          let text = '';
          res.on('data', (chunk: Buffer) => (text += chunk.toString()));
          res.on('end', () => {
            let body: Record<string, unknown>;
            try {
              body = JSON.parse(text || '{}') as Record<string, unknown>;
            } catch {
              body = { text };
            }
            resolve({ status: res.statusCode ?? 0, body });
          });
        },
      );
      req.on('error', reject);
      req.end(payload);
    });

  const heartbeat = {
    kitVersion: '1.0.0',
    servicePort: 8443,
    services: [{ name: 'afiliacion', path: '/salud' }],
    health: { status: 'ok' },
  };

  it('a node with its certificate sends a heartbeat through the gateway and comes online', async () => {
    const res = await overTls(`/api/v1/nodes/${node.id}/heartbeat`, node, {
      method: 'POST',
      body: heartbeat,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.status).toBe('online');
    const config = await overTls(`/api/v1/nodes/${node.id}/config`, node);
    expect(config.status).toBe(200);
    expect(config.body.nodeId).toBe(node.id);
  });

  it('forged control headers sent by the node change nothing', async () => {
    const res = await overTls(`/api/v1/nodes/${node.id}/config`, node, {
      headers: {
        'X-RID-Node-Control': 'token-falso',
        'X-RID-Client-Cert-S256': 'huella-falsa',
        X_RID_Client_Cert_S256: 'huella-falsa',
      },
    });
    expect(res.status).toBe(200);
  });

  it('another certificate of the network does not open the node', async () => {
    const { csr, keyPem } = await makeKeyAndCsr('rid-app-intruso');
    const cert = await new StepCaClient().sign({
      csrPem: csr,
      commonName: 'rid-app-intruso',
      validityHours: 1,
    });
    const res = await overTls(`/api/v1/nodes/${node.id}/config`, { cert, key: keyPem });
    expect(res.status).toBe(401);
  });

  it('without TLS nobody can claim a certificate, not even with the right headers', async () => {
    const res = await fetch(`http://127.0.0.1:${HTTP_PORT}/api/v1/nodes/${node.id}/config`, {
      headers: { 'X-RID-Node-Control': CONTROL_TOKEN, 'X-RID-Client-Cert-S256': 'x' },
    });
    expect(res.status).toBe(401);
  });

  it('without a client certificate there is no TLS session (network-wide mTLS)', async () => {
    // APISIX applies the SSL object of beforeAll within a moment.
    let refused = false;
    for (let i = 0; i < 20 && !refused; i += 1) {
      refused = await overTls(`/api/v1/nodes/${node.id}/config`, undefined).then(
        () => false,
        () => true,
      );
      if (!refused) await new Promise((r) => setTimeout(r, 250));
    }
    expect(refused).toBe(true);
  });
});
