import { expect, type Page, test } from '@playwright/test';
import { expectNoAccessibilityViolations, keycloakLogin } from './helpers';

// M1-02: roles come from the portal API (PostgreSQL), not from Keycloak, and shape the navigation.
test.describe('session context and role navigation', () => {
  const nav = (page: Page) => page.getByRole('navigation', { name: 'Navegación principal' });

  const signIn = async (page: Page, username: string, path = '/') => {
    await page.goto(path);
    await page.getByRole('button', { name: 'Iniciar sesión' }).first().click();
    await keycloakLogin(page, username);
  };

  test('an app developer sees the consumer sections of their entity', async ({ page }) => {
    await signIn(page, 'carlos.dev');
    await expect(page.getByText('Entidad: Programas Sociales (ficticia)')).toBeVisible();
    await expect(nav(page).getByRole('link', { name: 'Mis aplicaciones' })).toBeVisible();
    await expect(nav(page).getByRole('link', { name: 'Mi entidad' })).toBeVisible();
    await expect(nav(page).getByRole('link', { name: 'Mis APIs' })).toHaveCount(0);
    await expect(nav(page).getByRole('link', { name: 'Consola del operador' })).toHaveCount(0);
  });

  test('the operator reviewer sees the operator console and no entity', async ({ page }) => {
    await signIn(page, 'ana.operadora');
    await expect(nav(page).getByRole('link', { name: 'Consola del operador' })).toBeVisible();
    await expect(nav(page).getByRole('link', { name: 'Mis aplicaciones' })).toHaveCount(0);
    await expect(page.getByLabel('Entidad activa')).toHaveCount(0);
  });

  test('a member of two entities switches the active entity', async ({ page }) => {
    await signIn(page, 'pedro.publicador', '/catalog');
    const selector = page.getByLabel('Entidad activa');
    await expect(selector.locator('option')).toHaveText([
      'Salud (ficticia)',
      'Registro Socioeconómico (ficticia)',
    ]);
    await expect(nav(page).getByRole('link', { name: 'Mis APIs' })).toBeVisible();
    await expectNoAccessibilityViolations(page);

    await page.goto('/catalog');
    await selector.selectOption({ label: 'Registro Socioeconómico (ficticia)' });
    // Wait for the server action that stores the choice before navigating away.
    await Promise.all([
      page.waitForResponse((r) => r.request().method() === 'POST' && r.url().includes('/catalog')),
      page.getByRole('button', { name: 'Cambiar' }).click(),
    ]);
    await expect(page).toHaveURL(/\/catalog$/);

    // A full page load renders the remembered choice from the server.
    await page.goto('/');
    await expect(page.getByLabel('Entidad activa').locator('option:checked')).toHaveText(
      'Registro Socioeconómico (ficticia)',
    );
  });
});
