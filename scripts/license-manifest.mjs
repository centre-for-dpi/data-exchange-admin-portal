// @ts-check
// What `pnpm license:check` checks besides npm (B-32): the Python packages of the contract
// runner, the container images and the Helm chart dependencies, against the licenses recorded in
// scripts/third-party-licenses.json. Offline and deterministic: the manifest is reviewed by hand
// when a version changes; these functions check that it covers everything the repository uses and
// that every recorded license fits the policy (ADR-0002, ADR-0008, ADR-0012, CLAUDE.md rule 1;
// ADR-0033). Only collectUsage reads files; the rest are pure functions, unit tested.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { ALLOWED_LICENSES, isLicenseAllowed } from './license-policy.mjs';

/**
 * Licenses that may only run as a separate service in its own container, never linked into our
 * code (CLAUDE.md rule 1: Grafana, k6, ClamAV).
 */
const SEPARATE_SERVICE_ONLY = /^(?:A?GPL-[23]\.0(?:-only|-or-later)?)$/;
/** Never allowed, whatever the use (ADR-0002). */
const PROHIBITED = /BUSL|SSPL|Elastic|Commons-Clause|LicenseRef-/i;
/**
 * OSI-approved permissive licenses that are not in the npm list only because no npm dependency
 * uses them; for images (separate services) they are as acceptable as the list's.
 */
const EXTRA_SERVICE_LICENSES = new Set(['PostgreSQL']);

/**
 * @typedef {{ name: string, version: string }} Requirement
 * @typedef {{ name: string, version: string, license: string, declared?: string, note?: string }} PythonPackage
 * @typedef {{ image: string, license: string, separateService?: boolean, distribution?: boolean, note?: string }} ImageEntry
 * @typedef {{ chart: string, license: string, separateService?: boolean, note?: string }} ChartEntry
 * @typedef {{ python: Record<string, PythonPackage[]>, images: ImageEntry[], helmCharts: ChartEntry[] }} Manifest
 */

/** PEP 503 normalized name: case and runs of `-`, `_`, `.` do not matter. */
export const normalizePython = (/** @type {string} */ name) =>
  name.toLowerCase().replace(/[-_.]+/g, '-');

/**
 * Parses a requirements file where every line pins one package (`name==version`); comments and
 * blank lines are ignored. Anything else is an error: an unpinned package is not deterministic.
 * @param {string} text
 * @returns {Requirement[]}
 */
export function parseRequirements(text) {
  /** @type {Requirement[]} */
  const out = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    const match = /^([A-Za-z0-9][A-Za-z0-9._-]*)==([A-Za-z0-9.+!-]+)$/.exec(line);
    if (!match) throw new Error(`not pinned as name==version: ${line}`);
    out.push({ name: match[1], version: match[2] });
  }
  return out;
}

/** Images named without a registry or namespace are only recognized after these keywords. */
const IN_CONTEXT =
  /(?:^\s*FROM\s+(?:--platform=\S+\s+)?|\bimage:\s*['"]?|_IMAGE\s*=\s*['"]|\bIMAGE=['"]?)([a-z0-9][a-z0-9._/-]*):([A-Za-z0-9][\w.-]*)/gm;
/** Anywhere: `namespace/name:tag` (or `registry/namespace/name:tag`) with a version-like tag. */
const WITH_NAMESPACE =
  /(?<![\w./:@-])([a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)+):(v?\d[\w.-]*)/g;
/** Built from this repository: their contents are the npm and Python checks. */
const OWN_IMAGE = /^(?:den\/|ghcr\.io\/centre-for-dpi\/)/;

