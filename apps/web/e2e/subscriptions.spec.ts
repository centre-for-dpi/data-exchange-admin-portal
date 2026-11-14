import { expect, test } from '@playwright/test';
import { createApplication, openRequestForm, publishNewApi, requestAccess, signIn } from './flows';
import { expectNoAccessibilityViolations } from './helpers';

// M1-07: carlos asks for access with a purpose; lucia (data steward of the provider) decides.
test.describe('access requests (M1-07)', () => {
  test('carlos requests access and lucia approves it for 6 months', async ({ browser, page }) => {
    // Publishing an API (submit + review) alone takes most of the default 60 s.
    test.setTimeout(180_000);
    const apiName = `Afiliación ${Date.now().toString(36)}`;
    await publishNewApi(browser, { name: apiName });

    await signIn(page, 'carlos.dev', '/my-apps');
    const appName = `Validador de subsidios ${Date.now().toString(36)}`;
    await createApplication(page, appName);
    await openRequestForm(page, apiName);
    await expectNoAccessibilityViolations(page);

    // Required fields are announced in the error summary.
    await page.getByRole('button', { name: 'Enviar solicitud' }).click();
    await expect(page.locator('form').getByRole('alert')).toBeVisible();

    const id = await requestAccess(page, apiName, appName);
    // An empty selection stands for the read-only operations: the GET, not the POST.
    await expect(page.getByText('Todas las de solo lectura')).toBeVisible();
    await expect(page.getByText('GET /afiliados/{numeroIdentificacion}')).toBeVisible();
    await expect(
      page.getByText('Obligatoria: cada llamada debe enviar X-RID-End-User.'),
    ).toBeVisible();
    await expectNoAccessibilityViolations(page);

    const steward = await (await browser.newContext()).newPage();
    await signIn(steward, 'lucia.datos', '/requests');
    await expect(steward.getByRole('row', { name: new RegExp(apiName) })).toContainText(
      'Programas Sociales',
    );
    await expectNoAccessibilityViolations(steward);
    await steward.getByRole('link', { name: new RegExp(apiName) }).click();
    await expect(steward.getByText('Verificar afiliación al asignar el subsidio X.')).toBeVisible();
    await expectNoAccessibilityViolations(steward);

    const approve = steward.getByRole('form', { name: 'Aprobar' });
    await approve.getByLabel(/^Vigencia aprobada en meses/).fill('6');
    await approve.getByRole('button', { name: 'Aprobar' }).click();
    await expect(steward.getByTestId('subscription-status')).toHaveText('Aprobada (activándose)');
    await steward.context().close();

    await page.goto(`/my-apps/requests/${id}`);
    await expect(page.getByTestId('subscription-status')).toHaveText('Aprobada (activándose)');
    await expect(page.getByTestId('audit-timeline')).toContainText('Solicitud aprobada');
    await page.goto('/my-apps');
    await expect(page.getByRole('row', { name: new RegExp(apiName) })).toContainText(
      'Aprobada (activándose)',
    );
  });

  test('lucia rejects with a reason that carlos reads', async ({ browser, page }) => {
    // Publishing an API (submit + review) alone takes most of the default 60 s.
    test.setTimeout(180_000);
    const apiName = `Afiliación ${Date.now().toString(36)}`;
    await publishNewApi(browser, { name: apiName });
    await signIn(page, 'carlos.dev', '/my-apps');
    const appName = `Focalización ${Date.now().toString(36)}`;
    await createApplication(page, appName);
    const id = await requestAccess(page, apiName, appName);

    const steward = await (await browser.newContext()).newPage();
    await signIn(steward, 'lucia.datos', `/requests/${id}`);
    const reject = steward.getByRole('form', { name: 'Rechazar' });
    await reject.getByRole('button', { name: 'Rechazar' }).click();
    await expect(reject.getByRole('alert')).toBeVisible();
    await reject
      .getByLabel(/^Motivo del rechazo/)
      .fill('La finalidad no corresponde al convenio vigente.');
    await reject.getByRole('button', { name: 'Rechazar' }).click();
    await expect(steward.getByTestId('subscription-status')).toHaveText('Rechazada');
    await steward.context().close();

    await page.goto(`/my-apps/requests/${id}`);
    await expect(page.getByTestId('subscription-status')).toHaveText('Rechazada');
    await expect(page.getByText('La finalidad no corresponde al convenio vigente.')).toBeVisible();
  });

  test('a publisher of the provider reads the inbox but cannot decide', async ({ page }) => {
    await signIn(page, 'pedro.publicador', '/requests');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Solicitudes recibidas' }),
    ).toBeVisible();
    await expect(
      page.getByText('Solo el responsable de datos de tu entidad puede decidir.'),
    ).toBeVisible();
  });
});
