// `pnpm load:seed [--entities 200] [--apis 5] [--subscriptions 5000]`: the network at the scale of
// SPEC.md §9 for the load test (M6-03): entities, published APIs, applications and subscriptions
// that the reconcilers turn into APISIX routes, Keycloak clients and OPA data. Synthetic and
// recognisable (slug prefix `carga-`), idempotent (only creates what is missing), and audited
// like any other change (CLAUDE.md, rule 4). Load environments only: refused in production
// unless RID_ALLOW_LOAD_SEED=true.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { getCountryConfig } from '@rid/config';
import type { Prisma } from '../generated/prisma/client.js';
import { lintOpenApi } from '../apis/lint/openapi-lint.js';
import { type AuditActor, AuditService } from '../audit/audit.service.js';
import { loadDevEnv } from '../dev-env.js';
import { PrismaService } from '../prisma/prisma.service.js';

export const LOAD_PREFIX = 'carga';
const ACTOR: AuditActor = { type: 'system', id: 'load-seed' };
const CHUNK = 100;

export interface ScaleOptions {
  entities: number;
  apisPerEntity: number;
  subscriptions: number;
  /** The OpenAPI document of every synthetic API and its service on the test node. */
  openapiFile: string;
  servicePath: string;
}

export interface ScaleSummary {
  entities: number;
  apis: number;
  applications: number;
  subscriptions: number;
}

const pad = (n: number) => String(n).padStart(3, '0');

/** Creates what is missing of the synthetic network; returns what it created. */
export async function seedScale(
  prisma: PrismaService,
  audit: AuditService,
  options: ScaleOptions,
): Promise<ScaleSummary> {
  const config = getCountryConfig();
  const taxIdType = config.identifiers.organization[0] ?? 'ID';
  const purpose = config.purposes[0]?.code;
  if (!purpose) throw new Error('The country configuration has no purposes');
  const sectors = config.sectors.map((s) => s.code);
  const source = readFileSync(options.openapiFile, 'utf8');
  const parsed = await lintOpenApi(source, {
    noIdInQuery: config.features.lint.noIdInQuery,
    dataSubject: { required: true, documentTypes: config.identifiers.person },
  });
  if (!parsed.report.valid) throw new Error(`${options.openapiFile} does not pass the lint`);
  const operations = parsed.operations.filter((o) => o.method === 'GET').map((o) => o.operationId);
  const created: ScaleSummary = { entities: 0, apis: 0, applications: 0, subscriptions: 0 };
  const now = new Date();
  // Who "requested" the synthetic subscriptions: a disabled user with no Keycloak account.
  const requester = await syntheticRequester(prisma, audit);

  // Entities, each with its published APIs and one consumer application.
  for (let i = 1; i <= options.entities; i += 1) {
    const slug = `${LOAD_PREFIX}-${pad(i)}`;
    if (
      await prisma.entity.findFirst({ where: { slug, status: 'active' }, select: { id: true } })
    ) {
      continue;
    }
    await prisma.$transaction(
      async (tx) => {
        const entity = await tx.entity.create({
          data: {
            legalName: `Entidad de carga ${pad(i)}`,
            shortName: `Carga ${pad(i)}`,
            slug,
            taxIdType,
            taxId: `990${String(i).padStart(7, '0')}`,
            kind: 'national',
            sector: sectors[i % sectors.length] ?? 'general',
            status: 'active',
            contactEmail: `contacto@${slug}.load.rid.example`,
            dpoName: 'Responsable sintético',
            dpoEmail: `dpo@${slug}.load.rid.example`,
            createdBy: ACTOR.id,
            decidedAt: now,
          },
        });
        await audit.record(tx, {
          actor: ACTOR,
          action: 'entity.created',
          target: { type: 'entity', id: entity.id },
          after: { slug, status: entity.status, synthetic: true },
        });
        created.entities += 1;
        for (let a = 1; a <= options.apisPerEntity; a += 1) {
          const api = await tx.api.create({
            data: {
              entityId: entity.id,
              slug: `api-${a}`,
              name: `API de carga ${pad(i)}-${a}`,
              summary: 'API sintética de la prueba de carga.',
              description: 'Datos sintéticos (M6-03).',
              sector: entity.sector,
              classification: 'personal',
              status: 'published',
              ownerContact: entity.contactEmail,
              createdBy: ACTOR.id,
            },
          });
          const version = await tx.apiVersion.create({
            data: {
              apiId: api.id,
              version: '1.0',
              major: 1,
              minor: 0,
              status: 'published',
              openapiSpec: parsed.spec as Prisma.InputJsonObject,
              openapiSha256: parsed.sha256,
              lintReport: parsed.report,
              upstreamType: 'node',
              upstream: { type: 'node', servicePath: options.servicePath },
              basePath: `/${slug}/${api.slug}/v1`,
              exposedFields: [],
              legalReferences: [],
              publishedAt: now,
              createdBy: ACTOR.id,
              allowedPurposes: { create: [{ purposeCode: purpose }] },
            },
          });
          await audit.record(tx, {
            actor: ACTOR,
            action: 'api_version.published',
            target: { type: 'api_version', id: version.id },
            after: { api: api.slug, entity: slug, version: '1.0', status: 'published' },
          });
          created.apis += 1;
        }
        const app = await tx.application.create({
          data: {
            entityId: entity.id,
            name: `Aplicación de carga ${pad(i)}`,
            description: 'Consumidor sintético de la prueba de carga.',
            environment: 'production',
            keycloakClientId: `rid-app-${slug}`,
            technicalContact: entity.contactEmail,
            createdBy: ACTOR.id,
          },
        });
        await audit.record(tx, {
          actor: ACTOR,
          action: 'application.created',
          target: { type: 'application', id: app.id },
          after: { entity: slug, name: app.name },
        });
        created.applications += 1;
      },
      { timeout: 60_000 },
    );
  }

  // Subscriptions: each application asks for APIs of the other entities, round robin, until the
  // network has the target. They are approved: OPA activates them when it confirms the bundle.
  const apps = await prisma.application.findMany({
    where: { keycloakClientId: { startsWith: `rid-app-${LOAD_PREFIX}-` } },
    select: { id: true, entityId: true },
    orderBy: { keycloakClientId: 'asc' },
  });
  const versions = await prisma.apiVersion.findMany({
    where: { status: 'published', basePath: { startsWith: `/${LOAD_PREFIX}-` } },
    select: { id: true, api: { select: { entityId: true } } },
    orderBy: { basePath: 'asc' },
  });
  const existing = await prisma.subscription.count({
    where: { applicationId: { in: apps.map((a) => a.id) } },
  });
  const wanted: Prisma.SubscriptionCreateManyInput[] = [];
  const perApp = Math.ceil(options.subscriptions / Math.max(apps.length, 1));
  for (const [index, app] of apps.entries()) {
    const others = versions.filter((v) => v.api.entityId !== app.entityId);
    for (let k = 0; k < perApp && others.length > 0; k += 1) {
      const version = others[(index * perApp + k) % others.length];
      if (version) {
        wanted.push(subscriptionOf(app.id, version.id, purpose, operations, requester, now));
      }
    }
  }
  const missing = wanted.slice(existing, options.subscriptions);
  for (let start = 0; start < missing.length; start += CHUNK) {
    const chunk = missing.slice(start, start + CHUNK);
    await prisma.$transaction(
      async (tx) => {
        for (const data of chunk) {
          const subscription = await tx.subscription.create({ data });
          await audit.record(tx, {
            actor: ACTOR,
            action: 'subscription.approved',
            target: { type: 'subscription', id: subscription.id },
            after: { status: 'approved', purpose, synthetic: true },
          });
        }
      },
      { timeout: 120_000 },
    );
    created.subscriptions += chunk.length;
  }
  return created;
}

