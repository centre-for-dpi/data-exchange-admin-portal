import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  entityInvitationListSchema,
  entityInvitationSchema,
  entityMemberSchema,
  type EntityRole,
  invitationListSchema,
  meResponseSchema,
} from '@rid/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, createTestIssuer, type TestIssuer } from '../../test/test-auth.js';
import { MAIL_TRANSPORT, type MailMessage } from '../mail/mail.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { INVITATION_EMAIL_TOPIC } from './invitations.service.js';

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

describe('members and invitations (M2-02)', () => {
  const prisma = new PrismaService();
  let app: NestFastifyApplication;
  let issuer: TestIssuer;

  beforeAll(async () => {
    issuer = await createTestIssuer();
    app = await createTestApp(issuer, [
      {
        token: MAIL_TRANSPORT,
        value: { send: () => Promise.resolve() } satisfies { send(m: MailMessage): Promise<void> },
      },
    ]);
  });
  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  const call = async (
    method: 'GET' | 'POST' | 'PUT',
    url: string,
    who: Person,
    payload?: unknown,
  ) =>
    app.inject({
      method,
      url: `/api/v1${url}`,
      headers: {
        authorization: `Bearer ${await issuer.token(who.sub, {
          email: who.email,
          name: who.name,
          emailVerified: who.verified ?? true,
        })}`,
      },
      ...(payload !== undefined ? { payload: payload as object } : {}),
    });

  /** Registers a person through the API (first call) and makes them a member with `roles`. */
  async function member(entityId: string, roles: EntityRole[], label = 'miembro') {
    const who = person(label);
    expect((await call('GET', '/me', who)).statusCode).toBe(200);
    const user = await prisma.user.findUniqueOrThrow({ where: { keycloakSub: who.sub } });
    const membership = await prisma.membership.create({
      data: { userId: user.id, entityId, roles, status: 'active', createdBy: 'test' },
    });
    return { who, membershipId: membership.id };
  }

  /** An active entity with one admin. */
  async function entity() {
    const id = randomUUID().slice(0, 8);
    const created = await prisma.entity.create({
      data: {
        legalName: `Entidad ${id}`,
        shortName: `E ${id}`,
        slug: `e-${id}`,
        taxIdType: 'NIT',
        taxId: `8${id}`,
        kind: 'national',
        sector: 'salud',
        status: 'active',
        contactEmail: `c.${id}@example.org`,
        dpoName: 'Dora',
        dpoEmail: `d.${id}@example.org`,
        createdBy: 'test',
      },
    });
    const admin = await member(created.id, ['entity_admin'], 'admin');
    return { entityId: created.id, admin };
  }

  const audited = (targetId: string) =>
    prisma.auditEvent.findMany({ where: { targetId }, orderBy: { seq: 'asc' } });

  it('the admin invites by e-mail; the invitee accepts and gets exactly the roles', async () => {
    const { entityId, admin } = await entity();
    const invitee = person('invitada');
    const res = await call('POST', `/entities/${entityId}/invitations`, admin.who, {
      email: invitee.email.toUpperCase(),
      fullName: invitee.name,
      roles: ['api_publisher', 'entity_viewer'],
    });
    expect(res.statusCode, res.body).toBe(201);
    const invitation = entityInvitationSchema.parse(res.json());
    expect(invitation).toMatchObject({ email: invitee.email, status: 'pending', expired: false });
    expect(
      await prisma.outboxMessage.count({
        where: { topic: INVITATION_EMAIL_TOPIC, aggregate: `invitation:${invitation.id}` },
      }),
    ).toBe(1);
    const [created] = await audited(invitation.id);
    expect(created).toMatchObject({ action: 'invitation.created', actorEntityId: entityId });

    const again = await call('POST', `/entities/${entityId}/invitations`, admin.who, {
      email: invitee.email,
      roles: ['entity_viewer'],
    });
    expect(again.statusCode).toBe(409);

    const list = entityInvitationListSchema.parse(
      (await call('GET', `/entities/${entityId}/invitations`, admin.who)).json(),
    );
    expect(list.items.map((i) => i.id)).toContain(invitation.id);

    const mine = invitationListSchema.parse((await call('GET', '/me/invitations', invitee)).json());
    expect(mine.items.map((i) => i.id)).toEqual([invitation.id]);
    expect(
      (await call('POST', `/me/invitations/${invitation.id}/accept`, invitee)).statusCode,
    ).toBe(200);
    const me = meResponseSchema.parse((await call('GET', '/me', invitee)).json());
    expect(me.memberships.find((m) => m.entity.id === entityId)?.roles.sort()).toEqual([
      'api_publisher',
      'entity_viewer',
    ]);

    const inviteMember = await call('POST', `/entities/${entityId}/invitations`, admin.who, {
      email: invitee.email,
      roles: ['data_steward'],
    });
    expect(inviteMember.statusCode).toBe(409);
  });

  it('validates the roles', async () => {
    const { entityId, admin } = await entity();
    for (const roles of [[], ['platform_admin'], ['entity_viewer', 'entity_viewer']]) {
      const res = await call('POST', `/entities/${entityId}/invitations`, admin.who, {
        email: person('x').email,
        roles,
      });
      expect(res.statusCode).toBe(400);
    }
  });

  it('a revoked invitation can no longer be accepted', async () => {
    const { entityId, admin } = await entity();
    const invitee = person('revocada');
    const invitation = entityInvitationSchema.parse(
      (
        await call('POST', `/entities/${entityId}/invitations`, admin.who, {
          email: invitee.email,
          roles: ['entity_viewer'],
        })
      ).json(),
    );
    const res = await call(
      'POST',
      `/entities/${entityId}/invitations/${invitation.id}/revoke`,
      admin.who,
    );
    expect(res.statusCode, res.body).toBe(200);
    expect(entityInvitationSchema.parse(res.json()).status).toBe('revoked');
    expect(
      (await call('POST', `/me/invitations/${invitation.id}/accept`, invitee)).statusCode,
    ).toBe(409);
    expect((await audited(invitation.id)).map((e) => e.action)).toEqual([
      'invitation.created',
      'invitation.revoked',
    ]);
  });

  it('an expired invitation is replaced by a new one to the same address', async () => {
    const { entityId, admin } = await entity();
    const invitee = person('vencida');
    const first = entityInvitationSchema.parse(
      (
        await call('POST', `/entities/${entityId}/invitations`, admin.who, {
          email: invitee.email,
          roles: ['entity_viewer'],
        })
      ).json(),
    );
    await prisma.invitation.update({
      where: { id: first.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const second = await call('POST', `/entities/${entityId}/invitations`, admin.who, {
      email: invitee.email,
      roles: ['entity_viewer'],
    });
    expect(second.statusCode, second.body).toBe(201);
    expect((await audited(first.id)).map((e) => e.action)).toEqual([
      'invitation.created',
      'invitation.expired',
    ]);
  });

  it('the admin changes roles; the change applies on the member’s next request', async () => {
    const { entityId, admin } = await entity();
    const dev = await member(entityId, ['entity_viewer']);
    const before = await call('POST', `/entities/${entityId}/applications`, dev.who, {
      name: 'App de prueba',
      description: 'Aplicación de prueba de roles.',
      environment: 'sandbox',
      technicalContact: 'dev@example.org',
    });
    expect(before.statusCode).toBe(403);
    const res = await call(
      'PUT',
      `/entities/${entityId}/members/${dev.membershipId}/roles`,
      admin.who,
      {
        roles: ['app_developer'],
      },
    );
    expect(res.statusCode, res.body).toBe(200);
    expect(entityMemberSchema.parse(res.json()).roles).toEqual(['app_developer']);
    const me = meResponseSchema.parse((await call('GET', '/me', dev.who)).json());
    expect(me.memberships.find((m) => m.entity.id === entityId)?.roles).toEqual(['app_developer']);
    const [event] = await audited(dev.membershipId);
    expect(event).toMatchObject({
      action: 'membership.roles_changed',
      before: { roles: ['entity_viewer'] },
      after: { roles: ['app_developer'] },
    });
  });

  it('a revoked member loses access on the next request', async () => {
    const { entityId, admin } = await entity();
    const viewer = await member(entityId, ['entity_viewer']);
    expect((await call('GET', `/entities/${entityId}`, viewer.who)).statusCode).toBe(200);
    const res = await call(
      'POST',
      `/entities/${entityId}/members/${viewer.membershipId}/revoke`,
      admin.who,
    );
    expect(res.statusCode, res.body).toBe(200);
    expect(entityMemberSchema.parse(res.json()).status).toBe('revoked');
    expect((await call('GET', `/entities/${entityId}`, viewer.who)).statusCode).toBe(404);
    const me = meResponseSchema.parse((await call('GET', '/me', viewer.who)).json());
    expect(me.memberships.map((m) => m.entity.id)).not.toContain(entityId);
    expect((await audited(viewer.membershipId)).map((e) => e.action)).toEqual([
      'membership.revoked',
    ]);
    expect(
      (await call('POST', `/entities/${entityId}/members/${viewer.membershipId}/revoke`, admin.who))
        .statusCode,
    ).toBe(409);
  });

  it('a revoked member can be invited back', async () => {
    const { entityId, admin } = await entity();
    const back = await member(entityId, ['api_publisher']);
    await call('POST', `/entities/${entityId}/members/${back.membershipId}/revoke`, admin.who);
    const invitation = entityInvitationSchema.parse(
      (
        await call('POST', `/entities/${entityId}/invitations`, admin.who, {
          email: back.who.email,
          roles: ['entity_viewer'],
        })
      ).json(),
    );
    expect(
      (await call('POST', `/me/invitations/${invitation.id}/accept`, back.who)).statusCode,
    ).toBe(200);
    const me = meResponseSchema.parse((await call('GET', '/me', back.who)).json());
    // A revoked membership does not keep its old roles: only the new invitation's.
    expect(me.memberships.find((m) => m.entity.id === entityId)?.roles).toEqual(['entity_viewer']);
  });

  it('never leaves the entity without an active administrator', async () => {
    const { entityId, admin } = await entity();
    const demote = await call(
      'PUT',
      `/entities/${entityId}/members/${admin.membershipId}/roles`,
      admin.who,
      {
        roles: ['entity_viewer'],
      },
    );
    expect(demote.statusCode).toBe(409);
    const self = await call(
      'POST',
      `/entities/${entityId}/members/${admin.membershipId}/revoke`,
      admin.who,
    );
    expect(self.statusCode).toBe(409);
    // With a second admin, the first can step down.
    await member(entityId, ['entity_admin'], 'admin2');
    expect(
      (await call('POST', `/entities/${entityId}/members/${admin.membershipId}/revoke`, admin.who))
        .statusCode,
    ).toBe(200);
  });

  it('withdraws the pending invitations of an admin who is revoked or demoted', async () => {
    const { entityId, admin } = await entity();
    const other = await member(entityId, ['entity_admin'], 'admin2');
    const third = await member(entityId, ['entity_admin'], 'admin3');
    const invite = async (who: Person) =>
      entityInvitationSchema.parse(
        (
          await call('POST', `/entities/${entityId}/invitations`, who, {
            email: person('alt').email,
            roles: ['entity_admin'],
          })
        ).json(),
      );
    const byRevoked = await invite(other.who);
    const byDemoted = await invite(third.who);
    const byAdmin = await invite(admin.who);

    expect(
      (await call('POST', `/entities/${entityId}/members/${other.membershipId}/revoke`, admin.who))
        .statusCode,
    ).toBe(200);
    expect(
      (
        await call('PUT', `/entities/${entityId}/members/${third.membershipId}/roles`, admin.who, {
          roles: ['entity_viewer'],
        })
      ).statusCode,
    ).toBe(200);

    const status = async (id: string) =>
      (await prisma.invitation.findUniqueOrThrow({ where: { id } })).status;
    expect(await status(byRevoked.id)).toBe('revoked');
    expect(await status(byDemoted.id)).toBe('revoked');
    expect(await status(byAdmin.id)).toBe('pending');
    expect((await audited(byRevoked.id)).at(-1)).toMatchObject({
      action: 'invitation.revoked',
      after: { reason: 'inviter_no_longer_admin' },
    });
  });

  describe('authorization', () => {
    it('only the entity_admin manages members (403 for other roles, 404 for other entities)', async () => {
      const { entityId } = await entity();
      const target = await member(entityId, ['entity_viewer'], 'objetivo');
      const writes = (who: Person, entity = entityId) => [
        call('POST', `/entities/${entity}/invitations`, who, {
          email: person('x').email,
          roles: ['entity_viewer'],
        }),
        call('PUT', `/entities/${entity}/members/${target.membershipId}/roles`, who, {
          roles: ['api_publisher'],
        }),
        call('POST', `/entities/${entity}/members/${target.membershipId}/revoke`, who),
      ];
      for (const roles of [
        ['api_publisher'],
        ['data_steward'],
        ['app_developer'],
        ['entity_viewer'],
      ] as EntityRole[][]) {
        const other = await member(entityId, roles);
        for (const res of await Promise.all(writes(other.who))) expect(res.statusCode).toBe(403);
      }
      const outsider = await entity();
      for (const res of await Promise.all(writes(outsider.admin.who)))
        expect(res.statusCode).toBe(404);
      // An admin of another entity cannot reach this entity's member through their own entity.
      const cross = await call(
        'POST',
        `/entities/${outsider.entityId}/members/${target.membershipId}/revoke`,
        outsider.admin.who,
      );
      expect(cross.statusCode).toBe(404);
    });

    it('lists invitations to admins and viewers only', async () => {
      const { entityId, admin } = await entity();
      expect((await call('GET', `/entities/${entityId}/invitations`, admin.who)).statusCode).toBe(
        200,
      );
      const viewer = await member(entityId, ['entity_viewer']);
      expect((await call('GET', `/entities/${entityId}/invitations`, viewer.who)).statusCode).toBe(
        200,
      );
      const dev = await member(entityId, ['app_developer']);
      expect((await call('GET', `/entities/${entityId}/invitations`, dev.who)).statusCode).toBe(
        403,
      );
      expect(
        (await call('GET', `/entities/${entityId}/invitations`, person('nadie'))).statusCode,
      ).toBe(404);
    });
  });
});
