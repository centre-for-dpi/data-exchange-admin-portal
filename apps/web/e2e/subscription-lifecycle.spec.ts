import { expect, test } from '@playwright/test';
import { createApplication, publishNewApi, requestAccess, signIn } from './flows';
import { expectNoAccessibilityViolations } from './helpers';

// M2-06: the data steward asks for information and the requester answers; the steward
// approves, suspends and reactivates; the requester asks for a prefilled renewal.
test.describe('subscription lifecycle (M2-06)', () => {
  test('question and answer, suspension, reactivation and renewal', async ({ browser }) => {
    test.setTimeout(240_000);
    const stamp = Date.now().toString(36);
    const { name } = await publishNewApi(browser, {
      name: `Afiliación vida ${stamp}`,
      slug: `vida-${stamp}`,
    });

    const consumer = await (await browser.newContext()).newPage();
    await signIn(consumer, 'carlos.dev');
    const appName = `Subsidios ${stamp}`;
    await createApplication(consumer, appName);
    const id = await requestAccess(consumer, name, appName);

    // lucia asks a question; the request goes back to carlos.
    const steward = await (await browser.newContext()).newPage();
    await signIn(steward, 'lucia.datos', `/requests/${id}`);
    const ask = steward.getByRole('form', { name: 'Pedir información' });
    await ask.getByLabel(/^Qué necesitas saber/).fill('¿Para qué programa social son los datos?');
    await ask.getByRole('button', { name: 'Pedir información' }).click();
    await expect(steward.getByTestId('subscription-status')).toHaveText(
      'Con preguntas del proveedor',
    );

    await consumer.goto(`/my-apps/requests/${id}`);
    await expect(
      consumer.getByText('¿Para qué programa social son los datos?').first(),
    ).toBeVisible();
    await expectNoAccessibilityViolations(consumer);
    const answer = consumer.getByRole('form', { name: 'Responder al proveedor' });
    await answer.getByLabel(/^Tu respuesta/).fill('Para el subsidio de vivienda del programa X.');
    await answer.getByRole('button', { name: 'Responder al proveedor' }).click();
    await expect(consumer.getByTestId('subscription-status')).toHaveText('Pendiente del proveedor');

    // lucia approves; once active she suspends and reactivates it.
    await steward.goto(`/requests/${id}`);
    const approve = steward.getByRole('form', { name: 'Aprobar' });
    await approve.getByRole('button', { name: 'Aprobar' }).click();
    await expect(steward.getByTestId('subscription-status')).toHaveText('Activa', {
      timeout: 90_000,
    });
    await expectNoAccessibilityViolations(steward);
    const suspend = steward.getByRole('form', { name: 'Suspender el acceso' });
    await suspend.getByLabel(/^Motivo/).fill('Revisión del uso de los datos.');
    await suspend.getByRole('button', { name: 'Suspender el acceso' }).click();
    await expect(steward.getByTestId('subscription-status')).toHaveText('Suspendida');
    await steward
      .getByRole('form', { name: 'Reactivar el acceso' })
      .getByRole('button', { name: 'Reactivar el acceso' })
      .click();
    await expect(steward.getByTestId('subscription-status')).toHaveText('Activa');

    // carlos asks for the renewal: a prefilled request next to the active subscription.
    await consumer.goto(`/my-apps/requests/${id}`);
    await consumer.getByRole('link', { name: 'Pedir la renovación' }).click();
    await expect(consumer.getByRole('heading', { level: 1 })).toContainText('Renovar el acceso a');
    await expect(consumer.getByLabel(/^Para qué usarás los datos/)).toHaveValue(
      'Verificar afiliación al asignar el subsidio X.',
    );
    await expectNoAccessibilityViolations(consumer);
    await consumer.getByRole('button', { name: 'Enviar solicitud' }).click();
    await expect(consumer.getByTestId('subscription-status')).toHaveText('Pendiente del proveedor');
    await expect(
      consumer.getByText('Esta solicitud renueva una suscripción vigente.'),
    ).toBeVisible();
    await consumer.getByRole('link', { name: 'Ver la suscripción que renueva' }).click();
    await expect(consumer.getByTestId('subscription-status')).toHaveText('Activa');
    await expect(consumer.getByText('Hay una renovación en curso.')).toBeVisible();
  });
});
