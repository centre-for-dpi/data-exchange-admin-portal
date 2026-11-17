#!/usr/bin/env node
// `pnpm helm:kind`: installs the DEN charts on a kind cluster (Kubernetes in Docker) and
// checks them (M6-05). The production charts as they are, with infra/helm/kind/values-kind.yaml:
//   1. the cluster, Traefik (the ingress) and our images built locally (den/*:kind);
//   2. den-platform (CloudNativePG, External Secrets, cert-manager);
//   3. a fake External Secrets store with random secrets, and a CA of its own for step-ca;
//   4. den, waiting until every pod is ready;
//   5. checks: the portal, Keycloak's realms, migrations, OPA's bundle, etcd's cluster and the
//      network policies (what must not reach etcd and the database does not).
// Needs docker, kubectl and kind (PATH or DEN_KIND). Helm runs in its container (alpine/helm).
// Not run yet: no cluster installs for now (2026-11-16); expect fixes on its first run.
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLUSTER = 'den';
const KIND = process.env.DEN_KIND ?? 'kind';
const HELM_IMAGE = 'alpine/helm:4.3.1';
const STEP_IMAGE = 'smallstep/step-ca:0.30.2';
const TRAEFIK_CHART = '42.2.0';
const PUBLIC_HOST = 'den.127.0.0.1.nip.io';
const PORTAL = `http://${PUBLIC_HOST}:18080`;

const log = (text) => console.log(text);
const ok = (text) => log(`   ✓ ${text}`);
class KindError extends Error {}
const expect = (condition, message) => {
  if (!condition) throw new KindError(message);
};

function run(cmd, cmdArgs, options = {}) {
  const res = spawnSync(cmd, cmdArgs, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: options.timeout ?? 600_000,
    input: options.input,
    env: { ...process.env, MSYS_NO_PATHCONV: '1' },
  });
  if (options.allowFail) return res;
  expect(res.status === 0, `${cmd} ${cmdArgs.slice(0, 4).join(' ')}…: ${res.stderr || res.stdout}`);
  return res;
}
const kubectl = (...a) => run('kubectl', ['--context', `kind-${CLUSTER}`, ...a]);
const kubectlTry = (...a) =>
  run('kubectl', ['--context', `kind-${CLUSTER}`, ...a], { allowFail: true });
/** kubectl apply of a manifest given as an object. */
const kubectlApply = (manifest) =>
  run('kubectl', ['--context', `kind-${CLUSTER}`, 'apply', '-f', '-'], {
    input: JSON.stringify(manifest),
  });

/** Helm in its container, on kind's Docker network, with the cluster's internal kubeconfig. */
function helm(kubeconfig, ...helmArgs) {
  const charts = resolve(root, 'infra/helm');
  return run(
    'docker',
    [
      'run',
      '--rm',
      '--network',
      'kind',
      '-v',
      `${charts}:/charts`,
      '-v',
      `${kubeconfig}:/root/.kube/config:ro`,
      '-w',
      '/charts',
      HELM_IMAGE,
      ...helmArgs,
    ],
    { timeout: 1_200_000 },
  );
}

const secret = (bytes = 24) => randomBytes(bytes).toString('base64url');

/** Every key of the chart's Secrets (templates/_helpers.tpl, den.secrets), random. */
function platformSecrets(stepPassword) {
  const { privateKey } = generateKeyPairSync('ed25519');
  const hub = generateKeyPairSync('x25519');
  return {
    DB_OWNER_PASSWORD: secret(),
    DB_APP_PASSWORD: secret(),
    KEYCLOAK_DB_PASSWORD: secret(),
    APISIX_ADMIN_KEY: secret(),
    DEN_APISIX_KEYRING: secret(12),
    OPA_BUNDLE_TOKEN: secret(),
    DEN_END_USER_HASH_SALT: secret(32),
    DEN_SUBJECT_REF_KEY: secret(32),
    DEN_TRANSPARENCY_INGEST_TOKEN: secret(),
    DEN_TRANSPARENCY_SIGNING_JWK: JSON.stringify({
      ...privateKey.export({ format: 'jwk' }),
      kid: 'den-kind',
      alg: 'EdDSA',
      use: 'sig',
    }),
    DEN_NODE_CONTROL_TOKEN: secret(32),
    DEN_VALIDATION_TOKEN: secret(32),
    DEN_METRICS_TOKEN: secret(32),
    DEN_CONTRACT_RUNNER_TOKEN: secret(32),
    DEN_WG_HUB_AGENT_TOKEN: secret(32),
    DEN_WG_HUB_PRIVATE_KEY: Buffer.from(
      hub.privateKey.export({ format: 'jwk' }).d ?? '',
      'base64url',
    ).toString('base64'),
    DEN_STEP_CA_PROVISIONER_PASSWORD: stepPassword,
    DEN_SECRETS_KEY: randomBytes(32).toString('base64'),
    DEN_GATEWAY_PROVISIONER_SECRET: secret(),
    KEYCLOAK_ADMIN_PASSWORD: secret(16),
    KEYCLOAK_SMTP_USER: 'kind',
    KEYCLOAK_SMTP_PASSWORD: secret(),
    DEN_CITIZEN_APPS: '{}',
    DEN_SMTP_URL: 'smtp://localhost:25',
    DEN_OPENSEARCH_AUTH: '',
    AUTH_SECRET: randomBytes(32).toString('base64'),
    DEN_PORTAL_WEB_CLIENT_SECRET: secret(),
    DEN_CITIZEN_APP_CLIENT_SECRET: secret(),
    OPENSEARCH_USER: 'kind',
    OPENSEARCH_PASSWORD: secret(),
  };
}

