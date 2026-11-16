import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { fromRoot } from './paths.js';

type Compose = { services: Record<string, { networks?: Record<string, unknown> }> };

/** The resolved Compose configuration, as `docker compose config` renders it. */
function config(files: string[], env: Record<string, string> = {}): Compose {
  const result = spawnSync(
    'docker',
    [
      'compose',
      ...files.flatMap((f) => ['-f', fromRoot('infra/compose', f)]),
      '--env-file',
      fromRoot('.env'),
      '--profile',
      'observability',
      '--profile',
      'nodes',
      'config',
      '--format',
      'json',
    ],
    { encoding: 'utf8', env: { ...process.env, ...env } },
  );
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as Compose;
}

const networksOf = (compose: Compose, service: string) =>
  Object.keys(compose.services[service]?.networks ?? {}).sort();

/**
 * Network segmentation (M6-01): the gateway's control plane (etcd and OPA, without
 * authentication of their own) is reachable only from the gateway and the platform; the
 * upstreams and the contract runner reach neither it nor the platform; and the gateway reaches
 * nothing of the platform's internals (database, CA, analytics store, mail).
 */
describe('network segmentation of the stack (M6-01)', () => {
  const deployEnv = { RID_PUBLIC_URL: 'https://portal.test', MAILPIT_UI_AUTH: 'a:b' };
  const stacks = [
    ['development', config(['docker-compose.yml'])],
    ['pilot', config(['docker-compose.yml', 'docker-compose.deploy.yml'], deployEnv)],
  ] as const;

  for (const [name, compose] of stacks) {
    it(`${name}: etcd and OPA only on the gateway's control network`, () => {
      expect(networksOf(compose, 'etcd')).toEqual(['gateway']);
      expect(networksOf(compose, 'opa')).toEqual(['gateway']);
    });

    it(`${name}: the gateway is not on the platform network`, () => {
      expect(networksOf(compose, 'apisix')).not.toContain('default');
      // (The pilot's proxy reaches some of them on its own network, edge.)
      for (const internal of ['postgres', 'step-ca', 'opensearch', 'mailpit', 'tsa']) {
        const networks = networksOf(compose, internal);
        expect(networks, internal).not.toContain('gateway');
        expect(networks, internal).not.toContain('providers');
      }
    });

    it(`${name}: upstreams and the contract runner reach neither the control plane nor the platform`, () => {
      for (const service of ['mock-salud', 'mock-socioeconomico', 'mock-node']) {
        expect(networksOf(compose, service), service).toEqual(['providers']);
      }
      expect(networksOf(compose, 'contract-runner')).toEqual(
        name === 'pilot' ? ['providers', 'runner'] : ['providers'],
      );
    });
  }

  it('pilot: no upstream reaches the API without the proxy', () => {
    const [, pilot] = stacks[1];
    expect(networksOf(pilot, 'api')).toEqual(['default', 'edge', 'gateway', 'runner']);
    const onRunner = Object.keys(pilot.services).filter((s) =>
      networksOf(pilot, s).includes('runner'),
    );
    expect(onRunner.sort()).toEqual(['api', 'contract-runner']);
  });
});
