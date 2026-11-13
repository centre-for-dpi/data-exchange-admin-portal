import { spawnSync } from 'node:child_process';
import { type Browser, expect, type Page } from '@playwright/test';
import { createApplication, openRequestForm, publishNewApi, signIn } from './flows';

/** Calls through the real gateway (M1-09 onwards). */
export const gateway = process.env.RID_GATEWAY_PUBLIC_URL ?? 'http://localhost:9080';
const keycloak = process.env.KEYCLOAK_URL ?? 'http://localhost:8080';

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

/** client_credentials token of an application in the gateway realm. */
export async function gatewayToken(clientId: string, clientSecret: string): Promise<string> {
  const res = await fetch(`${keycloak}/realms/rid-gateway/protocol/openid-connect/token`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
    },
    body: 'grant_type=client_credentials',
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { access_token: string }).access_token;
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
  const clientId = await createApplication(page, appName);
  const clientSecret = (await page.getByTestId('client-secret').textContent()) ?? '';
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
