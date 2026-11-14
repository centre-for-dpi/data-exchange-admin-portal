import { expect, test } from '@playwright/test';
import { createApplication, requestAccess, signIn, submitNewApi } from './flows';
import { expectNoAccessibilityViolations } from './helpers';

// M2-04: with features.approval.regulatorForSensitive, a sensitive API is published only after
// the regulator approves it, and an access request to it is approved only after the regulator.
const versionIdOf = (url: string) => url.split('/versions/')[1]?.split(/[?#]/)[0] ?? '';

test.describe('regulator approval (M2-04)', () => {
  test('marta publishes a sensitive API and approves an access request to it', async ({
    browser,
  }) => {
    test.setTimeout(240_000);
    const stamp = Date.now().toString(36);
    const name = `Historia clínica ${stamp}`;

    // pedro submits a sensitive API; ana approves it as operator: it waits for the regulator.
    const publisher = await (await browser.newContext()).newPage();
    const { versionUrl } = await submitNewApi(publisher, {
      name,
      slug: `historia-${stamp}`,
      classification: 'Datos sensibles',
    });
    const versionId = versionIdOf(versionUrl);
    const operator = await (await browser.newContext()).newPage();
    await signIn(operator, 'ana.operadora', `/operator/reviews/${versionId}`);
    await operator.getByRole('button', { name: 'Aprobar' }).click();
    await expect(operator.getByTestId('version-status')).toHaveText('Aprobada por el operador');

    // marta sees it in her inbox and publishes it.
    const regulator = await (await browser.newContext()).newPage();
    await signIn(regulator, 'marta.regulador', '/regulator');
    await expect(
      regulator.getByRole('heading', { name: 'Publicaciones por aprobar' }),
    ).toBeVisible();
    await expectNoAccessibilityViolations(regulator);
    await regulator.getByRole('link', { name }).click();
    await expect(regulator.getByRole('heading', { name: 'Decisión del regulador' })).toBeVisible();
    await expectNoAccessibilityViolations(regulator);
    await regulator
      .getByRole('form', { name: 'Aprobar' })
      .getByRole('button', { name: 'Aprobar' })
      .click();
    await expect(regulator.getByTestId('version-status')).toHaveText('Publicada');

    // carlos asks for access; lucia approves; it waits for the regulator.
    const consumer = await (await browser.newContext()).newPage();
    await signIn(consumer, 'carlos.dev');
    const appName = `Validador salud ${stamp}`;
    await createApplication(consumer, appName);
    const subscriptionId = await requestAccess(consumer, name, appName, '6');
    const steward = await (await browser.newContext()).newPage();
    await signIn(steward, 'lucia.datos', `/requests/${subscriptionId}`);
    const approve = steward.getByRole('form', { name: 'Aprobar' });
    await approve.getByLabel(/^Vigencia aprobada en meses/).fill('6');
    await approve.getByRole('button', { name: 'Aprobar' }).click();
    await expect(steward.getByTestId('subscription-status')).toHaveText('Pendiente del regulador');

    // marta approves it from her inbox: the subscription activates at the gateway.
    await regulator.goto('/regulator');
    await regulator.getByRole('link', { name: new RegExp(name) }).click();
    await expect(regulator.getByRole('heading', { name: 'Decisión del regulador' })).toBeVisible();
    await expectNoAccessibilityViolations(regulator);
    await regulator
      .getByRole('form', { name: 'Aprobar' })
      .getByRole('button', { name: 'Aprobar' })
      .click();
    await expect(
      regulator.getByText('Esta solicitud no está esperando la decisión del regulador.'),
    ).toBeVisible();
    await consumer.goto(`/my-apps/requests/${subscriptionId}`);
    await expect(consumer.getByTestId('subscription-status')).toHaveText(/Aprobada|Activa/);
  });
});
