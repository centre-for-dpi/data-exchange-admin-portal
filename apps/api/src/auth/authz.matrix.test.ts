import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { API_PREFIX, createApp } from '../app.js';
import { type DiscoveredRoute, OpenApiService } from '../openapi/openapi.service.js';
import { repoRoot } from '../seed/realm.js';
import { AUTHZ_DOC, renderAuthzMatrix } from './authz.matrix.js';

describe('authorization matrix (M2-03)', () => {
  let app: NestFastifyApplication;
  let routes: DiscoveredRoute[];

  beforeAll(async () => {
    app = await createApp();
    const service = app.get(OpenApiService);
    service.setGlobalPrefix(API_PREFIX);
    routes = service.routes();
  });
  afterAll(async () => {
    await app.close();
  });

  const describeRoute = (r: DiscoveredRoute) => `${r.method} ${r.path} (${r.handler})`;

  it('every route declares who may call it', () => {
    expect(routes.filter((r) => r.access.kind === 'undeclared').map(describeRoute)).toEqual([]);
  });

  it('entity-scoped actions live under /entities/:entityId; platform ones do not', () => {
    const misplaced = routes.filter(
      (r) =>
        (r.access.kind === 'entity' && !r.path.includes('/entities/:entityId')) ||
        (r.access.kind === 'platform' && r.path.includes(':entityId')),
    );
    expect(misplaced.map(describeRoute)).toEqual([]);
  });

  it('keeps writes away from anonymous callers', () => {
    const openWrites = routes.filter((r) => r.method !== 'GET' && r.access.kind === 'optional');
    expect(openWrites.map(describeRoute)).toEqual([]);
  });

  it(`${AUTHZ_DOC} is generated from the current policy and routes`, () => {
    const file = join(repoRoot(), AUTHZ_DOC);
    const rendered = renderAuthzMatrix(routes);
    if (process.env.RID_UPDATE_AUTHZ_DOC === '1') writeFileSync(file, rendered);
    expect(readFileSync(file, 'utf8').replaceAll('\r\n', '\n')).toBe(rendered);
  });
});
