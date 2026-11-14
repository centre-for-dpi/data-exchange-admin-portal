import type {
  EntityRole,
  NotificationKind,
  NotificationParams,
  PlatformRole,
} from '@rid/contracts';
import type { PrismaService } from '../prisma/prisma.service.js';

export interface ResolvedNotification {
  kind: NotificationKind;
  params: NotificationParams;
  link: string;
  /** Portal user ids. The actor of the event is removed by the dispatcher. */
  recipients: string[];
}

interface Event {
  action: string;
  targetId: string;
  after: unknown;
}

const LIVE_GRANTED = ['approved', 'active', 'suspended'] as const;
const field = (value: unknown, key: string): unknown =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined;

async function membersWith(prisma: PrismaService, entityId: string, roles: EntityRole[]) {
  const rows = await prisma.membership.findMany({
    where: { entityId, status: 'active', roles: { hasSome: roles } },
    select: { userId: true },
  });
  return rows.map((r) => r.userId);
}

/**
 * Keeps only users who still belong (active membership) to the entity: a former member of the
 * consumer entity must not keep hearing about its requests.
 */
async function stillMembers(prisma: PrismaService, entityId: string, userIds: string[]) {
  if (userIds.length === 0) return [];
  const rows = await prisma.membership.findMany({
    where: { entityId, status: 'active', userId: { in: userIds } },
    select: { userId: true },
  });
  return rows.map((r) => r.userId);
}

async function platformUsers(prisma: PrismaService, roles: PlatformRole[]) {
  const rows = await prisma.userPlatformRole.findMany({
    where: { role: { in: roles } },
    select: { userId: true },
  });
  return rows.map((r) => r.userId);
}

async function subscriptionOf(prisma: PrismaService, id: string) {
  return prisma.subscription.findUnique({
    where: { id },
    include: {
      application: { include: { entity: true } },
      apiVersion: { include: { api: { include: { entity: true } } } },
    },
  });
}

async function versionOf(prisma: PrismaService, id: string) {
  return prisma.apiVersion.findUnique({
    where: { id },
    include: { api: { include: { entity: true } } },
  });
}

/**
 * Who hears about an audit event, and what they read (SPEC.md §7, M2-08). Recipients come from
 * the state at dispatch time: a member revoked meanwhile is no longer told. Texts carry names of
 * APIs, entities and applications only, never data of the people consulted.
 */
