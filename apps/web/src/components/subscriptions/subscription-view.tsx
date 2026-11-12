import type { SubscriptionDetail, SubscriptionSummary } from '@rid/contracts';
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';
import { Link } from '../../i18n/navigation';
import { localize } from '../../lib/localize';
import { StatusBadge } from '../ui/badge';

const operationLabel = (detail: SubscriptionDetail, operationId: string): string => {
  const op = detail.operations.find((o) => o.operationId === operationId);
  return op ? `${op.method} ${op.path}` : operationId;
};

/**
 * Facts of an access request, shared by the consumer and the provider views. Decisions (who,
 * when, why) are shown by the audit timeline next to it.
 */
export async function SubscriptionFacts({
  detail,
  side,
}: {
  detail: SubscriptionDetail;
  side: 'consumer' | 'provider';
}) {
  const t = await getTranslations();
  const locale = await getLocale();
  const format = await getFormatter();
  const date = (iso: string) => format.dateTime(new Date(iso), { dateStyle: 'medium' });
  const decided = detail.approvedOperations.length > 0;
  const operations = (ids: readonly string[]) => (
    <ul className="space-y-1 font-mono text-[0.8125rem]">
      {ids.map((id) => (
        <li key={id}>{operationLabel(detail, id)}</li>
      ))}
    </ul>
  );

  return (
    <div className="card p-6">
      <dl className="facts">
        <dt>{t('subscriptions.status')}</dt>
        <dd>
          <StatusBadge status={detail.status} data-testid="subscription-status">
            {t(`subscriptionStatus.${detail.status}`)}
          </StatusBadge>
        </dd>
        <dt>{side === 'consumer' ? t('subscriptions.provider') : t('subscriptions.consumer')}</dt>
        <dd>
          {side === 'consumer' ? detail.api.entity.shortName : detail.application.entity.shortName}
        </dd>
        <dt>{t('subscriptions.api')}</dt>
        <dd>
          {detail.api.name} · {detail.version.version} ·{' '}
          {t(`classification.${detail.api.classification}`)}
        </dd>
        <dt>{t('subscriptions.application')}</dt>
        <dd>
          {side === 'consumer' ? (
            <Link href={`/my-apps/${detail.application.id}`} className="link">
              {detail.application.name}
            </Link>
          ) : (
            detail.application.name
          )}{' '}
          <span className="font-mono text-muted-foreground">({detail.application.clientId})</span>
        </dd>
        <dt>{t('subscriptions.purpose')}</dt>
        <dd>
          {localize(detail.purpose.name, locale)}{' '}
          <span className="font-mono text-muted-foreground">({detail.purpose.code})</span>
        </dd>
        <dt>{t('subscriptions.purposeDetail')}</dt>
        <dd className="whitespace-pre-line">{detail.purposeDetail}</dd>
        <dt>{t('subscriptions.legalBasis')}</dt>
        <dd className="whitespace-pre-line">{detail.legalBasisText}</dd>
        {detail.legalReference ? (
          <>
            <dt>{t('subscriptions.legalReference')}</dt>
            <dd>{detail.legalReference}</dd>
          </>
        ) : null}
        <dt>{t('subscriptions.requestedOperations')}</dt>
        <dd>
          {detail.requestedOperations.length === 0 ? <p>{t('subscriptions.allReadOnly')}</p> : null}
          {operations(detail.effectiveRequestedOperations)}
        </dd>
        {decided ? (
          <>
            <dt>{t('subscriptions.approvedOperations')}</dt>
            <dd>{operations(detail.approvedOperations)}</dd>
            <dt>{t('subscriptions.validity')}</dt>
            <dd>
              {date(detail.validFrom)} – {date(detail.validUntil)}
            </dd>
          </>
        ) : (
          <>
            <dt>{t('subscriptions.requestedValidity')}</dt>
            <dd>{t('subscriptions.months', { count: detail.requestedValidityMonths })}</dd>
          </>
        )}
        <dt>{t('subscriptions.rateLimit')}</dt>
        <dd>
          {(detail.rateLimitPerMinute ?? detail.requestedRateLimit)
            ? t('subscriptions.perMinute', {
                limit: detail.rateLimitPerMinute ?? detail.requestedRateLimit ?? 0,
              })
            : t('subscriptions.defaultRateLimit', { limit: detail.defaultRateLimit })}
        </dd>
        <dt>{t('subscriptions.endUser')}</dt>
        <dd>
          {detail.endUserIdentificationRequired
            ? t('subscriptions.endUserRequired')
            : t('subscriptions.endUserNotRequired')}
        </dd>
      </dl>
    </div>
  );
}

/** Table of access requests; `hrefBase` is the detail route (consumer or provider side). */
export async function SubscriptionTable({
  items,
  side,
  hrefBase,
}: {
  items: readonly SubscriptionSummary[];
  side: 'consumer' | 'provider';
  hrefBase: string;
}) {
  const t = await getTranslations();
  const locale = await getLocale();
  const format = await getFormatter();
  return (
    <div className="table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            <th scope="col">{t('subscriptions.api')}</th>
            <th scope="col">
              {side === 'consumer' ? t('subscriptions.provider') : t('subscriptions.consumer')}
            </th>
            <th scope="col">{t('subscriptions.application')}</th>
            <th scope="col">{t('subscriptions.purpose')}</th>
            <th scope="col">{t('subscriptions.requestedAt')}</th>
            <th scope="col">{t('subscriptions.status')}</th>
          </tr>
        </thead>
        <tbody>
          {items.map((s) => (
            <tr key={s.id}>
              <td>
                <Link href={`${hrefBase}/${s.id}`} className="link">
                  {s.api.name} · {s.version.version}
                </Link>
              </td>
              <td>
                {side === 'consumer' ? s.api.entity.shortName : s.application.entity.shortName}
              </td>
              <td>{s.application.name}</td>
              <td>{localize(s.purpose.name, locale)}</td>
              <td className="whitespace-nowrap text-muted-foreground">
                {format.dateTime(new Date(s.requestedAt), { dateStyle: 'medium' })}
              </td>
              <td>
                <StatusBadge status={s.status}>{t(`subscriptionStatus.${s.status}`)}</StatusBadge>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
