import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { useTestDatabase } from './load-env.js';

/** Applies every migration to den_test as the schema owner before the integration suite. */
export default function setup(): void {
  useTestDatabase();
  execSync('pnpm exec prisma migrate deploy', {
    cwd: resolve(import.meta.dirname, '..'),
    stdio: 'inherit',
    env: process.env,
  });
}
