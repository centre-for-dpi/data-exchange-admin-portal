#!/usr/bin/env node
// Runs compiled code under plain Node ESM. Vitest transforms modules and hides CommonJS interop
// problems (e.g. namespace imports of CJS packages being undefined); this catches them.
// Usage: pnpm --filter @den/api build && node scripts/smoke-dist.mjs
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const { lintOpenApi } = await import(
  pathToFileURL(resolve(here, '../dist/apis/lint/openapi-lint.js')).href
);
const spec = readFileSync(
  resolve(here, '../../../infra/mock-providers/salud/openapi.yaml'),
  'utf8',
);

const ok = await lintOpenApi(spec, { noIdInQuery: true });
const broken = await lintOpenApi(spec.replace('operationId: getAfiliado', ''), {
  noIdInQuery: true,
});
// External $ref must be reported, never fetched (ref resolver wiring under plain Node).
const external = await lintOpenApi(
  spec.replace("$ref: '#/components/schemas/Afiliado'", "$ref: 'http://127.0.0.1:1/x.json'"),
  {
    noIdInQuery: true,
  },
);
const externalFlagged = external.report.issues.some((i) => i.code === 'den-no-external-ref');
if (!ok.report.valid || ok.operations.length !== 2 || broken.report.valid || !externalFlagged) {
  console.error(
    'Smoke test failed',
    JSON.stringify({ ok: ok.report, broken: broken.report.valid }),
  );
  process.exit(1);
}
console.log('dist smoke test OK: OpenAPI lint works under plain Node');
