import { expect, test } from '@playwright/test';
import { mailsTo } from './citizen';
import { createApplication, publishNewApi, requestAccess, signIn } from './flows';
import { expectNoAccessibilityViolations } from './helpers';

// M2-08: a new access request reaches the data steward in the portal and by e-mail; opening the
// notice marks it read and leads to the request; preferences are saved.
test.describe('notifications (M2-08)', () => {
  test('lucia hears about carlos’s request and opens it from her notices', async ({ browser }) => {
    test.setTimeout(300_000);
    const stamp = Date.now().toString(36);
    const { name } = await publishNewApi(browser, {
      name: `Afiliación aviso ${stamp}`,
      slug: `aviso-${stamp}`,
    });
    const consumer = await (await browser.newContext()).newPage();
    await signIn(consumer, 'carlos.dev');
    const appName = `Avisos ${stamp}`;
    await createApplication(consumer, appName);
    const id = await requestAccess(consumer, name, appName);

    const steward = await (await browser.newContext()).newPage();
    await signIn(steward, 'lucia.datos', '/notifications');
    const notice = steward.getByRole('link', { name: `${appName} pide acceso a ${name}` });
    await expect(async () => {
      await steward.reload();
      await expect(notice).toBeVisible({ timeout: 5_000 });
    }).toPass({ timeout: 60_000 });
    await expectNoAccessibilityViolations(steward);

    // The same notice arrived by e-mail (Mailpit), with the link to the request.
    await expect
      .poll(
        async () =>
          (await mailsTo('lucia.datos@demo.den.example')).some((m) => m.Subject.includes(appName)),
        {
          timeout: 60_000,
        },
      )
      .toBe(true);

    await notice.click();
    await steward.waitForURL(new RegExp(`/requests/${id}$`));
    await expect(steward.getByTestId('subscription-status')).toHaveText('Pendiente del proveedor');

    await steward.goto('/notifications');
    await steward.getByRole('button', { name: 'Guardar preferencias' }).click();
    await expect(steward.getByText('Preferencias guardadas.')).toBeVisible();
  });
});
