#!/usr/bin/env node
// @ts-check
// `pnpm license:check`: lists the licenses of every installed dependency (prod + dev, all
// workspace packages) and fails if any is outside the ADR-0008 policy and not covered by a
// per-package exception in scripts/license-exceptions.json. `--verbose` prints every package.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateLicenses } from './license-policy.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const verbose = process.argv.includes('--verbose');

/**
 * Runs pnpm with fixed arguments. On Windows pnpm is a .cmd shim that needs a shell; the command
 * is a constant string (no user input), so passing it whole to the shell is safe.
 * @param {string[]} args
 */
function runPnpm(args) {
  const options = {
    cwd: repoRoot,
    encoding: /** @type {const} */ ('utf8'),
    maxBuffer: 64 * 1024 * 1024,
  };
  const result =
    process.platform === 'win32'
      ? spawnSync(`pnpm ${args.join(' ')}`, { ...options, shell: true })
      : spawnSync('pnpm', args, options);
  if (result.status !== 0) {
    console.error(result.stderr || result.error?.message || 'pnpm licenses failed');
    process.exit(2);
  }
  return result.stdout;
}

const pnpmLicenses = JSON.parse(runPnpm(['licenses', 'list', '--json', '--recursive']));
/** @type {{ exceptions: import('./license-policy.mjs').LicenseException[] }} */
const { exceptions } = JSON.parse(
  readFileSync(resolve(repoRoot, 'scripts/license-exceptions.json'), 'utf8'),
);

const report = evaluateLicenses(pnpmLicenses, exceptions);

console.log(`License check (ADR-0008): ${report.total} packages`);
for (const [license, count] of [...report.countsByLicense].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(count).padStart(5)}  ${license}`);
}

if (verbose) {
  console.log('\nPackages:');
  for (const [, packages] of Object.entries(pnpmLicenses)) {
    for (const pkg of packages) {
      console.log(`  ${pkg.name}@${pkg.versions.join(',')}  ${pkg.license}`);
    }
  }
}

if (report.excepted.length > 0) {
  console.log('\nAllowed by exception (scripts/license-exceptions.json):');
  for (const pkg of report.excepted) {
    console.log(`  ${pkg.name}@${pkg.versions.join(',')}  ${pkg.license}`);
  }
}

let failed = false;

if (report.violations.length > 0) {
  failed = true;
  console.error('\nNot allowed:');
  for (const pkg of report.violations) {
    console.error(`  ${pkg.name}@${pkg.versions.join(',')}  ${pkg.license}`);
  }
  console.error(
    '\nReplace the dependency, or — only for data packages — add a justified exception (ADR-0008).',
  );
}

if (report.unusedExceptions.length > 0) {
  failed = true;
  console.error('\nUnused exceptions (remove them from scripts/license-exceptions.json):');
  for (const e of report.unusedExceptions) {
    console.error(`  ${e.package}  ${e.license}`);
  }
}

if (failed) {
  process.exit(1);
}
console.log('\nOK: every dependency complies with the license policy.');
