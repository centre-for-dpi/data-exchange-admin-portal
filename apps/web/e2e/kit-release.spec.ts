import { createHash, randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { expect, type Page, test } from '@playwright/test';
import { signIn } from './flows';
import { expectNoAccessibilityViolations } from './helpers';

// P-03: the operator sets the kit's current version and mirrors its bundle; every member of an
// entity sees it next to "Register a node", and anyone on the public site, with the commands to
// download, check and install it with this portal's URL.
const portal = (process.env.DEN_WEB_URL ?? 'http://localhost:3000').replace(/\/+$/, '');

const apiBase = (process.env.DEN_API_URL ?? 'http://localhost:4000').replace(/\/+$/, '');

async function currentVersion(page: Page): Promise<string> {
  const res = await page.request.get(`${apiBase}/api/v1/kit/current`);
  const body = (await res.json()) as { release: { version: string } | null };
  return body.release?.version ?? '';
}

test.describe('the node kit from the portal (P-03)', () => {
  test('anyone sees the current version, its checksum and the commands', async ({ page }) => {
    await page.goto('/kit');
    await expect(page.getByRole('heading', { level: 1, name: 'El kit del nodo' })).toBeVisible();
    const panel = page.getByTestId('kit-release');
    await expect(panel.getByTestId('kit-sha256')).toHaveText(/^[0-9a-f]{64}$/);
    await expect(panel.getByTestId('kit-checksum-notice')).toContainText(
      'quien controla el portal controla tanto el archivo como su suma',
    );
    const commands = (await panel.getByTestId('kit-commands-release').textContent()) ?? '';
    expect(commands).toContain('sha256sum -c -');
    expect(commands).toContain('sudo DEN_LANG=es ./install.sh');
    await expect(panel.getByTestId('kit-portal-url')).toHaveText(portal);
    await expectNoAccessibilityViolations(page);

    await page.goto('/en/kit');
    await expect(page.getByRole('heading', { level: 1, name: 'The node kit' })).toBeVisible();
    await expect(page.getByTestId('kit-commands-release')).toContainText('sudo ./install.sh');
    await expectNoAccessibilityViolations(page);

    // The footer links it on every page.
    await page.goto('/');
    await page.getByRole('contentinfo').getByRole('link', { name: 'El kit del nodo' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'El kit del nodo' })).toBeVisible();
  });

  test('every member of the entity sees it next to "Register a node"', async ({ browser }) => {
    for (const user of ['elena.admin', 'pedro.publicador']) {
      const page = await (await browser.newContext()).newPage();
      await signIn(page, user, '/my-entity/nodes');
      await expect(page.getByRole('heading', { name: 'Kit para instalar' })).toBeVisible();
      await expect(page.getByTestId('kit-commands-release')).toContainText('curl -fLO https://');
      await expect(page.getByTestId('kit-portal-url')).toHaveText(portal);
      await page.context().close();
    }
  });

  test('pablo sets a version, mirrors its bundle, and makes the previous one current again', async ({
    browser,
  }) => {
    test.setTimeout(240_000);
    const operator = await (await browser.newContext()).newPage();
    const previous = await currentVersion(operator);
    const stamp = Date.now().toString(36);
    const version = `0.0.1-e2e.${stamp}`;
    const fileName = `den-node-kit-${version}.tar.gz`;
    // Larger than the server actions' and the proxy's body limits (11 MB): the upload streams.
    const bytes = gzipSync(randomBytes(12 * 1024 * 1024));
    const sha256 = createHash('sha256').update(bytes).digest('hex');

    await signIn(operator, 'pablo.plataforma', '/operator/kit');
    await expect(operator.getByRole('heading', { level: 1, name: 'Kit del nodo' })).toBeVisible();
    const form = operator.getByRole('form', { name: 'Definir la versión vigente del kit' });
    await form.getByLabel(/^Versión/).fill(version);
    await form
      .getByLabel(/^Enlace al paquete/)
      .fill(`https://github.com/example/kit/releases/download/v${version}/${fileName}`);
    await form.getByLabel(/^Tamaño en bytes/).fill(String(bytes.length));
    await form.getByLabel(/^SHA-256/).fill('no-es-un-hash');
    await form.getByRole('button', { name: 'Hacerla la versión vigente' }).click();
    await expect(form.getByText('64 caracteres hexadecimales (un SHA-256).')).toBeVisible();
    await form.getByLabel(/^SHA-256/).fill(sha256);
    await form.getByRole('button', { name: 'Hacerla la versión vigente' }).click();
    await expect(operator.getByTestId('kit-version')).toHaveText(version);
    await expectNoAccessibilityViolations(operator);

    // Mirror: a file that is not the release is refused; the release's bytes are accepted.
    const upload = operator.getByRole('form', {
      name: `Servir el paquete de ${version} desde el portal`,
    });
    await upload.getByLabel(/^Paquete de/).setInputFiles({
      name: fileName,
      mimeType: 'application/gzip',
      buffer: gzipSync(randomBytes(2048)),
    });
    await upload.getByRole('button', { name: 'Subir al espejo' }).click();
    await expect(upload.getByRole('alert')).toBeVisible();
    await upload.getByLabel(/^Paquete de/).setInputFiles({
      name: fileName,
      mimeType: 'application/gzip',
      buffer: bytes,
    });
    await upload.getByRole('button', { name: 'Subir al espejo' }).click();
    await expect(
      operator.getByTestId('kit-releases').getByRole('row', { name: version }),
    ).toContainText('En el espejo desde');
    await expect(operator.getByTestId('kit-commands-portal')).toContainText(
      `curl -fLO ${portal}/kit/${version}/${fileName}`,
    );

    // The mirror, anonymously: the bytes, as a gzip download cached for good.
    const download = await operator.request.get(`/kit/${version}/${fileName}`);
    expect(download.status()).toBe(200);
    expect(download.headers()['content-type']).toBe('application/gzip');
    expect(download.headers()['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(download.headers()['x-content-type-options']).toBe('nosniff');
    expect(download.headers()['content-disposition']).toBe(`attachment; filename="${fileName}"`);
    expect(Buffer.from(await download.body()).equals(bytes)).toBe(true);
    const checksum = await operator.request.get(`/kit/${version}/${fileName}.sha256`);
    expect(await checksum.text()).toBe(`${sha256}  ${fileName}\n`);
    expect((await operator.request.get(`/kit/${version}/otro.tar.gz`)).status()).toBe(404);

    // An entity member sees the new version with both links.
    const member = await (await browser.newContext()).newPage();
    await signIn(member, 'elena.admin', '/my-entity/nodes');
    await expect(member.getByTestId('kit-version')).toHaveText(version);
    await expect(member.getByTestId('kit-mirror-link')).toHaveAttribute(
      'href',
      `${portal}/kit/${version}/${fileName}`,
    );

    // The reviewer reads the console without its forms; the regulator does not see it.
    const reviewer = await (await browser.newContext()).newPage();
    await signIn(reviewer, 'ana.operadora', '/operator/kit');
    await expect(reviewer.getByTestId('kit-releases')).toContainText(version);
    await expect(
      reviewer.getByRole('form', { name: 'Definir la versión vigente del kit' }),
    ).toHaveCount(0);
    const regulator = await (await browser.newContext()).newPage();
    await signIn(regulator, 'marta.regulador', '/operator/kit');
    await expect(regulator.getByTestId('kit-releases')).toHaveCount(0);

    // Back to what was current before, as a rollback would.
    if (previous) {
      await operator.getByRole('button', { name: `Hacer vigente la versión ${previous}` }).click();
      await expect(operator.getByTestId('kit-version')).toHaveText(previous);
    }
  });
});
