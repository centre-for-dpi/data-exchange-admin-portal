import { execFileSync, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../..');
const compose = (...args: string[]) =>
  execFileSync(
    'docker',
    [
      'compose',
      '-f',
      resolve(root, 'infra/compose/docker-compose.yml'),
      '--env-file',
      resolve(root, '.env'),
      '--profile',
      'nodes',
      ...args,
    ],
    { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
  );

/**
 * Starts a fresh simulated kit node (infra/mock-node, a test fixture: M4-03) and hands it the
 * enrollment token, as whoever installs the kit at the bootcamp would.
 */
export function startMockNode(token: string): void {
  compose('up', '-d', '--force-recreate', '--renew-anon-volumes', '--wait', 'mock-node');
  execFileSync(
    'docker',
    ['exec', '-i', 'rid-mock-node-1', 'sh', '-c', 'cat > /var/lib/mock-node/token'],
    { input: token },
  );
}

export function stopMockNode(): void {
  compose('stop', 'mock-node');
}

/** The node logs to stderr, which docker logs passes on as its own stderr. */
export const mockNodeLogs = (): string => {
  const res = spawnSync('docker', ['logs', '--tail', '200', 'rid-mock-node-1'], {
    encoding: 'utf8',
  });
  return `${res.stdout}${res.stderr}`;
};
