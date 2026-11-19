import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { loadCountryConfig } from '@den/config';
import {
  apiDetailSchema,
  apiVersionDetailSchema,
  type NodeService,
  nodeDetailSchema,
  nodeListSchema,
  reviewDetailSchema,
  syncPageSchema,
} from '@den/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, createTestIssuer, type TestIssuer } from '../../test/test-auth.js';
import { AuditService } from '../audit/audit.service.js';
import { MAIL_TRANSPORT } from '../mail/mail.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { NOTIFICATION_TOPIC } from '../notifications/notifying-actions.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { readRealmUsers } from '../seed/realm.js';
import { runSeed } from '../seed/seed.js';
import { NodeControlService } from './node-control.service.js';
import { NODE_CONTRACT_ACTION } from './node-contracts.js';

const saludOpenapi = readFileSync(
  resolve(import.meta.dirname, '../../../../infra/mock-providers/salud/openapi.yaml'),
  'utf8',
);
const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const OTHER = sha('openapi: 3.1.0\ninfo: { title: otra, version: "2" }\npaths: {}\n');
const THIRD = sha('openapi: 3.1.0\ninfo: { title: tercera, version: "3" }\npaths: {}\n');

/**
 * What a kit node serves against the published contract (P-02): the hash it reports per service
 * path, compared with the published version's at every heartbeat; the three states where the
 * provider, the reviewer and the operator look; the audit trail and the notification on
 * matches → differs only; and who sees it.
 */
