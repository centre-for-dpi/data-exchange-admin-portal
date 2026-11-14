import { Injectable } from '@nestjs/common';
import type { EntityInvitation, EntityMember, EntityRole } from '@rid/contracts';
import { AuditService } from '../audit/audit.service.js';
import type { EntityContext } from '../auth/decorators.js';
import type { Principal } from '../auth/principal.service.js';
import { ConflictError, NotFoundError } from '../common/errors.js';
import { PrismaService, type Tx } from '../prisma/prisma.service.js';
import { scopedRepo } from '../prisma/scoped-repo.js';
import { InvitationsService } from './invitations.service.js';

const actorOf = (principal: Principal, entity: EntityContext) => ({
  type: 'user' as const,
  id: principal.keycloakSub,
  entityId: entity.entityId,
});

/**
 * Members of an entity, managed by its entity_admin (SPEC.md §2.2, M2-02): invite by e-mail,
 * change roles, revoke. Roles are read from PostgreSQL on every request (ADR-0004), so a revoked
 * member loses access on their next call. An entity always keeps at least one active admin.
 */
@Injectable()
export class MembersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly invitations: InvitationsService,
  ) {}

  private static invitationView(row: {
    id: string;
    email: string;
    fullName: string | null;
    roles: EntityRole[];
    status: EntityInvitation['status'];
    expiresAt: Date;
    createdAt: Date;
  }): EntityInvitation {
    return {
      id: row.id,
      email: row.email,
      fullName: row.fullName,
      roles: row.roles,
      status: row.status,
      expiresAt: row.expiresAt.toISOString(),
      expired: row.status === 'pending' && row.expiresAt <= new Date(),
      createdAt: row.createdAt.toISOString(),
    };
  }

  /** Invitations of the entity, newest first (pending ones are what the admin acts on). */
  async listInvitations(entity: EntityContext): Promise<{ items: EntityInvitation[] }> {
    const rows = await scopedRepo(this.prisma.invitation, entity.entityId).findMany({
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return { items: rows.map((r) => MembersService.invitationView(r)) };
  }

  async invite(
    entity: EntityContext,
    principal: Principal,
    input: { email: string; fullName?: string; roles: EntityRole[] },
    requestId?: string,
  ): Promise<EntityInvitation> {
    const member = await this.prisma.membership.findFirst({
      where: { entityId: entity.entityId, status: 'active', user: { email: input.email } },
    });
    if (member)
      throw new ConflictError('That person is already an active member; change their roles');
    const pending = await this.prisma.invitation.findFirst({
      where: {
        entityId: entity.entityId,
        email: input.email,
        status: 'pending',
        expiresAt: { gt: new Date() },
      },
    });
    if (pending) throw new ConflictError('There is already a pending invitation for that e-mail');
    const created = await this.prisma.$transaction((tx) =>
      this.invitations.createInTx(tx, {
        entityId: entity.entityId,
        email: input.email,
        fullName: input.fullName ?? null,
        roles: input.roles,
        invitedBy: principal.userId,
        createdBy: principal.userId,
        actor: actorOf(principal, entity),
        requestId,
      }),
    );
    return MembersService.invitationView(created);
  }

  async revokeInvitation(
    entity: EntityContext,
    principal: Principal,
    invitationId: string,
    requestId?: string,
  ): Promise<EntityInvitation> {
    const invitation = await scopedRepo(this.prisma.invitation, entity.entityId).findFirst({
      where: { id: invitationId },
    });
    if (!invitation) throw new NotFoundError('Invitation');
    if (invitation.status !== 'pending') {
      throw new ConflictError(`The invitation was already ${invitation.status}`);
    }
    const updated = await this.prisma.$transaction(async (tx) => {
      const changed = await tx.invitation.updateMany({
        where: { id: invitationId, entityId: entity.entityId, status: 'pending' },
        data: { status: 'revoked', respondedAt: new Date(), respondedBy: principal.userId },
      });
      if (changed.count === 0) throw new ConflictError('The invitation changed meanwhile');
      await this.audit.record(tx, {
        actor: actorOf(principal, entity),
        action: 'invitation.revoked',
        target: { type: 'invitation', id: invitationId },
        before: { status: 'pending' },
        after: { status: 'revoked' },
        requestId,
      });
      return tx.invitation.findUniqueOrThrow({ where: { id: invitationId } });
    });
    return MembersService.invitationView(updated);
  }

  private async loadMember(entity: EntityContext, membershipId: string) {
    const membership = await scopedRepo(this.prisma.membership, entity.entityId).findFirst({
      where: { id: membershipId },
    });
    if (!membership) throw new NotFoundError('Member');
    // The user is looked up only for a membership already scoped to this entity.
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: membership.userId },
      select: { id: true, fullName: true, email: true },
    });
    return { ...membership, user };
  }

  /**
   * Fails if the change would leave the entity without an active entity_admin. Runs inside the
   * transaction after a row lock on the entity, so two admins cannot demote each other at once.
   */
  private static async assertAdminRemains(tx: Tx, entityId: string): Promise<void> {
    await tx.$queryRaw`SELECT id FROM entity WHERE id = ${entityId}::uuid FOR UPDATE`;
    const admins = await tx.membership.count({
      where: { entityId, status: 'active', roles: { has: 'entity_admin' } },
    });
    if (admins === 0) {
      throw new ConflictError('The entity must keep at least one active administrator');
    }
  }

  private static view(m: {
    id: string;
    roles: EntityRole[];
    status: EntityMember['status'];
    user: { id: string; fullName: string; email: string };
  }): EntityMember {
    return { membershipId: m.id, user: m.user, roles: m.roles, status: m.status };
  }

  async updateRoles(
    entity: EntityContext,
    principal: Principal,
    membershipId: string,
    roles: EntityRole[],
    requestId?: string,
  ): Promise<EntityMember> {
    const before = await this.loadMember(entity, membershipId);
    if (before.status !== 'active')
      throw new ConflictError('Only active members have roles to change');
    await this.prisma.$transaction(async (tx) => {
      const changed = await tx.membership.updateMany({
        where: { id: membershipId, entityId: entity.entityId, status: 'active' },
        data: { roles },
      });
      if (changed.count === 0) throw new ConflictError('The member changed meanwhile');
      await MembersService.assertAdminRemains(tx, entity.entityId);
      await this.audit.record(tx, {
        actor: actorOf(principal, entity),
        action: 'membership.roles_changed',
        target: { type: 'membership', id: membershipId },
        before: { roles: before.roles },
        after: { roles },
        requestId,
      });
    });
    return MembersService.view({ ...before, roles });
  }

  async revoke(
    entity: EntityContext,
    principal: Principal,
    membershipId: string,
    requestId?: string,
  ): Promise<EntityMember> {
    const before = await this.loadMember(entity, membershipId);
    if (before.status === 'revoked') throw new ConflictError('The membership is already revoked');
    await this.prisma.$transaction(async (tx) => {
      const changed = await tx.membership.updateMany({
        where: { id: membershipId, entityId: entity.entityId, status: { not: 'revoked' } },
        data: { status: 'revoked' },
      });
      if (changed.count === 0) throw new ConflictError('The member changed meanwhile');
      await MembersService.assertAdminRemains(tx, entity.entityId);
      await this.audit.record(tx, {
        actor: actorOf(principal, entity),
        action: 'membership.revoked',
        target: { type: 'membership', id: membershipId },
        before: { status: before.status, roles: before.roles },
        after: { status: 'revoked' },
        requestId,
      });
    });
    return MembersService.view({ ...before, status: 'revoked' });
  }
}
