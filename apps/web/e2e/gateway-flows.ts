import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';
import { type Browser, expect, type Page } from '@playwright/test';
import { makeCsr } from './csr';
import { createApplication, openRequestForm, publishNewApi, signIn } from './flows';
import { country } from './helpers';

/** Calls through the real gateway (M1-09 onwards): over TLS with mTLS since M3-10. */
export const gateway = process.env.RID_GATEWAY_PUBLIC_URL ?? 'https://localhost:9443';
/**
 * The gateway's plain-HTTP listener (local stack and CI only). Probes that only ask whether a
 * route exists, or which headers it adds, use it: they have no client certificate to present.
 */
const gatewayHttp = process.env.RID_GATEWAY_HTTP_URL ?? 'http://localhost:9080';
const apiUrl = process.env.RID_API_URL ?? 'http://localhost:4000';

const mtlsRequired = () => country().features.mtls.required;

interface ClientTls {
  cert: string;
  key: string;
}
/** Each application's certificate and private key, by client id (the token's azp). */
const certificates = new Map<string, ClientTls>();
let networkCa: Promise<string> | undefined;

/** The same path on the plain-HTTP listener, for probes without a client certificate. */
export const overHttp = (url: string): string =>
  url.startsWith(gateway) ? `${gatewayHttp}${url.slice(gateway.length)}` : url;

/** A call that only checks a route's existence or its headers: no token, no certificate. */
export const probeGateway = (url: string): Promise<Response> => fetch(overHttp(url));

const clientIdOf = (authorization: string | undefined): string | undefined => {
  const token = /^Bearer (.+)$/.exec(authorization ?? '')?.[1];
  try {
    const payload = JSON.parse(
      Buffer.from(token?.split('.')[1] ?? '', 'base64url').toString('utf8'),
    ) as { azp?: string };
    return payload.azp;
  } catch {
    return undefined;
  }
};

/**
 * fetch() for the gateway (M3-10). Over HTTPS it trusts the network CA and presents the
 * certificate of the application whose token goes in the Authorization header (a bound token
 * only works with it), or of the application `as` names.
 */
export async function gatewayFetch(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
  as?: string,
): Promise<Response> {
  if (!url.startsWith('https://')) return fetch(url, init);
  networkCa ??= fetch(`${apiUrl}/api/v1/pki/ca`).then((r) => r.text());
  const ca = await networkCa;
  const client = certificates.get(as ?? clientIdOf(init.headers?.authorization) ?? '');
  const target = new URL(url);
  return new Promise<Response>((resolve, reject) => {
    const req = httpsRequest(
      {
        host: target.hostname,
        port: target.port || 443,
        path: `${target.pathname}${target.search}`,
        method: init.method ?? 'GET',
        headers: init.headers,
        ca,
        agent: false,
        ...(client ?? {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const headers = new Headers();
          for (const [name, value] of Object.entries(res.headers)) {
            for (const v of Array.isArray(value) ? value : [value ?? '']) headers.append(name, v);
          }
          resolve(new Response(Buffer.concat(chunks), { status: res.statusCode ?? 0, headers }));
        });
      },
    );
    req.on('error', reject);
    req.end(init.body);
  });
}

/**
 * carlos creates an application and, when the network requires mTLS, gets its client certificate
 * through the portal (CSR made here, private key kept here): the gateway helpers then use it.
 */
export async function createGatewayApplication(
  page: Page,
  name: string,
): Promise<{ clientId: string; clientSecret: string }> {
  const clientId = await createApplication(page, name);
  const clientSecret = (await page.getByTestId('client-secret').textContent()) ?? '';
  // Always ends on the application's page, with the certificate when the network asks for one.
  await page.getByRole('link', { name: 'Ir a la aplicación' }).click();
  await issueCertificate(page, clientId);
  return { clientId, clientSecret };
}

/** The certificate of an application, as the gateway helpers present it. */
export const certificateOf = (clientId: string): ClientTls | undefined =>
  certificates.get(clientId);

/**
 * On the application's page: a CSR made here (the key never leaves the test), signed by the
 * network CA through the portal, and the chain downloaded. Nothing to do without mTLS.
 */
