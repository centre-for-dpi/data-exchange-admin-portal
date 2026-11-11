// Golden rule 6 (CLAUDE.md): nothing country-specific in code. Country data lives in
// config/country/*.yaml and i18n files. This guard scans production source (not tests) for
// terms of the first deployment that must never be hard-coded.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_ROOTS = ['apps', 'packages'];
const SOURCE_FILE = /\.(ts|tsx|mts|js|mjs|rego)$/;
const TEST_FILE = /(\.test\.|\.spec\.|_test\.rego$)/;
const SKIP_DIRS = new Set(['node_modules', 'dist', '.next', '.turbo', 'coverage']);

const FORBIDDEN = [
  /Colombia/i,
  /MinTIC/,
  /Agencia Nacional Digital/i,
  /Ley 1581/i,
  /Superintendencia de Industria/i,
  /America\/Bogota/,
  /\bes-CO\b/,
];

function* sourceFiles(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* sourceFiles(path);
    else if (SOURCE_FILE.test(entry) && !TEST_FILE.test(entry)) yield path;
  }
}

describe('country neutrality (golden rule 6)', () => {
  it('keeps country-specific terms out of production source code', () => {
    const findings = [];
    for (const root of SOURCE_ROOTS) {
      for (const file of sourceFiles(join(repoRoot, root))) {
        const lines = readFileSync(file, 'utf8').split('\n');
        lines.forEach((line, index) => {
          for (const pattern of FORBIDDEN) {
            if (pattern.test(line)) {
              findings.push(`${relative(repoRoot, file)}:${index + 1} matches ${pattern}`);
            }
          }
        });
      }
    }
    expect(findings).toEqual([]);
  });
});
