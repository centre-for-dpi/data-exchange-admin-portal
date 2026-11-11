import { problemDetailsSchema } from '@rid/contracts';
import { z } from 'zod';
import type { OperationSpec } from './api-operation.decorator.js';

export interface RouteDoc {
  method: string;
  /** Express-style path as registered in Nest, e.g. /api/v1/apis/:id */
  path: string;
  spec: OperationSpec;
}

type JsonSchema = Record<string, unknown>;

const PROBLEM_REF = { $ref: '#/components/schemas/Problem' };

const toSchema = (schema: z.ZodType): JsonSchema => {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema, {
    target: 'draft-2020-12',
    io: 'input',
    unrepresentable: 'any',
  }) as JsonSchema;
  return rest;
};

const openApiPath = (path: string): string => path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');

function parameters(spec: OperationSpec): JsonSchema[] {
  const list: JsonSchema[] = [];
  for (const [location, object] of [
    ['path', spec.params],
    ['query', spec.query],
  ] as const) {
    if (!object) continue;
    for (const [name, field] of Object.entries(object.shape)) {
      list.push({
        name,
        in: location,
        required: location === 'path' || !(field as z.ZodType).safeParse(undefined).success,
        schema: toSchema(field as z.ZodType),
      });
    }
  }
  return list;
}

function operation(route: RouteDoc): JsonSchema {
  const { spec } = route;
  const responses: Record<string, unknown> = {};
  for (const [status, response] of Object.entries(spec.responses)) {
    responses[status] = {
      description: response.description,
      ...(response.schema
        ? { content: { 'application/json': { schema: toSchema(response.schema) } } }
        : {}),
    };
  }
  for (const status of spec.errors ?? []) {
    responses[String(status)] = {
      description: 'Error (RFC 9457)',
      content: { 'application/problem+json': { schema: PROBLEM_REF } },
    };
  }
  responses.default = {
    description: 'Unexpected error (RFC 9457)',
    content: { 'application/problem+json': { schema: PROBLEM_REF } },
  };

  const params = parameters(spec);
  return {
    operationId: spec.operationId,
    summary: spec.summary,
    ...(spec.description ? { description: spec.description } : {}),
    tags: spec.tags,
    ...(params.length ? { parameters: params } : {}),
    ...(spec.body
      ? {
          requestBody: {
            required: true,
            content: { 'application/json': { schema: toSchema(spec.body) } },
          },
        }
      : {}),
    responses,
    ...(spec.authenticated === false ? { security: [] } : {}),
  };
}

/** Builds the OpenAPI 3.1 document of the portal API from the documented routes. */
export function buildOpenApiDocument(routes: RouteDoc[], info: { title: string; version: string }) {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const route of [...routes].sort((a, b) => a.path.localeCompare(b.path))) {
    const path = openApiPath(route.path);
    paths[path] = { ...paths[path], [route.method.toLowerCase()]: operation(route) };
  }
  return {
    openapi: '3.1.0',
    info: {
      ...info,
      description:
        'API of the RID portal. Errors use RFC 9457 problem details (application/problem+json).',
    },
    servers: [{ url: '/' }],
    security: [{ bearerAuth: [] }],
    paths,
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      },
      schemas: { Problem: toSchema(problemDetailsSchema) },
    },
  };
}
