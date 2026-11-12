import { expect, test } from '@playwright/test';
import { createApplication, publishNewApi, requestAccess, signIn } from './flows';
import { expectNoAccessibilityViolations } from './helpers';

// M1-11 (DEMO.md step 10): the regulator verifies the integrity of the hash chain and reads the
// timeline of a subscription; each entity sees the timeline of its own objects.
test.describe('audit trail (M1-11)', () => {
  test('marta verifies the chain and reads a subscription’s timeline', async ({
    browser,
    page,
  }) => {
    test.setTimeout(180_000);
    const slug = `audit-${Date.now().toString(36)}`;
    const apiName = `Afiliación ${slug}`;
    await publishNewApi(browser, { slug, name: apiName });

    await signIn(page, 'carlos.dev', '/my-apps');
    const appName = `Validador ${slug}`;
    await createApplication(page, appName);
    const subscriptionId = await requestAccess(page, apiName, appName);

    const steward = await (await browser.newContext()).newPage();
    await signIn(steward, 'lucia.datos', `/requests/${subscriptionId}`);
    const approve = steward.getByRole('form', { name: 'Aprobar' });
    await approve.getByLabel(/^Comentario/).fill('Aprobado para el subsidio X.');
    await approve.getByRole('button', { name: 'Aprobar' }).click();
    await expect(steward.getByTestId('subscription-status')).toHaveText(/Aprobada|Activa/);
    // The provider's timeline names its own steward.
    await expect(steward.getByTestId('audit-timeline')).toContainText('Solicitud aprobada');
    await steward.context().close();

    // The consumer sees the provider's decision without the name of the provider's person.
    await page.goto(`/my-apps/requests/${subscriptionId}`);
    const consumerTimeline = page.getByTestId('audit-timeline');
    await expect(consumerTimeline).toContainText('Acceso solicitado');
    await expect(consumerTimeline).toContainText('Persona de Salud (ficticia)');
    await expect(consumerTimeline).toContainText('Aprobado para el subsidio X.');
    await expectNoAccessibilityViolations(page);

    const regulator = await (await browser.newContext()).newPage();
    await signIn(regulator, 'marta.regulador', '/audit');
    await expect(regulator.getByRole('heading', { level: 1, name: 'Auditoría' })).toBeVisible();
    await regulator.getByRole('button', { name: 'Verificar integridad' }).click();
    await expect(regulator.getByTestId('chain-check')).toContainText('Cadena íntegra');
    await expectNoAccessibilityViolations(regulator);

    await regulator.goto(`/audit/subscription/${subscriptionId}`);
    const timeline = regulator.getByTestId('audit-timeline');
    // OPA may already have activated it (a third event): only the first two are certain.
    await expect(timeline.getByRole('listitem').nth(0)).toContainText('Acceso solicitado');
    await expect(timeline.getByRole('listitem').nth(1)).toContainText('Solicitud aprobada');
    await expect(timeline).toContainText('Acceso solicitado');
    await expect(timeline).toContainText('Solicitud aprobada');
    await expect(timeline).toContainText(
      'Estado: Pendiente del proveedor → Aprobada (activándose)',
    );
    await expect(timeline).not.toContainText('Persona de');
    await expectNoAccessibilityViolations(regulator);
    await regulator.context().close();
  });

  test('an entity member is pointed to the timelines of each object', async ({ page }) => {
    await signIn(page, 'elena.admin', '/audit');
    await expect(
      page.getByText(
        'Cada solicitud de acceso y cada API de tu entidad muestran su línea de tiempo',
      ),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Verificar integridad' })).toHaveCount(0);
  });
});
