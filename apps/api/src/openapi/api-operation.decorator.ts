import { SetMetadata } from '@nestjs/common';
import type { z } from 'zod';

export const OPENAPI_OPERATION = 'rid:openapi-operation';

export interface ResponseSpec {
  description: string;
  /** JSON body schema; omit for empty responses (204). */
  schema?: z.ZodType;
}

/** OpenAPI description of one endpoint, built from the same zod schemas that validate it. */
export interface OperationSpec {
  operationId: string;
  summary: string;
  description?: string;
  tags: string[];
  params?: z.ZodObject;
  query?: z.ZodObject;
  body?: z.ZodType;
  /** Success responses by status code. Error responses use the shared problem schema. */
  responses: Record<number, ResponseSpec>;
  /** Error statuses this endpoint can return (documented as application/problem+json). */
  errors?: number[];
  /** false for endpoints that do not require authentication. Defaults to true. */
  authenticated?: boolean;
}

/** Documents an endpoint in /api/docs (ADR-0013). Every route must have it (checked by a test). */
export const ApiOperation = (spec: OperationSpec) => SetMetadata(OPENAPI_OPERATION, spec);
