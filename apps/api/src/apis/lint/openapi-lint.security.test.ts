import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { lintOpenApi } from './openapi-lint.js';

/**
 * The OpenAPI document is untrusted input from a provider entity. Linting it must never make the
 * portal fetch URLs (SSRF) or read local files through `$ref`, nor blow up on YAML aliases.
 */
describe('OpenAPI lint security', () => {
  let server: Server;
  let hits = 0;
  let url = '';

  beforeAll(async () => {
    server = createServer((_req, res) => {
      hits += 1;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ type: 'object', description: 'internal secret' }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/schema.json`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const withRef = (ref: string) => `openapi: 3.1.0
info: { title: T, version: '1' }
paths:
  /x:
    get:
      operationId: getX
      responses:
        '200':
          description: ok
          content:
            application/json:
              schema:
                $ref: '${ref}'
`;

  it('never fetches remote $refs and reports them as errors', async () => {
    const result = await lintOpenApi(withRef(url), { noIdInQuery: true });
    expect(hits).toBe(0);
    expect(result.report.valid).toBe(false);
    expect(result.report.issues.map((i) => i.code)).toContain('den-no-external-ref');
    expect(JSON.stringify(result)).not.toContain('internal secret');
  });

  it.each(['file:///etc/hosts', '../../../../.env', 'C:/Windows/win.ini', './other.yaml#/X'])(
    'never reads local files through $ref (%s)',
    async (ref) => {
      const result = await lintOpenApi(withRef(ref), { noIdInQuery: true });
      expect(result.report.valid).toBe(false);
      expect(result.report.issues.map((i) => i.code)).toContain('den-no-external-ref');
      expect(JSON.stringify(result)).not.toMatch(/AUTH_SECRET|localhost|\[extensions\]/);
    },
  );

  it('refuses paths that could leave the version (dot segments, encoded slashes)', async () => {
    const withPath = (path: string) => `openapi: 3.1.0
info: { title: T, version: '1' }
paths:
  '${path}':
    get:
      operationId: op
      responses: { '200': { description: ok } }
`;
    for (const path of ['/../otra', '/a/./b', '/a/%2e%2e/b', '/a%2Fb', '/a\\\\b', '/a//b']) {
      const result = await lintOpenApi(withPath(path), { noIdInQuery: true });
      expect(
        result.report.issues.some((i) => i.code === 'den-path-traversal'),
        path,
      ).toBe(true);
    }
    const fine = await lintOpenApi(withPath('/afiliados/{id}'), { noIdInQuery: true });
    expect(fine.report.issues.some((i) => i.code === 'den-path-traversal')).toBe(false);
  });

  it('still resolves local #/components refs', async () => {
    const source = `${withRef('#/components/schemas/X')}components:
  schemas:
    X: { type: object }
`;
    const result = await lintOpenApi(source, { noIdInQuery: true });
    expect(result.report.issues.filter((i) => i.severity === 'error')).toEqual([]);
  });

  const aliasBomb = () => {
    const levels = ['a: &a ["lol","lol","lol","lol","lol","lol","lol","lol","lol"]'];
    for (let i = 1; i < 10; i += 1) {
      const prev = String.fromCharCode(96 + i);
      const name = String.fromCharCode(97 + i);
      levels.push(
        `${name}: &${name} [${Array(9)
          .fill('*' + prev)
          .join(',')}]`,
      );
    }
    return levels.join('\n');
  };

  it('fails closed: an alias bomb combined with an unrelated YAML error is still rejected', async () => {
    // A duplicate key makes a strict parser throw before it counts aliases; the document must
    // still never reach Spectral's (unbounded) parser.
    const source = `openapi: 3.1.0
info: { title: T, version: '1' }
paths: {}
paths: {}
${aliasBomb()}
`;
    const started = Date.now();
    const result = await lintOpenApi(source, { noIdInQuery: true });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result.report.valid).toBe(false);
    expect(result.spec).toEqual({});
  });

  it('rejects YAML alias bombs quickly instead of expanding them', async () => {
    const levels = ['a: &a ["lol","lol","lol","lol","lol","lol","lol","lol","lol"]'];
    for (let i = 1; i < 10; i += 1) {
      const prev = String.fromCharCode(96 + i);
      const name = String.fromCharCode(97 + i);
      levels.push(
        `${name}: &${name} [*${prev},*${prev},*${prev},*${prev},*${prev},*${prev},*${prev},*${prev},*${prev}]`,
      );
    }
    const bomb = `openapi: 3.1.0\ninfo: { title: T, version: '1' }\npaths: {}\n${levels.join('\n')}\n`;
    const started = Date.now();
    const result = await lintOpenApi(bomb, { noIdInQuery: true });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result.report.valid).toBe(false);
    expect(result.report.issues.map((i) => i.code)).toContain('den-yaml-too-complex');
    expect(JSON.stringify(result.spec).length).toBeLessThan(10_000);
  });
});
