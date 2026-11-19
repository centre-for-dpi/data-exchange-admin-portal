import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import { newVersion, openapiFile, registerApi, signIn } from './flows';
import { expectNoAccessibilityViolations } from './helpers';

/** SQL on the development database (the e2e stack's PostgreSQL container). */
function sql(statement: string): void {
  const result = spawnSync(
    'docker',
    ['exec', '-i', 'den-postgres-1', 'psql', '-U', 'den', '-d', 'den', '-v', 'ON_ERROR_STOP=1'],
    { input: statement, encoding: 'utf8' },
  );
  expect(result.status, result.stderr).toBe(0);
}

const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
/** What a node serving the salud mock's own file reports: the SHA-256 of its bytes. */
const FILE_SHA = sha(readFileSync(openapiFile));
const OTHER_SHA = sha('openapi: 3.1.0\ninfo: { title: otra, version: "2" }\npaths: {}\n');

/**
 * A draft registered by pedro on a kit node of salud that reports `reported` for /salud, then
 * published (as if reviewed) and seen at a heartbeat. The node is made up: it never connects.
 */
async function publishedOnNode(
  page: Page,
  reported: string,
  source: { file: string } | { text: string },
  check?: { status: 'matches' | 'differs'; hoursAgo: number },
) {
  const slug = `contrato-${Date.now().toString(36)}`;
  const name = `Afiliación por contrato ${slug}`;
  await signIn(page, 'pedro.publicador', '/my-apis');
  await registerApi(page, slug, name);
  await newVersion(page, { version: '1.0', ...source });
  await expect(page.getByTestId('version-status')).toHaveText('Borrador');
  const versionId = page.url().split('/versions/')[1]?.split(/[?#]/)[0] ?? '';
  const nodeId = randomUUID();
  const nodeName = `nodo-${slug}`;
  sql(`
    INSERT INTO node (id, entity_id, name, status, service_port, kit_version, services,
                      enrolled_at, last_heartbeat_at, created_by, updated_at)
    VALUES ('${nodeId}', (SELECT id FROM entity WHERE slug = 'salud'), '${nodeName}', 'online',
            8443, '1.0.0',
            '[{"name":"afiliacion","path":"/salud","openapiSha256":"${reported}"}]'::jsonb,
            now(), now(), 'e2e', now());
    UPDATE api_version SET status = 'published', published_at = now(),
      upstream = '{"type":"node","nodeId":"${nodeId}","servicePath":"/salud"}'::jsonb
    WHERE id = '${versionId}';
    ${
      check
        ? `INSERT INTO node_contract_check (api_version_id, node_id, status, service_name,
             expected_sha256, reported_sha256, since, updated_at)
           SELECT id, '${nodeId}', '${check.status}', 'afiliacion', openapi_sha256, '${reported}',
             now() - interval '${check.hoursAgo} hours', now()
           FROM api_version WHERE id = '${versionId}';`
        : ''
    }`);
  /** Out of the way of other specs: the version retired, the node decommissioned. */
  const cleanup = () =>
    sql(`
      UPDATE api_version SET status = 'retired', retired_at = now() WHERE id = '${versionId}';
      UPDATE node SET status = 'decommissioned', decommissioned_at = now() WHERE id = '${nodeId}';`);
  return { name, versionId, nodeName, cleanup };
}

// P-02: the portal compares the hash the node reports for the service with the published one,
// and shows it to the provider, the reviewer and the operator. It never blocks traffic.
test.describe('the contract a node serves (P-02)', () => {
  test('a pasted OpenAPI matches the file the node serves', async ({ page }) => {
    // The form sends a pasted document trimmed and with CRLF endings: still the same contract.
    const published = await publishedOnNode(page, FILE_SHA, {
      text: readFileSync(openapiFile, 'utf8'),
    });
    try {
      await page.reload();
      const contract = page.getByTestId('node-contract');
      await expect(contract).toContainText('Coincide con el publicado');
      await expect(contract).toContainText('El nodo sirve en /salud el mismo OpenAPI publicado.');
      await expectNoAccessibilityViolations(page);
    } finally {
      published.cleanup();
    }
  });

  test('a node serving another contract is flagged where the entity and the operator look', async ({
    browser,
  }) => {
    test.setTimeout(180_000);
    const page = await (await browser.newContext()).newPage();
    const published = await publishedOnNode(
      page,
      OTHER_SHA,
      { file: openapiFile },
      { status: 'differs', hoursAgo: 2 },
    );
    try {
      // The provider's version sheet: both hashes, since when, what to do.
      await page.reload();
      const sheet = page.getByTestId('node-contract');
      await expect(sheet).toContainText('Distinto del publicado');
      await expect(sheet).toContainText(FILE_SHA);
      await expect(sheet).toContainText(OTHER_SHA);
      await expect(sheet).toContainText('Distinto desde');
      await expect(sheet).toContainText('El tráfico sigue pasando con el contrato publicado');
      await expectNoAccessibilityViolations(page);
      await page.context().close();

      // The entity admin's node page.
      const admin = await (await browser.newContext()).newPage();
      await signIn(admin, 'elena.admin', '/my-entity/nodes');
      const row = admin
        .getByTestId('node-contracts')
        .getByRole('row')
        .filter({ hasText: published.name });
      await expect(row).toContainText(published.nodeName);
      await expect(row).toContainText('Distinto del publicado');
      await expect(row).toContainText(OTHER_SHA);
      await expectNoAccessibilityViolations(admin);
      await row.getByRole('link', { name: `${published.name} 1.0` }).click();
      await expect(admin.getByTestId('node-contract')).toContainText('Distinto del publicado');
      await admin.context().close();

      // The operator's sync console, and the sheet it links to.
      const operator = await (await browser.newContext()).newPage();
      await signIn(operator, 'pablo.plataforma', '/operator/sync');
      await expect(
        operator.getByRole('heading', { name: 'Nodos que no sirven el contrato publicado' }),
      ).toBeVisible();
      const flagged = operator
        .getByTestId('node-contracts')
        .getByRole('row')
        .filter({ hasText: published.name });
      await expect(flagged).toContainText(published.nodeName);
      await expect(flagged).toContainText('Distinto del publicado');
      await expectNoAccessibilityViolations(operator);
      await flagged.getByRole('link', { name: `${published.name} 1.0` }).click();
      await expect(operator.getByTestId('node-contract')).toContainText(OTHER_SHA);
      await expectNoAccessibilityViolations(operator);
      await operator.context().close();
    } finally {
      published.cleanup();
    }
  });
});
