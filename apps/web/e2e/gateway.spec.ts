import { expect, test } from '@playwright/test';
import { createApplication, publishNewApi, signIn } from './flows';

// M1-08: publishing an API makes its route appear in APISIX through the reconciler (no manual
// step), and the route only lets through tokens issued for the gateway.
const gateway = process.env.RID_GATEWAY_PUBLIC_URL ?? 'http://localhost:9080';
const keycloak = process.env.KEYCLOAK_URL ?? 'http://localhost:8080';

test.describe('gateway route (M1-08)', () => {
  test('a published API gets its route; the gateway demands a gateway token', async ({
    browser,
    page,
  }) => {
    const slug = `gw-${Date.now().toString(36)}`;
    await publishNewApi(browser, { slug, name: `Afiliación ${slug}` });
    const url = `${gateway}/salud/${slug}/v1/afiliados/1000000001`;

    // The outbox relay and the reconciler run in the API: the route shows up within seconds.
    await expect
      .poll(async () => (await fetch(url)).status, { timeout: 30_000, intervals: [1_000] })
      .toBe(401);

    // A token of a portal user (realm rid-portal) is not a gateway token.
    await signIn(page, 'carlos.dev', '/my-apps');
    const clientId = await createApplication(page, `Gateway ${slug}`);
    const clientSecret = (await page.getByTestId('client-secret').textContent()) ?? '';
    await page.getByRole('link', { name: 'Ir a la aplicación' }).click();
    await expect(page.getByTestId('provisioning')).toHaveText('Lista', { timeout: 60_000 });

    const tokenResponse = await fetch(
      `${keycloak}/realms/rid-gateway/protocol/openid-connect/token`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
        },
        body: 'grant_type=client_credentials',
      },
    );
    const { access_token: token } = (await tokenResponse.json()) as { access_token: string };

    const forged = await fetch(url, { headers: { authorization: 'Bearer not-a-token' } });
    expect(forged.status).toBe(401);

    // A valid gateway token passes authentication and reaches OPA, which fails closed. Until the
    // rid/authz policy exists (M1-09) its decision is empty and the opa plugin answers 503; M1-09
    // turns this into 403 no_subscription. The upstream is never reached.
    const denied = await fetch(url, {
      headers: { authorization: `Bearer ${token}`, 'x-rid-purpose': 'eligibility_check' },
    });
    expect(denied.status).toBe(503);
    expect(denied.headers.get('x-request-id')).toBeTruthy();
  });
});