export async function issueCertificate(page: Page, clientId: string): Promise<void> {
  if (!mtlsRequired()) return;
  const section = page.getByRole('region', { name: 'Certificado de cliente (mTLS)' });
  const { csr, keyPem } = await makeCsr(clientId);
  await section.getByLabel(/^Solicitud de certificado \(CSR\)/).fill(csr);
  await section.getByRole('button', { name: 'Solicitar certificado' }).click();
  const issued = section.getByRole('status');
  await expect(issued).toContainText('El certificado está listo');
  const downloading = page.waitForEvent('download');
  await issued.getByRole('link', { name: 'Descargar' }).click();
  const chain = await readFile((await (await downloading).path()) ?? '', 'utf8');
  certificates.set(clientId, { cert: chain, key: keyPem });
}

/** Headers the salud mock logged for a request (it logs X-RID-* and X-Request-Id only). */
export function providerSaw(requestId: string, since: string): Record<string, string> | undefined {
  const logs = spawnSync('docker', ['logs', '--since', since, 'rid-mock-salud-1'], {
    encoding: 'utf8',
  });
  for (const line of `${logs.stdout}${logs.stderr}`.split('\n')) {
    if (!line.includes(requestId)) continue;
    const entry = JSON.parse(line) as { rid?: Record<string, string> };
    if (entry.rid?.['x-request-id'] === requestId) return entry.rid;
  }
  return undefined;
}

/**
 * client_credentials token of an application, from the gateway's token route (M3-10): with mTLS
 * it is bound to the application's certificate (cnf.x5t#S256).
 */
export async function gatewayToken(clientId: string, clientSecret: string): Promise<string> {
  const res = await gatewayTokenResponse(clientId, clientSecret);
  expect(res.status, await res.clone().text()).toBe(200);
  return ((await res.json()) as { access_token: string }).access_token;
}

/** The token route's answer, whatever it is (secret rotation and revocation tests). */
export function gatewayTokenResponse(clientId: string, clientSecret: string): Promise<Response> {
  return gatewayFetch(
    `${gateway}/oauth/token`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
      },
      body: 'grant_type=client_credentials',
    },
    clientId,
  );
}

/**
 * Waits until the gateway knows a just-issued certificate: OPA gets it with the next bundle (every
 * 10-20 s); until then the call is denied as certificate_revoked. Returns the deny reason it
 * settled on, or null if the call was allowed.
 */
export async function untilCertificateKnown(url: string, token: string): Promise<string | null> {
  let reason: string | null = 'certificate_revoked';
  await expect
    .poll(
      async () => {
        const res = await gatewayFetch(url, {
          headers: { authorization: `Bearer ${token}`, 'x-rid-purpose': 'eligibility_check' },
        });
        reason = res.headers.get('x-rid-deny-reason');
        return reason;
      },
      { timeout: 60_000, intervals: [1_000] },
    )
    .not.toBe('certificate_revoked');
  return reason;
}

/** lucia (data steward of salud) approves a request for 6 months, as requested otherwise. */
export async function approveAsSteward(page: Page, subscriptionId: string) {
  await signIn(page, 'lucia.datos', `/requests/${subscriptionId}`);
  const approve = page.getByRole('form', { name: 'Aprobar' });
  await approve.getByLabel(/^Vigencia aprobada en meses/).fill('6');
  await approve.getByRole('button', { name: 'Aprobar' }).click();
  await expect(page.getByTestId('subscription-status')).toHaveText(/Aprobada|Activa/);
}

/**
 * The setting of the transparency stories: salud publishes an affiliation API (data subject in
 * the path and in the body), carlos asks for both operations for eligibility_check, lucia
 * approves, and the subscription is active at the gateway.
 */
