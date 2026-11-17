import { SetMetadata } from '@nestjs/common';
import type { z } from 'zod';

export const OPENAPI_OPERATION = 'den:openapi-operation';

export interface ResponseSpec {
  description: string;
  /** JSON body schema; omit for empty responses (204). */
  schema?: z.ZodType;
  /** Media type of a binary body (e.g. application/pdf) instead of JSON. */
  binary?: string;
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
  /** Media type of a binary request body (e.g. application/pdf), instead of a JSON `body`. */
  binaryBody?: string;
  /** Success responses by status code. Error responses use the shared problem schema. */
  responses: Record<number, ResponseSpec>;
  /** Error statuses this endpoint can return (documented as application/problem+json). */
  errors?: number[];
  /**
   * false for endpoints that do not require authentication; 'citizen' for endpoints that take a
   * citizen token of the national identity provider instead of a portal token; 'node' for the
   * control channel of kit nodes (mTLS with the node's certificate). Defaults to true.
   */
  authenticated?: boolean | 'citizen' | 'node';
}

/** Documents an endpoint in /api/docs (ADR-0013). Every route must have it (checked by a test). */
export const ApiOperation = (spec: OperationSpec) => SetMetadata(OPENAPI_OPERATION, spec);
