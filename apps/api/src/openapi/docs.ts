import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { apiReference } from '@scalar/nestjs-api-reference';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { OpenApiService } from './openapi.service.js';

export const DOCS_PATH = '/api/docs';
export const OPENAPI_JSON_PATH = `${DOCS_PATH}/openapi.json`;
/** The Scalar bundle, served from the API itself (B-11): no third-party host, no floating version. */
export const SCALAR_BUNDLE_PATH = `${DOCS_PATH}/scalar.js`;

/** The standalone browser bundle of the pinned `@scalar/api-reference` (exact version in package.json). */
function readScalarBundle(): Buffer {
  const entry = createRequire(import.meta.url).resolve('@scalar/api-reference');
  return readFileSync(new URL('./browser/standalone.js', pathToFileURL(entry)));
}

/**
 * Publishes the portal API's OpenAPI document and its Scalar reference (ADR-0013).
 * Must run after app.init() (routes discovered) and before the server starts listening.
 */
export function registerApiDocs(app: NestFastifyApplication, prefix: string): void {
  const openApi = app.get(OpenApiService);
  openApi.setGlobalPrefix(prefix);
  const document = openApi.document({ title: 'Portal DEN API', version: '1' });

  const fastify = app.getHttpAdapter().getInstance();
  fastify.get(OPENAPI_JSON_PATH, (_request, reply) => reply.send(document));

  const bundle = readScalarBundle();
  fastify.get(SCALAR_BUNDLE_PATH, (_request, reply) =>
    reply
      .header('content-type', 'text/javascript; charset=utf-8')
      .header('cache-control', 'public, max-age=3600')
      .send(bundle),
  );

  fastify.get(DOCS_PATH, (request, reply) => {
    // The page is written on the raw response (hijacked), outside the API's onSend hook, so its
    // headers are set here: scripts only from this origin or carrying this request's nonce.
    const nonce = randomBytes(16).toString('base64');
    const render = apiReference({
      url: OPENAPI_JSON_PATH,
      cdn: SCALAR_BUNDLE_PATH,
      nonce,
      withDefaultFonts: false,
      withFastify: true,
    }) as (request: unknown, response: ServerResponse) => void;
    void reply.hijack();
    const raw = reply.raw;
    raw.setHeader('x-content-type-options', 'nosniff');
    raw.setHeader('referrer-policy', 'no-referrer');
    raw.setHeader('cache-control', 'no-store');
    raw.setHeader(
      'content-security-policy',
      [
        "default-src 'none'",
        `script-src 'self' 'nonce-${nonce}'`,
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data:",
        "font-src 'self' data:",
        "connect-src 'self'",
        "base-uri 'none'",
        "form-action 'none'",
        "frame-ancestors 'none'",
      ].join('; '),
    );
    render(request, raw);
  });
}