export async function resolveNotification(
  prisma: PrismaService,
  event: Event,
): Promise<ResolvedNotification | null> {
  const [area] = event.action.split('.');

  if (event.action === 'invitation.created') {
    const invitation = await prisma.invitation.findUnique({
      where: { id: event.targetId },
      include: { entity: true },
    });
    if (!invitation) return null;
    const user = await prisma.user.findUnique({ where: { email: invitation.email } });
    return {
      kind: 'invitation_received',
      params: { entity: invitation.entity.shortName },
      link: '/invitations',
      recipients: user ? [user.id] : [],
    };
  }

  if (area === 'entity') {
    const entity = await prisma.entity.findUnique({ where: { id: event.targetId } });
    if (!entity?.applicantId) return null;
    return {
      kind: 'entity_request_decided',
      params: { entity: entity.shortName, decision: event.action.split('.')[1] },
      link: `/entity-requests/${entity.id}`,
      recipients: [entity.applicantId],
    };
  }

  if (area === 'api_version') {
    const v = await versionOf(prisma, event.targetId);
    if (!v) return null;
    const params = { api: v.api.name, version: v.version, entity: v.api.entity.shortName };
    const providerLink = `/my-apis/${v.apiId}/versions/${v.id}`;
    switch (event.action) {
      case 'api_version.submitted':
        return {
          kind: 'api_review_requested',
          params,
          link: `/operator/reviews/${v.id}`,
          recipients: await platformUsers(prisma, ['platform_reviewer', 'platform_admin']),
        };
      case 'api_version.approved':
        // Only when the operator's approval leaves it waiting for the regulator.
        if (
          field(event.after, 'status') !== 'approved_operator' ||
          v.status !== 'approved_operator'
        ) {
          return null;
        }
        return {
          kind: 'regulator_approval_needed',
          params: { ...params, what: 'api' },
          link: `/operator/reviews/${v.id}`,
          recipients: await platformUsers(prisma, ['regulator']),
        };
      case 'api_version.changes_requested':
        return {
          kind: 'api_changes_requested',
          params,
          link: providerLink,
          recipients: await membersWith(prisma, v.api.entityId, ['api_publisher']),
        };
      case 'api_version.published':
        return {
          kind: 'api_published',
          params,
          link: providerLink,
          recipients: await membersWith(prisma, v.api.entityId, ['api_publisher', 'entity_admin']),
        };
      case 'api_version.deprecated': {
        const consumers = await prisma.subscription.findMany({
          where: { apiVersionId: v.id, status: { in: [...LIVE_GRANTED] } },
          select: { requestedBy: true, application: { select: { entityId: true } } },
        });
        return {
          kind: 'api_deprecated',
          params: { ...params, date: v.sunsetAt?.toISOString() },
          link: `/catalog/${v.apiId}`,
          recipients: (
            await Promise.all(
              consumers.map((c) => stillMembers(prisma, c.application.entityId, [c.requestedBy])),
            )
          ).flat(),
        };
      }
      default:
        return null;
    }
  }

  if (area === 'subscription') {
    const s = await subscriptionOf(prisma, event.targetId);
    if (!s) return null;
    const params = {
      api: s.apiVersion.api.name,
      version: s.apiVersion.version,
      entity: s.apiVersion.api.entity.shortName,
      application: s.application.name,
    };
    const providerLink = `/requests/${s.id}`;
    const consumerLink = `/my-apps/requests/${s.id}`;
    const stewards = () => membersWith(prisma, s.apiVersion.api.entityId, ['data_steward']);
    const requester = await stillMembers(prisma, s.application.entityId, [s.requestedBy]);
    switch (event.action) {
      case 'subscription.requested':
      case 'subscription.renewal_requested':
        return {
          kind: 'access_requested',
          params,
          link: providerLink,
          recipients: await stewards(),
        };
      case 'subscription.info_provided':
        return {
          kind: 'access_request_answered',
          params,
          link: providerLink,
          recipients: await stewards(),
        };
      case 'subscription.info_requested':
        return { kind: 'access_info_requested', params, link: consumerLink, recipients: requester };
      case 'subscription.approved':
        if (field(event.after, 'status') === 'pending_regulator') {
          return {
            kind: 'regulator_approval_needed',
            params: { ...params, what: 'subscription' },
            link: `/regulator/subscriptions/${s.apiVersion.api.entityId}/${s.id}`,
            recipients: await platformUsers(prisma, ['regulator']),
          };
        }
        return { kind: 'access_approved', params, link: consumerLink, recipients: requester };
      case 'subscription.approved_regulator':
        return { kind: 'access_approved', params, link: consumerLink, recipients: requester };
      case 'subscription.rejected':
      case 'subscription.rejected_regulator':
        return { kind: 'access_rejected', params, link: consumerLink, recipients: requester };
      case 'subscription.suspended':
      case 'subscription.revoked': {
        // Access taken away: the requester and every app developer of the consumer entity.
        const developers = await membersWith(prisma, s.application.entityId, ['app_developer']);
        return {
          kind: event.action === 'subscription.suspended' ? 'access_suspended' : 'access_revoked',
          params,
          link: consumerLink,
          recipients: [...new Set([...requester, ...developers])],
        };
      }
      case 'subscription.renewal_notice_queued':
        return {
          kind: 'access_expiring',
          params: { ...params, date: s.validUntil.toISOString() },
          link: consumerLink,
          recipients: requester,
        };
      default:
        return null;
    }
  }
  return null;
}
