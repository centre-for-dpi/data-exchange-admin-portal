import { createHash, randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { loadCountryConfig } from '@den/config';
import { auditEventPageSchema, chainCheckSchema } from '@den/contracts';
import { compactVerify, importJWK, type JWK } from 'jose';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, createTestIssuer, type TestIssuer } from '../../test/test-auth.js';
import { MAIL_TRANSPORT, type MailMessage } from '../mail/mail.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { readRealmUsers } from '../seed/realm.js';
import { runSeed } from '../seed/seed.js';
import { AuditAnchorService } from './audit-anchor.service.js';
import { AuditService } from './audit.service.js';

describe('complete audit (M2-09)', () => {
  const prisma = new PrismaService();
  const audit = new AuditService();
  const realmUsers = readRealmUsers();
  const user = (username: string) => realmUsers.find((u) => u.username === username);
  /** The schema owner: plays the attacker with database access. */
  const owner = new pg.Client({ connectionString: process.env.DATABASE_MIGRATION_URL });
  const sent: MailMessage[] = [];
  let app: NestFastifyApplication;
  let issuer: TestIssuer;

  beforeAll(async () => {
    await runSeed(prisma, audit, { config: loadCountryConfig({ code: 'co' }), realmUsers });
    await owner.connect();
    issuer = await createTestIssuer();
    app = await createTestApp(issuer, [
      {
        token: MAIL_TRANSPORT,
        value: {
          send: (m: MailMessage) => {
            sent.push(m);
            return Promise.resolve();
          },
        },
      },
    ]);
  });
  afterAll(async () => {
    await app.close();
    await owner.end();
    await prisma.$disconnect();
  });

  const get = async (url: string, who: string) =>
    app.inject({
      method: 'GET',
      url: `/api/v1${url}`,
      headers: { authorization: `Bearer ${await issuer.token(user(who)?.id ?? '')}` },
    });

  /** A few events of a made-up area, unique to this run. */
  async function probe() {
    // Letters only (an action's area has no digits), all 16 hex symbols kept distinct: a digit
    // turned into a fixed letter made areas collide across runs in a database that keeps its events.
    const area = `probe_${randomUUID()
      .slice(0, 12)
      .replace(/-/g, '')
      .replace(/[0-9]/g, (d) => String.fromCharCode(103 + Number(d)))}`;
    const targetId = randomUUID();
    await prisma.$transaction(async (tx) => {
      await audit.record(tx, {
        actor: { type: 'system', id: 'test' },
        action: `${area}.created`,
        target: { type: area, id: targetId },
      });
      await audit.record(tx, {
        actor: { type: 'system', id: 'test' },
        action: `${area}.changed`,
        target: { type: area, id: targetId },
        // A value a spreadsheet would run as a formula.
        after: { note: '=HYPERLINK("http://evil")' },
      });
      await audit.record(tx, {
        actor: { type: 'system', id: 'test' },
        action: `${area}.created`,
        target: { type: area, id: randomUUID() },
      });
    });
    return { area, targetId };
  }

  describe('filters', () => {
    it('filter the trail by area, action, target and dates', async () => {
      const { area, targetId } = await probe();
      const list = async (q: string) =>
        auditEventPageSchema.parse(
          (await get(`/audit/events?limit=100&${q}`, 'sofia.auditora')).json(),
        ).items;
      expect(await list(`action=${area}`)).toHaveLength(3);
      expect(await list(`action=${area}.created`)).toHaveLength(2);
      expect(
        (await list(`targetType=${area}&targetId=${targetId}`)).map((i) => i.action).sort(),
      ).toEqual([`${area}.changed`, `${area}.created`].sort());
      const future = new Date(Date.now() + 3_600_000).toISOString();
      expect(await list(`action=${area}&from=${encodeURIComponent(future)}`)).toHaveLength(0);
      expect((await get('/audit/events?action=Bad-Action', 'sofia.auditora')).statusCode).toBe(400);
    });
  });

  describe('signed export', () => {
    it('exports CSV with its SHA-256 and a signature the public JWKS verifies; the export is audited', async () => {
      const { area } = await probe();
      const res = await get(`/audit/export?format=csv&action=${area}`, 'marta.regulador');
      expect(res.statusCode, res.body).toBe(200);
      const body = res.rawPayload;
      const sha = createHash('sha256').update(body).digest('hex');
      expect(res.headers['x-den-export-sha256']).toBe(sha);
      expect(res.headers['x-den-export-count']).toBe('3');
      const lines = body.toString('utf8').trim().split('\r\n');
      expect(lines[0]).toContain('seq,occurredAt');
      expect(lines).toHaveLength(4);
      // Formulas are neutralised.
      expect(body.toString('utf8')).not.toMatch(/(^|,)"=/m);

      const jwks = (await app.inject({ method: 'GET', url: '/api/v1/transparency/jwks' })).json<{
        keys: JWK[];
      }>();
      const jws = String(res.headers['x-den-export-signature']);
      const { protectedHeader } = await compactVerify(jws, async (header) => {
        const key = jwks.keys.find((k) => k.kid === header.kid);
        return importJWK(key ?? {}, 'EdDSA');
      });
      expect(protectedHeader.typ).toBe('den-audit-export+jws');
      const manifest = JSON.parse(
        Buffer.from(jws.split('.')[1] ?? '', 'base64url').toString('utf8'),
      ) as Record<string, unknown>;
      expect(manifest).toMatchObject({
        sha256: sha,
        format: 'csv',
        count: 3,
        filters: { action: area },
      });

      const exported = await prisma.auditEvent.findFirstOrThrow({
        where: { action: 'audit.exported', targetId: sha },
      });
      expect(exported.actorId).toBe(user('marta.regulador')?.id);
    });

    it('exports JSON with every field, hashes included', async () => {
      const { area } = await probe();
      const res = await get(`/audit/export?format=json&action=${area}`, 'sofia.auditora');
      expect(res.statusCode).toBe(200);
      const records = JSON.parse(res.body) as Array<Record<string, unknown>>;
      expect(records).toHaveLength(3);
      expect(records[0]).toEqual(
        expect.objectContaining({
          hash: expect.any(String) as string,
          prevHash: expect.any(String) as string,
        }),
      );
    });

    it('is only for the operator, the regulator and auditors', async () => {
      for (const who of ['lucia.datos', 'carlos.dev', 'elena.admin']) {
        expect((await get('/audit/export?format=csv', who)).statusCode).toBe(403);
      }
    });
  });

  describe('daily anchors', () => {
    // Two days ahead: today's events are a finished day too, so the anchors do not depend on a
    // database that already holds events of earlier days (a fresh one in CI has only today's).
    const later = () => new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);

    it('anchors finished days with a time-stamp, once, and e-mails the regulators', async () => {
      const service = app.get(AuditAnchorService);
      await service.anchorDue(later());
      expect(await service.anchorDue(later())).toEqual([]);
      const latest = await prisma.auditAnchor.findFirstOrThrow({ orderBy: { day: 'desc' } });
      const event = await prisma.auditEvent.findUniqueOrThrow({ where: { seq: latest.lastSeq } });
      expect(event.hash).toBe(latest.lastHash);
      expect(latest.tsaToken.length).toBeGreaterThan(100);
      expect(
        await prisma.auditEvent.count({
          where: { action: 'audit.anchored', targetId: latest.day },
        }),
      ).toBe(1);

      sent.length = 0;
      await service.email({ day: latest.day });
      expect(sent.find((m) => m.to === user('marta.regulador')?.email)?.text).toContain(
        latest.lastHash,
      );
    });

    it('verification reports an anchor whose event is gone (the tail was cut)', async () => {
      await app.get(AuditAnchorService).anchorDue(later());
      const ok = chainCheckSchema.parse((await get('/audit/verify', 'sofia.auditora')).json());
      expect(ok.anchors.checked).toBeGreaterThan(0);
      expect(ok.anchors.problems).toEqual([]);
      // The owner, triggers off, plants an anchor for an event that does not exist.
      const day = '2999-12-31';
      await owner.query('ALTER TABLE audit_anchor DISABLE TRIGGER USER');
      try {
        await owner.query(
          `INSERT INTO audit_anchor (day, last_seq, last_hash, tsa_token, tsa_gen_time) VALUES ($1, 9223372036854775000, 'x', '\\x00', now())`,
          [day],
        );
        const check = chainCheckSchema.parse((await get('/audit/verify', 'sofia.auditora')).json());
        expect(check.valid).toBe(false);
        expect(check.anchors.problems).toContainEqual({ day, reason: 'event_missing' });
      } finally {
        await owner.query('DELETE FROM audit_anchor WHERE day = $1', [day]);
        await owner.query('ALTER TABLE audit_anchor ENABLE TRIGGER USER');
      }
    });

    it('verification checks the RFC 3161 token of each anchor and rejects future dates (B-02)', async () => {
      await app.get(AuditAnchorService).anchorDue(later());
      const real = await prisma.auditAnchor.findFirstOrThrow({ orderBy: { day: 'desc' } });
      const ok = chainCheckSchema.parse((await get('/audit/verify', 'sofia.auditora')).json());
      expect(ok.anchors.timestampsChecked).toBe(true);
      expect(ok.anchors.problems).toEqual([]);
      // An anchor of an existing event, dated ahead, with a token that stamps nothing.
      const day = '2999-12-30';
      await owner.query('ALTER TABLE audit_anchor DISABLE TRIGGER USER');
      try {
        await owner.query(
          `INSERT INTO audit_anchor (day, last_seq, last_hash, tsa_token, tsa_gen_time) VALUES ($1, $2, $3, $4, now() + interval '3 days')`,
          [day, real.lastSeq.toString(), real.lastHash, Buffer.from('not a token')],
        );
        const check = chainCheckSchema.parse((await get('/audit/verify', 'sofia.auditora')).json());
        expect(check.valid).toBe(false);
        expect(check.anchors.problems).toEqual(
          expect.arrayContaining([
            { day, reason: 'timestamp_invalid' },
            { day, reason: 'future_dated' },
          ]),
        );
        // A token that is not the anchor's: the real one, stored under another anchor's hash.
        await owner.query('DELETE FROM audit_anchor WHERE day = $1', [day]);
        await owner.query(
          `INSERT INTO audit_anchor (day, last_seq, last_hash, tsa_token, tsa_gen_time) VALUES ($1, $2, $3, $4, $5)`,
          [day, real.lastSeq.toString(), real.lastHash, real.tsaToken, new Date(0)],
        );
        const swapped = chainCheckSchema.parse(
          (await get('/audit/verify', 'sofia.auditora')).json(),
        );
        // The genTime kept beside the token is not the token's.
        expect(swapped.anchors.problems).toContainEqual({ day, reason: 'timestamp_invalid' });
      } finally {
        await owner.query('DELETE FROM audit_anchor WHERE day = $1', [day]);
        await owner.query('ALTER TABLE audit_anchor ENABLE TRIGGER USER');
      }
    });

    it('the anchor e-mail carries the time-stamp token (B-02)', async () => {
      await app.get(AuditAnchorService).anchorDue(later());
      const latest = await prisma.auditAnchor.findFirstOrThrow({ orderBy: { day: 'desc' } });
      sent.length = 0;
      await app.get(AuditAnchorService).email({ day: latest.day });
      const attachment = sent[0]?.attachments?.[0];
      expect(attachment?.filename).toBe(`anchor-${latest.day}.tsr`);
      expect(Buffer.compare(attachment?.content ?? Buffer.alloc(0), latest.tsaToken)).toBe(0);
    });

    it('anchors cannot be changed or deleted, not even by the schema owner', async () => {
      await app.get(AuditAnchorService).anchorDue(later());
      const latest = await prisma.auditAnchor.findFirstOrThrow({ orderBy: { day: 'desc' } });
      await expect(
        prisma.auditAnchor.update({ where: { day: latest.day }, data: { lastHash: 'x' } }),
      ).rejects.toThrow(/permission denied/);
      await expect(prisma.auditAnchor.delete({ where: { day: latest.day } })).rejects.toThrow(
        /permission denied/,
      );
      await expect(
        owner.query('UPDATE audit_anchor SET last_hash = $1 WHERE day = $2', ['x', latest.day]),
      ).rejects.toThrow(/insert-only/);
      await expect(
        owner.query('DELETE FROM audit_anchor WHERE day = $1', [latest.day]),
      ).rejects.toThrow(/insert-only/);
    });
  });

  it('the audit trail cannot be changed or deleted by the schema owner either', async () => {
    const targetId = randomUUID();
    await prisma.$transaction((tx) =>
      audit.record(tx, {
        actor: { type: 'system', id: 'test' },
        action: 'probe.owner',
        target: { type: 'probe', id: targetId },
      }),
    );
    const { seq } = await prisma.auditEvent.findFirstOrThrow({ where: { targetId } });
    await expect(
      owner.query('UPDATE audit_event SET action = $1 WHERE seq = $2', [
        'probe.tampered',
        seq.toString(),
      ]),
    ).rejects.toThrow();
    await expect(
      owner.query('DELETE FROM audit_event WHERE seq = $1', [seq.toString()]),
    ).rejects.toThrow();
    await expect(owner.query('TRUNCATE audit_event')).rejects.toThrow();
    expect(await prisma.auditEvent.count({ where: { seq } })).toBe(1);
  });

  describe('the chain trigger (B-01)', () => {
    const forged = `INSERT INTO audit_event (seq, occurred_at, actor_type, actor_id, action, target_type, target_id, prev_hash, hash)
      SELECT seq + $1, $2::timestamptz, 'system', 'forger', 'probe.forged', 'probe', 'x', hash, repeat('a', 64)
      FROM audit_event ORDER BY seq DESC LIMIT 1`;

    it('is not fooled by a temporary table of the same name (search_path)', async () => {
      await expect(
        prisma.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(
            'CREATE TEMP TABLE audit_event (seq bigint, hash text, occurred_at timestamptz)',
          );
          // seq jumps by 5: the real table says no, an empty temp table would say nothing.
          await tx.$executeRawUnsafe(
            forged.replaceAll('audit_event', 'public.audit_event'),
            5,
            new Date().toISOString(),
          );
        }),
      ).rejects.toThrow(/does not follow/);
    });

    it('a transaction longer than the skew still appends its events at commit', async () => {
      // The owner shortens the skew to 1 s (den_app cannot) and the transaction outlives it.
      await owner.query('BEGIN');
      try {
        await owner.query("SET LOCAL den.audit_clock_skew_seconds = '1'");
        await owner.query('SELECT pg_sleep(2.5)');
        // Wall-clock time of the INSERT, as the API stamps at append time: fine (now() would not be).
        await owner.query(
          forged.replace('$2::timestamptz', 'clock_timestamp()').replace('$2', '$2'),
          [1],
        );
        // The bound itself is active: five seconds ahead is rejected.
        await owner.query('SAVEPOINT s');
        await expect(
          owner.query(
            forged.replace('$2::timestamptz', "clock_timestamp() + interval '5 seconds'"),
            [1],
          ),
        ).rejects.toThrow(/future/);
      } finally {
        await owner.query('ROLLBACK');
      }
    });

    it('den_app cannot loosen the skew', async () => {
      await expect(
        prisma.$transaction(async (tx) => {
          await tx.$executeRawUnsafe("SET LOCAL den.audit_clock_skew_seconds = '100000000'");
          await tx.$executeRawUnsafe(forged, 1, new Date(Date.now() + 3_600_000).toISOString());
        }),
      ).rejects.toThrow(/future/);
    });
  });
});
