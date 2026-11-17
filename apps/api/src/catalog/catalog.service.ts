import { Injectable } from '@nestjs/common';
import type { CatalogDetail, CatalogItem, CatalogQuery, ExposedField } from '@den/contracts';
import { catalogQuerySchema } from '@den/contracts';
import { listOperations } from '../apis/lint/openapi-lint.js';
import { NotFoundError } from '../common/errors.js';
import type { Prisma } from '../generated/prisma/client.js';
import { nodeIdOf, upstreamNodes } from '../nodes/node-status.js';
import { sandboxBasePath } from '../reconcilers/apisix/desired-state.js';
import { PrismaService } from '../prisma/prisma.service.js';

/** Version states visible in the catalogue. */
const LISTED = ['published', 'deprecated'] as const;

export const gatewayPublicUrl = (): string =>
  (process.env.DEN_GATEWAY_PUBLIC_URL ?? 'http://localhost:9080').replace(/\/$/, '');

const fieldsOf = (value: unknown): ExposedField[] =>
  Array.isArray(value) ? (value as ExposedField[]) : [];

/** Who is browsing: anonymous visitors only see public APIs (SPEC.md §2.3). */
export interface CatalogViewer {
  anonymous: boolean;
}

/**
 * Read-only catalogue of published APIs (SPEC.md §6, M1-05). Drafts and APIs under review never
 * appear here; providers see those in "My APIs".
 */
@Injectable()
export class CatalogService {
  constructor(private readonly prisma: PrismaService) {}

  private visibility(viewer: CatalogViewer): Prisma.ApiWhereInput {
    return {
      status: { in: [...LISTED] },
      versions: { some: { status: { in: [...LISTED] } } },
      ...(viewer.anonymous ? { classification: 'public' } : {}),
    };
  }

  async list(input: CatalogQuery, viewer: CatalogViewer) {
    const query = catalogQuerySchema.parse(input);
    const q = query.q?.trim();
    const where: Prisma.ApiWhereInput = {
      AND: [
        this.visibility(viewer),
        ...(query.sector ? [{ sector: query.sector }] : []),
        ...(query.classification ? [{ classification: query.classification }] : []),
        ...(query.entity ? [{ entity: { slug: query.entity } }] : []),
        ...(q
          ? [
              {
                OR: [
                  { name: { contains: q, mode: 'insensitive' as const } },
                  { summary: { contains: q, mode: 'insensitive' as const } },
                  { tags: { has: q.toLowerCase() } },
                ],
              },
            ]
          : []),
      ],
    };
    const rows = await this.prisma.api.findMany({
      where,
      orderBy: { id: 'asc' },
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      include: {
        entity: true,
        versions: {
          where: { status: { in: [...LISTED] } },
          orderBy: [{ major: 'desc' }, { minor: 'desc' }],
          take: 1,
        },
      },
    });
    const page = rows.slice(0, query.limit);
    const items: CatalogItem[] = page.flatMap((api) => {
      const latest = api.versions[0];
      if (!latest) return [];
      const fields = fieldsOf(latest.exposedFields);
      return [
        {
          api: {
            id: api.id,
            slug: api.slug,
            name: api.name,
            summary: api.summary,
            sector: api.sector,
            classification: api.classification,
            tags: api.tags,
          },
          entity: { id: api.entity.id, slug: api.entity.slug, shortName: api.entity.shortName },
          latestVersion: {
            id: latest.id,
            version: latest.version,
            basePath: latest.basePath,
            status: latest.status as (typeof LISTED)[number],
          },
          personalFields: fields.filter((f) => f.personal).map((f) => f.name),
          sensitiveFields: fields.filter((f) => f.sensitive).map((f) => f.name),
        },
      ];
    });
    return { items, nextCursor: rows.length > query.limit ? (page.at(-1)?.id ?? null) : null };
  }

  async entities(viewer: CatalogViewer) {
    const rows = await this.prisma.entity.findMany({
      where: { apis: { some: this.visibility(viewer) } },
      orderBy: { shortName: 'asc' },
      select: { id: true, slug: true, shortName: true },
    });
    return { items: rows };
  }

  async detail(apiId: string, viewer: CatalogViewer): Promise<CatalogDetail> {
    const api = await this.prisma.api.findFirst({
      where: { id: apiId, ...this.visibility(viewer) },
      include: {
        entity: true,
        versions: {
          where: { status: { in: [...LISTED] } },
          orderBy: [{ major: 'desc' }, { minor: 'desc' }],
          include: { allowedPurposes: { include: { purpose: true } } },
        },
      },
    });
    if (!api) throw new NotFoundError('API');
    // Consumers see whether the kit node behind a version is up (SPEC.md §6, M4-04).
    const nodes = await upstreamNodes(
      this.prisma,
      api.versions.map((v) => ({ upstream: v.upstream, entityId: api.entityId })),
    );
    return {
      api: {
        id: api.id,
        slug: api.slug,
        name: api.name,
        summary: api.summary,
        description: api.description,
        sector: api.sector,
        classification: api.classification,
        tags: api.tags,
        // The public catalogue (SPEC.md §2.3) shows the API, not who answers for it.
        ownerContact: viewer.anonymous ? null : api.ownerContact,
      },
      entity: {
        id: api.entity.id,
        slug: api.entity.slug,
        shortName: api.entity.shortName,
        legalName: api.entity.legalName,
      },
      versions: api.versions.map((v) => ({
        id: v.id,
        version: v.version,
        status: v.status as (typeof LISTED)[number],
        basePath: v.basePath,
        gatewayUrl: `${gatewayPublicUrl()}${v.basePath}`,
        sandboxUrl: v.sandboxUpstream
          ? `${gatewayPublicUrl()}${sandboxBasePath(v.basePath)}`
          : null,
        publishedAt: v.publishedAt?.toISOString() ?? null,
        deprecatedAt: v.deprecatedAt?.toISOString() ?? null,
        sunsetAt: v.sunsetAt?.toISOString() ?? null,
        allowedPurposes: v.allowedPurposes
          .map((p) => ({
            code: p.purposeCode,
            name: p.purpose
              .name as CatalogDetail['versions'][number]['allowedPurposes'][number]['name'],
          }))
          .sort((a, b) => a.code.localeCompare(b.code)),
        exposedFields: fieldsOf(v.exposedFields),
        operations: listOperations(v.openapiSpec as Record<string, unknown>),
        defaultRateLimit: v.defaultRateLimit,
        legalBasisText: v.legalBasisText,
        legalReferences: v.legalReferences,
        node: (() => {
          if (viewer.anonymous) return null;
          const node = nodes.get(nodeIdOf(v.upstream) ?? '');
          return node ? { status: node.status, lastHeartbeatAt: node.lastHeartbeatAt } : null;
        })(),
      })),
    };
  }

  /**
   * OpenAPI document of a listed version for the interactive documentation. `servers` is replaced
   * with the public gateway URL: consumers call the gateway, and the provider's internal
   * addresses are never published.
   */
  async openapi(apiId: string, versionId: string, viewer: CatalogViewer) {
    const version = await this.prisma.apiVersion.findFirst({
      where: { id: versionId, apiId, status: { in: [...LISTED] }, api: this.visibility(viewer) },
    });
    if (!version) throw new NotFoundError('API version');
    const spec = { ...(version.openapiSpec as Record<string, unknown>) };
    spec.servers = [
      { url: `${gatewayPublicUrl()}${version.basePath}`, description: 'DEN gateway' },
    ];
    return spec;
  }
}
