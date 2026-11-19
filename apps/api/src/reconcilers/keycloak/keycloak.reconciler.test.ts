import { describe, expect, it } from 'vitest';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { QueueService } from '../../queue/queue.service.js';
import type { KeycloakGatewayAdmin } from './keycloak-admin.js';
import { KeycloakReconciler, syncTarget } from './keycloak.reconciler.js';

const at = (iso: string) => new Date(iso);

describe('Keycloak full pass: deleted applications (B-14)', () => {
  const apps = [
    { id: 'a1', status: 'active', keycloakClientId: 'den-app-a1', updatedAt: at('2026-11-01') },
    { id: 'a2', status: 'suspended', keycloakClientId: 'den-app-a2', updatedAt: at('2026-11-01') },
    // Disabled in Keycloak after its deletion: settled.
    { id: 'd1', status: 'deleted', keycloakClientId: 'den-app-d1', updatedAt: at('2026-11-01') },
    // Applied before the deletion, never since: still visited.
    { id: 'd2', status: 'deleted', keycloakClientId: 'den-app-d2', updatedAt: at('2026-11-10') },
    // Last reconcile failed: still visited.
    { id: 'd3', status: 'deleted', keycloakClientId: 'den-app-d3', updatedAt: at('2026-11-01') },
    // Never reconciled: still visited.
    { id: 'd4', status: 'deleted', keycloakClientId: 'den-app-d4', updatedAt: at('2026-11-01') },
  ];
  const states = [
    { target: syncTarget('den-app-d1'), status: 'in_sync', appliedAt: at('2026-11-02') },
    { target: syncTarget('den-app-d2'), status: 'in_sync', appliedAt: at('2026-11-05') },
    { target: syncTarget('den-app-d3'), status: 'error', appliedAt: at('2026-11-02') },
  ];
  const prisma = {
    application: {
      findMany: ({ where }: { where: { status: string | { not: string } } }) =>
        Promise.resolve(
          apps.filter((a) =>
            typeof where.status === 'string'
              ? a.status === where.status
              : a.status !== where.status.not,
          ),
        ),
    },
    syncState: {
      findMany: ({ where }: { where: { target: { in: string[] }; status: string } }) =>
        Promise.resolve(
          states.filter((s) => where.target.in.includes(s.target) && s.status === where.status),
        ),
    },
  } as unknown as PrismaService;

  it('visits live applications and only the deleted ones not yet confirmed disabled', async () => {
    const reconciler = new KeycloakReconciler(
      prisma,
      {} as QueueService,
      {} as KeycloakGatewayAdmin,
    );
    const visited = (await reconciler.applicationsToVisit()).map((a) => a.id);
    expect(visited.sort()).toEqual(['a1', 'a2', 'd2', 'd3', 'd4']);
  });
});
