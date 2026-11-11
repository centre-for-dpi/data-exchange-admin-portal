#!/usr/bin/env node
// Runs `opa test` on packages/policy. Uses a local `opa` binary when available,
// otherwise the official OPA container image (so it works on Windows/macOS/Linux).
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const OPA_IMAGE = 'openpolicyagent/opa:1.21.4-static';
const COVERAGE_ARGS = ['--verbose', '--coverage', '--format=json'];

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const policyDir = resolve(repoRoot, 'packages/policy');
const extraArgs = process.argv.slice(2);

function hasLocalOpa() {
  const probe = spawnSync('opa', ['version'], { stdio: 'ignore', shell: false });
  return probe.status === 0;
}

function run(cmd, args) {
  const result = spawnSync(cmd, args, { stdio: 'inherit', shell: false });
  if (result.error) {
    console.error(`Failed to run ${cmd}: ${result.error.message}`);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}

const wantsCoverage = extraArgs.includes('--coverage');
const testArgs = wantsCoverage
  ? COVERAGE_ARGS
  : ['--verbose', ...extraArgs.filter((a) => a !== '--coverage')];

if (hasLocalOpa()) {
  run('opa', ['test', ...testArgs, policyDir]);
} else {
  run('docker', [
    'run',
    '--rm',
    '-v',
    `${policyDir}:/policy:ro`,
    OPA_IMAGE,
    'test',
    ...testArgs,
    '/policy',
  ]);
}
