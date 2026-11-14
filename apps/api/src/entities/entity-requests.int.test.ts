import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { loadCountryConfig } from '@rid/config';
import {
  entityRequestSchema,
  type EntityRequest,
  invitationListSchema,
  meResponseSchema,
} from '@rid/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, createTestIssuer, type TestIssuer } from '../../test/test-auth.js';
import { AuditService } from '../audit/audit.service.js';
import { MAIL_TRANSPORT, type MailMessage } from '../mail/mail.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { readRealmUsers } from '../seed/realm.js';
import { runSeed } from '../seed/seed.js';
import { INVITATION_EMAIL_TOPIC, InvitationsService } from './invitations.service.js';

const PDF = Buffer.from('%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\ntrailer << >>\n%%EOF\n');

interface Person {
  sub: string;
  email: string;
  name: string;
  verified?: boolean;
}

const person = (label: string): Person => {
  const id = randomUUID().slice(0, 8);
  return { sub: randomUUID(), email: `${label}.${id}@example.org`, name: `${label} ${id}` };
};

describe('entity onboarding (M2-01)', () => {
  const prisma = new PrismaService();
  const realmUsers = readRealmUsers();
  const subOf = (username: string) => realmUsers.find((u) => u.username === username)?.id ?? '';
  const sent: MailMessage[] = [];
  const documentsDir = mkdtempSync(join(tmpdir(), 'rid-documents-'));
  let app: NestFastifyApplication;
  let issuer: TestIssuer;

  beforeAll(async () => {
    process.env.RID_DOCUMENTS_DIR = documentsDir;
    await runSeed(prisma, new AuditService(), {
      config: loadCountryConfig({ code: 'co' }),
      realmUsers,
    });
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
    await prisma.$disconnect();
    rmSync(documentsDir, { recursive: true, force: true });
  });

  const emailOf = (username: string) => realmUsers.find((u) => u.username === username)?.email;
  const token = (who: string | Person) =>
    typeof who === 'string'
      ? issuer.token(subOf(who), { email: emailOf(who), emailVerified: true })
      : issuer.token(who.sub, {
          email: who.email,
          name: who.name,
          emailVerified: who.verified ?? true,
        });

  const call = async (
    method: 'GET' | 'POST' | 'PUT',
    url: string,
    who: string | Person,
    payload?: unknown,
  ) =>
    app.inject({
      method,
      url: `/api/v1${url}`,
      headers: { authorization: `Bearer ${await token(who)}` },
      ...(payload !== undefined ? { payload: payload as object } : {}),
    });

  const upload = async (
    requestId: string,
    who: string | Person,
    body: Buffer,
    type = 'application/pdf',
  ) =>
    app.inject({
      method: 'PUT',
      url: `/api/v1/entity-requests/${requestId}/designation-document?fileName=designacion.pdf`,
      headers: { authorization: `Bearer ${await token(who)}`, 'content-type': type },
      payload: body,
    });

  const input = (steward: Person, lead: Person) => {
    const id = randomUUID().slice(0, 8);
    return {
      legalName: `Instituto de Pruebas ${id}`,
      shortName: `IP ${id}`,
      slug: `ip-${id}`,
      taxIdType: 'NIT',
      taxId: `9${Math.floor(Math.random() * 1e8)}`,
      kind: 'national',
      sector: 'salud',
      contactEmail: `contacto.${id}@example.org`,
      website: 'https://ip.example.org',
      dpoName: 'Dora Protección',
      dpoEmail: `dpo.${id}@example.org`,
      designees: {
        data_steward: { fullName: steward.name, email: steward.email.toUpperCase() },
        technical_lead: { fullName: lead.name, email: lead.email },
      },
    };
  };

  /** A request filed, documented and submitted by a fresh applicant. */
  async function submitted() {
    const applicant = person('solicitante');
    const steward = person('datos');
    const lead = person('tecnico');
    const created = await call('POST', '/entity-requests', applicant, input(steward, lead));
    expect(created.statusCode, created.body).toBe(201);
    const request = entityRequestSchema.parse(created.json());
    expect((await upload(request.id, applicant, PDF)).statusCode).toBe(200);
    const submit = await call('POST', `/entity-requests/${request.id}/submit`, applicant);
    expect(submit.statusCode, submit.body).toBe(200);
    return { applicant, steward, lead, request: entityRequestSchema.parse(submit.json()) };
  }

  const audited = (targetId: string) =>
    prisma.auditEvent.findMany({ where: { targetId }, orderBy: { seq: 'asc' } });

  describe('the applicant', () => {
    it('files a request that stays in `requested`, normalizes e-mails and audits it', async () => {
      const applicant = person('solicitante');
      const steward = person('datos');
      const res = await call(
        'POST',
        '/entity-requests',
        applicant,
        input(steward, person('tecnico')),
      );
      expect(res.statusCode, res.body).toBe(201);
      const request = entityRequestSchema.parse(res.json());
      expect(request.status).toBe('requested');
      expect(request.applicant?.email).toBe(applicant.email);
      expect(request.designees.find((d) => d.role === 'data_steward')?.email).toBe(steward.email);
      expect((await audited(request.id)).map((e) => e.action)).toEqual(['entity.requested']);

      const mine = await call('GET', '/entity-requests', applicant);
      expect(mine.json<{ items: Array<{ id: string }> }>().items.map((i) => i.id)).toEqual([
        request.id,
      ]);
      // Filing a request gives no role at all (ADR-0018).
      const me = meResponseSchema.parse((await call('GET', '/me', applicant)).json());
      expect(me.memberships).toEqual([]);
    });

    it('rejects unknown sectors and identifier types from the country config', async () => {
      const body = { ...input(person('d'), person('t')), sector: 'astrologia', taxIdType: 'RUT' };
      const res = await call('POST', '/entity-requests', person('solicitante'), body);
      expect(res.statusCode).toBe(400);
      const paths = res.json<{ errors: Array<{ path: string }> }>().errors.map((e) => e.path);
      expect(paths).toEqual(expect.arrayContaining(['sector', 'taxIdType']));
    });

    it('cannot take the identifier or tax id of an active entity, nor a reserved slug', async () => {
      const applicant = person('solicitante');
      const salud = await prisma.entity.findFirstOrThrow({ where: { slug: 'salud' } });
      const taken = await call('POST', '/entity-requests', applicant, {
        ...input(person('d'), person('t')),
        slug: 'salud',
      });
      expect(taken.statusCode).toBe(400);
      expect(taken.json<{ errors: Array<{ path: string }> }>().errors[0]?.path).toBe('slug');
      const tax = await call('POST', '/entity-requests', applicant, {
        ...input(person('d'), person('t')),
        taxId: salud.taxId,
      });
      expect(tax.statusCode).toBe(400);
      expect(tax.json<{ errors: Array<{ path: string }> }>().errors[0]?.path).toBe('taxId');
      const reserved = await call('POST', '/entity-requests', applicant, {
        ...input(person('d'), person('t')),
        slug: 'internal',
      });
      expect(reserved.statusCode).toBe(400);
    });

    it('needs a verified e-mail to file a request', async () => {
      const res = await call(
        'POST',
        '/entity-requests',
        { ...person('s'), verified: false },
        input(person('d'), person('t')),
      );
      expect(res.statusCode).toBe(403);
    });

    it('drafts claim nothing: the first request submitted gets the identifier and tax id', async () => {
      const first = person('primero');
      const second = person('segundo');
      const body = input(person('d'), person('t'));
      const a = entityRequestSchema.parse(
        (await call('POST', '/entity-requests', first, body)).json(),
      );
      const created = await call('POST', '/entity-requests', second, body);
      expect(created.statusCode, created.body).toBe(201);
      const b = entityRequestSchema.parse(created.json());
      for (const [who, id] of [
        [first, a.id],
        [second, b.id],
      ] as const) {
        expect((await upload(id, who, PDF)).statusCode).toBe(200);
      }
      expect((await call('POST', `/entity-requests/${b.id}/submit`, second)).statusCode).toBe(200);
      const late = await call('POST', `/entity-requests/${a.id}/submit`, first);
      expect(late.statusCode).toBe(400);
      expect(late.json<{ errors: Array<{ path: string }> }>().errors[0]?.path).toBe('slug');
      // Nor can a new draft take what a submitted request holds.
      const third = await call('POST', '/entity-requests', person('tercero'), body);
      expect(third.statusCode).toBe(400);
    });

    it('may have at most three open requests', async () => {
      const applicant = person('solicitante');
      for (let i = 0; i < 3; i++) {
        const res = await call(
          'POST',
          '/entity-requests',
          applicant,
          input(person('d'), person('t')),
        );
        expect(res.statusCode).toBe(201);
      }
      const fourth = await call(
        'POST',
        '/entity-requests',
        applicant,
        input(person('d'), person('t')),
      );
      expect(fourth.statusCode).toBe(409);
    });

    it('edits the request, attaches a PDF and cannot submit without it', async () => {
      const applicant = person('solicitante');
      const created = entityRequestSchema.parse(
        (await call('POST', '/entity-requests', applicant, input(person('d'), person('t')))).json(),
      );
      const early = await call('POST', `/entity-requests/${created.id}/submit`, applicant);
      expect(early.statusCode).toBe(400);

      const changed = await call('PUT', `/entity-requests/${created.id}`, applicant, {
        ...input(person('d'), person('t')),
        slug: created.slug,
        taxId: created.taxId,
        shortName: 'Nombre corregido',
      });
      expect(changed.statusCode, changed.body).toBe(200);
      expect(entityRequestSchema.parse(changed.json()).shortName).toBe('Nombre corregido');

      const res = await upload(created.id, applicant, PDF);
      expect(res.statusCode, res.body).toBe(200);
      const doc = entityRequestSchema.parse(res.json()).designationDocument;
      expect(doc).toMatchObject({
        fileName: 'designacion.pdf',
        size: PDF.length,
        mimeType: 'application/pdf',
      });

      const download = await call(
        'GET',
        `/entity-requests/${created.id}/designation-document`,
        applicant,
      );
      expect(download.statusCode).toBe(200);
      expect(download.headers['content-type']).toBe('application/pdf');
      expect(download.headers['x-content-type-options']).toBe('nosniff');
      expect(download.rawPayload.equals(PDF)).toBe(true);

      const actions = (await audited(created.id)).map((e) => e.action);
      expect(actions).toEqual(['entity.requested', 'entity.request_updated']);
      const uploaded = await prisma.auditEvent.findFirstOrThrow({
        where: { action: 'document.uploaded', targetId: doc?.id ?? '' },
      });
      expect(uploaded.after).toMatchObject({ entityId: created.id, sha256: doc?.sha256 });
    });

    it('only accepts PDF bodies, and refuses anonymous uploads before reading them', async () => {
      const applicant = person('solicitante');
      const created = entityRequestSchema.parse(
        (await call('POST', '/entity-requests', applicant, input(person('d'), person('t')))).json(),
      );
      const notPdf = await upload(created.id, applicant, Buffer.from('MZ not a pdf'));
      expect(notPdf.statusCode).toBe(415);
      const json = await call(
        'PUT',
        `/entity-requests/${created.id}/designation-document`,
        applicant,
        {
          pdf: 'no',
        },
      );
      expect(json.statusCode).toBe(415);
      const anonymous = await app.inject({
        method: 'PUT',
        url: `/api/v1/entity-requests/${created.id}/designation-document`,
        headers: { 'content-type': 'application/pdf' },
        payload: PDF,
      });
      expect(anonymous.statusCode).toBe(401);
    });

    it('rejects documents above the size limit with 413', async () => {
      const applicant = person('solicitante');
      const created = entityRequestSchema.parse(
        (await call('POST', '/entity-requests', applicant, input(person('d'), person('t')))).json(),
      );
      const big = Buffer.concat([PDF, Buffer.alloc(10 * 1024 * 1024)]);
      const res = await upload(created.id, applicant, big);
      expect(res.statusCode).toBe(413);
    });

    it('cannot change the request once it is under review', async () => {
      const { applicant, request } = await submitted();
      const res = await upload(request.id, applicant, PDF);
      expect(res.statusCode).toBe(409);
    });
  });

  describe('authorization', () => {
    it('hides a request from other users (404) and shows it to the operator and the regulator', async () => {
      const { request } = await submitted();
      for (const who of [person('otro'), 'elena.admin', 'sofia.auditora']) {
        expect((await call('GET', `/entity-requests/${request.id}`, who)).statusCode).toBe(404);
        expect(
          (await call('GET', `/entity-requests/${request.id}/designation-document`, who))
            .statusCode,
        ).toBe(404);
      }
      for (const who of ['ana.operadora', 'pablo.plataforma', 'marta.regulador']) {
        expect((await call('GET', `/entity-requests/${request.id}`, who)).statusCode).toBe(200);
      }
    });

    it('lets only the operator (not the regulator, auditor or members) see the queue and decide', async () => {
      const { request } = await submitted();
      const queue = await call('GET', '/review/entities', 'ana.operadora');
      expect(queue.statusCode).toBe(200);
      expect(queue.json<{ items: Array<{ id: string }> }>().items.map((i) => i.id)).toContain(
        request.id,
      );
      expect((await call('GET', '/review/entities', 'marta.regulador')).statusCode).toBe(200);
      for (const who of ['sofia.auditora', 'elena.admin', person('nadie')]) {
        expect((await call('GET', '/review/entities', who)).statusCode).toBe(403);
      }
      for (const who of ['marta.regulador', 'sofia.auditora', 'elena.admin']) {
        const res = await call('POST', `/review/entities/${request.id}/approve`, who, {});
        expect(res.statusCode).toBe(403);
      }
    });

    it('does not let someone else edit or submit the request', async () => {
      const applicant = person('solicitante');
      const created = entityRequestSchema.parse(
        (await call('POST', '/entity-requests', applicant, input(person('d'), person('t')))).json(),
      );
      expect((await upload(created.id, person('intruso'), PDF)).statusCode).toBe(404);
      // The operator can read the request but it is not theirs to change.
      expect((await upload(created.id, 'ana.operadora', PDF)).statusCode).toBe(403);
      expect(
        (await call('POST', `/entity-requests/${created.id}/submit`, person('x'))).statusCode,
      ).toBe(404);
    });

    it('never treats seeded entities as requests', async () => {
      const salud = await prisma.entity.findFirstOrThrow({ where: { slug: 'salud' } });
      expect((await call('GET', `/entity-requests/${salud.id}`, 'ana.operadora')).statusCode).toBe(
        404,
      );
    });
  });

  describe('the operator', () => {
    it('sends the request back with a comment; the applicant fixes and resubmits', async () => {
      const { applicant, request } = await submitted();
      const short = await call(
        'POST',
        `/review/entities/${request.id}/request-changes`,
        'ana.operadora',
        {
          comment: 'corto',
        },
      );
      expect(short.statusCode).toBe(400);
      const back = await call(
        'POST',
        `/review/entities/${request.id}/request-changes`,
        'ana.operadora',
        {
          comment: 'El documento de designación no está firmado.',
        },
      );
      expect(back.statusCode, back.body).toBe(200);
      const returned = entityRequestSchema.parse(back.json());
      expect(returned.status).toBe('requested');
      expect(returned.reviews).toMatchObject([
        { decision: 'changes_requested', reviewerRole: 'platform_reviewer' },
      ]);

      const seen = entityRequestSchema.parse(
        (await call('GET', `/entity-requests/${request.id}`, applicant)).json(),
      );
      expect(seen.reviews[0]?.comment).toBe('El documento de designación no está firmado.');
      expect((await upload(request.id, applicant, PDF)).statusCode).toBe(200);
      expect(
        (await call('POST', `/entity-requests/${request.id}/submit`, applicant)).statusCode,
      ).toBe(200);
      expect((await audited(request.id)).map((e) => e.action)).toEqual([
        'entity.requested',
        'entity.submitted',
        'entity.changes_requested',
        'entity.submitted',
      ]);
    });

    it('rejects with a reason; rejection is final and frees the identifier', async () => {
      const { applicant, request } = await submitted();
      const res = await call('POST', `/review/entities/${request.id}/reject`, 'ana.operadora', {
        comment: 'La entidad no es una autoridad pública.',
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(entityRequestSchema.parse(res.json())).toMatchObject({ status: 'rejected' });
      const again = await call(
        'POST',
        `/review/entities/${request.id}/approve`,
        'pablo.plataforma',
        {},
      );
      expect(again.statusCode).toBe(409);

      const retry = await call('POST', '/entity-requests', applicant, {
        ...input(person('d'), person('t')),
        slug: request.slug,
        taxId: request.taxId,
      });
      expect(retry.statusCode, retry.body).toBe(201);
    });

    it('cannot decide on a request they filed or that designates them', async () => {
      const ana = realmUsers.find((u) => u.username === 'ana.operadora');
      const applicant = person('solicitante');
      const body = input({ ...person('d'), email: ana?.email ?? '' }, person('t'));
      const created = entityRequestSchema.parse(
        (await call('POST', '/entity-requests', applicant, body)).json(),
      );
      await upload(created.id, applicant, PDF);
      await call('POST', `/entity-requests/${created.id}/submit`, applicant);
      const res = await call('POST', `/review/entities/${created.id}/approve`, 'ana.operadora', {});
      expect(res.statusCode).toBe(403);

      const own = entityRequestSchema.parse(
        (
          await call(
            'POST',
            '/entity-requests',
            'pablo.plataforma',
            input(person('d'), person('t')),
          )
        ).json(),
      );
      await upload(own.id, 'pablo.plataforma', PDF);
      await call('POST', `/entity-requests/${own.id}/submit`, 'pablo.plataforma');
      const self = await call('POST', `/review/entities/${own.id}/approve`, 'pablo.plataforma', {});
      expect(self.statusCode).toBe(403);
    });

    it('approves: the entity is active, the applicant is entity_admin and the designees are invited', async () => {
      const { applicant, steward, lead, request } = await submitted();
      const res = await call('POST', `/review/entities/${request.id}/approve`, 'ana.operadora', {
        comment: 'Designación en regla.',
      });
      expect(res.statusCode, res.body).toBe(200);
      const approved: EntityRequest = entityRequestSchema.parse(res.json());
      expect(approved.status).toBe('active');
      expect(approved.decidedAt).not.toBeNull();

      const me = meResponseSchema.parse((await call('GET', '/me', applicant)).json());
      expect(me.memberships).toEqual([
        {
          entity: { id: request.id, slug: request.slug, shortName: request.shortName },
          roles: ['entity_admin'],
        },
      ]);

      const invitations = await prisma.invitation.findMany({ where: { entityId: request.id } });
      expect(invitations.map((i) => [i.email, [...i.roles].sort()]).sort()).toEqual(
        [
          [steward.email, ['data_steward']],
          [lead.email, ['api_publisher', 'app_developer']],
        ].sort(),
      );
      const outbox = await prisma.outboxMessage.findMany({
        where: {
          topic: INVITATION_EMAIL_TOPIC,
          aggregate: { in: invitations.map((i) => `invitation:${i.id}`) },
        },
      });
      expect(outbox).toHaveLength(2);

      const actions = (await audited(request.id)).map((e) => e.action);
      expect(actions).toContain('entity.approved');
      for (const invitation of invitations) {
        expect((await audited(invitation.id)).map((e) => e.action)).toEqual(['invitation.created']);
      }

      // The e-mail points to the portal; it carries no secret and names the entity.
      const invitation = invitations.find((i) => i.email === steward.email);
      await app.get(InvitationsService).sendEmail({ invitationId: invitation?.id });
      const mail = sent.find((m) => m.to === steward.email);
      expect(mail?.subject).toContain(request.shortName);
      expect(mail?.text).toContain('http://localhost:3000/invitations');
      expect(mail?.text).toContain('responsable de datos');
    });

    it('merges the applicant’s own designation into their membership instead of inviting them', async () => {
      const applicant = person('solicitante');
      const body = input(applicant, person('t'));
      const created = entityRequestSchema.parse(
        (await call('POST', '/entity-requests', applicant, body)).json(),
      );
      await upload(created.id, applicant, PDF);
      await call('POST', `/entity-requests/${created.id}/submit`, applicant);
      await call('POST', `/review/entities/${created.id}/approve`, 'ana.operadora', {});
      const me = meResponseSchema.parse((await call('GET', '/me', applicant)).json());
      expect(me.memberships[0]?.roles.sort()).toEqual(['data_steward', 'entity_admin']);
      expect(await prisma.invitation.count({ where: { entityId: created.id } })).toBe(1);
    });
  });

  describe('invitations', () => {
    async function approved() {
      const flow = await submitted();
      await call('POST', `/review/entities/${flow.request.id}/approve`, 'ana.operadora', {});
      return flow;
    }

    it('shows the invitation only to the invited, verified address and grants its roles on accept', async () => {
      const { steward, request } = await approved();
      expect(
        invitationListSchema.parse((await call('GET', '/me/invitations', person('x'))).json())
          .items,
      ).toEqual([]);
      const unverified = { ...steward, verified: false };
      expect(
        invitationListSchema.parse((await call('GET', '/me/invitations', unverified)).json()).items,
      ).toEqual([]);

      const list = invitationListSchema.parse(
        (await call('GET', '/me/invitations', steward)).json(),
      );
      expect(list.items).toHaveLength(1);
      const [invitation] = list.items;
      expect(invitation?.entity.id).toBe(request.id);
      expect(invitation?.roles).toEqual(['data_steward']);

      // Somebody else cannot accept it, not even knowing its id.
      expect(
        (await call('POST', `/me/invitations/${invitation?.id}/accept`, person('x'))).statusCode,
      ).toBe(404);

      const accepted = await call('POST', `/me/invitations/${invitation?.id}/accept`, steward);
      expect(accepted.statusCode, accepted.body).toBe(200);
      expect(accepted.json()).toMatchObject({
        entity: { id: request.id },
        roles: ['data_steward'],
      });
      const me = meResponseSchema.parse((await call('GET', '/me', steward)).json());
      expect(me.memberships.map((m) => m.entity.id)).toEqual([request.id]);
      // The steward can now act inside the entity: its inbox answers instead of 404.
      expect(
        (await call('GET', `/entities/${request.id}/access-requests`, steward)).statusCode,
      ).toBe(200);

      const twice = await call('POST', `/me/invitations/${invitation?.id}/accept`, steward);
      expect(twice.statusCode).toBe(409);
      expect((await audited(invitation?.id ?? '')).map((e) => e.action)).toEqual([
        'invitation.created',
        'invitation.accepted',
      ]);
    });

    it('requires a verified e-mail to answer', async () => {
      const { lead } = await approved();
      const [invitation] = invitationListSchema.parse(
        (await call('GET', '/me/invitations', lead)).json(),
      ).items;
      const res = await call('POST', `/me/invitations/${invitation?.id}/accept`, {
        ...lead,
        verified: false,
      });
      expect(res.statusCode).toBe(403);
    });

    it('can be declined, and an expired one cannot be accepted', async () => {
      const { steward, lead } = await approved();
      const [declined] = invitationListSchema.parse(
        (await call('GET', '/me/invitations', lead)).json(),
      ).items;
      const res = await call('POST', `/me/invitations/${declined?.id}/decline`, lead);
      expect(res.statusCode).toBe(204);
      expect(meResponseSchema.parse((await call('GET', '/me', lead)).json()).memberships).toEqual(
        [],
      );

      const [expiring] = invitationListSchema.parse(
        (await call('GET', '/me/invitations', steward)).json(),
      ).items;
      await prisma.invitation.update({
        where: { id: expiring?.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      const late = await call('POST', `/me/invitations/${expiring?.id}/accept`, steward);
      expect(late.statusCode).toBe(409);
    });

    it('does not e-mail an invitation that is no longer pending', async () => {
      const { lead } = await approved();
      const [invitation] = invitationListSchema.parse(
        (await call('GET', '/me/invitations', lead)).json(),
      ).items;
      await call('POST', `/me/invitations/${invitation?.id}/decline`, lead);
      const before = sent.length;
      await app.get(InvitationsService).sendEmail({ invitationId: invitation?.id });
      expect(sent.length).toBe(before);
    });
  });
});
