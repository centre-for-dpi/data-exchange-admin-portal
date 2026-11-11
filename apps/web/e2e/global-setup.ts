import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

/** Brings the development database up to date and loads the seed users and roles. */
export default function globalSetup(): void {
  const root = resolve(import.meta.dirname, '../../..');
  execSync('pnpm db:deploy', { cwd: root, stdio: 'inherit' });
  execSync('pnpm db:seed', { cwd: root, stdio: 'inherit' });
}
