import { execFileSync } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:https';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { loadCountryConfig } from '@rid/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeKeyAndCsr } from '../../../test/csr.js';
import { createTestApp, createTestIssuer } from '../../../test/test-auth.js';
import { leafOf } from '../../credentials/credential-view.js';
import { CERTIFICATE_AUTHORITY, StepCaClient } from '../../credentials/step-ca.client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { HttpApisixAdmin } from './apisix-admin.js';
import { APISIX_SETTINGS, ApisixReconciler, GATEWAY_TLS_SYNC_TARGET } from './apisix.reconciler.js';
import {
  GATEWAY_SSL_ID,
  type GatewaySettings,
  NODE_ONLY_SKIP_MTLS_REGEX,
  parseDevNodes,
} from './desired-state.js';
import { GatewayCertificates } from './gateway-certificates.js';

const HTTPS_PORT = Number(process.env.APISIX_HTTPS_PORT ?? 9443);
const HTTP_PORT = Number(process.env.APISIX_HTTP_PORT ?? 9080);
const ECHO_ROUTE = 'test-m3-02-client-cert';
const ECHO_PATH = '/__rid_m3_02__/echo';

interface Outcome {
  status?: number;
  seen?: string;
  error?: string;
}

/** One HTTPS call to the gateway with SNI localhost, on a fresh TLS session. */
function gatewayCall(root: string, client?: { cert: string; key: string }): Promise<Outcome> {
  return new Promise((resolve) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: HTTPS_PORT,
        servername: 'localhost',
        path: ECHO_PATH,
        ca: root,
        agent: false,
        headers: { 'x-rid-client-cert-s256': 'forged-by-the-client' },
        ...(client ?? {}),
      },
      (res) => {
        res.resume();
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            seen: String(res.headers['x-seen-thumbprint'] ?? ''),
          }),
        );
      },
    );
    req.on('error', (error) => resolve({ error: error.message }));
    req.end();
  });
}

/**
 * The gateway's TLS against the real APISIX and step-ca (M3-02): the server certificate issued
 * by the network CA, client.ca when mTLS is required, and the rid-client-cert plugin.
 */
