import { getCountryConfig } from '@rid/config';
import { catalogDetailSchema } from '@rid/contracts';
import type { Metadata } from 'next';
import { getFormatter, getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { dataSubjectLabel } from '../../../../../../components/apis/data-subject';
import { PrintButton } from '../../../../../../components/catalog/print-button';
import { Link } from '../../../../../../i18n/navigation';
import { ApiError, apiGet } from '../../../../../../lib/api';
import { localize } from '../../../../../../lib/localize';

interface PageProps {
  params: Promise<{ locale: string; apiId: string; versionId: string }>;
}

async function load(apiId: string) {
  try {
    return await apiGet(`/catalog/apis/${apiId}`, catalogDetailSchema);
  } catch (error) {
    if (error instanceof ApiError && [400, 401, 403, 404].includes(error.status)) notFound();
    throw error;
  }
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale, apiId } = await params;
  const t = await getTranslations({ locale, namespace: 'serviceSheet' });
  const detail = await load(apiId);
  return { title: t('title', { api: detail.api.name }) };
}

/**
 * The service sheet of a version (SPEC.md §3, "ficha del servicio", M4-09): what a consumer and a
 * reviewer need on one page, from the catalogue data, made to be printed or saved as PDF from the
 * browser. Only what the catalogue already shows to this viewer: nothing about the upstream.
 */
export default async function ServiceSheetPage({ params }: PageProps) {
  const { locale, apiId, versionId } = await params;
  setRequestLocale(locale);
  const t = await getTranslations();
  const format = await getFormatter();
  const detail = await load(apiId);
  const version = detail.versions.find((v) => v.id === versionId);
  if (!version) notFound();
  const country = getCountryConfig();
  const sector = country.sectors.find((s) => s.code === detail.api.sector);
  const date = (value: string | null) =>
    value ? format.dateTime(new Date(value), { dateStyle: 'long' }) : '—';

  return (
    <article className="mx-auto max-w-4xl space-y-8 px-6 py-10 print:max-w-none print:p-0">
      <div className="flex flex-wrap items-center justify-between gap-4 print:hidden">
        <Link href={`/catalog/${apiId}`} className="link">
          {t('serviceSheet.back')}
        </Link>
        <PrintButton />
      </div>

      <header className="space-y-2 border-b border-border pb-6">
        <p className="text-sm text-muted-foreground">
          {t('serviceSheet.eyebrow', { network: localize(country.branding.productName, locale) })}
        </p>
        <h1 className="text-3xl font-bold">
          {detail.api.name} <span className="font-mono text-xl">{version.version}</span>
        </h1>
        <p>{detail.api.summary}</p>
      </header>

      <section aria-labelledby="sheet-provider" className="space-y-3">
        <h2 id="sheet-provider" className="text-xl font-semibold">
          {t('serviceSheet.provider')}
        </h2>
        <dl className="facts">
          <dt>{t('serviceSheet.entity')}</dt>
          <dd>{detail.entity.legalName}</dd>
          <dt>{t('serviceSheet.owner')}</dt>
          <dd>{detail.api.ownerContact}</dd>
          <dt>{t('serviceSheet.sector')}</dt>
          <dd>{sector ? localize(sector.name, locale) : detail.api.sector}</dd>
          <dt>{t('serviceSheet.classification')}</dt>
          <dd>{t(`classification.${detail.api.classification}`)}</dd>
          <dt>{t('serviceSheet.status')}</dt>
          <dd>
            {t(`versionStatus.${version.status}`)}
            {version.status === 'deprecated' && version.sunsetAt
              ? ` — ${t('serviceSheet.sunset', { date: date(version.sunsetAt) })}`
              : ''}
          </dd>
          <dt>{t('serviceSheet.published')}</dt>
          <dd>{date(version.publishedAt)}</dd>
          {version.node ? (
            <>
              <dt>{t('serviceSheet.node')}</dt>
              <dd>{t(`nodeStatus.${version.node.status}`)}</dd>
            </>
          ) : null}
        </dl>
      </section>

      <section aria-labelledby="sheet-access" className="space-y-3">
        <h2 id="sheet-access" className="text-xl font-semibold">
          {t('serviceSheet.access')}
        </h2>
        <dl className="facts">
          <dt>{t('serviceSheet.url')}</dt>
          <dd className="font-mono break-all">{version.gatewayUrl}</dd>
          {version.sandboxUrl ? (
            <>
              <dt>{t('serviceSheet.sandbox')}</dt>
              <dd className="font-mono break-all">{version.sandboxUrl}</dd>
            </>
          ) : null}
          <dt>{t('serviceSheet.purposes')}</dt>
          <dd>{version.allowedPurposes.map((p) => localize(p.name, locale)).join(', ')}</dd>
          <dt>{t('serviceSheet.rateLimit')}</dt>
          <dd>{t('serviceSheet.perMinute', { limit: version.defaultRateLimit })}</dd>
          <dt>{t('serviceSheet.legalBasis')}</dt>
          <dd>
            {version.legalBasisText ?? '—'}
            {version.legalReferences.length ? (
              <ul className="mt-1 list-disc pl-5">
                {version.legalReferences.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            ) : null}
          </dd>
        </dl>
      </section>

      <section aria-labelledby="sheet-data" className="space-y-3">
        <h2 id="sheet-data" className="text-xl font-semibold">
          {t('serviceSheet.data')}
        </h2>
        {version.exposedFields.length === 0 ? (
          <p>{t('catalog.noPersonalData')}</p>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">{t('serviceSheet.field')}</th>
                <th scope="col">{t('serviceSheet.personal')}</th>
                <th scope="col">{t('serviceSheet.sensitive')}</th>
              </tr>
            </thead>
            <tbody>
              {version.exposedFields.map((f) => (
                <tr key={f.name}>
                  <td className="font-mono">{f.name}</td>
                  <td>{f.personal ? t('version.detail.yes') : t('version.detail.no')}</td>
                  <td>{f.sensitive ? t('version.detail.yes') : t('version.detail.no')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section aria-labelledby="sheet-operations" className="space-y-3">
        <h2 id="sheet-operations" className="text-xl font-semibold">
          {t('serviceSheet.operations')}
        </h2>
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">{t('serviceSheet.method')}</th>
              <th scope="col">{t('serviceSheet.path')}</th>
              <th scope="col">{t('serviceSheet.operation')}</th>
              <th scope="col">{t('serviceSheet.subject')}</th>
            </tr>
          </thead>
          <tbody>
            {version.operations.map((o) => (
              <tr key={o.operationId}>
                <td className="font-mono">{o.method}</td>
                <td className="font-mono break-all">{o.path}</td>
                <td className="font-mono">{o.operationId}</td>
                <td>{dataSubjectLabel(t, o.dataSubject)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section aria-labelledby="sheet-description" className="space-y-3">
        <h2 id="sheet-description" className="text-xl font-semibold">
          {t('serviceSheet.description')}
        </h2>
        <p className="whitespace-pre-line">{detail.api.description}</p>
      </section>

      <footer className="border-t border-border pt-4 text-sm text-muted-foreground">
        {t('serviceSheet.generated', { date: format.dateTime(new Date(), { dateStyle: 'long' }) })}
      </footer>
    </article>
  );
}
