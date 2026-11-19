import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** The repository's root: the nearest directory with pnpm-workspace.yaml, from `start` up. */
export function repoRoot(start: string = process.cwd()): string {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`No pnpm-workspace.yaml above ${start}`);
    dir = parent;
  }
}

/**
 * `scripts/entity-check.sh`, the entities' helper (check, csr, call), as the repository has it:
 * one source of truth for the file the application page offers (P-05). The web reads it while it
 * is built (its route is static) and the image carries a copy too (apps/web/Dockerfile).
 */
export function entityCheckScript(): Uint8Array<ArrayBuffer> {
  return new Uint8Array(readFileSync(join(repoRoot(), 'scripts', 'entity-check.sh')));
}
