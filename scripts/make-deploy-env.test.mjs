import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const script = resolve(import.meta.dirname, 'make-deploy-env.mjs');

function run(env, ...args) {
  const out = join(mkdtempSync(join(tmpdir(), 'den-env-')), '.env');
  const result = spawnSync(
    process.execPath,
    [
      script,
      'https://portal.example.org',
      '--gateway-host',
      'gw.example.org',
      '--out',
      out,
      ...args,
    ],
    { encoding: 'utf8', env: { ...process.env, ...env } },
  );
  return { ...result, out };
}

const demoPassword = (file) =>
  readFileSync(file, 'utf8').match(/^DEN_DEMO_USER_PASSWORD=(.*)$/m)?.[1] ?? '';

describe('make-deploy-env demo password', () => {
  // install.sh passes the operator's answer in DEN_DEPLOY_DEMO_PASSWORD; Enter means "random".
  it('an empty answer gives a random password', () => {
    const r = run({ DEN_DEPLOY_DEMO_PASSWORD: '' });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(demoPassword(r.out).length).toBeGreaterThanOrEqual(12);
  });

  it('a short password is refused (the realm policy asks for 12)', () => {
    const r = run({ DEN_DEPLOY_DEMO_PASSWORD: 'short' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('at least 12 characters');
  });

  it('a long enough password is kept', () => {
    const r = run({ DEN_DEPLOY_DEMO_PASSWORD: 'a-long-enough-password' });
    expect(r.status).toBe(0);
    expect(demoPassword(r.out)).toBe('a-long-enough-password');
  });
});

describe('make-deploy-env documents folder', () => {
  // The development value (data/documents) resolved inside the image to a folder `node` cannot
  // create, and env_file overrode the image's ENV: uploads failed in every deployment (P-06).
  it('points DEN_DOCUMENTS_DIR at the api-documents volume', () => {
    const r = run({ DEN_DEPLOY_DEMO_PASSWORD: '' });
    expect(r.status).toBe(0);
    const lines = readFileSync(r.out, 'utf8').match(/^DEN_DOCUMENTS_DIR=.*$/gm);
    expect(lines).toEqual(['DEN_DOCUMENTS_DIR=/var/lib/den/documents']);
  });

  it('the deploy overlay pins it for the API whatever .env says', () => {
    const overlay = readFileSync(
      resolve(import.meta.dirname, '../infra/compose/docker-compose.deploy.yml'),
      'utf8',
    );
    const api = overlay.slice(overlay.indexOf('\n  api:\n'), overlay.indexOf('\n  web:\n'));
    expect(api).toMatch(/^ {6}DEN_DOCUMENTS_DIR: \/var\/lib\/den\/documents$/m);
    expect(api).toContain('api-documents:/var/lib/den/documents');
  });
});
