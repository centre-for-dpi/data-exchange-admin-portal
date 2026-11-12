import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { expect, type Page, test } from '@playwright/test';
import { createApplication, publishNewApi, requestAccess, signIn } from './flows';

// M1-09: the first real call end to end (DEMO.md steps 5-8). OPA allows it only with an active
// subscription, the right operation, purpose and official; the provider receives the gateway's
// trace headers and never a value the client forged.
const gateway = process.env.RID_GATEWAY_PUBLIC_URL ?? 'http://localhost:9080';
const keycloak = process.env.KEYCLOAK_URL ?? 'http://localhost:8080';

/** Headers the salud mock logged for a request (it logs X-RID-* and X-Request-Id only). */
function providerSaw(requestId: string, since: string): Record<string, string> | undefined {
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

async function gatewayToken(clientId: string, clientSecret: string): Promise<string> {
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

async function approveAsSteward(page: Page, subscriptionId: string) {
  await signIn(page, 'lucia.datos', `/requests/${subscriptionId}`);
  const approve = page.getByRole('form', { name: 'Aprobar' });
  await approve.getByLabel(/^Vigencia aprobada en meses/).fill('6');
  await approve.getByRole('button', { name: 'Aprobar' }).click();
  await expect(page.getByTestId('subscription-status')).toHaveText(/Aprobada|Activa/);
}

test.describe('a call through the gateway (M1-09)', () => {
  test('subscribed call reaches the provider with trusted headers only', async ({
    browser,
    page,
  }) => {
    test.setTimeout(240_000);
    const slug = `call-${Date.now().toString(36)}`;
    const apiName = `Afiliación ${slug}`;
    await publishNewApi(browser, { slug, name: apiName });

    await signIn(page, 'carlos.dev', '/my-apps');
    const appName = `Validador ${slug}`;
    const clientId = await createApplication(page, appName);
    const clientSecret = (await page.getByTestId('client-secret').textContent()) ?? '';
    const subscriptionId = await requestAccess(page, apiName, appName);

    const steward = await (await browser.newContext()).newPage();
    await approveAsSteward(steward, subscriptionId);
    await steward.context().close();

    // OPA downloads the bundle (every 10-20 s) and reports it; the page refreshes itself.
    await page.goto(`/my-apps/requests/${subscriptionId}`);
    await expect(page.getByTestId('subscription-status')).toHaveText('Activa', { timeout: 60_000 });

    const token = await gatewayToken(clientId, clientSecret);
    const base = `${gateway}/salud/${slug}/v1/afiliados`;
    const headers = (extra: Record<string, string> = {}) => ({
      authorization: `Bearer ${token}`,
      'x-rid-purpose': 'eligibility_check',
      'x-rid-end-user': 'funcionario-42',
      ...extra,
    });

    // Allowed, even with forged gateway headers: the provider sees only OPA's values.
    const since = new Date(Date.now() - 2_000).toISOString();
    const requestId = `e2e-${randomUUID()}`;
    const ok = await fetch(`${base}/1000000001`, {
      headers: headers({
        'x-request-id': requestId,
        'x-rid-subscription': 'sub-SPOOFED',
        'x-rid-operation': 'deleteEverything',
        'x-rid-consumer-entity': 'entidad-falsa',
        'x-rid-end-user-hash': 'hash-falso',
      }),
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toHaveProperty('regimen');

    await expect.poll(() => providerSaw(requestId, since), { timeout: 10_000 }).toBeDefined();
    const seen = providerSaw(requestId, since) ?? {};
    expect(seen).toMatchObject({
      'x-rid-subscription': subscriptionId,
      'x-rid-operation': 'getAfiliado',
      'x-rid-consumer-entity': 'programas-sociales',
      'x-rid-consumer-app': clientId,
      'x-rid-purpose': 'eligibility_check',
    });
    expect(seen['x-rid-end-user-hash']).toMatch(/^[0-9a-f]{64}$/);
    // The official's identifier never reaches the provider in clear (the mock would log it).
    expect(seen).not.toHaveProperty('x-rid-end-user');

    // Denials with stable reasons (DEMO.md step 8).
    const deny = async (url: string, init: RequestInit, reason: string) => {
      const res = await fetch(url, init);
      expect(res.status, reason).toBe(403);
      expect(res.headers.get('x-rid-deny-reason')).toBe(reason);
      expect(res.headers.get('content-type')).toMatch(/problem\+json/);
      expect(await res.json()).toMatchObject({ code: reason, status: 403 });
    };
    await deny(
      `${base}/1000000001`,
      { headers: headers({ 'x-rid-purpose': 'benefit_targeting' }) },
      'purpose_not_allowed',
    );
    const withoutOfficial: Record<string, string> = headers();
    delete withoutOfficial['x-rid-end-user'];
    await deny(`${base}/1000000001`, { headers: withoutOfficial }, 'end_user_required');
    // The POST operation exists in the API but was not requested (read-only by default).
    await deny(
      `${base}/verificaciones`,
      {
        method: 'POST',
        headers: { ...headers(), 'content-type': 'application/json' },
        body: JSON.stringify({ numeroIdentificacion: '1000000001' }),
      },
      'operation_not_allowed',
    );

    // M1-10 (DEMO.md step 9): lucia revokes; within 60 s the same call is denied.
    const revoker = await (await browser.newContext()).newPage();
    await signIn(revoker, 'lucia.datos', `/requests/${subscriptionId}`);
    const revoke = revoker.getByRole('form', { name: 'Revocar acceso' });
    await revoke.getByLabel(/^Motivo de la revocación/).fill('El convenio de intercambio terminó.');
    await revoke.getByRole('button', { name: 'Revocar acceso' }).click();
    await expect(revoker.getByTestId('subscription-status')).toHaveText('Revocada');
    const revokedAt = Date.now();
    await revoker.context().close();

    await expect
      .poll(
        async () => {
          const res = await fetch(`${base}/1000000001`, { headers: headers() });
          return res.status === 403 ? res.headers.get('x-rid-deny-reason') : String(res.status);
        },
        { timeout: 60_000, intervals: [1_000] },
      )
      .toBe('no_subscription');
    const seconds = (Date.now() - revokedAt) / 1000;
    expect(seconds).toBeLessThan(60);
    test.info().annotations.push({ type: 'revocation', description: `denied after ${seconds} s` });

    // The consumer reads why.
    await page.goto(`/my-apps/requests/${subscriptionId}`);
    await expect(page.getByTestId('subscription-status')).toHaveText('Revocada');
    await expect(page.getByText('El convenio de intercambio terminó.')).toBeVisible();
  });
});
