import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import {
  openapiFile,
  openCatalogApi,
  openRequestForm,
  registerApi,
  signIn,
  waitForValidations,
} from './flows';
import {
  gateway,
  gatewayFetch,
  gatewayToken,
  issueCertificate,
  untilCertificateKnown,
} from './gateway-flows';
import { enrollOneTimeCode, expectNoAccessibilityViolations } from './helpers';
import { mockNodeLogs, startMockNode, stopMockNode } from './mock-node';
import { newPerson, registerAccount } from './onboarding';

// Closing of M4 (bootcamp simulation): a new entity enrolls a node, publishes an instant API and
// another entity consumes it in sandbox the same day. Also the e2e of sandbox mode (M4-08): the
// sandbox request is approved at once and only reaches the sandbox.
test.describe('bootcamp simulation (M4 closing, M4-08)', () => {
  test('new entity, node, instant API, consumed in sandbox the same day', async ({ browser }) => {
    test.setTimeout(600_000);
    const id = Date.now().toString(36);
    const slug = `bootcamp-${id}`;
    const admin = newPerson('bootcamp', id);
    const adminName = `${admin.firstName} ${admin.lastName}`;

    // 1. The operator registers the entity at the bootcamp, with its admin.
    const operator = await (await browser.newContext()).newPage();
    await signIn(operator, 'pablo.plataforma', '/operator/entities/new');
    await operator.getByLabel('Nombre legal').fill(`Instituto Bootcamp ${id}`);
    await operator.getByLabel('Nombre corto').fill(`Bootcamp ${id}`);
    await operator.locator('[name="slug"]').fill(slug);
    await operator.getByLabel('Número de identificación').fill(`902${id}`);
    await operator
      .getByLabel('Correo de contacto de la entidad')
      .fill(`contacto.${id}@example.org`);
    await operator.locator('[name="dpoName"]').fill('Dora Protección');
    await operator.locator('[name="dpoEmail"]').fill(`dpo.${id}@example.org`);
    for (const role of ['data_steward', 'technical_lead']) {
      await operator.locator(`[name="designees.${role}.fullName"]`).fill(`Persona ${role}`);
      await operator.locator(`[name="designees.${role}.email"]`).fill(`${role}.${id}@example.org`);
    }
    await operator.locator('[name="admin.fullName"]').fill(adminName);
    await operator.locator('[name="admin.email"]').fill(admin.email);
    await operator
      .getByLabel(/^Acto o decisión que fundamenta el alta/)
      .fill('Acta del bootcamp de integración, 2026.');
    await operator.getByRole('button', { name: 'Registrar entidad' }).click();
    await operator.waitForURL(/\/operator\/entities$/, { timeout: 30_000 });

    // 2. The admin creates an account, accepts and takes the publisher role too.
    const page = await (await browser.newContext()).newPage();
    await registerAccount(page, admin);
    await page.goto('/invitations');
    await page.getByRole('button', { name: /^Aceptar la invitación/ }).click();
    await page.waitForURL((url) => !url.pathname.includes('/invitations'));
    // entity_admin needs a second factor (ADR-0035): a new account sets one up in Keycloak.
    await enrollOneTimeCode(page, admin.password);
    await page.goto('/my-entity');
    await page.getByText(`Gestionar a ${adminName}`).click();
    await page
      .getByRole('group', { name: `Roles de ${adminName}` })
      .getByLabel('Publicación de APIs')
      .check();
    await page.getByRole('button', { name: 'Guardar roles' }).click();
    await expect(page.getByRole('row', { name: new RegExp(admin.email) })).toContainText(
      'Publicación de APIs',
    );

    // 3. The node of the kit: token, installation (simulated), tunnel and heartbeat.
    const nodeName = `nodo-${id}`;
    await page.goto('/my-entity/nodes');
    await page.getByLabel('Nombre del nodo').fill(nodeName);
    await page.getByRole('button', { name: 'Registrar y emitir token' }).click();
    startMockNode((await page.getByTestId('enrollment-token').textContent()) ?? '');
    const nodeRow = page.getByTestId('node-list').getByRole('row', { name: new RegExp(nodeName) });
    try {
      await expect(async () => {
        await page.reload();
        await expect(nodeRow).toContainText('En línea', { timeout: 2_000 });
      }).toPass({ timeout: 120_000, intervals: [3_000] });
    } catch (error) {
      console.error(mockNodeLogs());
      throw error;
    }

    // 4. The instant API on the node, with its sandbox on the node too, sent to review.
    const apiSlug = `afiliacion-${id}`;
    const apiName = `Afiliación instantánea ${id}`;
    await page.goto('/my-apis');
    await registerApi(page, apiSlug, apiName);
    await page.getByRole('link', { name: 'Nueva versión' }).click();
    await page.getByLabel(/^Versión/).fill('1.0');
    await page.getByLabel('Archivo OpenAPI (YAML o JSON)').setInputFiles(openapiFile);
    const nodeOption = async (label: string) => {
      const select = page.getByLabel(label, { exact: true });
      const value = await select.locator('option', { hasText: nodeName }).getAttribute('value');
      await select.selectOption(value ?? '');
    };
    await nodeOption('Nodo del kit');
    await page.getByLabel('Ruta del servicio en el nodo').fill('/salud');
    await page.getByLabel('En un nodo').check();
    await nodeOption('Nodo del sandbox');
    await page.getByLabel(/^Ruta del servicio de pruebas/).fill('/salud');
    await page.getByLabel('Verificación de requisitos de un trámite').check();
    await page.getByLabel('Nombre del dato').fill('regimen');
    await page.getByRole('button', { name: 'Crear versión' }).click();
    await page.getByRole('button', { name: 'Enviar a revisión' }).click();
    await expect(page.getByTestId('version-status')).toHaveText('En revisión');
    const versionId = page.url().split('/versions/')[1]?.split(/[?#]/)[0] ?? '';

    // 5. The operator reviews: the validations (healthcheck through the hub, contract test on
    // the sandbox) passed; approved and published.
    const reviewer = await (await browser.newContext()).newPage();
    await signIn(reviewer, 'ana.operadora', `/operator/reviews/${versionId}`);
    await waitForValidations(reviewer);
    await reviewer.getByRole('button', { name: 'Aprobar' }).click();
    await expect(reviewer.getByTestId('version-status')).toHaveText('Publicada');

    // 6. Another entity consumes it in sandbox: approved at once, active within seconds.
    const consumer = await (await browser.newContext()).newPage();
    await signIn(consumer, 'carlos.dev', '/my-apps/new');
    const appName = `Sandbox bootcamp ${id}`;
    await consumer.getByLabel(/^Nombre de la aplicación/).fill(appName);
    await consumer.getByLabel(/^Para qué la usará/).fill('Probar la integración en el sandbox.');
    await consumer.getByLabel(/^Entorno/).selectOption('sandbox');
    await consumer
      .getByLabel(/^Correo del contacto técnico/)
      .fill('dev@programas.demo.den.example');
    await consumer.getByRole('button', { name: 'Crear aplicación' }).click();
    const clientId = (await consumer.getByTestId('client-id').textContent()) ?? '';
    const clientSecret = (await consumer.getByTestId('client-secret').textContent()) ?? '';
    await consumer.getByRole('link', { name: 'Ir a la aplicación' }).click();
    await issueCertificate(consumer, clientId);
    await expect(consumer.getByTestId('provisioning')).toHaveText('Lista', { timeout: 60_000 });

    // The catalogue shows the sandbox URL of the version.
    await openCatalogApi(consumer, apiName);
    await expect(consumer.getByTestId('catalog-sandbox')).toContainText(`/sandbox/${slug}/`);
    await openRequestForm(consumer, apiName);
    await consumer.getByLabel(/^Aplicación que hará las llamadas/).selectOption({ label: appName });
    await consumer.getByLabel(/^Finalidad/).selectOption('eligibility_check');
    await consumer.getByLabel(/^Para qué usarás los datos/).fill('Probar la integración.');
    await consumer.getByLabel(/^Base legal/).fill('Pruebas con datos sintéticos del sandbox.');
    await consumer.getByLabel(/^Vigencia en meses/).fill('3');
    await consumer.getByRole('button', { name: 'Enviar solicitud' }).click();
    await expect(consumer.getByTestId('subscription-status')).toHaveText(/Aprobada|Activa/);
    await expectNoAccessibilityViolations(consumer);
    await expect(async () => {
      await consumer.reload();
      await expect(consumer.getByTestId('subscription-status')).toHaveText('Activa', {
        timeout: 2_000,
      });
    }).toPass({ timeout: 90_000, intervals: [3_000] });

    // 7. The call: the sandbox URL, mTLS and a bound token; it goes through the node's tunnel.
    const sandboxUrl = `${gateway}/sandbox/${slug}/${apiSlug}/v1/afiliados/1000000001`;
    const token = await gatewayToken(clientId, clientSecret);
    await untilCertificateKnown(sandboxUrl, token);
    const requestId = randomUUID();
    const res = await gatewayFetch(sandboxUrl, {
      headers: {
        authorization: `Bearer ${token}`,
        'x-den-purpose': 'eligibility_check',
        'x-den-end-user': 'funcionario-bootcamp',
        'x-request-id': requestId,
      },
    });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(mockNodeLogs()).toContain(`forwarding GET request ${requestId}`);

    // The sandbox application never reaches the real service.
    const real = await gatewayFetch(sandboxUrl.replace('/sandbox/', '/'), {
      headers: {
        authorization: `Bearer ${token}`,
        'x-den-purpose': 'eligibility_check',
        'x-den-end-user': 'funcionario-bootcamp',
      },
    });
    expect(real.status).toBe(403);
    expect(real.headers.get('x-den-deny-reason')).toBe('environment_mismatch');
    stopMockNode();
  });
});
