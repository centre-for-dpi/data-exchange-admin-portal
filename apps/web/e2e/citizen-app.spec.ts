import { expect, test } from '@playwright/test';
import { citizenApp, mailsTo, mailText } from './citizen';
import {
  activeAffiliationSubscription,
  gateway,
  gatewayFetch,
  gatewayToken,
} from './gateway-flows';
import { expectNoAccessibilityViolations } from './helpers';

// MT-07, closing the transparency milestone: the demo citizen sees in the reference citizen app the
// consultation carlos's app made, gets the notice by email and verifies the receipt without
// trusting the portal.
test.describe('reference citizen app (MT-07)', () => {
  test('who consulted my data, the notice and the receipt', async ({ browser, page }) => {
    test.setTimeout(300_000);
    const slug = `citizenApp-${Date.now().toString(36)}`;
    const { apiName, clientId, clientSecret } = await activeAffiliationSubscription(
      browser,
      page,
      slug,
    );

    // Valentina (CC 1000000001) signs in to the citizen app with the national identity.
    const citizen = await (await browser.newContext()).newPage();
    await citizen.goto(`${citizenApp}/`);
    await expect(citizen.getByRole('heading', { level: 1 })).toHaveText(
      '¿Quién consultó mis datos?',
    );
    await expectNoAccessibilityViolations(citizen);
    await citizen.getByRole('link', { name: 'Ingresar con tu identidad digital' }).click();
    await citizen.waitForURL(/\/realms\/den-citizens\//);
    await citizen.locator('#username').fill('ciudadana.demo');
    await citizen
      .locator('#password')
      .fill(process.env.DEN_DEMO_USER_PASSWORD ?? 'den-demo-password');
    await citizen.locator('#kc-login').click();
    await citizen.waitForURL(`${citizenApp}/consultas`);

    // She asks to be told about consultations of her personal data; the email stays in the
    // citizen app, the portal only gets the choice.
    const email = `valentina+${slug}@ciudadana.demo.den.example`;
    await citizen.getByLabel('Datos personales', { exact: true }).check();
    await citizen.getByLabel('Correo para los avisos').fill(email);
    await citizen.getByRole('button', { name: 'Guardar avisos' }).click();
    await expect(citizen.getByRole('status')).toHaveText('Avisos guardados.');

    // carlos's app consults her affiliation through the gateway.
    const res = await gatewayFetch(`${gateway}/salud/${slug}/v1/afiliados/1000000001`, {
      headers: {
        authorization: `Bearer ${await gatewayToken(clientId, clientSecret)}`,
        'x-den-purpose': 'eligibility_check',
        'x-den-end-user': 'funcionario-42',
      },
    });
    expect(res.status).toBe(200);

    // The notice: a signed webhook to the citizen app, an email from the citizen app. No data in it.
    await expect.poll(async () => (await mailsTo(email)).length, { timeout: 60_000 }).toBe(1);
    const [mail] = await mailsTo(email);
    expect(mail?.Subject).toBe('Una entidad consultó tus datos');
    const text = await mailText(mail?.ID ?? '');
    expect(text).toContain(`${citizenApp}/consultas`);
    expect(text).not.toContain('1000000001');
    expect(text).not.toContain(apiName);

    // She sees who, which data and why…
    await citizen.reload();
    const row = citizen.getByRole('row').filter({ hasText: apiName });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('Programas Sociales');
    await expect(row).toContainText('Verificación de requisitos de un trámite');
    await expect(row).toContainText('Respondida');
    await expectNoAccessibilityViolations(citizen);

    // …and once the batch is sealed and stamped, she verifies the receipt.
    await expect
      .poll(
        async () => {
          await citizen.reload();
          return row.getByRole('link', { name: /Verificar/ }).count();
        },
        { timeout: 90_000, intervals: [3_000] },
      )
      .toBe(1);
    await row.getByRole('link', { name: /Verificar/ }).click();
    await expect(citizen.getByTestId('receipt-status')).toHaveText('Comprobante válido');
    await expect(
      citizen.getByRole('listitem').filter({ hasText: 'Sello de tiempo' }),
    ).toContainText('Correcto');
    await expectNoAccessibilityViolations(citizen);
  });
});
