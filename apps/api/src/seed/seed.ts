import { isDeepStrictEqual } from 'node:util';
import type { CountryConfig } from '@den/config';
import type { AuditService } from '../audit/audit.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import type { PrismaService, Tx } from '../prisma/prisma.service.js';
import { SEED_ENTITIES, SEED_ROLES, type SeedEntity, type SeedRoles } from './seed-data.js';

export const SEED_ACTOR = 'system:seed';

/** A user from the Keycloak realm export (infra/keycloak/den-portal-realm.json). */
export interface RealmUser {
  id: string;
  username: string;
  firstName?: string;
  lastName?: string;
  email: string;
}

export interface SeedSummary {
  created: Record<'entities' | 'users' | 'platformRoles' | 'memberships' | 'purposes', number>;
  updated: Record<'purposes', number>;
  warnings: string[];
}

export interface SeedInput {
  config: CountryConfig;
  realmUsers: RealmUser[];
  entities?: readonly SeedEntity[];
  roles?: Readonly<Record<string, SeedRoles>>;
}

const asJson = (value: unknown): Prisma.InputJsonValue => value as Prisma.InputJsonValue;

/**
 * Idempotent development seed (M1-01): fictitious entities, the Keycloak seed users with their
 * roles, and the purpose catalogue from the country configuration. It only creates what is missing
 * (and refreshes config-sourced purposes); it never deletes or overwrites changes made in the
 * portal. Every change is audited in the same transaction (CLAUDE.md, rule 4).
 */
export async function runSeed(
  prisma: PrismaService,
  audit: AuditService,
  input: SeedInput,
): Promise<SeedSummary> {
  const entities = input.entities ?? SEED_ENTITIES;
  const roles = input.roles ?? SEED_ROLES;
  const summary: SeedSummary = {
    created: { entities: 0, users: 0, platformRoles: 0, memberships: 0, purposes: 0 },
    updated: { purposes: 0 },
    warnings: [],
  };
  const actor = { type: 'system' as const, id: SEED_ACTOR };

  await prisma.$transaction(async (tx: Tx) => {
    // Purposes: the country config is the source of truth for purposes with source=config.
    for (const purpose of input.config.purposes) {
      const data = {
        name: asJson(purpose.name),
        description: asJson(purpose.description),
        legalReference: purpose.legalReference ?? null,
      };
      const existing = await tx.purpose.findUnique({ where: { code: purpose.code } });
      if (!existing) {
        const created = await tx.purpose.create({
          data: { code: purpose.code, ...data, source: 'config', createdBy: SEED_ACTOR },
        });
        await audit.record(tx, {
          actor,
          action: 'purpose.created',
          target: { type: 'purpose', id: created.code },
          after: created,
        });
        summary.created.purposes += 1;
      } else if (
        existing.source === 'config' &&
        // Key order is irrelevant: PostgreSQL stores JSONB with its own key order.
        (!isDeepStrictEqual(existing.name, data.name) ||
          !isDeepStrictEqual(existing.description, data.description) ||
          existing.legalReference !== data.legalReference)
      ) {
        const updated = await tx.purpose.update({ where: { code: purpose.code }, data });
        await audit.record(tx, {
          actor,
          action: 'purpose.updated',
          target: { type: 'purpose', id: updated.code },
          before: existing,
          after: updated,
        });
        summary.updated.purposes += 1;
      }
    }

    // Entities.
    const sectorCodes = new Set(input.config.sectors.map((s) => s.code));
    const taxIdType = input.config.identifiers.organization[0] ?? 'TAX_ID';
    const entityIds = new Map<string, string>();
    for (const seed of entities) {
      const existing = await tx.entity.findFirst({
        where: { slug: seed.slug, status: { notIn: ['requested', 'rejected'] } },
      });
      if (existing) {
        entityIds.set(seed.slug, existing.id);
        continue;
      }
      let sector = seed.sector;
      if (!sectorCodes.has(sector)) {
        sector = input.config.sectors[0]?.code ?? sector;
        summary.warnings.push(
          `sector "${seed.sector}" not configured; ${seed.slug} uses "${sector}"`,
        );
      }
      const created = await tx.entity.create({
        data: {
          slug: seed.slug,
          legalName: seed.legalName,
          shortName: seed.shortName,
          taxIdType,
          taxId: seed.taxId,
          kind: seed.kind,
          sector,
          status: 'active',
          contactEmail: seed.contactEmail,
          dpoName: seed.dpoName,
          dpoEmail: seed.dpoEmail,
          createdBy: SEED_ACTOR,
        },
      });
      await audit.record(tx, {
        actor,
        action: 'entity.created',
        target: { type: 'entity', id: created.id },
        after: created,
      });
      entityIds.set(seed.slug, created.id);
      summary.created.entities += 1;
    }

    // Users, platform roles and memberships.
    for (const realmUser of input.realmUsers) {
      let user = await tx.user.findUnique({ where: { keycloakSub: realmUser.id } });
      if (!user) {
        user = await tx.user.create({
          data: {
            keycloakSub: realmUser.id,
            email: realmUser.email,
            fullName:
              [realmUser.firstName, realmUser.lastName].filter(Boolean).join(' ') ||
              realmUser.username,
            status: 'active',
            createdBy: SEED_ACTOR,
          },
        });
        await audit.record(tx, {
          actor,
          action: 'user.created',
          target: { type: 'user', id: user.id },
          after: user,
        });
        summary.created.users += 1;
      }

      const userRoles = roles[realmUser.username];
      if (!userRoles) {
        summary.warnings.push(`no seed roles for ${realmUser.username}`);
        continue;
      }

      for (const role of userRoles.platform ?? []) {
        const key = { userId_role: { userId: user.id, role } };
        if (await tx.userPlatformRole.findUnique({ where: key })) continue;
        await tx.userPlatformRole.create({
          data: { userId: user.id, role, grantedBy: SEED_ACTOR },
        });
        await audit.record(tx, {
          actor,
          action: 'platform_role.granted',
          target: { type: 'user', id: user.id },
          after: { role },
        });
        summary.created.platformRoles += 1;
      }

      for (const [slug, entityRoles] of Object.entries(userRoles.entities ?? {})) {
        const entityId = entityIds.get(slug);
        if (!entityId) {
          summary.warnings.push(`unknown entity "${slug}" for ${realmUser.username}`);
          continue;
        }
        const key = { userId_entityId: { userId: user.id, entityId } };
        if (await tx.membership.findUnique({ where: key })) continue;
        const membership = await tx.membership.create({
          data: {
            userId: user.id,
            entityId,
            roles: entityRoles,
            status: 'active',
            invitedBy: SEED_ACTOR,
            createdBy: SEED_ACTOR,
          },
        });
        await audit.record(tx, {
          actor,
          action: 'membership.created',
          target: { type: 'membership', id: membership.id },
          after: membership,
        });
        summary.created.memberships += 1;
      }
    }
  });

  return summary;
}
