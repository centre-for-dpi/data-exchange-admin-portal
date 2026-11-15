import { type ApiVersionDetail, xroadServicePath } from '@rid/contracts';
import { getFormatter, getTranslations } from 'next-intl/server';
import { Badge, StatusBadge } from '../ui/badge';
import { Notice } from '../ui/notice';
import { Section } from '../ui/page';
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
    version.upstream.type === 'node'
      ? version.upstream.servicePath
      : version.upstream.type === 'xroad'
        ? `X-Road ${xroadServicePath(version.upstream.serviceId)}${version.upstream.servicePath}`
        : version.upstream.url;
  const when = (value: string | null) =>
    value ? format.dateTime(new Date(value), { dateStyle: 'medium', timeStyle: 'short' }) : '—';

  const yesNo = (value: boolean, tone: 'info' | 'warning') =>
    value ? <Badge tone={tone}>{t('version.detail.yes')}</Badge> : t('version.detail.no');

  return (
    <>
      <div className="card p-6">
        <dl className="facts">
          <dt>{t('version.detail.status')}</dt>
          <dd data-testid="version-status">
            <StatusBadge status={version.status}>
              {t(`versionStatus.${version.status}`)}
            </StatusBadge>
          </dd>
          <dt>{t('version.detail.basePath')}</dt>
          <dd className="font-mono">{version.basePath}</dd>
          <dt>{t('version.detail.upstream')}</dt>
          <dd className="font-mono">{upstream}</dd>
          {version.node ? (
            <>
              <dt>{t('version.detail.node')}</dt>
              <dd data-testid="version-node">
                <span className="font-medium">{version.node.name}</span>{' '}
                <StatusBadge status={version.node.status}>
                  {t(`nodeStatus.${version.node.status}`)}
                </StatusBadge>
                <span className="block text-sm text-muted-foreground">
                  {t('nodes.lastHeartbeat')}: {when(version.node.lastHeartbeatAt)}
                </span>
              </dd>
            </>
          ) : null}
          <dt>{t('version.detail.purposes')}</dt>
          <dd>
            {version.allowedPurposes.map((code) => purposeNames.get(code) ?? code).join(', ')}
          </dd>
        </dl>
      </div>

      {version.reviews.length > 0 ? (
        <Section title={t('version.detail.reviews')}>
          <ul className="space-y-3 text-sm">
            {version.reviews.map((review, index) => (
              <li key={index} className="card space-y-2 px-5 py-4">
                <p className="flex flex-wrap items-center gap-3">
                  <StatusBadge status={review.decision}>
                    {t(`reviewDecision.${review.decision}`)}
                  </StatusBadge>
                  <span className="text-muted-foreground">
                    {format.dateTime(new Date(review.createdAt), {
                      dateStyle: 'medium',
                      timeStyle: 'short',
                    })}
                  </span>
                </p>
                {review.comment ? <p className="leading-relaxed">{review.comment}</p> : null}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      <Section title={t('version.detail.exposedFields')}>
        {version.exposedFields.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('version.detail.none')}</p>
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
      </Section>

      <Section title={t('version.detail.operations')}>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">{t('version.detail.method')}</th>
                <th scope="col">{t('version.detail.path')}</th>
                <th scope="col">operationId</th>
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
                  <td className="font-mono">{op.operationId}</td>
                  <td>{dataSubjectLabel(t, op.dataSubject)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section title={t('version.detail.lint')}>
        {version.lintReport.valid ? (
          <Notice tone="success">{t('version.detail.lintOk')}</Notice>
        ) : (
          <Notice tone="danger">{t('version.detail.lintErrors', { count: errors.length })}</Notice>
        )}
        {version.lintReport.issues.length > 0 ? (
          <ul className="card divide-y divide-border text-sm">
            {version.lintReport.issues.map((issue, index) => (
              <li key={index} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-5 py-3">
                <span
                  aria-hidden="true"
                  className={`size-2 shrink-0 self-center rounded-full ${
                    issue.severity === 'error' ? 'bg-danger-border' : 'bg-warning-border'
                  }`}
                />
                {issue.line ? (
                  <strong>{t('version.detail.line', { line: issue.line })}:</strong>
                ) : null}
                <span>{issue.message}</span>
                <span className="font-mono text-muted-foreground">({issue.code})</span>
              </li>
            ))}
          </ul>
        ) : null}
      </Section>
    </>
  );
}
