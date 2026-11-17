import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from './prisma.service.js';
import { scopedRepo } from './scoped-repo.js';

/** Database-level guarantees of the domain model (M1-01) against PostgreSQL, as den_app. */
describe('domain model constraints (M1-01)', () => {
  const prisma = new PrismaService();
  const run = randomUUID().slice(0, 8);
  let providerId: string;
  let consumerId: string;
  let otherConsumerId: string;
  let apiVersionId: string;
  let applicationId: string;
  const purposeCode = `test_purpose_${run}`;
  const userId = randomUUID();

  const createEntity = (slug: string) =>
    prisma.entity.create({
      data: {
        slug: `${slug}-${run}`,
        legalName: `Entity ${slug} ${run}`,
        shortName: slug,
        taxIdType: 'TAX_ID',
        taxId: `${slug}-${run}`,
        kind: 'national',
        sector: 'test',
        status: 'active',
        contactEmail: 'test@example.org',
        dpoName: 'DPO',
        dpoEmail: 'dpo@example.org',
        createdBy: 'system:test',
      },
    });

  const createApplication = (entityId: string, name: string) => {
    const id = randomUUID();
    return prisma.application.create({
      data: {
        id,
        entityId,
        name,
        description: 'test',
        environment: 'sandbox',
        keycloakClientId: `den-app-${id}`,
        technicalContact: 'dev@example.org',
        createdBy: 'system:test',
      },
    });
  };

  beforeAll(async () => {
    providerId = (await createEntity('provider')).id;
    consumerId = (await createEntity('consumer')).id;
    otherConsumerId = (await createEntity('other')).id;
    await prisma.purpose.create({
      data: {
        code: purposeCode,
        name: { es: 'Prueba' },
        description: { es: 'Prueba' },
        source: 'operator',
        createdBy: 'system:test',
      },
    });
    const api = await prisma.api.create({
      data: {
        entityId: providerId,
        slug: `api-${run}`,
        name: 'Test API',
        summary: 'test',
        description: 'test',
        sector: 'test',
        classification: 'personal',
        ownerContact: 'owner@example.org',
        createdBy: 'system:test',
      },
    });
    apiVersionId = (
      await prisma.apiVersion.create({
        data: {
          apiId: api.id,
          version: '1.0',
          major: 1,
          minor: 0,
          openapiSpec: { openapi: '3.1.0' },
          openapiSha256: 'x',
          upstreamType: 'direct',
          upstream: { url: 'https://example.org' },
          basePath: `/provider-${run}/api-${run}/v1`,
          createdBy: 'system:test',
        },
      })
    ).id;
    applicationId = (await createApplication(consumerId, 'Consumer app')).id;
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  const subscription = (status: 'pending_provider' | 'rejected' | 'active' = 'pending_provider') =>
    prisma.subscription.create({
      data: {
        applicationId,
        apiVersionId,
        purposeCode,
        purposeDetail: 'test',
        legalBasisText: 'test',
        requestedValidityMonths: 1,
        validFrom: new Date(),
        validUntil: new Date(Date.now() + 86_400_000),
        status,
        requestedBy: userId,
        createdBy: userId,
      },
    });

  it('generates UUIDv7 ids in the database', async () => {
    const entity = await prisma.entity.findUniqueOrThrow({ where: { id: providerId } });
    expect(entity.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('never deletes domain rows: the runtime role has no DELETE', async () => {
    await expect(prisma.entity.delete({ where: { id: providerId } })).rejects.toThrow(
      /permission denied/,
    );
    await expect(prisma.application.delete({ where: { id: applicationId } })).rejects.toThrow(
      /permission denied/,
    );
  });

  it('allows one live subscription per application, version and purpose', async () => {
    const first = await subscription();
    await expect(subscription()).rejects.toThrow(
      /subscription_one_live_per_purpose|Unique constraint/,
    );
    // Once the first one is closed (rejected), a new request is allowed.
    await prisma.subscription.update({ where: { id: first.id }, data: { status: 'rejected' } });
    const second = await subscription();
    expect(second.id).not.toBe(first.id);
  });

  it('enforces unique entity slugs', async () => {
    await expect(createEntity('provider')).rejects.toThrow(/Unique constraint/);
  });

  it('scopedRepo returns only rows of the given entity', async () => {
    await createApplication(otherConsumerId, 'Other app');
    const mine = await scopedRepo(prisma.application, consumerId).findMany();
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((app) => app.entityId === consumerId)).toBe(true);
    const leaked = await scopedRepo(prisma.application, consumerId).findFirst({
      where: { entityId: otherConsumerId },
    });
    expect(leaked).toBeNull();
  });
});
