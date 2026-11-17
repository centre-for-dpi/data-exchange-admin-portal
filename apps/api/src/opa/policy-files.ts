import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Directory of the Rego policies (packages/policy). DEN_POLICY_DIR wins (container images);
 * otherwise it is searched upwards from this file, which works from src/ and dist/.
 */
export function findPolicyDir(): string {
  if (process.env.DEN_POLICY_DIR) return resolve(process.env.DEN_POLICY_DIR);
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = join(dir, 'packages', 'policy');
    if (existsSync(join(candidate, 'den'))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error('packages/policy not found (set DEN_POLICY_DIR)');
    dir = parent;
  }
}

/** Every .rego file except tests, with its path relative to the policy dir (POSIX separators). */
export function readPolicies(dir = findPolicyDir()): Array<{ path: string; source: string }> {
  const files: Array<{ path: string; source: string }> = [];
  const walk = (current: string) => {
    for (const name of readdirSync(current).sort()) {
      const full = join(current, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith('.rego') && !name.endsWith('_test.rego')) {
        files.push({
          path: relative(dir, full).split(sep).join('/'),
          source: readFileSync(full, 'utf8'),
        });
      }
    }
  };
  walk(dir);
  if (files.length === 0) throw new Error(`No Rego policies in ${dir}`);
  return files;
}
