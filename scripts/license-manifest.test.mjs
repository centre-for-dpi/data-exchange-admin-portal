import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  checkManifest,
  collectUsage,
  findImageReferences,
  parseRequirements,
} from './license-manifest.mjs';

const root = resolve(import.meta.dirname, '..');

describe('parseRequirements', () => {
  it('reads name==version lines, skipping comments and blank lines', () => {
    expect(parseRequirements('# header\n\nrequests==2.34.2  # http\nPyYAML==6.0.3\n')).toEqual([
      { name: 'requests', version: '2.34.2' },
      { name: 'PyYAML', version: '6.0.3' },
    ]);
  });

  it('refuses a package that is not pinned', () => {
    expect(() => parseRequirements('requests>=2\n')).toThrow('not pinned');
  });
});

describe('findImageReferences', () => {
  it('finds Compose, Dockerfile, Helm values, script and workflow references', () => {
    const text = [
      '    image: quay.io/keycloak/keycloak:26.8.0',
      'FROM node:24.22.1-alpine3.24 AS build',
      'FROM build',
      '  apisix: apache/apisix:3.19.0-debian',
      "const OPA_IMAGE = 'openpolicyagent/opa:1.21.4-static';",
      'NODE_IMAGE="node:24.22.1-alpine3.24"',
      '- run: docker run --rm prom/prometheus:v3.15.1 test',
      '    image: docker.io/library/postgres:18.6-alpine',
    ].join('\n');
    expect([...findImageReferences(text)].sort()).toEqual([
      'apache/apisix',
      'node',
      'openpolicyagent/opa',
      'postgres',
      'prom/prometheus',
      'quay.io/keycloak/keycloak',
    ]);
  });

  it('ignores our own images, URLs with ports and variables', () => {
    const text = [
      '    image: den/portal-api:deploy',
      '    image: ghcr.io/centre-for-dpi/den-portal-web:${DEN_IMAGE_TAG}',
      'KEYCLOAK_URL: http://keycloak:8080/auth',
      'DATABASE_URL=postgresql://den:pw@postgres:5432/den',
      '    image: ${IMAGE}:1.0',
    ].join('\n');
    expect([...findImageReferences(text)]).toEqual([]);
  });
});

describe('checkManifest', () => {
  const used = (images = {}, charts = {}, requirements = {}) => ({
    requirements,
    images: new Map(Object.entries(images)),
    charts: new Map(Object.entries(charts)),
  });
  const empty = { python: {}, images: [], helmCharts: [] };

  it('passes when everything used is recorded with an allowed license', () => {
    const manifest = {
      python: { 'req.txt': [{ name: 'PyYAML', version: '6.0.3', license: 'MIT' }] },
      images: [
        { image: 'apache/apisix', license: 'Apache-2.0' },
        { image: 'postgres', license: 'PostgreSQL' },
        { image: 'grafana/grafana', license: 'AGPL-3.0-only', separateService: true },
        { image: 'alpine', license: 'MIT AND GPL-2.0-only', distribution: true, note: 'base' },
      ],
      helmCharts: [{ chart: 'opensearch', license: 'Apache-2.0' }],
    };
    const r = checkManifest(
      manifest,
      used(
        { 'apache/apisix': ['a'], postgres: ['b'], 'grafana/grafana': ['c'], alpine: ['d'] },
        { opensearch: ['Chart.yaml'] },
        { 'req.txt': [{ name: 'pyyaml', version: '6.0.3' }] },
      ),
    );
    expect(r.problems).toEqual([]);
    expect(r.counts).toEqual({ python: 1, images: 4, charts: 1 });
  });

  it('fails on an image, chart or Python package without a recorded license', () => {
    const r = checkManifest(
      empty,
      used({ 'some/image': ['compose.yml'] }, { chart: ['Chart.yaml'] }, {}),
    );
    expect(r.problems).toEqual([
      'image some/image (compose.yml) has no license recorded',
      'Helm chart chart (Chart.yaml) has no license recorded',
    ]);
    const py = checkManifest(
      { ...empty, python: { 'req.txt': [] } },
      used({}, {}, { 'req.txt': [{ name: 'x', version: '1' }] }),
    );
    expect(py.problems).toEqual(['req.txt: x==1 has no license recorded']);
  });

  it('fails when a Python package changed version since its license was recorded', () => {
    const r = checkManifest(
      { ...empty, python: { 'req.txt': [{ name: 'x', version: '1', license: 'MIT' }] } },
      used({}, {}, { 'req.txt': [{ name: 'x', version: '2' }] }),
    );
    expect(r.problems).toEqual(['req.txt: x is 2, its license was recorded for 1']);
  });

  it('fails on licenses outside the policy', () => {
    const r = checkManifest(
      {
        python: { 'req.txt': [{ name: 'x', version: '1', license: 'GPL-3.0-only' }] },
        images: [
          { image: 'linked/gpl', license: 'GPL-3.0-only' },
          { image: 'bsl/thing', license: 'BUSL-1.1', separateService: true },
          { image: 'os/base', license: 'GPL-2.0-only', distribution: true },
        ],
        helmCharts: [],
      },
      used(
        { 'linked/gpl': ['a'], 'bsl/thing': ['b'], 'os/base': ['c'] },
        {},
        { 'req.txt': [{ name: 'x', version: '1' }] },
      ),
    );
    expect(r.problems).toEqual([
      'req.txt: x==1 is GPL-3.0-only, not allowed',
      'image linked/gpl: GPL-3.0-only is not allowed (copyleft only as a separate service)',
      'image bsl/thing: BUSL-1.1 is prohibited (ADR-0002)',
      'image os/base: a distribution needs a note',
    ]);
  });

  it('fails on entries nothing uses any more', () => {
    const r = checkManifest(
      {
        python: { 'gone.txt': [] },
        images: [{ image: 'old/image', license: 'MIT' }],
        helmCharts: [{ chart: 'old', license: 'MIT' }],
      },
      used(),
    );
    expect(r.problems).toEqual([
      'gone.txt: recorded but not checked',
      'image old/image is recorded but not used (remove it)',
      'Helm chart old is recorded but not used (remove it)',
    ]);
  });
});

// The real repository: the manifest covers every image, chart and Python package in use (B-32).
describe('scripts/third-party-licenses.json', () => {
  const manifest = JSON.parse(
    readFileSync(resolve(root, 'scripts/third-party-licenses.json'), 'utf8'),
  );
  const usage = collectUsage(root);

  it('covers what the repository uses, with allowed licenses', () => {
    expect(checkManifest(manifest, usage).problems).toEqual([]);
  });

  it('finds the images of Compose, the Dockerfiles and Helm', () => {
    expect(usage.images.get('quay.io/keycloak/keycloak')).toEqual(
      expect.arrayContaining(['infra/compose/docker-compose.yml', 'infra/helm/den/values.yaml']),
    );
    expect(usage.images.get('node')).toContain('apps/api/Dockerfile');
    expect(usage.charts.get('cert-manager')).toEqual(['infra/helm/den-platform/Chart.yaml']);
  });

  it('the contract runner installs exactly its pinned packages', () => {
    const dockerfile = readFileSync(resolve(root, 'infra/contract-runner/Dockerfile'), 'utf8');
    expect(dockerfile).toContain('pip install --no-cache-dir --no-deps -r /tmp/requirements.txt');
    expect(dockerfile).toContain('pip check');
    expect(usage.requirements['infra/contract-runner/requirements.txt']).toContainEqual({
      name: 'schemathesis',
      version: '4.33.4',
    });
  });
});
