import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { NODE_CONTRACT_VERSION } from '@den/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { API_PREFIX, createApp } from '../app.js';
import { OpenApiService } from '../openapi/openapi.service.js';
import { repoRoot } from '../seed/realm.js';

/** The versioned contract with the kit (ADR-0011), generated from the API itself. */
export const NODE_CONTRACT_DOC = `docs/contracts/node-contract-v${NODE_CONTRACT_VERSION}.openapi.json`;
const TAG = 'node contract';

describe('contract with the kit (ARCHITECTURE.md §10, M4-02)', () => {
  let app: NestFastifyApplication;
  let document: { paths: Record<string, Record<string, { tags?: string[] }>> } & Record<
    string,
    unknown
  >;

  beforeAll(async () => {
    app = await createApp();
    const service = app.get(OpenApiService);
    service.setGlobalPrefix(API_PREFIX);
    document = service.document({
      title: 'DEN portal: contract with the instant-APIs kit',
      version: NODE_CONTRACT_VERSION,
    }) as typeof document;
  });
  afterAll(async () => {
    await app.close();
  });

  const contract = () => {
    const paths: Record<string, Record<string, { tags?: string[] }>> = {};
    for (const [path, operations] of Object.entries(document.paths)) {
      const kept = Object.entries(operations).filter(([, op]) => op.tags?.includes(TAG));
      if (kept.length > 0) paths[path] = Object.fromEntries(kept);
    }
    return { ...document, paths };
  };

  it('has exactly the four endpoints of ARCHITECTURE.md §10', () => {
    expect(Object.keys(contract().paths).sort()).toEqual([
      '/api/v1/nodes/enroll',
      '/api/v1/nodes/{nodeId}/config',
      '/api/v1/nodes/{nodeId}/heartbeat',
      '/api/v1/nodes/{nodeId}/renew',
    ]);
  });

  it(`${NODE_CONTRACT_DOC} is generated from the API`, () => {
    const file = join(repoRoot(), NODE_CONTRACT_DOC);
    const rendered = `${JSON.stringify(contract(), null, 2)}\n`;
    if (process.env.DEN_UPDATE_NODE_CONTRACT === '1') writeFileSync(file, rendered);
    expect(readFileSync(file, 'utf8').replaceAll('\r\n', '\n')).toBe(rendered);
  });
});