/** `docker.io/library/node` and `node` are the same image. */
export const normalizeImage = (/** @type {string} */ name) =>
  name.replace(/^docker\.io\//, '').replace(/^library\//, '');

/**
 * The third-party images a file refers to, by name without tag: Compose and Helm `image:`,
 * Dockerfile `FROM`, `*_IMAGE` constants of the scripts and `docker run` lines of the workflows.
 * @param {string} text
 * @returns {Set<string>}
 */
export function findImageReferences(text) {
  const found = new Set();
  for (const re of [IN_CONTEXT, WITH_NAMESPACE]) {
    for (const match of text.matchAll(re)) {
      const name = normalizeImage(match[1]);
      // Build stages (`FROM etcd`) and variables are not images.
      if (OWN_IMAGE.test(name) || name.includes('$')) continue;
      found.add(name);
    }
  }
  return found;
}

/**
 * Whether a license recorded for an image or chart fits the policy.
 * @param {{ license: string, separateService?: boolean, distribution?: boolean, note?: string }} entry
 * @returns {string | undefined} why not, or undefined when it does
 */
function serviceLicenseProblem(entry) {
  if (PROHIBITED.test(entry.license)) return `${entry.license} is prohibited (ADR-0002)`;
  // An operating system base: its packages (apk, deb) carry their own licenses (documented limit).
  if (entry.distribution) return entry.note ? undefined : 'a distribution needs a note';
  const allowed = new Set([...ALLOWED_LICENSES, ...EXTRA_SERVICE_LICENSES]);
  if (isLicenseAllowed(entry.license, allowed)) return undefined;
  if (entry.separateService && SEPARATE_SERVICE_ONLY.test(entry.license)) return undefined;
  return entry.separateService
    ? `${entry.license} is not allowed even as a separate service`
    : `${entry.license} is not allowed (copyleft only as a separate service)`;
}

/**
 * Checks the manifest against what the repository uses.
 * @param {Manifest} manifest
 * @param {{ requirements: Record<string, Requirement[]>, images: Map<string, string[]>, charts: Map<string, string[]> }} used
 *   the pinned Python packages by requirements file, and the images and Helm charts each with the
 *   files that refer to them
 * @returns {{ problems: string[], counts: { python: number, images: number, charts: number } }}
 */
export function checkManifest(manifest, used) {
  /** @type {string[]} */
  const problems = [];

  // Python: the manifest has exactly the pinned packages, same versions, allowed licenses.
  for (const [file, requirements] of Object.entries(used.requirements)) {
    const recorded = new Map(
      (manifest.python[file] ?? []).map((p) => [normalizePython(p.name), p]),
    );
    for (const req of requirements) {
      const entry = recorded.get(normalizePython(req.name));
      recorded.delete(normalizePython(req.name));
      if (!entry) {
        problems.push(`${file}: ${req.name}==${req.version} has no license recorded`);
      } else if (entry.version !== req.version) {
        problems.push(
          `${file}: ${req.name} is ${req.version}, its license was recorded for ${entry.version}`,
        );
      } else if (!isLicenseAllowed(entry.license)) {
        problems.push(`${file}: ${req.name}==${req.version} is ${entry.license}, not allowed`);
      }
    }
    for (const stale of recorded.values()) {
      problems.push(`${file}: ${stale.name} is recorded but not required (remove it)`);
    }
  }
  for (const file of Object.keys(manifest.python)) {
    if (!(file in used.requirements)) problems.push(`${file}: recorded but not checked`);
  }

  // Images and charts: every one used is recorded with a license that fits; none stale.
  for (const [kind, entries, uses] of /** @type {const} */ ([
    ['image', manifest.images.map((e) => ({ ...e, key: e.image })), used.images],
    ['Helm chart', manifest.helmCharts.map((e) => ({ ...e, key: e.chart })), used.charts],
  ])) {
    const recorded = new Map(entries.map((e) => [e.key, e]));
    for (const [name, files] of uses) {
      const entry = recorded.get(name);
      if (!entry) {
        problems.push(`${kind} ${name} (${files.join(', ')}) has no license recorded`);
        continue;
      }
      const problem = serviceLicenseProblem(entry);
      if (problem) problems.push(`${kind} ${name}: ${problem}`);
    }
    for (const key of recorded.keys()) {
      if (!uses.has(key)) problems.push(`${kind} ${key} is recorded but not used (remove it)`);
    }
  }

  return {
    problems,
    counts: {
      python: Object.values(used.requirements).reduce((n, r) => n + r.length, 0),
      images: used.images.size,
      charts: used.charts.size,
    },
  };
}

/** Requirements files whose packages are checked (each pins its whole dependency closure). */
export const REQUIREMENTS_FILES = ['infra/contract-runner/requirements.txt'];

/** Files that may name an image: Compose, Dockerfiles, Helm, the installer, scripts, workflows. */
const IMAGE_FILE =
  /^(?:infra\/compose\/[^/]+\.ya?ml|(?:.+\/)?Dockerfile[^/]*|infra\/helm\/.+\.ya?ml|install\.sh|scripts\/[^/]+\.(?:mjs|sh)|\.github\/workflows\/[^/]+\.ya?ml)$/;
/** Not walked: dependencies, build output, fetched Helm charts, and tests (fake names). */
const SKIP_DIR = new Set(['node_modules', '.git', '.next', '.turbo', 'dist', 'charts', 'backups']);

/** Repository files, as paths relative to the root with `/` separators. */
function* walk(/** @type {string} */ root, dir = root) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIR.has(entry.name)) yield* walk(root, join(dir, entry.name));
    } else if (entry.isFile()) {
      yield relative(root, join(dir, entry.name)).split(sep).join('/');
    }
  }
}

/**
 * What the repository uses: the pinned Python packages, the third-party images (with the files
 * that name them) and the dependencies of the Helm charts (`infra/helm/<chart>/Chart.yaml`).
 * @param {string} root
 */
export function collectUsage(root) {
  /** @type {Record<string, Requirement[]>} */
  const requirements = {};
  for (const file of REQUIREMENTS_FILES) {
    requirements[file] = parseRequirements(readFileSync(join(root, file), 'utf8'));
  }
  /** @type {Map<string, string[]>} */
  const images = new Map();
  /** @type {Map<string, string[]>} */
  const charts = new Map();
  const add = (/** @type {Map<string, string[]>} */ map, /** @type {string} */ key, file) =>
    map.set(key, [...(map.get(key) ?? []), file]);
  for (const file of walk(root)) {
    if (file.endsWith('.test.mjs') || !IMAGE_FILE.test(file)) continue;
    const text = readFileSync(join(root, file), 'utf8');
    for (const image of findImageReferences(text)) add(images, image, file);
    if (/^infra\/helm\/[^/]+\/Chart\.yaml$/.test(file)) {
      const deps = text.split(/^dependencies:\s*$/m)[1] ?? '';
      for (const match of deps.matchAll(/^\s*-\s*name:\s*['"]?([\w.-]+)/gm)) {
        add(charts, match[1], file);
      }
    }
  }
  return { requirements, images, charts };
}
