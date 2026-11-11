import { z } from 'zod';
import { classificationSchema, exposedFieldSchema } from './apis.js';
import { pageOf } from './session.js';

/** Catalogue search (SPEC.md §6). Only published (and deprecated) versions are listed. */
export const catalogQuerySchema = z.strictObject({
  q: z.string().trim().max(100).optional(),
  sector: z.string().trim().max(60).optional(),
  /** Provider entity slug. */
  entity: z.string().trim().max(60).optional(),
  classification: classificationSchema.optional(),
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(24),
});
export type CatalogQuery = z.input<typeof catalogQuerySchema>;

const entityRef = z.object({ id: z.uuid(), slug: z.string(), shortName: z.string() });

export const catalogItemSchema = z.object({
  api: z.object({
    id: z.uuid(),
    slug: z.string(),
    name: z.string(),
    summary: z.string(),
    sector: z.string(),
    classification: classificationSchema,
    tags: z.array(z.string()),
  }),
  entity: entityRef,
  latestVersion: z.object({
    id: z.uuid(),
    version: z.string(),
    basePath: z.string(),
    status: z.enum(['published', 'deprecated']),
  }),
  /** Names of the personal data the latest version exposes (shown on the card, SPEC.md §5). */
  personalFields: z.array(z.string()),
  sensitiveFields: z.array(z.string()),
});
export type CatalogItem = z.infer<typeof catalogItemSchema>;
export const catalogPageSchema = pageOf(catalogItemSchema);

export const catalogPurposeSchema = z.object({
  code: z.string(),
  name: z.union([z.string(), z.object({ es: z.string().optional(), en: z.string().optional() })]),
});

export const catalogVersionSchema = z.object({
  id: z.uuid(),
  version: z.string(),
  status: z.enum(['published', 'deprecated']),
  basePath: z.string(),
  /** Public URL of the version on the gateway. */
  gatewayUrl: z.string(),
  publishedAt: z.iso.datetime().nullable(),
  deprecatedAt: z.iso.datetime().nullable(),
  sunsetAt: z.iso.datetime().nullable(),
  allowedPurposes: z.array(catalogPurposeSchema),
  exposedFields: z.array(exposedFieldSchema),
  operations: z.array(z.object({ operationId: z.string(), method: z.string(), path: z.string() })),
  defaultRateLimit: z.number().int(),
  legalBasisText: z.string().nullable(),
  legalReferences: z.array(z.string()),
});
export type CatalogVersion = z.infer<typeof catalogVersionSchema>;

export const catalogDetailSchema = z.object({
  api: catalogItemSchema.shape.api.extend({
    description: z.string(),
    ownerContact: z.string(),
  }),
  entity: entityRef.extend({ legalName: z.string() }),
  versions: z.array(catalogVersionSchema),
});
export type CatalogDetail = z.infer<typeof catalogDetailSchema>;

/** Provider entities that have at least one published API (catalogue filter). */
export const catalogEntitiesSchema = z.object({ items: z.array(entityRef) });

export const catalogApiParamsSchema = z.strictObject({ apiId: z.uuid() });
export const catalogVersionParamsSchema = z.strictObject({ apiId: z.uuid(), versionId: z.uuid() });