describe('node contract check (P-02)', () => {
  const prisma = new PrismaService();
  const realmUsers = readRealmUsers();
  const sub = (username: string) => realmUsers.find((u) => u.username === username)?.id ?? '';
  const run = randomUUID().slice(0, 6);
  let app: NestFastifyApplication;
  let issuer: TestIssuer;
  let salud = '';

  beforeAll(async () => {
    await runSeed(prisma, new AuditService(), {
      config: loadCountryConfig({ code: 'co' }),
      realmUsers,
    });
    salud = (await prisma.entity.findFirstOrThrow({ where: { slug: 'salud' } })).id;
    issuer = await createTestIssuer();
    app = await createTestApp(issuer, [
      { token: MAIL_TRANSPORT, value: { send: () => Promise.resolve() } },
    ]);
  });
  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  const request = async (url: string, username: string) =>
    app.inject({
      method: 'GET',
      url: `/api/v1${url}`,
      headers: { authorization: `Bearer ${await issuer.token(sub(username))}` },
    });

  /** An online node of the salud entity, as if it had enrolled. */
  const onlineNode = async () =>
    prisma.node.create({
      data: {
        entityId: salud,
        name: `nodo-contrato-${run}-${randomUUID().slice(0, 4)}`,
        status: 'online',
        servicePort: 8443,
        kitVersion: '1.0.0',
        enrolledAt: new Date(),
        lastHeartbeatAt: new Date(),
        createdBy: 'test',
      },
    });

  /** A version on that node, registered by the publisher with `openapi`, then published. */
  const publishedVersion = async (nodeId: string, servicePath: string, openapi = saludOpenapi) => {
    const api = await app.inject({
      method: 'POST',
      url: `/api/v1/entities/${salud}/apis`,
      headers: { authorization: `Bearer ${await issuer.token(sub('pedro.publicador'))}` },
      payload: {
        slug: `contrato-${run}-${randomUUID().slice(0, 4)}`,
        name: `Contrato ${servicePath} ${run}`,
        summary: 'Consulta el estado de afiliación de una persona.',
        description: 'API de prueba con datos sintéticos.',
        sector: 'salud',
        tags: [],
        classification: 'personal',
        ownerContact: 'apis@salud.demo.den.example',
      },
    });
    expect(api.statusCode, api.body).toBe(201);
    const apiId = apiDetailSchema.parse(api.json()).id;
    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/entities/${salud}/apis/${apiId}/versions`,
      headers: { authorization: `Bearer ${await issuer.token(sub('pedro.publicador'))}` },
      payload: {
        version: '1.0',
        openapi,
        upstream: { type: 'node', nodeId, servicePath },
        exposedFields: [{ name: 'regimen', personal: true, sensitive: false }],
        allowedPurposes: ['eligibility_check'],
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const versionId = apiVersionDetailSchema.parse(created.json()).id;
    await prisma.apiVersion.update({
      where: { id: versionId },
      data: { status: 'published', publishedAt: new Date() },
    });
    return { apiId, versionId, url: `/entities/${salud}/apis/${apiId}/versions/${versionId}` };
  };

  /** A heartbeat of the node declaring these services, as the control channel hands it over. */
  const beat = async (nodeId: string, services: NodeService[]) => {
    const node = await prisma.node.findUniqueOrThrow({ where: { id: nodeId } });
    await app.get(NodeControlService).heartbeat(node, {
      kitVersion: '1.0.0',
      servicePort: 8443,
      services,
      health: { status: 'ok' },
    });
  };
  const service = (path: string, openapiSha256?: string): NodeService => ({
    name: path.slice(1),
    path,
    ...(openapiSha256 ? { openapiSha256 } : {}),
  });

  const contractOf = async (url: string) => {
    const res = await request(url, 'pedro.publicador');
    expect(res.statusCode, res.body).toBe(200);
    return apiVersionDetailSchema.parse(res.json()).nodeContract;
  };
  const transitions = (versionId: string) =>
    prisma.auditEvent.findMany({
      where: { targetId: versionId, action: NODE_CONTRACT_ACTION },
      orderBy: { seq: 'asc' },
    });
  /** Runs the dispatcher on an audit event, as the worker would: how many were notified. */
  const dispatch = (seq: bigint) => app.get(NotificationsService).dispatch({ seq: seq.toString() });

  it('compares per service path, the published hash and its line-ending variants', async () => {
    const node = await onlineNode();
    const salud1 = await publishedVersion(node.id, '/salud');
    const certificados = await publishedVersion(node.id, '/certificados');
    // The same file as the publisher pasted it: trimmed and with CRLF endings.
    const pasted = await publishedVersion(
      node.id,
      '/pegado',
      saludOpenapi.trim().replace(/\n/g, '\r\n'),
    );
    await beat(node.id, [
      service('/salud', sha(saludOpenapi)),
      service('/certificados', OTHER),
      service('/pegado', sha(saludOpenapi)),
    ]);

    const matching = await contractOf(salud1.url);
    expect(matching).toMatchObject({
      status: 'matches',
      servicePath: '/salud',
      serviceName: 'salud',
      expectedSha256: sha(saludOpenapi),
      reportedSha256: sha(saludOpenapi),
    });
    expect(matching?.since).not.toBeNull();
    expect(await contractOf(certificados.url)).toMatchObject({
      status: 'differs',
      serviceName: 'certificados',
      expectedSha256: sha(saludOpenapi),
      reportedSha256: OTHER,
    });
    const viaPaste = await contractOf(pasted.url);
    expect(viaPaste?.expectedSha256).not.toBe(sha(saludOpenapi));
    expect(viaPaste?.status).toBe('matches');
  });

  it('is not reported without an OpenAPI on the node, or without a service on the path', async () => {
    const node = await onlineNode();
    const noOpenapi = await publishedVersion(node.id, '/salud');
    const noService = await publishedVersion(node.id, '/certificados');
    await beat(node.id, [service('/salud')]);
    expect(await contractOf(noOpenapi.url)).toMatchObject({
      status: 'not_reported',
      serviceName: 'salud',
      reportedSha256: null,
    });
    expect(await contractOf(noService.url)).toMatchObject({
      status: 'not_reported',
      serviceName: null,
      reportedSha256: null,
    });
  });

  it('is shown only for served versions on a node', async () => {
    const node = await onlineNode();
    const draft = await publishedVersion(node.id, '/salud');
    await prisma.apiVersion.update({ where: { id: draft.versionId }, data: { status: 'draft' } });
    await beat(node.id, [service('/salud', OTHER)]);
    expect(await contractOf(draft.url)).toBeNull();
    expect(await transitions(draft.versionId)).toHaveLength(0);
  });

  it('records each change once, with since, and notifies on matches → differs only', async () => {
    const node = await onlineNode();
    const { versionId, url } = await publishedVersion(node.id, '/salud');
    const gatewayJobs = () =>
      prisma.outboxMessage.count({ where: { aggregate: `apiVersion:${versionId}` } });
    const jobsBefore = await gatewayJobs();

    // First seen: matches. Audited (from nothing); nobody is notified.
    await beat(node.id, [service('/salud', sha(saludOpenapi))]);
    await beat(node.id, [service('/salud', sha(saludOpenapi))]);
    let events = await transitions(versionId);
    expect(events).toHaveLength(1);
    expect(events[0]?.before).toBeNull();
    expect(events[0]?.after).toMatchObject({ status: 'matches', nodeId: node.id });
    expect(events[0]?.actorId).toBe(`den-node-${node.id}`);
    expect(await dispatch(events[0]?.seq ?? 0n)).toBe(0);

    // matches → differs: audited with both hashes, notified to publishers and admins.
    await beat(node.id, [service('/salud', OTHER)]);
    events = await transitions(versionId);
    expect(events).toHaveLength(2);
    const differs = events[1];
    expect(differs?.before).toMatchObject({ status: 'matches' });
    expect(differs?.after).toMatchObject({
      status: 'differs',
      servicePath: '/salud',
      expectedSha256: sha(saludOpenapi),
      reportedSha256: OTHER,
    });
    expect(
      await prisma.outboxMessage.count({
        where: { topic: NOTIFICATION_TOPIC, aggregate: `audit:${differs?.seq}` },
      }),
    ).toBe(1);
    expect(await dispatch(differs?.seq ?? 0n)).toBeGreaterThan(0);
    const notified = await prisma.notification.findMany({
      where: { sourceSeq: differs?.seq },
      include: { user: { select: { keycloakSub: true } } },
    });
    expect(notified.every((n) => n.kind === 'api_contract_differs')).toBe(true);
    const who = notified.map((n) => n.user.keycloakSub);
    expect(who).toEqual(expect.arrayContaining([sub('pedro.publicador'), sub('elena.admin')]));
    expect(who).not.toContain(sub('lucia.datos'));
    const payload = notified[0]?.payload as { params: object; link: string } | undefined;
    expect(payload?.params).toMatchObject({ node: node.name, version: '1.0' });
    expect(payload?.link).toContain(`/versions/${versionId}`);
    const since = (await contractOf(url))?.since;
    expect(since).toBe(
      (
        await prisma.nodeContractCheck.findUniqueOrThrow({ where: { apiVersionId: versionId } })
      ).since.toISOString(),
    );

    // Still differs, even with yet another document: no new event, the same since.
    await beat(node.id, [service('/salud', OTHER)]);
    await beat(node.id, [service('/salud', THIRD)]);
    expect(await transitions(versionId)).toHaveLength(2);
    expect(await contractOf(url)).toMatchObject({
      status: 'differs',
      reportedSha256: THIRD,
      since,
    });

    // Back to matches, then not reported, then differs again: audited, never notified.
    await beat(node.id, [service('/salud', sha(saludOpenapi))]);
    await beat(node.id, [service('/salud')]);
    await beat(node.id, [service('/salud', OTHER)]);
    events = await transitions(versionId);
    expect(events.map((e) => (e.after as { status: string }).status)).toEqual([
      'matches',
      'differs',
      'matches',
      'not_reported',
      'differs',
    ]);
    for (const e of events.slice(2)) expect(await dispatch(e.seq)).toBe(0);

    // It never touches the routes: the gateway keeps the published contract.
    expect(await gatewayJobs()).toBe(jobsBefore);
  });

  it('a revision with what the node serves turns it back to matches', async () => {
    const node = await onlineNode();
    const { versionId, url } = await publishedVersion(node.id, '/salud');
    const revised = saludOpenapi.replace(
      'title: Consulta de afiliación en salud',
      'title: Consulta de afiliación en salud (revisada)',
    );
    await beat(node.id, [service('/salud', sha(revised))]);
    expect((await contractOf(url))?.status).toBe('differs');
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1${url}/openapi`,
      headers: { authorization: `Bearer ${await issuer.token(sub('pedro.publicador'))}` },
      payload: { openapi: revised },
    });
    expect(res.statusCode, res.body).toBe(200);
    // Shown at once; recorded (since) at the next heartbeat.
    expect(await contractOf(url)).toMatchObject({ status: 'matches', since: null });
    await beat(node.id, [service('/salud', sha(revised))]);
    expect((await contractOf(url))?.since).not.toBeNull();
    expect((await transitions(versionId)).at(-1)?.after).toMatchObject({ status: 'matches' });
  });

  describe('who sees it', () => {
    let target: { versionId: string; url: string; nodeId: string; nodeName: string };
    beforeAll(async () => {
      const node = await onlineNode();
      const version = await publishedVersion(node.id, '/salud');
      await beat(node.id, [service('/salud', OTHER)]);
      target = { ...version, nodeId: node.id, nodeName: node.name };
    });

    it('the version sheet: the entity’s members and the reviewer; others 404', async () => {
      for (const user of ['pedro.publicador', 'elena.admin']) {
        const res = await request(target.url, user);
        expect(res.statusCode, `${user}: ${res.body}`).toBe(200);
        expect(apiVersionDetailSchema.parse(res.json()).nodeContract?.status).toBe('differs');
      }
      for (const user of ['ana.operadora', 'pablo.plataforma']) {
        const res = await request(`/review/api-versions/${target.versionId}`, user);
        expect(res.statusCode, `${user}: ${res.body}`).toBe(200);
        expect(reviewDetailSchema.parse(res.json()).version.nodeContract).toMatchObject({
          status: 'differs',
          reportedSha256: OTHER,
        });
      }
      // The reviewer's sheet is the operator's: the provider gets 403.
      expect(
        (await request(`/review/api-versions/${target.versionId}`, 'pedro.publicador')).statusCode,
      ).toBe(403);
      // Not a member and no platform role that reads APIs: 404, nothing about the entity.
      expect((await request(target.url, 'carlos.dev')).statusCode).toBe(404);
      expect((await request(target.url, 'sofia.auditora')).statusCode).toBe(404);
    });

    it('the node page: the entity’s admin; others 404', async () => {
      const res = await request(`/entities/${salud}/nodes`, 'elena.admin');
      expect(res.statusCode, res.body).toBe(200);
      const node = nodeListSchema.parse(res.json()).items.find((n) => n.id === target.nodeId);
      expect(node?.contracts).toEqual([
        expect.objectContaining({
          apiVersionId: target.versionId,
          status: 'differs',
          servicePath: '/salud',
          reportedSha256: OTHER,
        }),
      ]);
      const one = await request(`/entities/${salud}/nodes/${target.nodeId}`, 'elena.admin');
      expect(one.statusCode, one.body).toBe(200);
      expect(nodeDetailSchema.parse(one.json()).contracts).toHaveLength(1);
      expect((await request(`/entities/${salud}/nodes`, 'carlos.dev')).statusCode).toBe(404);
      expect((await request(`/entities/${salud}/nodes`, 'sofia.auditora')).statusCode).toBe(404);
    });

    it('the sync console: the operator; others 403', async () => {
      for (const user of ['pablo.plataforma', 'ana.operadora']) {
        const res = await request('/admin/sync', user);
        expect(res.statusCode, `${user}: ${res.body}`).toBe(200);
        const rows = syncPageSchema.parse(res.json()).nodeContracts;
        expect(rows).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              apiVersionId: target.versionId,
              status: 'differs',
              nodeId: target.nodeId,
              nodeName: target.nodeName,
              expectedSha256: sha(saludOpenapi),
              reportedSha256: OTHER,
            }),
          ]),
        );
        // Differing ones first; matching ones are not listed.
        const statuses = rows.map((r) => r.status);
        expect(statuses).not.toContain('matches');
        expect(statuses.lastIndexOf('differs')).toBeLessThan(
          statuses.includes('not_reported') ? statuses.indexOf('not_reported') : Infinity,
        );
      }
      for (const user of ['pedro.publicador', 'elena.admin', 'marta.regulador']) {
        expect((await request('/admin/sync', user)).statusCode, user).toBe(403);
      }
    });
  });
});
