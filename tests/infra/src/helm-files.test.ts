import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { fromRoot } from './paths.js';

/**
 * The Helm chart reads its copies of the configuration it shares with Compose (M6-05): Helm only
 * sees files inside the chart. They must be the repository's, byte for byte (`pnpm helm:sync`).
 */
describe('Helm chart files', () => {
  it('are the same as their sources in infra/', () => {
    const run = spawnSync(process.execPath, [fromRoot('scripts/helm-sync.mjs'), '--check'], {
      encoding: 'utf8',
    });
    expect(run.status, run.stderr).toBe(0);
  });
});
