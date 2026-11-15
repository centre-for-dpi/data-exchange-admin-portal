import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { makeCsr } from './csr';
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

  test('a node enrolls with its token (M4-02) and elena decommissions it', async ({ page }) => {
    const name = `servidor-${randomUUID().slice(0, 8)}`;
    await signIn(page, 'elena.admin', '/my-entity/nodes');
    await page.getByLabel('Nombre del nodo').fill(name);
    await page.getByRole('button', { name: 'Registrar y emitir token' }).click();
    const token = (await page.getByTestId('enrollment-token').textContent()) ?? '';

    // The kit enrolls through the contract (ARCHITECTURE.md §10) with the token.
    const { x } = generateKeyPairSync('x25519').publicKey.export({ format: 'jwk' });
    const res = await fetch(
      `${process.env.RID_API_URL ?? 'http://localhost:4000'}/api/v1/nodes/enroll`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          token,
          csr: (await makeCsr('rid-node')).csr,
          wireguardPublicKey: Buffer.from(x ?? '', 'base64url').toString('base64'),
          kitVersion: '1.0.0',
        }),
      },
    );
    expect(res.status, await res.clone().text()).toBe(201);

    await page.reload();
    const row = page.getByRole('row', { name: new RegExp(name) });
    await expect(row).toContainText('Enrolado');
    await expect(row).toContainText('1.0.0');
    await expect(row).toContainText('Usado');
    await expectNoAccessibilityViolations(page);

    page.once('dialog', (dialog) => void dialog.accept());
    await row.getByRole('button', { name: `Dar de baja ${name}` }).click();
    await expect(row).toContainText('Dado de baja');
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
