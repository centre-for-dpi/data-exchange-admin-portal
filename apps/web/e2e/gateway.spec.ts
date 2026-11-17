import { createHash, X509Certificate } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { publishNewApi, signIn } from './flows';
import {
  certificateOf,
  createGatewayApplication,
  gateway,
  gatewayFetch,
  gatewayToken,
  probeGateway,
  untilCertificateKnown,
} from './gateway-flows';
import { country } from './helpers';

// M1-08: publishing an API makes its route appear in APISIX through the reconciler (no manual
// step), and the route only lets through tokens issued for the gateway.

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
      .poll(async () => (await probeGateway(url)).status, { timeout: 30_000, intervals: [1_000] })
      .toBe(401);

    // A token of a portal user (realm den-portal) is not a gateway token.
    await signIn(page, 'carlos.dev', '/my-apps');
    const { clientId, clientSecret } = await createGatewayApplication(page, `Gateway ${slug}`);
    await expect(page.getByTestId('provisioning')).toHaveText('Lista', { timeout: 60_000 });

    // The token comes from the gateway's own token route (M3-10).
    const token = await gatewayToken(clientId, clientSecret);

    const forged = await gatewayFetch(
      url,
      { headers: { authorization: 'Bearer not-a-token' } },
      clientId,
    );
    expect(forged.status).toBe(401);

    // A valid gateway token passes authentication and reaches OPA, which denies: the application
    // has no subscription. The upstream is never reached.
    await untilCertificateKnown(url, token);
    const denied = await gatewayFetch(url, {
      headers: { authorization: `Bearer ${token}`, 'x-den-purpose': 'eligibility_check' },
    });
    expect(denied.status).toBe(403);
    expect(denied.headers.get('x-den-deny-reason')).toBe('no_subscription');
    expect(denied.headers.get('x-request-id')).toBeTruthy();

    if (!country().features.mtls.required) return;
    // M3-10: the token is bound to the application's certificate (RFC 8705, cnf.x5t#S256).
    const claims = JSON.parse(
      Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'),
    ) as { cnf?: Record<string, string> };
    const leaf = new X509Certificate(certificateOf(clientId)?.cert ?? '');
    expect(claims.cnf?.['x5t#S256']).toBe(
      createHash('sha256').update(leaf.raw).digest('base64url'),
    );
    // Without a client certificate there is no TLS session with the gateway at all.
    await expect(
      gatewayFetch(url, { headers: { authorization: `Bearer ${token}` } }, 'no-certificate'),
    ).rejects.toThrow();

    // M3 closing criterion: revoking the certificate takes effect within 60 s, token or not.
    await page.reload();
    await page.getByText(/^Revocar el certificado/).click();
    await page.getByLabel(/^Motivo/).fill('La clave privada quedó expuesta');
    await page.getByRole('button', { name: 'Revocar ahora' }).click();
    await expect(
      page.getByRole('status').filter({ hasText: 'Credencial revocada.' }),
    ).toBeVisible();
    const revokedAt = Date.now();
    await expect
      .poll(
        async () =>
          (
            await gatewayFetch(url, {
              headers: { authorization: `Bearer ${token}`, 'x-den-purpose': 'eligibility_check' },
            })
          ).headers.get('x-den-deny-reason'),
        { timeout: 60_000, intervals: [1_000] },
      )
      .toBe('certificate_revoked');
    const seconds = (Date.now() - revokedAt) / 1000;
    expect(seconds).toBeLessThan(60);
    test.info().annotations.push({ type: 'revocation', description: `refused after ${seconds} s` });
  });
});
