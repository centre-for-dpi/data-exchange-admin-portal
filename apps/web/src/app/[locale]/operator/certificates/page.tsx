import { certificateRevocationPreviewSchema } from '@den/contracts';
import type { Metadata } from 'next';
import { getFormatter, getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { CertificateRevocationForm } from '../../../../components/certificates/revocation-form';
import { inputClass } from '../../../../components/form/field';
import { Button } from '../../../../components/ui/button';
import { Notice } from '../../../../components/ui/notice';
import { EmptyState, Page, PageHeader, Section } from '../../../../components/ui/page';
import { Link } from '../../../../i18n/navigation';
import { apiGet } from '../../../../lib/api';
import { getViewer } from '../../../../lib/viewer';

interface PageProps {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const SHA256 = /^[0-9a-f]{64}$/;

/** The day after a YYYY-MM-DD day (UTC): `to` includes the whole day it names. */
const nextDay = (day: string) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + 24 * 60 * 60 * 1000).toISOString();

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'certificateRevocations' });
  return { title: t('title') };
}

/**
 * Operator console: mass revocation of client certificates in an incident (M6-07). The filters
 * live in the URL (a plain GET form); the page shows what they would revoke, and the form below
 * revokes exactly that set.
 */
export default async function CertificateRevocationsPage({ params, searchParams }: PageProps) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('certificateRevocations');
  const format = await getFormatter();
  const viewer = await getViewer();
  if (!viewer.platformRoles.includes('platform_admin')) notFound();

  const query = await searchParams;
  const text = (key: string) => (typeof query[key] === 'string' ? query[key].trim() : '');
  const shown = {
    entity: UUID.test(text('entity')) ? text('entity') : '',
    from: DAY.test(text('from')) ? text('from') : '',
    to: DAY.test(text('to')) ? text('to') : '',
    issuer: SHA256.test(text('issuer')) ? text('issuer') : '',
  };
  // The API's filters (dates in UTC, as the audit log's).
  const filters: Record<string, string> = {};
  if (shown.entity) filters.entityId = shown.entity;
  if (shown.from) filters.issuedFrom = `${shown.from}T00:00:00.000Z`;
  if (shown.to) filters.issuedTo = nextDay(shown.to);
  if (shown.issuer) filters.issuer = shown.issuer;
  const unfiltered = Object.keys(filters).length === 0;
  const revoked = /^\d+$/.test(text('revoked')) ? Number(text('revoked')) : undefined;
  const withIssuer = (fingerprint: string) => {
    const next = new URLSearchParams(Object.entries(shown).filter(([k, v]) => v && k !== 'issuer'));
    next.set('issuer', fingerprint);
    return `/operator/certificates?${next.toString()}`;
  };

  // The entities to choose from: those with live certificates (M6-11), whatever their number.
  const [entities, preview] = await Promise.all([
    apiGet('/admin/certificate-revocations/preview', certificateRevocationPreviewSchema).then(
      (all) => ({ items: all.entities }),
    ),
    apiGet(
      `/admin/certificate-revocations/preview?${new URLSearchParams(filters).toString()}`,
      certificateRevocationPreviewSchema,
    ),
  ]);

  return (
    <Page>
      <PageHeader title={t('title')} description={t('lead')} />
      {revoked !== undefined ? (
        <Notice tone="success" role="status">
          {t('done', { count: revoked })}
        </Notice>
      ) : null}

      <Section title={t('filters.title')} description={t('filters.hint')}>
        <form
          method="get"
          className="card grid gap-4 p-6 md:grid-cols-4"
          aria-label={t('filters.title')}
        >
          <label className="block text-sm font-medium text-foreground-strong">
            {t('filters.entity')}
            <select name="entity" defaultValue={shown.entity} className={`${inputClass} mt-1.5`}>
              <option value="">{t('filters.any')}</option>
              {entities.items.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.shortName}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm font-medium text-foreground-strong">
            {t('filters.from')}
            <input
              type="date"
              name="from"
              defaultValue={shown.from}
              className={`${inputClass} mt-1.5`}
            />
          </label>
          <label className="block text-sm font-medium text-foreground-strong">
            {t('filters.to')}
            <input
              type="date"
              name="to"
              defaultValue={shown.to}
              className={`${inputClass} mt-1.5`}
            />
          </label>
          {shown.issuer ? <input type="hidden" name="issuer" value={shown.issuer} /> : null}
          <div className="flex flex-wrap items-end gap-3">
            <Button type="submit">{t('filters.apply')}</Button>
            <Button asChild variant="outline">
              <Link href="/operator/certificates">{t('filters.clear')}</Link>
            </Button>
          </div>
          {shown.issuer ? (
            <p className="text-sm md:col-span-4">
              {t('filters.issuerSelected')}{' '}
              <span className="font-mono text-xs break-all">{shown.issuer}</span>
            </p>
          ) : null}
        </form>
      </Section>

      <Section title={t('preview.title')}>
        {preview.count === 0 ? (
          <EmptyState>{t('preview.empty')}</EmptyState>
        ) : (
          <>
            <p className="text-lg font-semibold" role="status">
              {t('preview.count', { count: preview.count, entities: preview.entities.length })}
            </p>
            {unfiltered ? <Notice tone="warning">{t('preview.wholeNetwork')}</Notice> : null}
            <div className="table-wrap">
              <table className="data-table">
                <caption className="sr-only">{t('preview.byEntity')}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t('preview.entity')}</th>
                    <th scope="col">{t('preview.applications')}</th>
                    <th scope="col">{t('preview.certificates')}</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.entities.map((e) => (
                    <tr key={e.id}>
                      <td>{e.shortName}</td>
                      <td>{format.number(e.applications)}</td>
                      <td>{format.number(e.certificates)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Section>

      {preview.issuers.length > 0 ? (
        <Section title={t('issuers.title')} description={t('issuers.hint')}>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">{t('issuers.subject')}</th>
                  <th scope="col">{t('issuers.validUntil')}</th>
                  <th scope="col">{t('preview.certificates')}</th>
                  <th scope="col">{t('issuers.action')}</th>
                </tr>
              </thead>
              <tbody>
                {preview.issuers.map((i) => (
                  <tr key={i.fingerprint}>
                    <td>
                      <span className="block">{i.subject || t('issuers.unknown')}</span>
                      <span className="block font-mono text-xs break-all text-muted-foreground">
                        SHA-256 {i.fingerprint}
                      </span>
                    </td>
                    <td className="text-sm">
                      {i.notAfter
                        ? format.dateTime(new Date(i.notAfter), { dateStyle: 'medium' })
                        : '—'}
                    </td>
                    <td>{format.number(i.certificates)}</td>
                    <td>
                      {i.fingerprint === shown.issuer ? (
                        <span className="text-sm">{t('issuers.selected')}</span>
                      ) : (
                        <Link href={withIssuer(i.fingerprint)} className="link text-sm">
                          {t('issuers.only', { subject: i.subject || i.fingerprint.slice(0, 12) })}
                        </Link>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      ) : null}

      {preview.count > 0 ? (
        <Section title={t('revokeTitle')} description={t('revokeHint')}>
          <CertificateRevocationForm filters={filters} count={preview.count} />
        </Section>
      ) : null}
    </Page>
  );
}
