import type { ApiVersionDetail } from '@rid/contracts';
import { getFormatter, getTranslations } from 'next-intl/server';
import { dataSubjectLabel } from './data-subject';

/**
 * Service sheet of a version (SPEC.md §3 "ficha del servicio"): what the provider declared and
 * what the reviewer checks (minimization of exposed personal data, purposes, lint). Shared by the
 * provider's version page and the operator's review page.
 */
export async function VersionSheet({
  version,
  purposeNames,
}: {
  version: ApiVersionDetail;
  purposeNames: Map<string, string>;
}) {
  const t = await getTranslations();
  const format = await getFormatter();
  const errors = version.lintReport.issues.filter((i) => i.severity === 'error');
  const upstream =
    version.upstream.type === 'node' ? version.upstream.servicePath : version.upstream.url;

  return (
    <>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1 text-sm">
        <dt className="font-medium">{t('version.detail.status')}</dt>
        <dd data-testid="version-status">{t(`versionStatus.${version.status}`)}</dd>
        <dt className="font-medium">{t('version.detail.basePath')}</dt>
        <dd className="font-mono">{version.basePath}</dd>
        <dt className="font-medium">{t('version.detail.upstream')}</dt>
        <dd className="font-mono">{upstream}</dd>
        <dt className="font-medium">{t('version.detail.purposes')}</dt>
        <dd>{version.allowedPurposes.map((code) => purposeNames.get(code) ?? code).join(', ')}</dd>
      </dl>

      {version.reviews.length > 0 ? (
        <div>
          <h2 className="text-xl font-semibold">{t('version.detail.reviews')}</h2>
          <ul className="mt-2 space-y-2 text-sm">
            {version.reviews.map((review, index) => (
              <li key={index} className="rounded-md border border-border p-3">
                <p className="font-medium">
                  {t(`reviewDecision.${review.decision}`)} ·{' '}
                  {format.dateTime(new Date(review.createdAt), {
                    dateStyle: 'medium',
                    timeStyle: 'short',
                  })}
                </p>
                {review.comment ? <p className="mt-1">{review.comment}</p> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

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
              <th scope="col" className="py-1 pr-6">
                operationId
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
                <td className="py-1 pr-6 font-mono">{op.operationId}</td>
                <td className="py-1">{dataSubjectLabel(t, op.dataSubject)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div>
        <h2 className="text-xl font-semibold">{t('version.detail.lint')}</h2>
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
    </>
  );
}
