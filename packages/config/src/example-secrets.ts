import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * Example secrets (M-25). `.env.example` publishes a value for every secret, good for development
 * only. In production each service refuses to start while one of its secrets still has that value:
 * a hand-written `.env`, or one copied from the example, would otherwise run with keys anyone can
 * read in the repository. The images carry `.env.example` for this check.
 */

/** The repository root (`pnpm-workspace.yaml`, also in the images) at or above `startDir`. */
function repoRoot(startDir: string): string | undefined {
  // turbopackIgnore: runtime path, so the Next.js file tracer does not walk the whole repository.
  let dir = resolve(/* turbopackIgnore: true */ startDir);
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** `KEY=value` lines of a dotenv file, without comments; one pair of outer quotes removed. */
export function parseDotenv(text: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (!match) continue;
    let value = match[2]!.trim();
    const quote = value[0];
    if ((quote === "'" || quote === '"') && value.length >= 2 && value.endsWith(quote)) {
      value = value.slice(1, -1);
    }
    values.set(match[1]!, value);
  }
  return values;
}

/** The values of the repository's `.env.example`, or undefined when it cannot be found. */
export function readEnvExample(startDir: string = process.cwd()): Map<string, string> | undefined {
  const root = repoRoot(startDir);
  const file = root && join(root, '.env.example');
  if (!file || !existsSync(file)) return undefined;
  return parseDotenv(readFileSync(file, 'utf8'));
}

/**
 * The secrets among `names` whose value is the one in `.env.example`. `embedded` names, for a
 * value that carries another secret inside (a connection string, a JSON), the example secrets it
 * must not contain (DATABASE_URL: the database password of the example).
 */
export function exampleSecretsInUse(
  names: readonly string[],
  env: NodeJS.ProcessEnv,
  example: Map<string, string>,
  embedded: Readonly<Record<string, readonly string[]>> = {},
): string[] {
  return names.filter((name) => {
    const value = env[name]?.trim();
    if (!value) return false;
    const sample = example.get(name);
    if (sample && value === sample) return true;
    return (embedded[name] ?? []).some((other) => {
      const inner = example.get(other);
      return inner !== undefined && inner.length >= 8 && value.includes(inner);
    });
  });
}

/**
 * A deployment rather than a laptop: NODE_ENV=production and the service's public address
 * (`url`) is not loopback. `next start` and the local end-to-end tests run with NODE_ENV=production
 * on localhost and keep the example values.
 */
export function isDeployed(url: string | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.NODE_ENV !== 'production') return false;
  try {
    return !['localhost', '127.0.0.1', '[::1]'].includes(new URL(url ?? '').hostname);
  } catch {
    return true;
  }
}

export class ExampleSecretError extends Error {
  constructor(readonly names: string[]) {
    super(
      names.length === 0
        ? '.env.example was not found: the example secrets cannot be checked'
        : `${names.join(', ')} still ${names.length === 1 ? 'has' : 'have'} the example value ` +
            'of .env.example: generate one per deployment (scripts/make-deploy-env.mjs)',
    );
    this.name = 'ExampleSecretError';
  }
}

/**
 * Throws in production (NODE_ENV=production) when one of `names` has its `.env.example` value, or
 * when `.env.example` is missing (the check could not run: fails closed). Does nothing otherwise.
 */
export function assertNoExampleSecrets(
  names: readonly string[],
  options: {
    env?: NodeJS.ProcessEnv;
    startDir?: string;
    production?: boolean;
    embedded?: Readonly<Record<string, readonly string[]>>;
  } = {},
): void {
  const env = options.env ?? process.env;
  const production = options.production ?? env.NODE_ENV === 'production';
  if (!production) return;
  const example = readEnvExample(options.startDir);
  if (!example) throw new ExampleSecretError([]);
  const found = exampleSecretsInUse(names, env, example, options.embedded);
  if (found.length > 0) throw new ExampleSecretError(found);
}
