import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { signIn } from './flows';
import { expectNoAccessibilityViolations } from './helpers';

// M4-01: the entity admin registers a node and gets its single-use enrollment token once; tokens
// are listed without the token and can be revoked; the operator sees every node of the network.
test.describe('nodes of the kit and enrollment tokens (M4-01)', () => {
  test('elena registers a node, re-issues and revokes its token', async ({ page }) => {
    const name = `servidor-${randomUUID().slice(0, 8)}`;
    await signIn(page, 'elena.admin', '/my-entity/nodes');
    await expect(page.getByRole('heading', { name: 'Nodos del kit' })).toBeVisible();
    await expectNoAccessibilityViolations(page);

    await page.getByLabel('Nombre del nodo').fill(name);
    await page.getByRole('button', { name: 'Registrar y emitir token' }).click();
    await expect(
      page.getByRole('heading', { name: `Token de enrolamiento de ${name}` }),
    ).toBeFocused();
    const token = (await page.getByTestId('enrollment-token').textContent()) ?? '';
    expect(token).toMatch(/^rid-enroll-[A-Za-z0-9_-]{43}$/);
    await expectNoAccessibilityViolations(page);

    const row = page.getByRole('row', { name: new RegExp(name) });
    await expect(row).toContainText('Esperando enrolamiento');
    await expect(row).toContainText('Vigente');

    // A new token replaces the old one, shown once as well.
    await row.getByRole('button', { name: `Emitir token nuevo para ${name}` }).click();
    const fresh = row.getByTestId('enrollment-token');
    await expect(fresh).toBeVisible();
    await expect(fresh).not.toHaveText(token);

    // Revoked: the node waits for a new token. The page never shows a token again.
    await row.getByRole('button', { name: `Anular token de ${name}` }).click();
    await expect(row).toContainText('Anulado');
    await page.reload();
    await expect(page.getByTestId('enrollment-token')).toHaveCount(0);
    await expect(page.getByText(token)).toHaveCount(0);
  });

  test('a publisher sees the nodes but cannot issue tokens', async ({ page }) => {
    await signIn(page, 'pedro.publicador', '/my-entity/nodes');
    await expect(page.getByRole('heading', { name: 'Nodos del kit' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Registrar y emitir token' })).toHaveCount(0);
  });

  test('the operator sees every node of the network', async ({ page }) => {
    await signIn(page, 'pablo.plataforma', '/operator/nodes');
    await expect(page.getByRole('heading', { name: 'Nodos de la red' })).toBeVisible();
    await expectNoAccessibilityViolations(page);
  });
});
