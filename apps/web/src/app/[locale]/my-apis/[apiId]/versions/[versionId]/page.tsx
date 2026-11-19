import { apiDetailSchema, apiVersionDetailSchema, purposeListSchema } from '@den/contracts';
import { getCountryConfig } from '@den/config';
import type { Metadata } from 'next';
import { getFormatter, getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import {
  DeprecateVersionForm,
  ReplaceOpenapiForm,
  RevalidateVersionForm,
  SubmitVersionForm,
} from '../../../../../../components/apis/api-forms';
import { VersionSheet } from '../../../../../../components/apis/version-sheet';
import { VersionPurposesForm } from '../../../../../../components/purposes/forms';
import { Notice } from '../../../../../../components/ui/notice';
import { Page, PageHeader, Section } from '../../../../../../components/ui/page';
import { ApiError, apiGet } from '../../../../../../lib/api';
import { localize } from '../../../../../../lib/localize';
import { getViewer } from '../../../../../../lib/viewer';
import { uuidParams } from '../../../../../../lib/route-params';

/** First retirement date (YYYY-MM-DD) the notice period allows, with a day of margin. */
function earliestRetirementDate(noticeDays: number, now = new Date()): string {
  return new Date(now.getTime() + (noticeDays + 1) * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
}

interface PageProps {
  params: Promise<{ locale: string; apiId: string; versionId: string }>;
}

async function load(apiId: string, versionId: string) {
  const entity = (await getViewer()).activeEntity;
  if (!entity) notFound();
  const base = `/entities/${entity.entity.id}/apis/${apiId}`;
  try {
    const [api, version] = await Promise.all([
      apiGet(base, apiDetailSchema),
      apiGet(`${base}/versions/${versionId}`, apiVersionDetailSchema),
    ]);
    return { entity, api, version };
  } catch (error) {
    if (error instanceof ApiError && [400, 403, 404].includes(error.status)) notFound();
    throw error;
  }
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale, apiId, versionId } = uuidParams(await params, 'apiId', 'versionId');
  const { api, version } = await load(apiId, versionId);
  const t = await getTranslations({ locale, namespace: 'version.detail' });
  return { title: t('title', { api: api.name, version: version.version }) };
}

export default async function VersionPage({ params }: PageProps) {
  const { locale, apiId, versionId } = uuidParams(await params, 'apiId', 'versionId');
  setRequestLocale(locale);
  const t = await getTranslations();
  const { entity, api, version } = await load(apiId, versionId);
  const purposeNames = new Map(
    (await apiGet('/purposes', purposeListSchema)).items.map((p) => [
      p.code,
      localize(p.name, locale),
    ]),
  );
  const canWrite = entity.roles.includes('api_publisher');
  const editable = version.status === 'draft' || version.status === 'changes_requested';
  const format = await getFormatter();
  const day = (iso: string | null) =>
    iso ? format.dateTime(new Date(iso), { dateStyle: 'long' }) : '';
  // Earliest retirement date the notice period allows, plus a day of margin (ADR-0019).
  const noticeDays = getCountryConfig().lifecycle.apiRetirementNoticeDays;
  const minSunset = earliestRetirementDate(noticeDays);

  return (
    <Page>
      <PageHeader
        eyebrow={api.name}
        title={t('version.detail.title', { api: api.name, version: version.version })}
      />

      {version.status === 'in_review' ? (
        <Notice tone="warning" role="status">
          {t('version.detail.inReview')}
        </Notice>
      ) : null}
      {version.status === 'published' ? (
        <Notice tone="success" role="status">
          {t('version.detail.published')}
        </Notice>
      ) : null}

      {version.status === 'deprecated' ? (
        <Notice tone="warning" role="status">
          {t('version.lifecycle.deprecatedNotice', { date: day(version.sunsetAt) })}
        </Notice>
      ) : null}
      {version.status === 'retired' ? (
        <Notice tone="info" role="status">
          {t('version.lifecycle.retiredNotice', { date: day(version.retiredAt) })}
        </Notice>
      ) : null}

      <VersionSheet version={version} purposeNames={purposeNames} />

      {version.revisions.length > 0 ? (
        <Section title={t('version.lifecycle.revisions')}>
          <ul className="space-y-2 text-sm">
            {version.revisions.map((r) => (
              <li key={r.replacedAt}>
                <span className="font-mono">{r.version}</span>{' '}
                <span className="text-muted-foreground">
                  · {t('version.lifecycle.replacedOn', { date: day(r.replacedAt) })} ·{' '}
                  <span className="font-mono break-all">{r.openapiSha256.slice(0, 16)}…</span>
                </span>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {entity.roles.includes('data_steward') && version.status !== 'retired' ? (
        <Section title={t('purposes.version.title')} description={t('purposes.version.lead')}>
          <div className="card max-w-3xl p-6 md:p-8">
            <VersionPurposesForm
              apiId={api.id}
              versionId={version.id}
              options={[...purposeNames].map(([code, label]) => ({ code, label }))}
              selected={version.allowedPurposes}
            />
          </div>
        </Section>
      ) : null}

      {canWrite && version.status === 'published' ? (
        <>
          <Section
            title={t('version.lifecycle.reviseTitle')}
            description={t('version.lifecycle.reviseHint')}
          >
            <div className="card max-w-3xl p-6 md:p-8">
              <ReplaceOpenapiForm
                apiId={api.id}
                versionId={version.id}
                submitLabel={t('version.lifecycle.reviseSubmit')}
              />
            </div>
          </Section>
          <Section
            title={t('version.lifecycle.deprecateTitle')}
            description={t('version.lifecycle.deprecateHint', { days: noticeDays })}
          >
            <div className="card max-w-3xl p-6 md:p-8">
              <DeprecateVersionForm apiId={api.id} versionId={version.id} minDate={minSunset} />
            </div>
          </Section>
        </>
      ) : null}

      {canWrite && version.status === 'in_review' && version.validation?.status !== 'running' ? (
        <div className="card flex flex-wrap items-center justify-between gap-4 bg-surface-panel p-6">
          <p className="text-sm">{t('version.validation.rerunHint')}</p>
          <RevalidateVersionForm apiId={api.id} versionId={version.id} />
        </div>
      ) : null}

      {canWrite && editable ? (
        <>
          <Section title={t('version.detail.replace')}>
            <div className="card max-w-3xl p-6 md:p-8">
              <ReplaceOpenapiForm apiId={api.id} versionId={version.id} />
            </div>
          </Section>
          <div className="card flex flex-wrap items-center justify-between gap-4 bg-surface-panel p-6">
            <SubmitVersionForm
              apiId={api.id}
              versionId={version.id}
              disabled={!version.lintReport.valid}
            />
          </div>
        </>
      ) : null}
    </Page>
  );
}
