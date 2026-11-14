import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { parse } from 'yaml';
import { openapiFile, signIn, submitNewApi } from './flows';
import { gateway } from './gateway-flows';
import { expectNoAccessibilityViolations } from './helpers';

// M2-05 (ADR-0019): a published version gets a compatible revision (1.0 -> 1.1, same route),
// an incompatible one is refused, and deprecation is announced by the gateway.
const versionIdOf = (url: string) => url.split('/versions/')[1]?.split(/[?#]/)[0] ?? '';

const documentWith = (edit: (doc: { paths: Record<string, unknown> }) => void) => {
  const doc = parse(readFileSync(openapiFile, 'utf8')) as {
    paths: Record<string, Record<string, Record<string, unknown>>>;
  };
  edit(doc);
  return JSON.stringify(doc, null, 2);
};

test.describe('API version lifecycle (M2-05)', () => {
  test('pedro revises a published version, is stopped on a breaking change and deprecates it', async ({
    browser,
  }) => {
    test.setTimeout(240_000);
    const stamp = Date.now().toString(36);
    const name = `Afiliación ciclo ${stamp}`;
    const slug = `ciclo-${stamp}`;
    const publisher = await (await browser.newContext()).newPage();
    const { versionUrl } = await submitNewApi(publisher, { name, slug });
    const operator = await (await browser.newContext()).newPage();
    await signIn(operator, 'ana.operadora', `/operator/reviews/${versionIdOf(versionUrl)}`);
    await operator.getByRole('button', { name: 'Aprobar' }).click();
    await expect(operator.getByTestId('version-status')).toHaveText('Publicada');

    // A compatible revision: one more optional operation.
    await publisher.goto(versionUrl);
    await expect(
      publisher.getByRole('heading', { name: 'Revisar el documento (cambio compatible)' }),
    ).toBeVisible();
    await expectNoAccessibilityViolations(publisher);
    const compatible = documentWith((doc) => {
      const source = doc.paths['/afiliados/{numeroIdentificacion}'] as Record<
        string,
        Record<string, unknown>
      >;
      doc.paths['/afiliados/{numeroIdentificacion}/historial'] = {
        get: { ...structuredClone(source.get), operationId: 'getHistorialAfiliado' },
      };
    });
    await publisher.getByLabel('O pega el documento OpenAPI').fill(compatible);
    await publisher.getByRole('button', { name: 'Publicar revisión' }).click();
    await expect(publisher.getByRole('heading', { level: 1 })).toContainText('1.1');
    await expect(publisher.getByRole('heading', { name: 'Historial de revisiones' })).toBeVisible();
    expect(publisher.url()).toBe(versionUrl);

    // An incompatible change is refused and explained.
    const breaking = documentWith((doc) => {
      delete doc.paths['/afiliados/verificaciones'];
    });
    await publisher.getByLabel('O pega el documento OpenAPI').fill(breaking);
    await publisher.getByRole('button', { name: 'Publicar revisión' }).click();
    await expect(publisher.getByText(/needs a new major version/).first()).toBeVisible();
    await expect(publisher.getByRole('heading', { level: 1 })).toContainText('1.1');

    // Deprecation with the earliest date the notice allows.
    await publisher.getByRole('button', { name: 'Marcar como obsoleta' }).click();
    await expect(publisher.getByText(/Versión obsoleta: se retira el/)).toBeVisible();
    await expectNoAccessibilityViolations(publisher);

    // The gateway announces it on every response (the reconciler applies it within seconds).
    await expect
      .poll(
        async () => {
          const res = await fetch(`${gateway}/salud/${slug}/v1/afiliados/1000000001`);
          return [res.headers.get('deprecation') ?? '', res.headers.get('sunset') ?? ''];
        },
        { timeout: 60_000, intervals: [2_000] },
      )
      .toEqual([expect.stringMatching(/^@\d+$/), expect.stringMatching(/GMT$/)]);
  });
});
