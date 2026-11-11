import { expect, test } from '@playwright/test';
import { country, expectNoAccessibilityViolations } from './helpers';

test.describe('home page (anonymous)', () => {
  test('renders in Spanish with the country branding and passes axe', async ({ page }) => {
    const config = country();
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('lang', 'es');
    await expect(page).toHaveTitle(config.branding.productName);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(config.branding.productName);
    await expect(page.getByRole('contentinfo')).toContainText(config.authorities.operator.name);
    await expect(page.getByRole('contentinfo')).toContainText(config.authorities.regulator.name);
    await expect(page.getByRole('button', { name: 'Iniciar sesión' }).first()).toBeVisible();

    // Anonymous users only see the home entry unless the public catalogue is enabled.
    const nav = page.getByRole('navigation', { name: 'Navegación principal' });
    await expect(nav.getByRole('link')).toHaveCount(config.features.publicCatalog ? 2 : 1);

    await expectNoAccessibilityViolations(page);
  });

  test('switches to English and keeps the current page', async ({ page }) => {
    await page.goto('/catalog');
    await page
      .getByRole('navigation', { name: 'Idioma' })
      .getByRole('link', { name: 'English' })
      .click();
    await expect(page).toHaveURL(/\/en\/catalog$/);
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Catalogue');
    await expectNoAccessibilityViolations(page);
  });

  test('offers a skip link that moves focus to the main content', async ({ page }) => {
    await page.goto('/');
    await page.keyboard.press('Tab');
    const skip = page.getByRole('link', { name: 'Saltar al contenido principal' });
    await expect(skip).toBeFocused();
    await expect(skip).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(page.locator('#main-content')).toBeFocused();
  });

  test('serves the configured logo', async ({ request }) => {
    const res = await request.get('/branding/logo');
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toMatch(/^image\//);
  });
});
