import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { fromRoot } from './paths.js';

// The images of the compose file: the checks run with the same Prometheus and Alertmanager.
const PROMETHEUS = 'prom/prometheus:v3.15.1';
const ALERTMANAGER = 'prom/alertmanager:v0.34.2';

function docker(args: string[]) {
  const result = spawnSync('docker', args, {
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, MSYS_NO_PATHCONV: '1' },
  });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

/** The alerts of ARCHITECTURE.md §9 (M5-06), with promtool and amtool. */
describe('alert rules and Alertmanager configuration (M5-06)', () => {
  it('every alert fires on the series it is for, and not on healthy ones', () => {
    const run = docker([
      'run',
      '--rm',
      '-v',
      `${fromRoot('infra/prometheus')}:/p:ro`,
      '-w',
      '/p/tests',
      '--entrypoint',
      'promtool',
      PROMETHEUS,
      'test',
      'rules',
      'rid.rules.test.yml',
    ]);
    expect(run.status, run.out).toBe(0);
    expect(run.out).toContain('SUCCESS');
  });

  it('the rules and the Alertmanager configuration are valid', () => {
    const rules = docker([
      'run',
      '--rm',
      '-v',
      `${fromRoot('infra/prometheus')}:/p:ro`,
      '--entrypoint',
      'promtool',
      PROMETHEUS,
      'check',
      'rules',
      '/p/rules/rid.rules.yml',
    ]);
    expect(rules.status, rules.out).toBe(0);
    expect(rules.out).toContain('9 rules found');
    const alertmanager = docker([
      'run',
      '--rm',
      '-v',
      `${fromRoot('infra/alertmanager')}:/a:ro`,
      '--entrypoint',
      'amtool',
      ALERTMANAGER,
      'check-config',
      '/a/alertmanager.yml',
    ]);
    expect(alertmanager.status, alertmanager.out).toBe(0);
  });
});
