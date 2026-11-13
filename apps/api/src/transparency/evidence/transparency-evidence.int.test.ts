import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { loadCountryConfig } from '@rid/config';
import {
  createdApplicationSchema,
  subscriptionDetailSchema,
  transparencyCheckpointPageSchema,
  transparencyReceiptSchema,
  transparencyVerificationSchema,
} from '@rid/contracts';
import { verifyReceipt } from '@rid/transparency-verifier';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, createTestIssuer, type TestIssuer } from '../../../test/test-auth.js';
import { AuditService } from '../../audit/audit.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { routeId } from '../../reconcilers/apisix/desired-state.js';
import { readRealmUsers } from '../../seed/realm.js';
import { runSeed } from '../../seed/seed.js';
import { TransparencyEvidenceService } from './transparency-evidence.service.js';
import { TsaClient } from './tsa.client.js';

const openapi = readFileSync(
  resolve(import.meta.dirname, '../../../../../infra/mock-providers/salud/openapi.yaml'),
  'utf8',
);
const hex = (bytes: number) => randomBytes(bytes).toString('hex');

// Needs the development TSA (pnpm infra:up, or the tsa service in CI).
describe('transparency evidence (MT-04)', () => {
  const prisma = new PrismaService();
  const realmUsers = readRealmUsers();
  const subOf = (username: string) => realmUsers.find((u) => u.username === username)?.id ?? '';
  const run = randomUUID().slice(0, 6);
  /** The schema owner: plays the attacker with database access who tampers with the evidence. */
  const owner = new pg.Client({ connectionString: process.env.DATABASE_MIGRATION_URL });
  let app: NestFastifyApplication;
  let issuer: TestIssuer;
  let evidence: TransparencyEvidenceService;
  let versionId = '';
  let subscriptionId = '';

  const call = async (method: 'GET' | 'POST', url: string, who?: string, payload?: unknown) =>
    app.inject({
      method,
      url: `/api/v1${url}`,
      headers: who ? { authorization: `Bearer ${await issuer.token(subOf(who))}` } : {},
      ...(payload !== undefined ? { payload: payload as object } : {}),
    });

  /** Records reach the register as the gateway's Fluent Bit sends them (MT-03). */
  const ingest = async (count: number): Promise<string[]> => {
    const records = Array.from({ length: count }, () => ({
      ts: (Date.now() / 1000).toFixed(3),
      gateway_node: `apisix-${run}`,
      gateway_request_id: hex(16),
      route_id: routeId(versionId),
      operation: 'getAfiliado',
      subscription_id: subscriptionId,
      subject_ref: hex(32),
      end_user_hash: hex(32),
      status: '200',
      upstream_status: '200',
    }));
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/internal/subject-access',
      headers: { authorization: `Bearer ${process.env.RID_TRANSPARENCY_INGEST_TOKEN}` },
      payload: records,
    });
    expect(res.json()).toMatchObject({ accepted: count });
    const rows = await prisma.subjectAccessRecord.findMany({
      where: { gatewayRequestId: { in: records.map((r) => r.gateway_request_id) } },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  };

  const verification = async () => {
    const res = await call('GET', '/transparency/verify', 'sofia.auditora');
    expect(res.statusCode, res.body).toBe(200);
    return transparencyVerificationSchema.parse(res.json());
  };

  /** Runs `tamper` as the owner with the insert-only triggers off, and always undoes it. */
  const tampered = async (tamper: string, undo: string, check: () => Promise<void>) => {
    const triggers = (on: boolean) =>
      owner.query(
        [
          'subject_access_record',
          'transparency_checkpoint',
          'transparency_leaf',
          'transparency_timestamp',
        ]
          .map((t) => `ALTER TABLE ${t} ${on ? 'ENABLE' : 'DISABLE'} TRIGGER USER;`)
          .join(' '),
      );
    await triggers(false);
    try {
      await owner.query(tamper);
      await check();
    } finally {
      await owner.query(undo);
      await triggers(true);
    }
  };

  beforeAll(async () => {
    await owner.connect();
    await runSeed(prisma, new AuditService(), {
      config: loadCountryConfig({ code: 'co' }),
      realmUsers,
    });
    const salud = (await prisma.entity.findUniqueOrThrow({ where: { slug: 'salud' } })).id;
    const programas = (
      await prisma.entity.findUniqueOrThrow({ where: { slug: 'programas-sociales' } })
    ).id;
    issuer = await createTestIssuer();
    app = await createTestApp(issuer);
    evidence = app.get(TransparencyEvidenceService);

    const api = await call('POST', `/entities/${salud}/apis`, 'pedro.publicador', {
      slug: `evidencia-${run}`,
      name: `Evidencia ${run}`,
      summary: 'API para probar la evidencia del registro de transparencia.',
      description: 'Datos sintéticos.',
      sector: 'salud',
      tags: [],
      classification: 'personal',
      ownerContact: 'apis@salud.demo.rid.example',
    });
    const apiId = api.json<{ id: string }>().id;
    const version = await call(
      'POST',
      `/entities/${salud}/apis/${apiId}/versions`,
      'pedro.publicador',
      {
        version: '1.0',
        openapi,
        upstream: { type: 'node', servicePath: '/salud' },
        allowedPurposes: ['eligibility_check'],
        exposedFields: [{ name: 'regimen', personal: true, sensitive: false }],
      },
    );
    versionId = version.json<{ id: string }>().id;
    await call(
      'POST',
      `/entities/${salud}/apis/${apiId}/versions/${versionId}/submit`,
      'pedro.publicador',
    );
    await call('POST', `/review/api-versions/${versionId}/approve`, 'ana.operadora', {});
    const created = await call('POST', `/entities/${programas}/applications`, 'carlos.dev', {
      name: `Evidencia ${run}`,
      description: 'Verifica afiliación.',
      environment: 'production',
      technicalContact: 'dev@programas.demo.rid.example',
    });
    const applicationId = createdApplicationSchema.parse(created.json()).application.id;
    const requested = await call('POST', `/entities/${programas}/subscriptions`, 'carlos.dev', {
      applicationId,
      apiVersionId: versionId,
      purposeCode: 'eligibility_check',
      purposeDetail: 'Verificar afiliación al asignar el subsidio X.',
      legalBasisText: 'Ley de protección de datos, artículo 10, literal b.',
      validityMonths: 12,
    });
    subscriptionId = subscriptionDetailSchema.parse(requested.json()).id;
    const approved = await call(
      'POST',
      `/entities/${salud}/access-requests/${subscriptionId}/approve`,
      'lucia.datos',
      { validityMonths: 6 },
    );
    expect(approved.statusCode, approved.body).toBe(200);

    // Whatever earlier runs left unsealed or unstamped, so each test starts from a clean state.
    await evidence.sealPending();
    await evidence.stampPending();
  });

  afterAll(async () => {
    await owner.end();
    await app.close();
    await prisma.$disconnect();
  });

  describe('authorization', () => {
    it('publishes keys and checkpoints to anyone; receipts and the re-check to oversight roles', async () => {
      const [id] = await ingest(1);
      await evidence.sealPending();
      expect((await call('GET', '/transparency/jwks')).statusCode).toBe(200);
      expect((await call('GET', '/transparency/checkpoints')).statusCode).toBe(200);
      for (const path of [`/transparency/records/${id}/receipt`, '/transparency/verify']) {
        expect((await call('GET', path)).statusCode).toBe(401);
        for (const who of ['carlos.dev', 'pedro.publicador', 'lucia.datos']) {
          expect((await call('GET', path, who)).statusCode, `${who} ${path}`).toBe(403);
        }
        for (const who of ['ana.operadora', 'marta.regulador', 'sofia.auditora']) {
          expect((await call('GET', path, who)).statusCode, `${who} ${path}`).toBe(200);
        }
      }
    });
  });

  describe('sealing', () => {
    it('seals new records in a signed batch chained to the previous one, anchored in the audit chain', async () => {
      const before = await prisma.transparencyCheckpoint.findFirst({ orderBy: { seq: 'desc' } });
      const ids = await ingest(3);
      const [seq] = await evidence.sealPending();
      expect(seq).toBe((before?.seq ?? 0) + 1);
      const checkpoint = await prisma.transparencyCheckpoint.findUniqueOrThrow({
        where: { seq },
        include: { leaves: true },
      });
      expect(checkpoint.prev).toBe(before?.hash ?? null);
      expect(checkpoint.leaves.map((l) => l.recordId).sort()).toEqual([...ids].sort());
      expect(
        await prisma.auditEvent.findFirst({
          where: { action: 'transparency.checkpoint', targetId: String(seq) },
        }),
      ).toMatchObject({ actorType: 'system', actorId: 'transparency-sealer' });
      // Nothing left: a second round seals nothing.
      expect(await evidence.sealPending()).toEqual([]);

      const page = transparencyCheckpointPageSchema.parse(
        (await call('GET', `/transparency/checkpoints?cursor=${(seq ?? 1) - 1}&limit=1`)).json(),
      );
      expect(page.items[0]).toMatchObject({ seq, treeSize: 3, timestamp: null });
    });

    it('gives a receipt anyone can verify with the public keys and the TSA certificate', async () => {
      const [id] = await ingest(5);
      await evidence.sealPending();
      expect((await evidence.stampPending()).length).toBeGreaterThan(0);

      const res = await call('GET', `/transparency/records/${id}/receipt`, 'marta.regulador');
      expect(res.statusCode, res.body).toBe(200);
      const receipt = transparencyReceiptSchema.parse(res.json());
      const jwks = (await call('GET', '/transparency/jwks')).json<{ keys: [] }>();
      const result = await verifyReceipt(receipt, {
        jwks,
        tsaRoots: await app.get(TsaClient).certificates(),
      });
      expect(result.errors).toEqual([]);
      expect(result).toMatchObject({ valid: true, checks: { timestamp: 'valid' } });
      // The receipt carries metadata and the pseudonym only.
      expect(JSON.stringify(receipt)).not.toMatch(/numeroIdentificacion|1000000001/);
    });

    it('answers 409 for a record not sealed yet and 404 for an unknown one', async () => {
      const [id] = await ingest(1);
      expect(
        (await call('GET', `/transparency/records/${id}/receipt`, 'sofia.auditora')).statusCode,
      ).toBe(409);
      expect(
        (await call('GET', `/transparency/records/${randomUUID()}/receipt`, 'sofia.auditora'))
          .statusCode,
      ).toBe(404);
      await evidence.sealPending();
      await evidence.stampPending();
    });

    it('keeps a batch pending while the TSA does not answer, and stamps it later', async () => {
      const tsaUrl = process.env.RID_TSA_URL;
      const [id] = await ingest(1);
      process.env.RID_TSA_URL = 'http://127.0.0.1:9';
      try {
        const [seq] = await evidence.sealPending();
        expect(await evidence.stampPending()).toEqual([]);
        const receipt = (
          await call('GET', `/transparency/records/${id}/receipt`, 'sofia.auditora')
        ).json<{
          timestamp: string | null;
        }>();
        expect(receipt.timestamp).toBeNull();
        expect((await verification()).pendingTimestamps).toBeGreaterThanOrEqual(1);
        process.env.RID_TSA_URL = tsaUrl;
        expect(await evidence.stampPending()).toContain(seq);
      } finally {
        process.env.RID_TSA_URL = tsaUrl;
      }
    });
  });

  describe('tamper evidence', () => {
    it('finds the register whole', async () => {
      const result = await verification();
      expect(result.problems).toEqual([]);
      expect(result).toMatchObject({ valid: true, timestampsChecked: true, unsealed: 0 });
    });

    it('detects an altered record', async () => {
      const [id] = await ingest(1);
      await evidence.sealPending();
      await tampered(
        `UPDATE subject_access_record SET purpose_code = 'other_purpose' WHERE id = '${id}'`,
        `UPDATE subject_access_record SET purpose_code = 'eligibility_check' WHERE id = '${id}'`,
        async () => {
          expect((await verification()).problems).toContainEqual(
            expect.objectContaining({ kind: 'record_altered', recordId: id }),
          );
        },
      );
      expect((await verification()).valid).toBe(true);
    });

    it('detects a record deleted before its retention ends', async () => {
      const [id] = await ingest(1);
      await evidence.sealPending();
      const backup = 'subject_access_record_backup_' + run;
      await owner.query(
        `CREATE TABLE ${backup} AS SELECT * FROM subject_access_record WHERE id = '${id}'`,
      );
      try {
        await tampered(
          `DELETE FROM subject_access_record WHERE id = '${id}'`,
          `INSERT INTO subject_access_record SELECT * FROM ${backup}`,
          async () => {
            expect((await verification()).problems).toContainEqual(
              expect.objectContaining({ kind: 'record_deleted', recordId: id }),
            );
          },
        );
      } finally {
        await owner.query(`DROP TABLE ${backup}`);
      }
      expect((await verification()).valid).toBe(true);
    });

    it('detects a record deleted early whose leaf was moved back to look purged', async () => {
      const [id] = await ingest(1);
      await evidence.sealPending();
      const backup = 'subject_access_record_moved_' + run;
      const leaf = await prisma.transparencyLeaf.findUniqueOrThrow({ where: { recordId: id } });
      await owner.query(
        `CREATE TABLE ${backup} AS SELECT * FROM subject_access_record WHERE id = '${id}'`,
      );
      try {
        await tampered(
          `DELETE FROM subject_access_record WHERE id = '${id}';
           UPDATE transparency_leaf SET occurred_at = '2001-01-01' WHERE record_id = '${id}'`,
          `INSERT INTO subject_access_record SELECT * FROM ${backup};
           UPDATE transparency_leaf SET occurred_at = '${leaf.occurredAt.toISOString()}'
           WHERE record_id = '${id}'`,
          async () => {
            const result = await verification();
            expect(result.problems).toContainEqual(
              expect.objectContaining({ kind: 'leaf_altered', recordId: id }),
            );
          },
        );
      } finally {
        await owner.query(`DROP TABLE ${backup}`);
      }
      expect((await verification()).valid).toBe(true);
    });

    it('detects batches removed from the end of the chain', async () => {
      await ingest(1);
      const [seq] = await evidence.sealPending();
      await evidence.stampPending();
      const tables = ['transparency_timestamp', 'transparency_leaf', 'transparency_checkpoint'];
      const column = (t: string) => (t === 'transparency_checkpoint' ? 'seq' : 'checkpoint_seq');
      for (const t of tables) {
        await owner.query(
          `CREATE TABLE ${t}_cut_${run} AS SELECT * FROM ${t} WHERE ${column(t)} = ${seq}`,
        );
      }
      try {
        await tampered(
          tables.map((t) => `DELETE FROM ${t} WHERE ${column(t)} = ${seq};`).join(' '),
          [...tables]
            .reverse()
            .map((t) => `INSERT INTO ${t} SELECT * FROM ${t}_cut_${run};`)
            .join(' '),
          async () => {
            // The chain alone still looks whole; the audit anchor says a batch is missing.
            expect((await verification()).problems).toContainEqual(
              expect.objectContaining({ kind: 'checkpoint_missing', seq }),
            );
          },
        );
      } finally {
        for (const t of tables) await owner.query(`DROP TABLE ${t}_cut_${run}`);
      }
      expect((await verification()).valid).toBe(true);
    });

    it('detects a record slipped into a sealed batch', async () => {
      await ingest(2);
      const [seq] = await evidence.sealPending();
      const intruder = randomUUID();
      await tampered(
        `INSERT INTO transparency_leaf (record_id, checkpoint_seq, leaf_index, leaf_hash, occurred_at)
         VALUES ('${intruder}', ${seq}, 2, '${hex(32)}', now())`,
        `DELETE FROM transparency_leaf WHERE record_id = '${intruder}'`,
        async () => {
          expect((await verification()).problems).toContainEqual(
            expect.objectContaining({ kind: 'root_mismatch', seq }),
          );
        },
      );
    });

    it('detects a rewritten checkpoint', async () => {
      const latest = await prisma.transparencyCheckpoint.findFirstOrThrow({
        orderBy: { seq: 'desc' },
      });
      await tampered(
        `UPDATE transparency_checkpoint SET root = '${hex(32)}' WHERE seq = ${latest.seq}`,
        `UPDATE transparency_checkpoint SET root = '${latest.root}' WHERE seq = ${latest.seq}`,
        async () => {
          const kinds = (await verification()).problems.map((p) => p.kind);
          expect(kinds).toEqual(expect.arrayContaining(['signature_invalid', 'root_mismatch']));
        },
      );
      expect((await verification()).valid).toBe(true);
    });

    it('refuses updates and deletes of the evidence to the runtime role', async () => {
      const latest = await prisma.transparencyCheckpoint.findFirstOrThrow({
        orderBy: { seq: 'desc' },
      });
      await expect(
        prisma.transparencyCheckpoint.update({
          where: { seq: latest.seq },
          data: { root: hex(32) },
        }),
      ).rejects.toThrow();
      await expect(
        prisma.transparencyLeaf.deleteMany({ where: { checkpointSeq: latest.seq } }),
      ).rejects.toThrow();
      await expect(
        prisma.transparencyTimestamp.deleteMany({ where: { checkpointSeq: latest.seq } }),
      ).rejects.toThrow();
      await expect(
        prisma.$executeRawUnsafe('TRUNCATE transparency_leaf CASCADE'),
      ).rejects.toThrow();
    });
  });
});
