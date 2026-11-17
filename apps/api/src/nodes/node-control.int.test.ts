import { createHash, generateKeyPairSync, randomUUID, X509Certificate } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  issuedEnrollmentTokenSchema,
  nodeConfigSchema,
  nodeDetailSchema,
  nodeEnrollmentSchema,
  nodeHeartbeatResponseSchema,
  renewedNodeCertificateSchema,
} from '@den/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeCsr } from '../../test/csr.js';
import { createTestApp, createTestIssuer, type TestIssuer } from '../../test/test-auth.js';
import { MAIL_TRANSPORT } from '../mail/mail.service.js';
import { NOTIFICATION_TOPIC } from '../notifications/notifying-actions.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { NodeControlService } from './node-control.service.js';

const CONTROL_TOKEN = 'm4-02-control-token-0123456789abcdef';

/** A WireGuard key pair's public half, as `wg pubkey` prints it. */
const wireguardKey = (): string => {
  const { publicKey } = generateKeyPairSync('x25519');
  const { x } = publicKey.export({ format: 'jwk' });
  return Buffer.from(x ?? '', 'base64url').toString('base64');
};
const thumbprint = (pem: string): string =>
  createHash('sha256').update(new X509Certificate(pem).raw).digest('base64url');

/**
 * Contract with the kit (ARCHITECTURE.md §10, M4-02) against the real step-ca: enrollment with
 * the single-use token, then the control channel as the gateway's control route presents it
 * (the shared token plus the verified thumbprint). The route itself is tested with APISIX in
 * node-control-route.int.test.ts.
 */