export async function activeAffiliationSubscription(browser: Browser, page: Page, slug: string) {
  const apiName = `Afiliación ${slug}`;
  await publishNewApi(browser, { slug, name: apiName });
  await signIn(page, 'carlos.dev', '/my-apps');
  const appName = `Verificador ${slug}`;
  const { clientId, clientSecret } = await createGatewayApplication(page, appName);
  await openRequestForm(page, apiName);
  await page.getByLabel(/^Aplicación que hará las llamadas/).selectOption({ label: appName });
  await page.getByLabel(/^Finalidad/).selectOption('eligibility_check');
  await page
    .getByLabel(/^Para qué usarás los datos/)
    .fill('Verificar afiliación al asignar el subsidio X.');
  await page.getByLabel(/^Base legal/).fill('Ley de protección de datos, artículo 10, literal b.');
  await page.getByRole('checkbox', { name: /getAfiliado/ }).check();
  await page.getByRole('checkbox', { name: /verificarAfiliacion/ }).check();
  await page.getByLabel(/^Vigencia en meses/).fill('12');
  await page.getByRole('button', { name: 'Enviar solicitud' }).click();
  await expect(page.getByTestId('subscription-status')).toHaveText('Pendiente del proveedor');
  const subscriptionId = page.url().split('/my-apps/requests/')[1] ?? '';
  const steward = await (await browser.newContext()).newPage();
  await approveAsSteward(steward, subscriptionId);
  await steward.context().close();
  await page.goto(`/my-apps/requests/${subscriptionId}`);
  await expect(page.getByTestId('subscription-status')).toHaveText('Activa', { timeout: 60_000 });
  return { apiName, appName, clientId, clientSecret, subscriptionId };
}

// A timeout so that a stuck command fails the test instead of blocking the worker forever.
const docker = (...args: string[]) =>
  spawnSync('docker', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: 60_000 });

/** Rows of the transparency register (MT-03) for a subscription, oldest first. */
export function registeredCalls(subscriptionId: string): Array<{
  operation: string;
  source: string;
  subjectRef: string;
  status: number;
}> {
  if (!/^[0-9a-f-]{36}$/.test(subscriptionId)) throw new Error('Not a subscription id');
  const res = docker(
    'exec',
    'rid-postgres-1',
    'psql',
    '-U',
    process.env.POSTGRES_USER ?? 'rid',
    '-d',
    process.env.POSTGRES_DB ?? 'rid',
    '-At',
    '-F',
    '|',
    '-c',
    `SELECT operation_id, subject_source, subject_ref, status FROM subject_access_record
     WHERE subscription_id = '${subscriptionId}' ORDER BY occurred_at, id`,
  );
  if (res.status !== 0) throw new Error(res.stderr);
  return res.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [operation = '', source = '', subjectRef = '', status = ''] = line.split('|');
      return { operation, source, subjectRef, status: Number(status) };
    });
}

/**
 * Where a document number must never land (ADR-0015, golden rule 2): the gateway's logs, the
 * transparency pipeline's logs and disk buffer, and the whole portal database. Returns the places
 * that contain it.
 */
export function placesHolding(value: string): string[] {
  const found: string[] = [];
  const has = (output: string | null) => (output ?? '').includes(value);
  const apisix = docker('logs', 'rid-apisix-1');
  if (has(apisix.stdout) || has(apisix.stderr)) found.push('apisix logs');
  // Regular files only: the image links access.log and error.log to the container's stdout and
  // stderr (already read above), and reading those links would block.
  const logFiles = docker(
    'exec',
    'rid-apisix-1',
    'find',
    '/usr/local/apisix/logs',
    '-type',
    'f',
    '-exec',
    'cat',
    '{}',
    '+',
  );
  if (logFiles.status !== 0) throw new Error(logFiles.stderr || String(logFiles.error));
  if (has(logFiles.stdout)) found.push('apisix log files');
  const shipper = docker('logs', 'rid-fluent-bit-transparency-1');
  if (has(shipper.stdout) || has(shipper.stderr)) found.push('transparency pipeline logs');
  const buffer = docker(
    'exec',
    'rid-fluent-bit-transparency-1',
    'grep',
    '-r',
    '-l',
    value,
    '/var/lib/fluent-bit',
  );
  if (buffer.status === 0) found.push('transparency pipeline buffer');
  // grep: 1 = not found; anything else means the check did not run.
  else if (buffer.status !== 1) throw new Error(buffer.stderr || String(buffer.error));
  const dump = docker(
    'exec',
    'rid-postgres-1',
    'pg_dump',
    '-U',
    process.env.POSTGRES_USER ?? 'rid',
    '--data-only',
    process.env.POSTGRES_DB ?? 'rid',
  );
  if (dump.status !== 0) throw new Error(dump.stderr);
  if (has(dump.stdout)) found.push('portal database');
  return found;
}
