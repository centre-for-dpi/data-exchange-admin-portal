import { getCountryConfig } from '@rid/config';
import { catalogDetailSchema } from '@rid/contracts';
import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import Markdown from 'react-markdown';
import { z } from 'zod';
import { dataSubjectLabel } from '../../../../components/apis/data-subject';
import { ApiDocs } from '../../../../components/catalog/api-docs';
import { Button } from '../../../../components/ui/button';
import { Link } from '../../../../i18n/navigation';
import { ApiError, apiGet } from '../../../../lib/api';
import { localize } from '../../../../lib/localize';
import { getViewer } from '../../../../lib/viewer';

interface PageProps {
  params: Promise<{ locale: string; apiId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const specSchema = z.record(z.string(), z.unknown());

async function load(apiId: string) {
  const anonymous = !(await getViewer()).authenticated;
  try {
    return {
      anonymous,
      detail: await apiGet(`/catalog/apis/${apiId}`, catalogDetailSchema, { anonymous }),
    };
  } catch (error) {
    // 401: anonymous visitor without a public catalogue.
    if (error instanceof ApiError && [400, 401, 404].includes(error.status)) notFound();
    throw error;
  }
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { apiId } = await params;
  const { detail } = await load(apiId);
  return { title: detail.api.name };
}

export default async function CatalogApiPage({ params, searchParams }: PageProps) {
  const { locale, apiId } = await params;
  setRequestLocale(locale);
  const t = await getTranslations();
  const { anonymous, detail } = await load(apiId);
  const requested = (await searchParams).version;
  const version = detail.versions.find((v) => v.id === requested) ?? detail.versions[0];
  // A listed API always has a published version; anything else is not in the catalogue.
  if (!version) notFound();
  const spec = await apiGet(`/catalog/apis/${apiId}/versions/${version.id}/openapi`, specSchema, {
    anonymous,
  });
  const sector = getCountryConfig().sectors.find((s) => s.code === detail.api.sector);
  // Only app developers request access; the API checks it again (SPEC.md §2.2).
  const canRequest =
    version.status === 'published' &&
    Boolean((await getViewer()).activeEntity?.roles.includes('app_developer'));

  return (
    <section className="mx-auto max-w-6xl space-y-8 px-4 py-10">
      <div>
        <h1 className="text-2xl font-bold">{detail.api.name}</h1>
        <p className="mt-2 text-lg text-muted-foreground">{detail.api.summary}</p>
      </div>

      <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1 text-sm">
        <dt className="font-medium">{t('catalog.detail.provider')}</dt>
        <dd>{detail.entity.legalName}</dd>
        <dt className="font-medium">{t('catalog.sector')}</dt>
        <dd>{sector ? localize(sector.name, locale) : detail.api.sector}</dd>
        <dt className="font-medium">{t('catalog.classification')}</dt>
        <dd>{t(`classification.${detail.api.classification}`)}</dd>
        <dt className="font-medium">{t('catalog.detail.owner')}</dt>
        <dd>{detail.api.ownerContact}</dd>
      </dl>

      <div className="max-w-3xl space-y-2 [&_a]:underline [&_ul]:list-disc [&_ul]:pl-6">
        {/* react-markdown renders no raw HTML and sanitizes link protocols. */}
        <Markdown skipHtml>{detail.api.description}</Markdown>
      </div>

      {detail.versions.length > 1 ? (
        <nav aria-label={t('catalog.detail.versions')}>
          <ul className="flex flex-wrap gap-2 text-sm">
            {detail.versions.map((v) => (
              <li key={v.id}>
                <Link
                  href={`/catalog/${apiId}?version=${v.id}`}
                  aria-current={v.id === version.id ? 'page' : undefined}
                  className="underline"
                >
                  {t('catalog.detail.version', { version: v.version })}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      ) : null}

      <div className="space-y-4">
        <h2 className="text-xl font-semibold">
          {t('catalog.detail.version', { version: version.version })}
          {version.status === 'deprecated' ? ` · ${t('catalog.detail.deprecated')}` : ''}
        </h2>
        <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1 text-sm">
          <dt className="font-medium">{t('catalog.detail.gatewayUrl')}</dt>
          <dd className="font-mono break-all">{version.gatewayUrl}</dd>
          <dt className="font-medium">{t('catalog.detail.purposes')}</dt>
          <dd>{version.allowedPurposes.map((p) => localize(p.name, locale)).join(', ')}</dd>
          {version.legalBasisText ? (
            <>
              <dt className="font-medium">{t('catalog.detail.legalBasis')}</dt>
              <dd>{version.legalBasisText}</dd>
            </>
          ) : null}
        </dl>
        <p className="text-sm">
          {t('catalog.detail.rateLimit', { limit: version.defaultRateLimit })}
        </p>
        {canRequest ? (
          <div className="flex flex-wrap items-center gap-4">
            <Button asChild>
              <Link href={`/my-apps/request?api=${apiId}&version=${version.id}`}>
                {t('subscriptions.requestAccess')}
              </Link>
            </Button>
            <p className="text-sm text-muted-foreground">{t('subscriptions.requestAccessNote')}</p>
          </div>
        ) : null}

        <h3 className="font-semibold">{t('catalog.detail.exposedFields')}</h3>
        {version.exposedFields.length === 0 ? (
          <p className="text-sm">{t('catalog.noPersonalData')}</p>
        ) : (
          <table className="text-left text-sm">
            <thead>
              <tr className="border-b border-border">
                <th scope="col" className="py-1 pr-6">
                  {t('version.create.fieldName')}
                </th>
                <th scope="col" className="py-1 pr-6">
                  {t('version.create.personal')}
                </th>
                <th scope="col" className="py-1">
                  {t('version.create.sensitive')}
                </th>
              </tr>
            </thead>
            <tbody>
              {version.exposedFields.map((f) => (
                <tr key={f.name} className="border-b border-border">
                  <td className="py-1 pr-6">{f.name}</td>
                  <td className="py-1 pr-6">
                    {f.personal ? t('version.detail.yes') : t('version.detail.no')}
                  </td>
                  <td className="py-1">
                    {f.sensitive ? t('version.detail.yes') : t('version.detail.no')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <h3 className="font-semibold">{t('catalog.detail.operations')}</h3>
        <p className="max-w-3xl text-sm text-muted-foreground">{t('dataSubject.note')}</p>
        <table className="text-left text-sm">
          <thead>
            <tr className="border-b border-border">
              <th scope="col" className="py-1 pr-6">
                {t('version.detail.method')}
              </th>
              <th scope="col" className="py-1 pr-6">
                {t('version.detail.path')}
              </th>
              <th scope="col" className="py-1">
                {t('dataSubject.column')}
              </th>
            </tr>
          </thead>
          <tbody>
            {version.operations.map((op) => (
              <tr key={op.operationId} className="border-b border-border">
                <td className="py-1 pr-6 font-mono">{op.method}</td>
                <td className="py-1 pr-6 font-mono">{op.path}</td>
                <td className="py-1">{dataSubjectLabel(t, op.dataSubject)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="space-y-3">
        <h2 className="text-xl font-semibold">{t('catalog.detail.documentation')}</h2>
        <p className="text-sm text-muted-foreground">{t('catalog.detail.documentationNote')}</p>
        <ApiDocs spec={spec} />
      </div>
    </section>
  );
}
