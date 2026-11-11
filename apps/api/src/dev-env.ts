import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * Outside production, loads the repo-root .env (the same file Docker Compose uses) so `pnpm dev`
 * works without exporting variables. Variables already set in the environment win.
 */
export function loadDevEnv(startDir: string = process.cwd()): string | undefined {
  if (process.env.NODE_ENV === 'production') return undefined;
  let dir = resolve(startDir);
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) {
      const file = join(dir, '.env');
      if (!existsSync(file)) return undefined;
      process.loadEnvFile(file);
      return file;
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}