async function syntheticRequester(prisma: PrismaService, audit: AuditService): Promise<string> {
  const keycloakSub = ACTOR.id;
  const found = await prisma.user.findUnique({ where: { keycloakSub }, select: { id: true } });
  if (found) return found.id;
  return prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        keycloakSub,
        email: `${ACTOR.id}@load.rid.example`,
        fullName: 'Solicitante sintético (prueba de carga)',
        status: 'disabled',
        createdBy: ACTOR.id,
      },
    });
    await audit.record(tx, {
      actor: ACTOR,
      action: 'user.created',
      target: { type: 'user', id: user.id },
      after: { keycloakSub, status: user.status, synthetic: true },
    });
    return user.id;
  });
}

function subscriptionOf(
  applicationId: string,
  apiVersionId: string,
  purpose: string,
  operations: string[],
  requestedBy: string,
  now: Date,
): Prisma.SubscriptionCreateManyInput {
  const until = new Date(now);
  until.setUTCFullYear(until.getUTCFullYear() + 1);
  return {
    applicationId,
    apiVersionId,
    purposeCode: purpose,
    purposeDetail: 'Prueba de carga (datos sintéticos).',
    legalBasisText: 'Datos sintéticos de la prueba de carga.',
    requestedValidityMonths: 12,
    rateLimitPerMinute: 600,
    requestedOperations: operations,
    approvedOperations: operations,
    validFrom: now,
    validUntil: until,
    status: 'approved',
    requestedBy,
    createdBy: ACTOR.id,
  };
}

async function main(): Promise<void> {
  loadDevEnv();
  if (process.env.NODE_ENV === 'production' && process.env.RID_ALLOW_LOAD_SEED !== 'true') {
    throw new Error('Refusing the load seed in production (RID_ALLOW_LOAD_SEED=true)');
  }
  const { values } = parseArgs({
    options: {
      entities: { type: 'string', default: '200' },
      apis: { type: 'string', default: '5' },
      subscriptions: { type: 'string', default: '5000' },
      openapi: { type: 'string' },
      'service-path': { type: 'string', default: '/salud' },
    },
  });
  const root = resolve(import.meta.dirname, '../../../..');
  const prisma = new PrismaService();
  try {
    const started = Date.now();
    const summary = await seedScale(prisma, new AuditService(), {
      entities: Number(values.entities),
      apisPerEntity: Number(values.apis),
      subscriptions: Number(values.subscriptions),
      openapiFile: values.openapi ?? resolve(root, 'infra/mock-providers/salud/openapi.yaml'),
      servicePath: values['service-path'],
    });
    console.warn(
      `Load seed: created ${JSON.stringify(summary)} in ${Math.round((Date.now() - started) / 1000)} s`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1]?.endsWith('scale-seed.ts')) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
