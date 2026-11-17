import { adminEntityListSchema, DOCUMENT_KINDS, documentPageSchema } from '@rid/contracts';
import type { Metadata } from 'next';
import { getFormatter, getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { PurgeDocumentForm } from '../../../../components/documents/purge-form';
import { StatusBadge } from '../../../../components/ui/badge';
import { Button } from '../../../../components/ui/button';
import { EmptyState, Page, PageHeader, Section } from '../../../../components/ui/page';
import { Link } from '../../../../i18n/navigation';
import { apiGet } from '../../../../lib/api';
import { getViewer } from '../../../../lib/viewer';

interface PageProps {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const selectClass =
  'mt-1.5 block w-full rounded-[var(--radius-control)] border border-border-control bg-background px-3.5 py-2.5 text-sm';

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'documentsAdmin' });
  return { title: t('title') };
}

/** Operator console: register of attached documents and deletion by legal order (M2-07). */
export default async function DocumentsAdminPage({ params, searchParams }: PageProps) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('documentsAdmin');
  const format = await getFormatter();
  const viewer = await getViewer();
  if (!viewer.platformRoles.includes('platform_admin')) notFound();

  const query = await searchParams;
  const text = (key: string) => (typeof query[key] === 'string' ? query[key].trim() : '');
  // Filters kept in the URL (a plain GET form), validated before they reach the API.
  const filters = new URLSearchParams();
  if (UUID.test(text('owner'))) filters.set('ownerEntityId', text('owner'));
  const kind = (DOCUMENT_KINDS as readonly string[]).includes(text('kind')) ? text('kind') : '';
  if (kind) filters.set('kind', kind);
  const purged = ['true', 'false'].includes(text('purged')) ? text('purged') : '';
  if (purged) filters.set('purged', purged);
  const shown = new URLSearchParams();
  if (filters.get('ownerEntityId')) shown.set('owner', text('owner'));
  if (kind) shown.set('kind', kind);
  if (purged) shown.set('purged', purged);
  // The owner list narrowed by a search (M6-11): the first 500 by name otherwise.
  const ownerq = text('ownerq').slice(0, 100);
  if (ownerq) shown.set('ownerq', ownerq);
  const kept = shown.toString();
  if (UUID.test(text('cursor'))) filters.set('cursor', text('cursor'));

  const [entities, documents] = await Promise.all([
    apiGet(
      `/admin/entities?limit=500${ownerq ? `&q=${encodeURIComponent(ownerq)}` : ''}`,
      adminEntityListSchema,
    ),
    apiGet(`/documents?limit=50&${filters.toString()}`, documentPageSchema),
  ]);

  return (
    <Page>
      <PageHeader title={t('title')} description={t('lead')} />

      <Section title={t('filters.title')}>
        <form
          method="get"
          className="card grid gap-4 p-6 md:grid-cols-3"
          aria-label={t('filters.title')}
        >
          <label className="block text-sm font-medium text-foreground-strong">
            {t('filters.ownerSearch')}
            <input
              type="search"
              name="ownerq"
              defaultValue={ownerq}
              maxLength={100}
              className={selectClass}
            />
            {entities.nextCursor ? (
              <span className="mt-1 block text-xs font-normal text-muted-foreground">
                {t('filters.ownerTruncated', { count: entities.items.length })}
              </span>
            ) : null}
          </label>
          <label className="block text-sm font-medium text-foreground-strong">
            {t('filters.owner')}
            <select name="owner" defaultValue={shown.get('owner') ?? ''} className={selectClass}>
              <option value="">{t('filters.any')}</option>
              {entities.items.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.shortName}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm font-medium text-foreground-strong">
            {t('filters.kind')}
            <select name="kind" defaultValue={kind} className={selectClass}>
              <option value="">{t('filters.any')}</option>
              {DOCUMENT_KINDS.map((k) => (
                <option key={k} value={k}>
                  {t(`kinds.${k}`)}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm font-medium text-foreground-strong">
            {t('filters.state')}
            <select name="purged" defaultValue={purged} className={selectClass}>
              <option value="">{t('filters.any')}</option>
              <option value="false">{t('available')}</option>
              <option value="true">{t('purged')}</option>
            </select>
          </label>
          <div className="flex flex-wrap items-end gap-3">
            <Button type="submit">{t('filters.apply')}</Button>
            <Button asChild variant="outline">
              <Link href="/operator/documents">{t('filters.clear')}</Link>
            </Button>
          </div>
        </form>
      </Section>

      <Section title={t('register')}>
        {documents.items.length === 0 ? (
          <EmptyState>{t('empty')}</EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">{t('document')}</th>
                  <th scope="col">{t('owner')}</th>
                  <th scope="col">{t('uploaded')}</th>
                  <th scope="col">{t('state')}</th>
                  <th scope="col">{t('actions')}</th>
                </tr>
              </thead>
              <tbody>
                {documents.items.map((d) => (
                  <tr key={d.id}>
                    <td>
                      <span className="block font-medium">{d.fileName}</span>
                      <span className="block text-xs text-muted-foreground">
                        {t(`kinds.${d.kind}`)} · {t('size', { kb: Math.ceil(d.size / 1024) })}
                      </span>
                      <span className="block font-mono text-xs break-all text-muted-foreground">
                        SHA-256 {d.sha256}
                      </span>
                    </td>
                    <td>{d.owner.shortName}</td>
                    <td className="text-sm">
                      {format.dateTime(new Date(d.uploadedAt), { dateStyle: 'medium' })}
                    </td>
                    <td>
                      {d.purgedAt ? (
                        <>
                          <StatusBadge status="revoked">{t('purged')}</StatusBadge>
                          <span className="mt-1 block text-xs">
                            {t('purgedOn', {
                              date: format.dateTime(new Date(d.purgedAt), { dateStyle: 'medium' }),
                              order: d.purgeOrder ?? '',
                            })}
                          </span>
                        </>
                      ) : (
                        <StatusBadge status="active">{t('available')}</StatusBadge>
                      )}
                    </td>
                    <td>
                      {d.purgedAt ? null : (
                        <PurgeDocumentForm documentId={d.id} name={d.fileName} />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {documents.nextCursor ? (
          <div className="flex justify-center">
            <Button asChild variant="outline">
              <Link
                href={`/operator/documents?cursor=${documents.nextCursor}${kept ? `&${kept}` : ''}`}
              >
                {t('older')}
              </Link>
            </Button>
          </div>
        ) : null}
      </Section>
    </Page>
  );
}
