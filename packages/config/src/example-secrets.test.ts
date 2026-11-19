import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertNoExampleSecrets,
  ExampleSecretError,
  exampleSecretsInUse,
  isDeployed,
  parseDotenv,
  readEnvExample,
} from './example-secrets.js';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

/** A repository root (pnpm-workspace.yaml) with this .env.example. */
function repo(example?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'den-example-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'pnpm-workspace.yaml'), 'packages: []\n');
  if (example !== undefined) writeFileSync(join(dir, '.env.example'), example);
  return dir;
}

const EXAMPLE = [
  '# comment',
  'AUTH_SECRET=den-dev-auth-secret-change-me',
  'SIGNING_JWK=\'{"d":"abc"}\'',
  'DB_PASSWORD=den-app-dev-password',
  'DATABASE_URL=postgresql://den_app:den-app-dev-password@localhost:5432/den',
  'EMPTY=',
  '# COMMENTED=value',
].join('\n');

describe('example secrets (M-25)', () => {
  it('parses .env.example: comments skipped, outer quotes removed', () => {
    const values = parseDotenv(EXAMPLE);
    expect(values.get('SIGNING_JWK')).toBe('{"d":"abc"}');
    expect(values.get('EMPTY')).toBe('');
    expect(values.has('COMMENTED')).toBe(false);
  });

  it('finds the repository .env.example from a folder inside it', () => {
    const root = repo(EXAMPLE);
    expect(readEnvExample(root)?.get('AUTH_SECRET')).toBe('den-dev-auth-secret-change-me');
    expect(readEnvExample(repo())).toBeUndefined();
  });

  it('flags a secret equal to its example, or one that carries an example secret inside', () => {
    const example = parseDotenv(EXAMPLE);
    const env = {
      AUTH_SECRET: 'den-dev-auth-secret-change-me',
      SIGNING_JWK: '{"d":"abc"}',
      DATABASE_URL: 'postgresql://den_app:den-app-dev-password@postgres:5432/den',
      EMPTY: '',
    };
    const names = ['AUTH_SECRET', 'SIGNING_JWK', 'DATABASE_URL', 'EMPTY', 'UNSET'];
    expect(exampleSecretsInUse(names, env, example)).toEqual(['AUTH_SECRET', 'SIGNING_JWK']);
    expect(exampleSecretsInUse(names, env, example, { DATABASE_URL: ['DB_PASSWORD'] })).toEqual([
      'AUTH_SECRET',
      'SIGNING_JWK',
      'DATABASE_URL',
    ]);
    expect(exampleSecretsInUse(names, { AUTH_SECRET: 'random-and-long' }, example)).toEqual([]);
  });

  it('refuses in production only, and fails closed without .env.example', () => {
    const env = { AUTH_SECRET: 'den-dev-auth-secret-change-me' };
    const startDir = repo(EXAMPLE);
    expect(() => assertNoExampleSecrets(['AUTH_SECRET'], { env, startDir })).not.toThrow();
    expect(() =>
      assertNoExampleSecrets(['AUTH_SECRET'], { env, startDir, production: true }),
    ).toThrow(/AUTH_SECRET still has the example value/);
    expect(() =>
      assertNoExampleSecrets(['AUTH_SECRET'], {
        env: { NODE_ENV: 'production', AUTH_SECRET: 'x' },
        startDir: repo(),
      }),
    ).toThrow(ExampleSecretError);
  });

  it('a deployment is production on an address other than loopback', () => {
    const production = { NODE_ENV: 'production' };
    expect(isDeployed('https://portal.den.example', production)).toBe(true);
    expect(isDeployed('http://localhost:3000', production)).toBe(false);
    expect(isDeployed('http://127.0.0.1:3100/citizen-app', production)).toBe(false);
    expect(isDeployed('https://portal.den.example', { NODE_ENV: 'development' })).toBe(false);
    // No address: assume a deployment.
    expect(isDeployed(undefined, production)).toBe(true);
  });
});
