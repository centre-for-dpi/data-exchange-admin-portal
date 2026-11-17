import { randomUUID } from 'node:crypto';
import { expect, type Page } from '@playwright/test';
import { openCatalogApi } from './flows';

/** Access-log helpers of the usage and indicator e2e (M5): the store is OpenSearch on the host. */
const OPENSEARCH = process.env.DEN_OPENSEARCH_URL ?? 'http://localhost:9200';

/** The API and version ids of a published API, from its service-sheet link in the catalogue. */
export async function publishedIds(page: Page, name: string) {
  await openCatalogApi(page, name);
  const href =
    (await page.getByRole('link', { name: /^Ficha del servicio 1\.0/ }).getAttribute('href')) ?? '';
  const [, apiId = '', versionId = ''] = /\/catalog\/([^/]+)\/sheet\/([^/?#]+)/.exec(href) ?? [];
  return { apiId, versionId };
}

/** Access-log documents as Fluent Bit leaves them, into an index of the test's own. */
export async function indexAccessLogs(index: string, docs: Array<Record<string, unknown>>) {
  const body =
    docs
      .flatMap((d) => [
        JSON.stringify({ index: { _index: index } }),
        JSON.stringify({ request_id: randomUUID(), method: 'GET', gateway_node: 'e2e', ...d }),
      ])
      .join('\n') + '\n';
  const res = await fetch(`${OPENSEARCH}/_bulk?refresh=true`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-ndjson' },
    body,
  });
  expect(((await res.json()) as { errors: boolean }).errors).toBe(false);
}

export const dropIndex = (index: string) => fetch(`${OPENSEARCH}/${index}`, { method: 'DELETE' });
