import { randomUUID } from 'node:crypto';
import { expect, type Page, test } from '@playwright/test';
import { openCatalogApi, signIn } from './flows';
import {
  activeAffiliationSubscription,
  gateway,
  gatewayFetch,
  gatewayToken,
  probeGateway,
  untilCertificateKnown,
} from './gateway-flows';
import { expectNoAccessibilityViolations } from './helpers';
import { mockNodeLogs, startMockNode, stopMockNode } from './mock-node';

/** elena registers a node and the simulated kit node enrolls with its token (M4-01..M4-03). */
export async function enrolledMockNode(page: Page): Promise<string> {
  const name = `nodo-${randomUUID().slice(0, 8)}`;
  await signIn(page, 'elena.admin', '/my-entity/nodes');
  await page.getByLabel('Nombre del nodo').fill(name);
  await page.getByRole('button', { name: 'Registrar y emitir token' }).click();
  const token = (await page.getByTestId('enrollment-token').textContent()) ?? '';
  startMockNode(token);
  const row = page.getByRole('row', { name: new RegExp(name) });
  try {
    await expect(async () => {
      await page.reload();
      await expect(row).toContainText('En línea', { timeout: 2_000 });
    }).toPass({ timeout: 120_000, intervals: [3_000] });
  } catch (error) {
    console.error(mockNodeLogs());
    throw error;
  }
  return name;
}

// M4-04: a version on an enrolled node is served through the hub and the node's tunnel; the API
// shows the node's state; a decommissioned node is never called again.
test.describe('upstream on a kit node (M4-04)', () => {
  test('a call through the gateway reaches the service on the node, through its tunnel', async ({
    browser,
    page,
  }) => {
    test.setTimeout(360_000);
    const admin = await (await browser.newContext()).newPage();
    const node = await enrolledMockNode(admin);

    const slug = `nodo-${Date.now().toString(36)}`;
    const { apiName, clientId, clientSecret } = await activeAffiliationSubscription(
      browser,
      page,
      slug,
      { node },
    );
    const url = `${gateway}/salud/${slug}/v1/afiliados/1000000001`;
    const token = await gatewayToken(clientId, clientSecret);
    await untilCertificateKnown(url, token);

    const requestId = randomUUID();
    const res = await gatewayFetch(url, {
      headers: {
        authorization: `Bearer ${token}`,
        'x-rid-purpose': 'eligibility_check',
        'x-rid-end-user': 'funcionario-e2e',
        'x-request-id': requestId,
      },
    });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toMatchObject({ numeroIdentificacion: '1000000001' });
    // The node forwarded it: the call went through the hub and the node's tunnel.
    expect(mockNodeLogs()).toContain(`forwarding GET request ${requestId}`);

    // The catalogue shows the state of the provider's node.
    await openCatalogApi(page, apiName);
    await expect(page.getByTestId('catalog-node')).toContainText('En línea');
    await expectNoAccessibilityViolations(page);

    // Decommissioned, the node is never called again: its route goes (fail closed).
    await admin.goto('/my-entity/nodes');
    admin.once('dialog', (dialog) => void dialog.accept());
    await admin.getByRole('button', { name: `Dar de baja ${node}` }).click();
    await expect(admin.getByRole('row', { name: new RegExp(node) })).toContainText('Dado de baja');
    await expect
      .poll(async () => (await probeGateway(url)).status, { timeout: 30_000, intervals: [1_000] })
      .toBe(404);
    stopMockNode();
  });
});