describe('gateway TLS and client certificates (M3-02)', () => {
  const prisma = new PrismaService();
  const admin = new HttpApisixAdmin({
    baseUrl: process.env.APISIX_ADMIN_URL ?? 'http://localhost:9180',
    apiKey: process.env.APISIX_ADMIN_KEY ?? '',
  });
  const settings: GatewaySettings = {
    keycloakDiscoveryUrl:
      'http://keycloak:8080/realms/rid-gateway/.well-known/openid-configuration',
    audience: 'rid-gateway',
    opaUrl: 'http://opa:8181',
    accessLogUrl: 'http://fluent-bit:9880/',
    transparencyLog: { host: 'fluent-bit-transparency', port: 5170 },
    devNodes: parseDevNodes('salud=mock-salud:8000'),
    resolveHost: () => Promise.resolve(['93.184.215.14']),
    tls: { hosts: ['localhost'], mtlsRequired: true, clientName: 'rid-gateway' },
  };
  const ca = new StepCaClient();
  let app: NestFastifyApplication;
  let reconciler: ApisixReconciler;
  let root = '';
  let client: { cert: string; key: string };

  beforeAll(async () => {
    app = await createTestApp(await createTestIssuer(), [
      { token: APISIX_SETTINGS, value: settings },
      { token: CERTIFICATE_AUTHORITY, value: ca },
    ]);
    reconciler = app.get(ApisixReconciler);
    root = await ca.rootCertificate();
    // A client certificate of the network CA, as an application gets it (M3-01).
    const { csr, keyPem } = await makeKeyAndCsr('rid-app-m3-02-test');
    const cert = await ca.sign({ csrPem: csr, commonName: 'rid-app-m3-02-test', validityHours: 1 });
    client = { cert, key: keyPem };
    // A route outside the reconciler's prefix that echoes what rid-client-cert computed.
    await admin.put('routes', ECHO_ROUTE, {
      uri: ECHO_PATH,
      methods: ['GET'],
      upstream: { type: 'roundrobin', scheme: 'http', nodes: { 'mock-salud:8000': 1 } },
      plugins: {
        'rid-client-cert': {},
        'proxy-rewrite': { uri: '/health' },
        'response-rewrite': {
          headers: { set: { 'X-Seen-Thumbprint': '$http_x_rid_client_cert_s256' } },
        },
      },
    });
  });

  afterAll(async () => {
    await admin.delete('routes', ECHO_ROUTE);
    // Leave what the country configuration says (co.yaml requires mTLS since M3-10).
    settings.tls.mtlsRequired = loadCountryConfig({ code: 'co' }).features.mtls.required;
    await reconciler.reconcileTls();
    await app.close();
    await prisma.$disconnect();
  });

  const waitFor = async <T>(probe: () => Promise<T>, ok: (value: T) => boolean): Promise<T> => {
    let value = await probe();
    for (let i = 0; i < 40 && !ok(value); i += 1) {
      await new Promise((r) => setTimeout(r, 250));
      value = await probe();
    }
    return value;
  };

  it('issues the server certificate through step-ca and puts it in the SSL object', async () => {
    expect(['created', 'updated', 'unchanged']).toContain(await reconciler.reconcileTls());
    expect(await reconciler.reconcileTls()).toBe('unchanged');

    const row = await prisma.gatewayCertificate.findFirstOrThrow({
      where: { purpose: 'server' },
      orderBy: { createdAt: 'desc' },
    });
    expect(row.hosts).toEqual(['localhost']);
    expect(row.sealedKey).not.toContain('PRIVATE KEY');
    const leaf = leafOf(row.certificatePem);
    expect(leaf.subjectAltName).toBe('DNS:localhost');
    expect(leaf.keyUsage).toEqual(['1.3.6.1.5.5.7.3.1']);

    const ssl = await admin.get('ssls', GATEWAY_SSL_ID);
    expect(ssl).toMatchObject({ snis: ['localhost'], client: { depth: 2 } });
    const state = await prisma.syncState.findUniqueOrThrow({
      where: { target: GATEWAY_TLS_SYNC_TARGET },
    });
    expect(state.status).toBe('in_sync');
    expect(
      await prisma.auditEvent.count({
        where: { targetId: row.id, action: 'gateway_certificate.issued' },
      }),
    ).toBe(1);
  });

  it('with mTLS required, refuses the handshake without a client certificate', async () => {
    await reconciler.reconcileTls();
    const outcome = await waitFor(
      () => gatewayCall(root),
      (o) => Boolean(o.error),
    );
    expect(outcome.error).toBeTruthy();
    expect(outcome.status).toBeUndefined();
  });

  it('refuses a certificate the network CA did not issue', async () => {
    const { keyPem } = await makeKeyAndCsr('rid-app-m3-02-test');
    // Self-signed with the same subject: another CA.
    const dir = mkdtempSync(join(tmpdir(), 'rid-m3-02-'));
    const keyFile = join(dir, 'key.pem');
    writeFileSync(keyFile, keyPem);
    const selfSigned = execFileSync(
      'openssl',
      ['req', '-x509', '-key', keyFile, '-subj', '/CN=rid-app-m3-02-test', '-days', '1'],
      { encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' } },
    );
    rmSync(dir, { recursive: true, force: true });
    expect(selfSigned).toContain('BEGIN CERTIFICATE');
    const outcome = await gatewayCall(root, { cert: selfSigned, key: keyPem });
    expect(outcome.error).toBeTruthy();
  });

  it('accepts a certificate of the network CA and passes its RFC 8705 thumbprint, never the forged one', async () => {
    const outcome = await waitFor(
      () => gatewayCall(root, client),
      (o) => o.status === 200,
    );
    expect(outcome.status).toBe(200);
    const thumbprint = createHash('sha256')
      .update(new X509Certificate(client.cert).raw)
      .digest('base64url');
    expect(outcome.seen).toBe(thumbprint);
  });

  it('without mTLS, the TLS handshake needs no client certificate', async () => {
    settings.tls.mtlsRequired = false;
    expect(await reconciler.reconcileTls()).toBe('updated');
    // The CA stays to verify a certificate when one is presented, and the node control channel
    // still requires one (M4-02).
    expect((await admin.get('ssls', GATEWAY_SSL_ID))?.client).toMatchObject({
      skip_mtls_uri_regex: [NODE_ONLY_SKIP_MTLS_REGEX],
    });
    const outcome = await waitFor(
      () => gatewayCall(root),
      (o) => o.status === 200,
    );
    expect(outcome.status).toBe(200);
    // No verified certificate, so no thumbprint, and the client's value is gone.
    expect(outcome.seen).toBe('');
    settings.tls.mtlsRequired = true;
    expect(await reconciler.reconcileTls()).toBe('updated');
  });

  it('removes a thumbprint the client sends over plain HTTP', async () => {
    const res = await fetch(`http://127.0.0.1:${HTTP_PORT}${ECHO_PATH}`, {
      headers: { 'x-rid-client-cert-s256': 'forged-by-the-client' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-seen-thumbprint') ?? '').toBe('');
  });

  it('renews the server certificate in the last third of its life, or for other host names', async () => {
    const certificates = app.get(GatewayCertificates);
    const current = await certificates.server(['localhost']);
    const late = new Date(current.notAfter.getTime() - 10 * 24 * 60 * 60 * 1000);
    const renewed = await certificates.server(['localhost'], late);
    expect(renewed.id).not.toBe(current.id);
    expect(renewed.fingerprint).not.toBe(current.fingerprint);
    expect((await certificates.server(['localhost'])).id).toBe(renewed.id);
    expect(await reconciler.reconcileTls()).toBe('updated');
  });
});
