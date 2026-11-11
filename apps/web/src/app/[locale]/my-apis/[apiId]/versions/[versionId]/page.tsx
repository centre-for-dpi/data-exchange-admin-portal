import { apiDetailSchema, apiVersionDetailSchema, purposeListSchema } from '@rid/contracts';
import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { ReplaceOpenapiForm, SubmitVersionForm } from '../../../../../../components/apis/api-forms';
import { ApiError, apiGet } from '../../../../../../lib/api';
import { localize } from '../../../../../../lib/localize';
import { getViewer } from '../../../../../../lib/viewer';

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
  const { locale, apiId, versionId } = await params;
  const { api, version } = await load(apiId, versionId);
  const t = await getTranslations({ locale, namespace: 'version.detail' });
  return { title: t('title', { api: api.name, version: version.version }) };
}

export default async function VersionPage({ params }: PageProps) {
  const { locale, apiId, versionId } = await params;
  setRequestLocale(locale);
  const t = await getTranslations();
  const { entity, api, version } = await load(apiId, versionId);
  const purposes = new Map(
    (await apiGet('/purposes', purposeListSchema)).items.map((p) => [
      p.code,
      localize(p.name, locale),
    ]),
  );
  const canWrite = entity.roles.includes('api_publisher');
  const editable = version.status === 'draft' || version.status === 'changes_requested';
  const errors = version.lintReport.issues.filter((i) => i.severity === 'error');
  const upstream =
    version.upstream.type === 'node' ? version.upstream.servicePath : version.upstream.url;

  return (
    <section className="mx-auto max-w-6xl space-y-8 px-4 py-10">
      <h1 className="text-2xl font-bold">
        {t('version.detail.title', { api: api.name, version: version.version })}
      </h1>

      <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1 text-sm">
        <dt className="font-medium">{t('version.detail.status')}</dt>
        <dd data-testid="version-status">{t(`versionStatus.${version.status}`)}</dd>
        <dt className="font-medium">{t('version.detail.basePath')}</dt>
        <dd className="font-mono">{version.basePath}</dd>
        <dt className="font-medium">{t('version.detail.upstream')}</dt>
        <dd className="font-mono">{upstream}</dd>
        <dt className="font-medium">{t('version.detail.purposes')}</dt>
        <dd>{version.allowedPurposes.map((code) => purposes.get(code) ?? code).join(', ')}</dd>
      </dl>

      <div>
        <h2 className="text-xl font-semibold">{t('version.detail.exposedFields')}</h2>
        {version.exposedFields.length === 0 ? (
          <p className="mt-2">{t('version.detail.none')}</p>
        ) : (
          <table className="mt-2 text-left text-sm">
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
      </div>

      <div>
        <h2 className="text-xl font-semibold">{t('version.detail.operations')}</h2>
        <table className="mt-2 text-left text-sm">
          <thead>
            <tr className="border-b border-border">
              <th scope="col" className="py-1 pr-6">
                {t('version.detail.method')}
              </th>
              <th scope="col" className="py-1 pr-6">
                {t('version.detail.path')}
              </th>
              <th scope="col" className="py-1">
                operationId
              </th>
            </tr>
          </thead>
          <tbody>
            {version.operations.map((op) => (
              <tr key={op.operationId} className="border-b border-border">
                <td className="py-1 pr-6 font-mono">{op.method}</td>
                <td className="py-1 pr-6 font-mono">{op.path}</td>
                <td className="py-1 font-mono">{op.operationId}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div aria-labelledby="lint-heading">
        <h2 id="lint-heading" className="text-xl font-semibold">
          {t('version.detail.lint')}
        </h2>
        {version.lintReport.valid ? (
          <p className="mt-2">{t('version.detail.lintOk')}</p>
        ) : (
          <p className="mt-2 text-red-800">
            {t('version.detail.lintErrors', { count: errors.length })}
          </p>
        )}
        {version.lintReport.issues.length > 0 ? (
          <ul className="mt-2 list-disc space-y-1 pl-6 text-sm">
            {version.lintReport.issues.map((issue, index) => (
              <li key={index}>
                {issue.line ? (
                  <strong>{t('version.detail.line', { line: issue.line })}: </strong>
                ) : null}
                {issue.message}{' '}
                <span className="font-mono text-muted-foreground">({issue.code})</span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      {version.status === 'in_review' ? <p role="status">{t('version.detail.inReview')}</p> : null}

      {canWrite && editable ? (
        <>
          <div className="space-y-3">
            <h2 className="text-xl font-semibold">{t('version.detail.replace')}</h2>
            <ReplaceOpenapiForm apiId={api.id} versionId={version.id} />
          </div>
          <SubmitVersionForm
            apiId={api.id}
            versionId={version.id}
            disabled={!version.lintReport.valid}
          />
        </>
      ) : null}
    </section>
  );
}
