import { getCountryConfig } from '@den/config';
import { catalogDetailSchema } from '@den/contracts';
import type { Metadata } from 'next';
import { getFormatter, getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import Markdown from 'react-markdown';
import { z } from 'zod';
import { dataSubjectLabel } from '../../../../components/apis/data-subject';
import { ApiDocs } from '../../../../components/catalog/api-docs';
import { Badge, classificationTone, StatusBadge } from '../../../../components/ui/badge';
import { Button } from '../../../../components/ui/button';
import { Card, Page, PageHeader, Section } from '../../../../components/ui/page';
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
  const format = await getFormatter();
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

  const yesNo = (value: boolean, tone: 'info' | 'warning') =>
    value ? <Badge tone={tone}>{t('version.detail.yes')}</Badge> : t('version.detail.no');

  return (
    <Page>
      <PageHeader
        eyebrow={detail.entity.legalName}
        title={detail.api.name}
        description={detail.api.summary}
        actions={
          canRequest ? (
            <Button asChild size="lg">
              <Link href={`/my-apps/request?api=${apiId}&version=${version.id}`}>
                {t('subscriptions.requestAccess')}
              </Link>
            </Button>
          ) : null
        }
      />
      {canRequest ? (
        <p className="-mt-4 text-sm text-muted-foreground">
          {t('subscriptions.requestAccessNote')}
        </p>
      ) : null}

      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_20rem]">
        {/* First in reading order; shown as a sidebar on wide screens. */}
        <aside className="lg:order-2">
          <Card className="space-y-2 lg:sticky lg:top-6">
            <dl className="facts facts-stack">
              <dt>{t('catalog.detail.provider')}</dt>
              <dd>{detail.entity.legalName}</dd>
              <dt>{t('catalog.sector')}</dt>
              <dd>{sector ? localize(sector.name, locale) : detail.api.sector}</dd>
              <dt>{t('catalog.classification')}</dt>
              <dd>
                <Badge tone={classificationTone(detail.api.classification)}>
                  {t(`classification.${detail.api.classification}`)}
                </Badge>
              </dd>
              {detail.api.ownerContact ? (
                <>
                  <dt>{t('catalog.detail.owner')}</dt>
                  <dd>{detail.api.ownerContact}</dd>
                </>
              ) : null}
            </dl>
          </Card>
        </aside>

        <div className="min-w-0 space-y-10">
          <div className="prose-den">
            {/* react-markdown renders no raw HTML and sanitizes link protocols. */}
            <Markdown skipHtml>{detail.api.description}</Markdown>
          </div>

          <Section
            title={
              <span className="flex flex-wrap items-center gap-3">
                {t('catalog.detail.version', { version: version.version })}
                {version.status === 'deprecated' ? (
                  <Badge tone="warning">{t('catalog.detail.deprecated')}</Badge>
                ) : null}
              </span>
            }
            actions={
              detail.versions.length > 1 ? (
                <nav aria-label={t('catalog.detail.versions')}>
                  <ul className="flex flex-wrap gap-1 rounded-full border border-border bg-background p-1 text-sm">
                    {detail.versions.map((v) => (
                      <li key={v.id}>
                        <Link
                          href={`/catalog/${apiId}?version=${v.id}`}
                          aria-current={v.id === version.id ? 'page' : undefined}
                          className={
                            v.id === version.id
                              ? 'block rounded-full bg-primary-soft px-3 py-1 font-medium text-primary-ink'
                              : 'block rounded-full px-3 py-1 text-muted-foreground hover:text-foreground-strong'
                          }
                        >
                          {v.version}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </nav>
              ) : null
            }
          >
            <Card className="space-y-3">
              <dl className="facts">
                <dt>{t('catalog.detail.gatewayUrl')}</dt>
                <dd className="font-mono break-all">{version.gatewayUrl}</dd>
                {version.sandboxUrl ? (
                  <>
                    <dt>{t('catalog.detail.sandboxUrl')}</dt>
                    <dd className="font-mono break-all" data-testid="catalog-sandbox">
                      {version.sandboxUrl}
                    </dd>
                  </>
                ) : null}
                <dt>{t('catalog.detail.purposes')}</dt>
                <dd>{version.allowedPurposes.map((p) => localize(p.name, locale)).join(', ')}</dd>
                {version.node ? (
                  <>
                    <dt>{t('catalog.detail.node')}</dt>
                    <dd data-testid="catalog-node">
                      <StatusBadge status={version.node.status}>
                        {t(`nodeStatus.${version.node.status}`)}
                      </StatusBadge>
                      {version.node.lastHeartbeatAt ? (
                        <span className="block text-sm text-muted-foreground">
                          {t('catalog.detail.nodeStatusHint', {
                            date: format.dateTime(new Date(version.node.lastHeartbeatAt), {
                              dateStyle: 'medium',
                              timeStyle: 'short',
                            }),
                          })}
                        </span>
                      ) : null}
                    </dd>
                  </>
                ) : null}
                {version.legalBasisText ? (
                  <>
                    <dt>{t('catalog.detail.legalBasis')}</dt>
                    <dd>{version.legalBasisText}</dd>
                  </>
                ) : null}
              </dl>
              <p className="text-sm text-muted-foreground">
                {t('catalog.detail.rateLimit', { limit: version.defaultRateLimit })}
              </p>
              <Link href={`/catalog/${detail.api.id}/sheet/${version.id}`} className="link text-sm">
                {t('serviceSheet.open', { version: version.version })}
              </Link>
            </Card>

            <h3 className="pt-2 text-lg font-semibold">{t('catalog.detail.exposedFields')}</h3>
            {version.exposedFields.length === 0 ? (
              <p className="text-sm">{t('catalog.noPersonalData')}</p>
            ) : (
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th scope="col">{t('version.create.fieldName')}</th>
                      <th scope="col">{t('version.create.personal')}</th>
                      <th scope="col">{t('version.create.sensitive')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {version.exposedFields.map((f) => (
                      <tr key={f.name}>
                        <td className="font-mono">{f.name}</td>
                        <td>{yesNo(f.personal, 'info')}</td>
                        <td>{yesNo(f.sensitive, 'warning')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <h3 className="pt-2 text-lg font-semibold">{t('catalog.detail.operations')}</h3>
            <p className="max-w-3xl text-sm text-muted-foreground">{t('dataSubject.note')}</p>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th scope="col">{t('version.detail.method')}</th>
                    <th scope="col">{t('version.detail.path')}</th>
                    <th scope="col">{t('dataSubject.column')}</th>
                  </tr>
                </thead>
                <tbody>
                  {version.operations.map((op) => (
                    <tr key={op.operationId}>
                      <td>
                        <Badge tone="brand" className="font-mono">
                          {op.method}
                        </Badge>
                      </td>
                      <td className="font-mono">{op.path}</td>
                      <td>{dataSubjectLabel(t, op.dataSubject)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>
        </div>
      </div>

      <Section
        title={t('catalog.detail.documentation')}
        description={t('catalog.detail.documentationNote')}
      >
        <ApiDocs spec={spec} />
      </Section>
    </Page>
  );
}
