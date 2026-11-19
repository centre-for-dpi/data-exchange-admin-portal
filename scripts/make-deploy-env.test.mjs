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

/** A value of the generated file, without the single quotes it may be written in. */
const valueOf = (file, name) =>
  (readFileSync(file, 'utf8').match(new RegExp(`^${name}=(.*)$`, 'm'))?.[1] ?? '').replace(
    /^'(.*)'$/,
    '$1',
  );
const demoPassword = (file) => valueOf(file, 'DEN_DEMO_USER_PASSWORD');

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

describe('make-deploy-env secrets of the pilot (R-04)', () => {
  it('a password with $ or # is written in single quotes, and quotes are refused (B-30)', () => {
    const r = run({ DEN_DEPLOY_DEMO_PASSWORD: 'pa$$word#with spaces' });
    expect(r.status).toBe(0);
    expect(readFileSync(r.out, 'utf8')).toContain(
      "\nDEN_DEMO_USER_PASSWORD='pa$$word#with spaces'\n",
    );
    for (const bad of ["it's-long-enough", 'a"long-enough-one', 'a\\long-enough-one']) {
      const refused = run({ DEN_DEPLOY_DEMO_PASSWORD: bad });
      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain('no quotes');
    }
  });

  it('the critical roles get a random password of their own (M-29)', () => {
    const r = run({ DEN_DEPLOY_DEMO_PASSWORD: 'shared-at-the-workshop' });
    const critical = valueOf(r.out, 'DEN_DEMO_CRITICAL_PASSWORD');
    expect(critical.length).toBeGreaterThanOrEqual(16);
    expect(critical).not.toBe('shared-at-the-workshop');
  });

  it("each step-ca provisioner has a password of its own, not the CA's (B-16)", () => {
    const r = run({ DEN_DEPLOY_DEMO_PASSWORD: '' });
    const names = [
      'STEP_CA_PASSWORD',
      'DEN_STEP_CA_PROVISIONER_PASSWORD',
      'DEN_STEP_CA_GATEWAY_PROVISIONER_PASSWORD',
      'DEN_STEP_CA_NODE_PROVISIONER_PASSWORD',
    ];
    const values = names.map((n) => valueOf(r.out, n));
    expect(values.every((v) => v.length >= 24)).toBe(true);
    expect(new Set(values).size).toBe(names.length);
  });

  it('mail goes to Mailpit on the Compose network; the proxy network is neutral (M-28, B-33)', () => {
    const r = run({ DEN_DEPLOY_DEMO_PASSWORD: '' });
    expect(valueOf(r.out, 'DEN_SMTP_URL')).toBe('smtp://mailpit:1025');
    expect(valueOf(r.out, 'TRAEFIK_NETWORK')).toBe('den-edge');
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
