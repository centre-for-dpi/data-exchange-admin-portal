import { resolve } from 'node:path';
import { expect, type Page } from '@playwright/test';
import { keycloakLogin } from './helpers';

/** Shared UI flows of the API lifecycle (M1-03, M1-04). */
export const openapiFile = resolve(
  import.meta.dirname,
  '../../../infra/mock-providers/salud/openapi.yaml',
);

export async function signIn(page: Page, username: string, path = '/') {
  // Start at the home page: protected pages answer 404 to anonymous users (no sign-in button).
  await page.goto('/');
  await page.getByRole('button', { name: 'Iniciar sesión' }).first().click();
  await keycloakLogin(page, username);
  await page.goto(path);
}

export const signInAsPublisher = (page: Page) => signIn(page, 'pedro.publicador', '/my-apis');
export async function registerApi(page: Page, slug: string) {
  await page.getByRole('link', { name: 'Registrar API' }).click();
  await page.getByLabel(/^Nombre/).fill('Consulta de afiliación');
  await page.getByLabel('Identificador en la URL').fill(slug);
  await page.getByLabel('Resumen').fill('Consulta el estado de afiliación de una persona.');
  await page.getByLabel('Descripción (Markdown)').fill('API de prueba con datos sintéticos.');
  await page.getByLabel('Sector').selectOption({ label: 'Salud' });
  await page.getByLabel('Clasificación').selectOption({ label: 'Datos personales' });
  await page.getByLabel('Correo del responsable').fill('apis@salud.demo.rid.example');
  await page.getByRole('button', { name: 'Registrar API' }).click();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Consulta de afiliación' }),
  ).toBeVisible();
}

export async function newVersion(
  page: Page,
  options: { version: string; file?: string; text?: string },
) {
  await page.getByRole('link', { name: 'Nueva versión' }).click();
  await page.getByLabel(/^Versión/).fill(options.version);
  if (options.file)
    await page.getByLabel('Archivo OpenAPI (YAML o JSON)').setInputFiles(options.file);
  if (options.text) await page.getByLabel('O pega el documento OpenAPI').fill(options.text);
  await page.getByLabel('Ruta del servicio en el nodo').fill('/salud');
  await page.getByLabel('Verificación de requisitos de un trámite').check();
  await page.getByLabel('Nombre del dato').fill('regimen');
  await page.getByRole('button', { name: 'Crear versión' }).click();
}

/** pedro registers an API and a version from the salud mock and sends it to review. */
export async function submitNewApi(page: Page): Promise<{ name: string; versionUrl: string }> {
  await signInAsPublisher(page);
  await registerApi(page, `afiliacion-${Date.now().toString(36)}`);
  await newVersion(page, { version: '1.0', file: openapiFile });
  await page.getByRole('button', { name: 'Enviar a revisión' }).click();
  await expect(page.getByTestId('version-status')).toHaveText('En revisión');
  return { name: 'Consulta de afiliación', versionUrl: page.url() };
}
