import { spawnSync } from 'node:child_process';
import { expect, type Page } from '@playwright/test';
import { signIn } from './flows';

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
