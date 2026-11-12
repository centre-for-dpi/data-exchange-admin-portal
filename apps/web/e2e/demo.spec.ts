import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { createApplication, openCatalogApi, publishNewApi, requestAccess, signIn } from './flows';
import { approveAsSteward, gateway, gatewayToken, providerSaw } from './gateway-flows';
import { expectNoAccessibilityViolations } from './helpers';

// M1-12: the whole of docs/DEMO.md in the UI, steps 1-10 (pnpm demo runs the same script from the
// terminal). The call itself (M1-09): OPA allows it only with an active subscription, the right
// operation, purpose and official; the provider receives the gateway's trace headers and never a
// value the client forged. Revocation (M1-10) takes effect in under 60 s.
test.describe('DEMO.md end to end (M1-12)', () => {
  test('publish, review, discover, subscribe, call, revoke and audit', async ({
    browser,
    page,
  }) => {
    test.setTimeout(360_000);
    const slug = `call-${Date.now().toString(36)}`;
    const apiName = `Afiliación ${slug}`;
    // Steps 1-2: pedro publishes, ana approves; the reconciler creates the route by itself.
    await publishNewApi(browser, { slug, name: apiName });
    const base = `${gateway}/salud/${slug}/v1/afiliados`;
    await expect
      .poll(async () => (await fetch(`${base}/1000000001`)).status, { timeout: 60_000 })
      .toBe(401);

    // Step 3: carlos discovers it in the catalogue, with its interactive documentation.
    await signIn(page, 'carlos.dev', '/my-apps');
    await openCatalogApi(page, apiName);
    await expect(page.getByRole('heading', { name: 'Documentación interactiva' })).toBeVisible();

    // Step 4: credentials. With a token but no subscription the gateway says why.
    const appName = `Validador de subsidios ${slug}`;
    const clientId = await createApplication(page, appName);
    const clientSecret = (await page.getByTestId('client-secret').textContent()) ?? '';
    await page.getByRole('link', { name: 'Ir a la aplicación' }).click();
    await expect(page.getByTestId('provisioning')).toHaveText('Lista', { timeout: 60_000 });
    const early = await fetch(`${base}/1000000001`, {
      headers: {
        authorization: `Bearer ${await gatewayToken(clientId, clientSecret)}`,
        'x-rid-purpose': 'eligibility_check',
      },
    });
    expect(early.status).toBe(403);
    expect(early.headers.get('x-rid-deny-reason')).toBe('no_subscription');

    // Steps 5-6: request with a purpose; lucia approves for 6 months.
    const subscriptionId = await requestAccess(page, apiName, appName);

    const steward = await (await browser.newContext()).newPage();
    await approveAsSteward(steward, subscriptionId);
    await steward.context().close();

    // OPA downloads the bundle (every 10-20 s) and reports it; the page refreshes itself.
    await page.goto(`/my-apps/requests/${subscriptionId}`);
    await expect(page.getByTestId('subscription-status')).toHaveText('Activa', { timeout: 60_000 });

    // Steps 7-8: the call, and the denials.
    const token = await gatewayToken(clientId, clientSecret);
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

    // Step 10: marta reads the subscription's whole story and verifies the chain.
    const regulator = await (await browser.newContext()).newPage();
    await signIn(regulator, 'marta.regulador', `/audit/subscription/${subscriptionId}`);
    const timeline = regulator.getByTestId('audit-timeline');
    for (const action of [
      'Acceso solicitado',
      'Solicitud aprobada',
      'Acceso activo en el gateway',
      'Acceso revocado',
    ]) {
      await expect(timeline).toContainText(action);
    }
    await regulator.goto('/audit');
    await regulator.getByRole('button', { name: 'Verificar integridad' }).click();
    await expect(regulator.getByTestId('chain-check')).toContainText('Cadena íntegra');
    await expectNoAccessibilityViolations(regulator);
    await regulator.context().close();
  });
});