/** The network's CA for the test: a root (never in the cluster) and its intermediate. */
function testCa(dir, password) {
  writeFileSync(join(dir, 'password'), password);
  const script = [
    'set -e',
    'cd /out',
    'step certificate create "DEN kind root" root_ca.crt root_ca_key --profile root-ca --no-password --insecure',
    'step certificate create "DEN kind intermediate" intermediate_ca.crt intermediate_ca_key --profile intermediate-ca --ca root_ca.crt --ca-key root_ca_key --password-file password',
    'step certificate fingerprint root_ca.crt',
  ].join(' && ');
  const res = run('docker', [
    'run',
    '--rm',
    '--user',
    'root',
    '-v',
    `${dir}:/out`,
    '--entrypoint',
    'sh',
    STEP_IMAGE,
    '-c',
    script,
  ]);
  return res.stdout.trim().split('\n').pop();
}

async function main() {
  log('DEN en kind (M6-05)');
  const work = mkdtempSync(join(tmpdir(), 'den-kind-'));
  try {
    // 1. Cluster, ingress and images.
    log('\n1. Clúster, Traefik e imágenes');
    const clusters = run(KIND, ['get', 'clusters']).stdout.split('\n');
    if (!clusters.includes(CLUSTER)) {
      run(
        KIND,
        ['create', 'cluster', '--config', resolve(root, 'infra/helm/kind/kind-config.yaml')],
        {
          timeout: 900_000,
        },
      );
    }
    ok(`clúster ${CLUSTER}`);
    const kubeconfig = join(work, 'kubeconfig');
    writeFileSync(
      kubeconfig,
      run(KIND, ['get', 'kubeconfig', '--name', CLUSTER, '--internal']).stdout,
    );
    for (const image of [
      'den/portal-api:kind',
      'den/portal-web:kind',
      'den/contract-runner:kind',
    ]) {
      run(KIND, ['load', 'docker-image', '--name', CLUSTER, image], { timeout: 900_000 });
    }
    ok('imágenes cargadas');
    helm(
      kubeconfig,
      'upgrade',
      '--install',
      'traefik',
      'traefik',
      '--repo',
      'https://traefik.github.io/charts',
      '--version',
      TRAEFIK_CHART,
      '--namespace',
      'traefik',
      '--create-namespace',
      '--wait',
      '--set',
      'service.type=NodePort',
      '--set',
      'ports.web.nodePort=30080',
      '--set',
      'ports.web.exposedPort=18080',
      '--set',
      'ingressClass.isDefaultClass=false',
    );
    // Inside the cluster the portal's public name is Traefik too (the web calls Keycloak there).
    const corefile = JSON.parse(
      kubectl('-n', 'kube-system', 'get', 'cm', 'coredns', '-o', 'json').stdout,
    );
    if (!corefile.data.Corefile.includes(PUBLIC_HOST)) {
      corefile.data.Corefile = corefile.data.Corefile.replace(
        '.:53 {',
        `.:53 {\n    rewrite name ${PUBLIC_HOST} traefik.traefik.svc.cluster.local`,
      );
      kubectlApply(corefile);
      kubectl('-n', 'kube-system', 'rollout', 'restart', 'deployment/coredns');
    }
    ok(`Traefik en ${PORTAL}`);

    // 2. Operators.
    log('\n2. den-platform');
    helm(kubeconfig, 'dependency', 'build', 'den-platform');
    helm(
      kubeconfig,
      'upgrade',
      '--install',
      'den-platform',
      'den-platform',
      '--namespace',
      'den-platform',
      '--create-namespace',
      '--wait',
      '--timeout',
      '10m',
    );
    ok('CloudNativePG, External Secrets y cert-manager');

    // 3. Secrets and CA.
    log('\n3. Secretos (almacén falso de External Secrets) y CA de prueba');
    kubectlTry('create', 'namespace', 'den');
    const stepPassword = secret();
    const existing = kubectlTry('get', 'clustersecretstore', 'den-kind', '-o', 'json');
    let values;
    if (existing.status === 0) {
      values = JSON.parse(JSON.parse(existing.stdout).spec.provider.fake.data[0].value);
    } else {
      values = platformSecrets(stepPassword);
      const store = {
        apiVersion: 'external-secrets.io/v1',
        kind: 'ClusterSecretStore',
        metadata: { name: 'den-kind' },
        spec: {
          provider: { fake: { data: [{ key: 'den/platform', value: JSON.stringify(values) }] } },
        },
      };
      kubectlApply(store);
    }
    let fingerprint = kubectlTry(
      '-n',
      'den',
      'get',
      'secret',
      'den-step-ca-pki',
      '-o',
      'jsonpath={.metadata.annotations.fingerprint}',
    ).stdout;
    if (!fingerprint) {
      fingerprint = testCa(work, values.DEN_STEP_CA_PROVISIONER_PASSWORD);
      kubectl(
        '-n',
        'den',
        'create',
        'secret',
        'generic',
        'den-step-ca-pki',
        `--from-file=root_ca.crt=${join(work, 'root_ca.crt')}`,
        `--from-file=intermediate_ca.crt=${join(work, 'intermediate_ca.crt')}`,
        `--from-file=intermediate_ca_key=${join(work, 'intermediate_ca_key')}`,
      );
      kubectl('-n', 'den', 'annotate', 'secret', 'den-step-ca-pki', `fingerprint=${fingerprint}`);
    }
    ok(`CA de prueba (raíz ${fingerprint.slice(0, 12)}…, su clave nunca entra al clúster)`);

    // 4. DEN.
    log('\n4. den');
    helm(
      kubeconfig,
      'upgrade',
      '--install',
      'den',
      'den',
      '--namespace',
      'den',
      '-f',
      'kind/values-kind.yaml',
      '--set',
      `stepCa.rootFingerprint=${fingerprint}`,
      '--wait',
      '--timeout',
      '15m',
    );
    ok('todos los pods listos');

    // 5. Checks.
    log('\n5. Comprobaciones');
    const health = await fetch(`${PORTAL}/api/v1/health`).then(
      (r) => r.status,
      () => 0,
    );
    expect(health === 200, `the API through Traefik answered ${health}`);
    ok('API por el ingress');
    const blocked = await fetch(`${PORTAL}/api/v1/opa/bundle.tar.gz`).then(
      (r) => r.status,
      () => 0,
    );
    expect(blocked === 503, `the OPA bundle route is public (${blocked})`);
    ok('las rutas de servicio no están en el host público (503)');
    for (const realm of ['den-portal', 'den-gateway']) {
      const r = await fetch(`${PORTAL}/auth/realms/${realm}`).then(
        (x) => x.status,
        () => 0,
      );
      expect(r === 200, `realm ${realm}: ${r}`);
    }
    ok('Keycloak con sus realms (sin usuarios de demostración)');
    const opa = kubectlTry(
      '-n',
      'den',
      'exec',
      'den-gateway-0',
      '-c',
      'opa',
      '--',
      '/opa',
      'eval',
      '--fail',
      'r := http.send({"method": "get", "url": "http://127.0.0.1:8282/health?bundles=true"}); r.status_code == 200',
    );
    expect(opa.status === 0, 'OPA has no bundle');
    ok('OPA con su bundle');
    const members = kubectl('-n', 'den', 'exec', 'den-etcd-0', '--', 'etcdctl', 'member', 'list')
      .stdout.trim()
      .split('\n');
    expect(members.length === 3, `etcd has ${members.length} members`);
    ok('etcd con 3 miembros');
    // Network policies: a pod of the namespace that is not the gateway must not reach etcd, nor
    // anything other than the API reach the database.
    const probe = (target, port) =>
      kubectlTry(
        '-n',
        'den',
        'run',
        `np-probe-${Date.now()}`,
        '--rm',
        '-i',
        '--restart=Never',
        '--image=busybox:1.37',
        '--labels=app.kubernetes.io/part-of=den-probe',
        '--',
        'nc',
        '-z',
        '-w',
        '3',
        target,
        String(port),
      ).status === 0;
    expect(!probe('den-etcd', 2379), 'a pod that is not the gateway reached etcd');
    expect(!probe('den-db-rw', 5432), 'a pod that is not the API reached the database');
    ok('las NetworkPolicies cierran etcd y la base de datos');
    log(`\nDEN en kind en verde. Portal: ${PORTAL}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
    log(`(el clúster queda: \`${KIND} delete cluster --name ${CLUSTER}\` para borrarlo)`);
  }
}

main().catch((error) => {
  console.error(error instanceof KindError ? `\n✗ ${error.message}` : error);
  process.exit(1);
});
