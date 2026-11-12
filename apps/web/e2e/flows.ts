import { resolve } from 'node:path';
import { type Browser, expect, type Page } from '@playwright/test';
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
export async function registerApi(page: Page, slug: string, name = 'Consulta de afiliación') {
  await page.getByRole('link', { name: 'Registrar API' }).click();
  await page.getByLabel(/^Nombre/).fill(name);
  await page.getByLabel('Identificador en la URL').fill(slug);
  await page.getByLabel('Resumen').fill('Consulta el estado de afiliación de una persona.');
  await page.getByLabel('Descripción (Markdown)').fill('API de prueba con datos sintéticos.');
  await page.getByLabel('Sector').selectOption({ label: 'Salud' });
  await page.getByLabel('Clasificación').selectOption({ label: 'Datos personales' });
  await page.getByLabel('Correo del responsable').fill('apis@salud.demo.rid.example');
  await page.getByRole('button', { name: 'Registrar API' }).click();
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
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
export async function submitNewApi(
  page: Page,
  options: { name?: string; slug?: string } = {},
): Promise<{ name: string; slug: string; versionUrl: string }> {
  const slug = options.slug ?? `afiliacion-${Date.now().toString(36)}`;
  const name = options.name ?? 'Consulta de afiliación';
  await signInAsPublisher(page);
  await registerApi(page, slug, name);
  await newVersion(page, { version: '1.0', file: openapiFile });
  await page.getByRole('button', { name: 'Enviar a revisión' }).click();
  await expect(page.getByTestId('version-status')).toHaveText('En revisión');
  return { name, slug, versionUrl: page.url() };
}

/** pedro submits a new API and ana approves it, in separate browser sessions. */
export async function publishNewApi(
  browser: Browser,
  options: { name?: string; slug?: string } = {},
): Promise<{ name: string; slug: string }> {
  const publisher = await (await browser.newContext()).newPage();
  const submitted = await submitNewApi(publisher, options);
  const versionId = submitted.versionUrl.split('/versions/')[1]?.split(/[?#]/)[0] ?? '';
  const operator = await (await browser.newContext()).newPage();
  await signIn(operator, 'ana.operadora', `/operator/reviews/${versionId}`);
  await operator.getByRole('button', { name: 'Aprobar' }).click();
  await expect(operator.getByTestId('version-status')).toHaveText('Publicada');
  await publisher.context().close();
  await operator.context().close();
  return { name: submitted.name, slug: submitted.slug };
}

/** carlos (signed in) creates an application in the UI and returns its client id (M1-06). */
export async function createApplication(page: Page, name: string): Promise<string> {
  await page.goto('/my-apps/new');
  await page.getByLabel(/^Nombre de la aplicación/).fill(name);
  await page.getByLabel(/^Para qué la usará/).fill('Verifica requisitos de subsidios.');
  await page.getByLabel(/^Entorno/).selectOption('production');
  await page.getByLabel(/^Correo del contacto técnico/).fill('dev@programas.demo.rid.example');
  await page.getByRole('button', { name: 'Crear aplicación' }).click();
  return (await page.getByTestId('client-id').textContent()) ?? '';
}

/** Opens the catalogue sheet of a published API by its (unique) name. */
export async function openCatalogApi(page: Page, name: string) {
  await page.goto('/catalog');
  await page.getByLabel('Buscar por nombre, resumen o etiqueta').fill(name);
  await page.getByRole('button', { name: 'Filtrar' }).click();
  await page.getByRole('link', { name }).click();
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
}
