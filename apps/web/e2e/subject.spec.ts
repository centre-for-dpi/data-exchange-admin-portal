import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { createApplication, openRequestForm, publishNewApi, signIn } from './flows';
import { approveAsSteward, gateway, gatewayToken, providerSaw } from './gateway-flows';

// MT-02 (ADR-0015): the gateway turns the data subject of every call into a keyed pseudonym,
// X-RID-Subject-Ref. The provider gets the pseudonym, never the X-RID-Data-Subject header in clear;
// an operation that declares a data subject is denied without one.
test.describe('data subject pseudonym at the gateway (MT-02)', () => {
  test('same person, same reference, wherever the identifier travels', async ({
    browser,
    page,
  }) => {
    test.setTimeout(300_000);
    const slug = `titular-${Date.now().toString(36)}`;
    const apiName = `Afiliación ${slug}`;
    await publishNewApi(browser, { slug, name: apiName });

    // carlos asks for both operations: the GET (subject in the path) and the POST (in the header).
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
    await page
      .getByLabel(/^Base legal/)
      .fill('Ley de protección de datos, artículo 10, literal b.');
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

    const token = await gatewayToken(clientId, clientSecret);
    const base = `${gateway}/salud/${slug}/v1/afiliados`;
    const since = new Date(Date.now() - 2_000).toISOString();
    const call = async (path: string, init: RequestInit = {}) => {
      const requestId = `mt02-${randomUUID()}`;
      const res = await fetch(`${base}${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${token}`,
          'x-rid-purpose': 'eligibility_check',
          'x-rid-end-user': 'funcionario-42',
          'x-request-id': requestId,
          // A client cannot choose its own reference: the gateway overwrites it.
          'x-rid-subject-ref': 'forged-reference',
          ...(init.headers as Record<string, string>),
        },
      });
      return { res, requestId };
    };
    const seenBy = async (requestId: string) => {
      await expect.poll(() => providerSaw(requestId, since), { timeout: 10_000 }).toBeDefined();
      return providerSaw(requestId, since) ?? {};
    };

    // Subject in the path.
    const byPath = await call('/1000000001');
    expect(byPath.res.status).toBe(200);
    const ref = (await seenBy(byPath.requestId))['x-rid-subject-ref'] ?? '';
    expect(ref).toMatch(/^[0-9a-f]{64}$/);

    // Same person, identifier in the body and declared in the header: same reference, and the
    // header in clear never reaches the provider (the mock would log it, masked).
    const verify = (headers: Record<string, string>) =>
      call('/verificaciones', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ numeroIdentificacion: '1000000001' }),
      });
    const byHeader = await verify({ 'x-rid-data-subject': 'CC:1000000001' });
    expect(byHeader.res.status).toBe(200);
    const headerSeen = await seenBy(byHeader.requestId);
    expect(headerSeen['x-rid-subject-ref']).toBe(ref);
    expect(headerSeen).not.toHaveProperty('x-rid-data-subject');

    // Without the header, the gateway does not know whose data it is: denied.
    const anonymous = await verify({});
    expect(anonymous.res.status).toBe(403);
    expect(anonymous.res.headers.get('x-rid-deny-reason')).toBe('data_subject_required');

    // Another person, another reference.
    const other = await call('/1000000002');
    expect(other.res.status).toBe(200);
    expect((await seenBy(other.requestId))['x-rid-subject-ref']).not.toBe(ref);
  });
});
