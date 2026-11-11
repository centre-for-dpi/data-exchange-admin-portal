import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { RealmUser } from './seed.js';

export function repoRoot(start: string = process.cwd()): string {
  let dir = resolve(start);
  while (!existsSync(join(dir, 'pnpm-workspace.yaml'))) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error('Repository root (pnpm-workspace.yaml) not found');
    dir = parent;
  }
  return dir;
}

/** Seed users of the Keycloak realm export: single source for their ids (keycloakSub). */
export function readRealmUsers(root: string = repoRoot()): RealmUser[] {
  const file = join(root, 'infra', 'keycloak', 'rid-portal-realm.json');
  const realm = JSON.parse(readFileSync(file, 'utf8')) as { users?: RealmUser[] };
  return realm.users ?? [];
}