describe('node enrollment and heartbeat (M4-02)', () => {
  const prisma = new PrismaService();
  let app: NestFastifyApplication;
  let issuer: TestIssuer;
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    for (const [k, v] of Object.entries({
      DEN_WG_HUB_PUBLIC_KEY: wireguardKey(),
      DEN_WG_HUB_ENDPOINT: 'hub.den.example:51820',
      DEN_WG_SUBNET: '10.77.0.0/16',
      DEN_NODE_CONTROL_TOKEN: CONTROL_TOKEN,
      DEN_NODE_CONTROL_URL: 'https://gateway.den.example',
    })) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
    issuer = await createTestIssuer();
    app = await createTestApp(issuer, [
      { token: MAIL_TRANSPORT, value: { send: () => Promise.resolve() } },
    ]);
  });
  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  async function admin() {
    const id = randomUUID().slice(0, 8);
    const entity = await prisma.entity.create({
      data: {
        legalName: `Entidad kit ${id}`,
        shortName: `K ${id}`,
        slug: `kit-${id}`,
        taxIdType: 'NIT',
        taxId: `5${id}`,
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
    const bearer = async () =>
      `Bearer ${await issuer.token(who.sub, { email: who.email, name: who.email, emailVerified: true })}`;
    await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { authorization: await bearer() },
    });
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
    const as = async (method: 'GET' | 'POST', url: string, payload?: object) =>
      app.inject({
        method,
        url: `/api/v1/entities/${entity.id}${url}`,
        headers: { authorization: await bearer() },
        payload: payload ?? {},
      });
    return { entityId: entity.id, as };
  }

  async function issued(as: Awaited<ReturnType<typeof admin>>['as']) {
    const res = await as('POST', '/nodes', { name: `nodo-${randomUUID().slice(0, 6)}` });
    expect(res.statusCode, res.body).toBe(201);
    return issuedEnrollmentTokenSchema.parse(res.json());
  }

  const enroll = async (payload: object) =>
    app.inject({ method: 'POST', url: '/api/v1/nodes/enroll', payload });

  const enrollment = async (token: string) => ({
    token,
    csr: await makeCsr('den-node'),
    wireguardPublicKey: wireguardKey(),
    kitVersion: '1.0.0',
    servicePort: 8443,
  });

  async function enrolled() {
    const owner = await admin();
    const created = await issued(owner.as);
    const res = await enroll(await enrollment(created.token));
    expect(res.statusCode, res.body).toBe(201);
    const body = nodeEnrollmentSchema.parse(res.json());
    return { ...owner, created, body, fingerprint: thumbprint(body.certificate) };
  }

  const control = (
    method: 'GET' | 'POST',
    nodeId: string,
    path: string,
    headers: Record<string, string>,
    payload?: object,
  ) =>
    app.inject({
      method,
      url: `/api/v1/nodes/${nodeId}/${path}`,
      headers,
      ...(payload ? { payload } : {}),
    });

  const heartbeatBody = {
    kitVersion: '1.0.0',
    servicePort: 8443,
    services: [{ name: 'afiliacion', path: '/salud' }],
    health: { status: 'ok' },
  };
  const asNode = (fingerprint: string) => ({
    'x-den-node-control': CONTROL_TOKEN,
    'x-den-client-cert-s256': fingerprint,
  });

  it('enrolls with the token: certificate for its own name, tunnel address, token used', async () => {
    const { created, body, entityId, as } = await enrolled();
    const nodeId = created.node.id;
    expect(body).toMatchObject({
      contractVersion: '1',
      nodeId,
      nodeName: `den-node-${nodeId}`,
      controlUrl: 'https://gateway.den.example',
      heartbeatIntervalSeconds: 60,
      wireguard: {
        hubEndpoint: 'hub.den.example:51820',
        hubAddress: '10.77.0.1',
        allowedIps: ['10.77.0.1/32'],
      },
    });
    expect(body.wireguard.address).toMatch(/^10\.77\.\d+\.\d+\/32$/);

    // The CA named the node, for server and client authentication, from the network root.
    const [leafPem, ...chain] = body.certificate.split(/(?<=-----END CERTIFICATE-----\n)/);
    const leaf = new X509Certificate(leafPem ?? '');
    expect(leaf.subject).toBe('CN=den-node');
    expect(leaf.subjectAltName).toBe(`DNS:den-node-${nodeId}`);
    expect(leaf.toLegacyObject().ext_key_usage).toEqual(
      expect.arrayContaining(['1.3.6.1.5.5.7.3.1', '1.3.6.1.5.5.7.3.2']),
    );
    const root = new X509Certificate(body.caCertificate);
    const intermediate = new X509Certificate(chain.join('').trim());
    expect(leaf.verify(intermediate.publicKey)).toBe(true);
    expect(intermediate.verify(root.publicKey)).toBe(true);

    const node = nodeDetailSchema.parse((await as('GET', `/nodes/${nodeId}`)).json());
    expect(node).toMatchObject({
      status: 'enrolled',
      kitVersion: '1.0.0',
      tunnelAddress: body.wireguard.address.replace('/32', ''),
    });
    expect(node.enrollmentTokens[0]?.status).toBe('used');
    const event = await prisma.auditEvent.findFirstOrThrow({
      where: { targetId: nodeId, action: 'node.enrolled' },
    });
    expect(event.actorEntityId).toBe(entityId);
    expect(JSON.stringify(event.after)).not.toContain('PRIVATE KEY');

    // Single use: the same token never enrolls again.
    expect((await enroll(await enrollment(created.token))).statusCode).toBe(401);
  });

  it('gives each node its own address', async () => {
    const a = await enrolled();
    const b = await enrolled();
    expect(a.body.wireguard.address).not.toBe(b.body.wireguard.address);
  });

  it('refuses unknown, expired and revoked tokens alike, with 401', async () => {
    expect((await enroll(await enrollment(`den-enroll-${'x'.repeat(43)}`))).statusCode).toBe(401);

    const { as } = await admin();
    const expired = await issued(as);
    await prisma.nodeEnrollmentToken.updateMany({
      where: { nodeId: expired.node.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const res = await enroll(await enrollment(expired.token));
    expect(res.statusCode).toBe(401);
    expect(res.json<{ detail: string }>().detail).toBe('The enrollment token is not valid');

    const revoked = await issued(as);
    const tokenId = revoked.node.enrollmentToken?.id ?? '';
    await as('POST', `/nodes/${revoked.node.id}/enrollment-tokens/${tokenId}/revoke`);
    expect((await enroll(await enrollment(revoked.token))).statusCode).toBe(401);
  });

  it('a refused CSR leaves the token usable; the CSR names nothing but CN=den-node', async () => {
    const { as } = await admin();
    const created = await issued(as);
    for (const csr of [
      await makeCsr('otro-nombre'),
      await makeCsr('den-node', { dnsNames: ['den-node-intruso'] }),
      await makeCsr('den-node', { key: 'RSA-1024' }),
    ]) {
      const res = await enroll({ ...(await enrollment(created.token)), csr });
      expect(res.statusCode, res.body).toBe(400);
    }
    expect((await enroll(await enrollment(created.token))).statusCode).toBe(201);
  });

  it('without the hub configured it answers 503 and keeps the token', async () => {
    const { as } = await admin();
    const created = await issued(as);
    const key = process.env.DEN_WG_HUB_PUBLIC_KEY;
    delete process.env.DEN_WG_HUB_PUBLIC_KEY;
    try {
      expect((await enroll(await enrollment(created.token))).statusCode).toBe(503);
    } finally {
      process.env.DEN_WG_HUB_PUBLIC_KEY = key;
    }
    expect((await enroll(await enrollment(created.token))).statusCode).toBe(201);
  });

  it('a WireGuard key already in the network cannot enroll a second node', async () => {
    const first = await enrolled();
    const { as } = await admin();
    const second = await issued(as);
    const res = await enroll({
      ...(await enrollment(second.token)),
      wireguardPublicKey: (
        await prisma.node.findUniqueOrThrow({ where: { id: first.created.node.id } })
      ).wireguardPublicKey,
    });
    expect(res.statusCode).toBe(409);
    expect((await enroll(await enrollment(second.token))).statusCode).toBe(201);
  });

  it('heartbeats need the gateway control token and the node certificate', async () => {
    const a = await enrolled();
    const b = await enrolled();
    const nodeId = a.created.node.id;
    // Straight to the API with a thumbprint header: not through the gateway.
    expect(
      (
        await control(
          'POST',
          nodeId,
          'heartbeat',
          { 'x-den-client-cert-s256': a.fingerprint },
          heartbeatBody,
        )
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await control(
          'POST',
          nodeId,
          'heartbeat',
          { ...asNode(a.fingerprint), 'x-den-node-control': 'otro-token-de-control-0123456789ab' },
          heartbeatBody,
        )
      ).statusCode,
    ).toBe(401);
    // Another node's certificate does not open this node.
    expect(
      (await control('POST', nodeId, 'heartbeat', asNode(b.fingerprint), heartbeatBody)).statusCode,
    ).toBe(401);
    expect(
      (await control('POST', nodeId, 'heartbeat', asNode('huella-inventada'), heartbeatBody))
        .statusCode,
    ).toBe(401);
  });

  it('a heartbeat brings the node online; offline after five minutes alerts, and back', async () => {
    const { created, fingerprint, as } = await enrolled();
    const nodeId = created.node.id;
    const res = await control('POST', nodeId, 'heartbeat', asNode(fingerprint), heartbeatBody);
    expect(res.statusCode, res.body).toBe(200);
    expect(nodeHeartbeatResponseSchema.parse(res.json())).toEqual({
      status: 'online',
      nextHeartbeatSeconds: 60,
      renewCertificate: false,
    });
    const again = await control('POST', nodeId, 'heartbeat', asNode(fingerprint), heartbeatBody);
    expect(again.statusCode).toBe(200);
    const detail = nodeDetailSchema.parse((await as('GET', `/nodes/${nodeId}`)).json());
    expect(detail).toMatchObject({
      status: 'online',
      services: [{ name: 'afiliacion', path: '/salud' }],
      health: { status: 'ok' },
    });
    const actions = async () =>
      (
        await prisma.auditEvent.findMany({ where: { targetId: nodeId }, orderBy: { seq: 'asc' } })
      ).map((e) => e.action);
    // One online and one services change: heartbeats that change nothing are not audited.
    expect(await actions()).toEqual([
      'node.created',
      'node.enrollment_token_issued',
      'node.enrolled',
      'node.online',
      'node.services_changed',
    ]);

    await prisma.node.updateMany({
      where: { id: nodeId },
      data: { lastHeartbeatAt: new Date(Date.now() - 6 * 60_000) },
    });
    const marked = await app.get(NodeControlService).markOffline();
    expect(marked).toContain(nodeId);
    expect(nodeDetailSchema.parse((await as('GET', `/nodes/${nodeId}`)).json()).status).toBe(
      'offline',
    );
    const offline = await prisma.auditEvent.findFirstOrThrow({
      where: { targetId: nodeId, action: 'node.offline' },
    });
    expect(
      await prisma.outboxMessage.count({
        where: { topic: NOTIFICATION_TOPIC, aggregate: `audit:${offline.seq}` },
      }),
    ).toBe(1);
    expect(await app.get(NodeControlService).markOffline()).not.toContain(nodeId);

    const back = await control('POST', nodeId, 'heartbeat', asNode(fingerprint), heartbeatBody);
    expect(nodeHeartbeatResponseSchema.parse(back.json()).status).toBe('online');
  });

  it('an enrolled node that never sends a heartbeat goes offline too', async () => {
    const { created } = await enrolled();
    await prisma.node.updateMany({
      where: { id: created.node.id },
      data: { enrolledAt: new Date(Date.now() - 6 * 60_000) },
    });
    expect(await app.get(NodeControlService).markOffline()).toContain(created.node.id);
  });

  it('renews its certificate; the replaced one can only repeat that renewal', async () => {
    const { created, fingerprint } = await enrolled();
    const nodeId = created.node.id;
    const csr = await makeCsr('den-node');
    const res = await control('POST', nodeId, 'renew', asNode(fingerprint), { csr });
    expect(res.statusCode, res.body).toBe(200);
    const renewed = renewedNodeCertificateSchema.parse(res.json());
    const fresh = thumbprint(renewed.certificate);
    expect(fresh).not.toBe(fingerprint);
    expect(
      new X509Certificate(
        `${renewed.certificate.split('-----END CERTIFICATE-----')[0]}-----END CERTIFICATE-----`,
      ).subjectAltName,
    ).toBe(`DNS:den-node-${nodeId}`);
    expect(
      (await control('POST', nodeId, 'heartbeat', asNode(fresh), heartbeatBody)).statusCode,
    ).toBe(200);
    // The replaced certificate no longer sends heartbeats or reads the configuration...
    expect(
      (await control('POST', nodeId, 'heartbeat', asNode(fingerprint), heartbeatBody)).statusCode,
    ).toBe(401);
    expect((await control('GET', nodeId, 'config', asNode(fingerprint))).statusCode).toBe(401);
    // ...it only repeats the renewal it lost: same key, the current certificate back.
    const retry = await control('POST', nodeId, 'renew', asNode(fingerprint), { csr });
    expect(retry.statusCode, retry.body).toBe(200);
    expect(renewedNodeCertificateSchema.parse(retry.json()).certificate).toBe(renewed.certificate);
    // A new key with the replaced certificate is refused: nobody takes the node over with it.
    const takeover = await control('POST', nodeId, 'renew', asNode(fingerprint), {
      csr: await makeCsr('den-node'),
    });
    expect(takeover.statusCode).toBe(401);
    expect((await prisma.node.findUniqueOrThrow({ where: { id: nodeId } })).certificatePem).toBe(
      renewed.certificate,
    );

    await prisma.node.updateMany({
      where: { id: nodeId },
      data: { previousCertificateUntil: new Date(Date.now() - 1000) },
    });
    expect((await control('POST', nodeId, 'renew', asNode(fingerprint), { csr })).statusCode).toBe(
      401,
    );
    expect(
      await prisma.auditEvent.count({
        where: { targetId: nodeId, action: 'node.certificate_renewed' },
      }),
    ).toBe(1);
  });

  it('a suspended entity cannot renew its nodes; an offboarded one loses the channel', async () => {
    const { created, fingerprint, entityId } = await enrolled();
    const nodeId = created.node.id;
    await prisma.entity.updateMany({ where: { id: entityId }, data: { status: 'suspended' } });
    expect(
      (await control('POST', nodeId, 'heartbeat', asNode(fingerprint), heartbeatBody)).statusCode,
    ).toBe(200);
    expect(
      (
        await control('POST', nodeId, 'renew', asNode(fingerprint), {
          csr: await makeCsr('den-node'),
        })
      ).statusCode,
    ).toBe(409);
    await prisma.entity.updateMany({ where: { id: entityId }, data: { status: 'offboarded' } });
    expect(
      (await control('POST', nodeId, 'heartbeat', asNode(fingerprint), heartbeatBody)).statusCode,
    ).toBe(401);
  });

  it('tells the node which published versions it serves', async () => {
    const { created, fingerprint, entityId } = await enrolled();
    const nodeId = created.node.id;
    const api = await prisma.api.create({
      data: {
        entityId,
        slug: `api-${randomUUID().slice(0, 6)}`,
        name: 'Afiliación del kit',
        summary: 'Consulta de afiliación servida por el nodo',
        description: 'Consulta de afiliación servida por el nodo del kit.',
        sector: 'salud',
        classification: 'internal',
        status: 'published',
        ownerContact: 'c@example.org',
        createdBy: 'test',
      },
    });
    const version = await prisma.apiVersion.create({
      data: {
        apiId: api.id,
        version: '1.0',
        major: 1,
        minor: 0,
        status: 'published',
        openapiSpec: {},
        openapiSha256: '0'.repeat(64),
        upstreamType: 'node',
        upstream: { type: 'node', nodeId, servicePath: '/afiliacion' },
        basePath: `/kit/${api.slug}/v1`,
        legalReferences: [],
        createdBy: 'test',
      },
    });
    const res = await control('GET', nodeId, 'config', asNode(fingerprint));
    expect(res.statusCode, res.body).toBe(200);
    expect(nodeConfigSchema.parse(res.json()).services).toEqual([
      {
        apiVersionId: version.id,
        apiName: 'Afiliación del kit',
        version: '1.0',
        basePath: `/kit/${api.slug}/v1`,
        servicePath: '/afiliacion',
      },
    ]);
  });

  it('a decommissioned node loses the control channel for good', async () => {
    const { created, fingerprint, as } = await enrolled();
    const nodeId = created.node.id;
    const res = await as('POST', `/nodes/${nodeId}/decommission`, { reason: 'servidor retirado' });
    expect(res.statusCode, res.body).toBe(200);
    expect(nodeDetailSchema.parse(res.json()).status).toBe('decommissioned');
    expect(
      (await control('POST', nodeId, 'heartbeat', asNode(fingerprint), heartbeatBody)).statusCode,
    ).toBe(401);
    expect((await as('POST', `/nodes/${nodeId}/decommission`, {})).statusCode).toBe(409);
    const event = await prisma.auditEvent.findFirstOrThrow({
      where: { targetId: nodeId, action: 'node.decommissioned' },
    });
    expect(event.after).toMatchObject({ status: 'decommissioned', reason: 'servidor retirado' });
  });

  it('decommissioning a node that never enrolled revokes its token', async () => {
    const { as } = await admin();
    const created = await issued(as);
    const res = await as('POST', `/nodes/${created.node.id}/decommission`, {});
    expect(res.statusCode, res.body).toBe(200);
    expect(nodeDetailSchema.parse(res.json()).enrollmentTokens[0]?.status).toBe('revoked');
    expect((await enroll(await enrollment(created.token))).statusCode).toBe(401);
  });
});
