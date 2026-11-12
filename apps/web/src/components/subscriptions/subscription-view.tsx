import type { SubscriptionDetail, SubscriptionSummary } from '@rid/contracts';
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';
import { Link } from '../../i18n/navigation';
import { localize } from '../../lib/localize';

const operationLabel = (detail: SubscriptionDetail, operationId: string): string => {
  const op = detail.operations.find((o) => o.operationId === operationId);
  return op ? `${op.method} ${op.path}` : operationId;
};

/** Facts of an access request, shared by the consumer and the provider views. */
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
    <ul className="font-mono">
      {ids.map((id) => (
        <li key={id}>{operationLabel(detail, id)}</li>
      ))}
    </ul>
  );

  return (
    <div className="space-y-8">
      <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
        <dt className="font-medium">{t('subscriptions.status')}</dt>
        <dd>
          <span data-testid="subscription-status">{t(`subscriptionStatus.${detail.status}`)}</span>
        </dd>
        <dt className="font-medium">
          {side === 'consumer' ? t('subscriptions.provider') : t('subscriptions.consumer')}
        </dt>
        <dd>
          {side === 'consumer' ? detail.api.entity.shortName : detail.application.entity.shortName}
        </dd>
        <dt className="font-medium">{t('subscriptions.api')}</dt>
        <dd>
          {detail.api.name} · {detail.version.version} ·{' '}
          {t(`classification.${detail.api.classification}`)}
        </dd>
        <dt className="font-medium">{t('subscriptions.application')}</dt>
        <dd>
          {side === 'consumer' ? (
            <Link href={`/my-apps/${detail.application.id}`} className="underline">
              {detail.application.name}
            </Link>
          ) : (
            detail.application.name
          )}{' '}
          <span className="font-mono text-muted-foreground">({detail.application.clientId})</span>
        </dd>
        <dt className="font-medium">{t('subscriptions.purpose')}</dt>
        <dd>
          {localize(detail.purpose.name, locale)}{' '}
          <span className="font-mono text-muted-foreground">({detail.purpose.code})</span>
        </dd>
        <dt className="font-medium">{t('subscriptions.purposeDetail')}</dt>
        <dd className="whitespace-pre-line">{detail.purposeDetail}</dd>
        <dt className="font-medium">{t('subscriptions.legalBasis')}</dt>
        <dd className="whitespace-pre-line">{detail.legalBasisText}</dd>
        {detail.legalReference ? (
          <>
            <dt className="font-medium">{t('subscriptions.legalReference')}</dt>
            <dd>{detail.legalReference}</dd>
          </>
        ) : null}
        <dt className="font-medium">{t('subscriptions.requestedOperations')}</dt>
        <dd>
          {detail.requestedOperations.length === 0 ? <p>{t('subscriptions.allReadOnly')}</p> : null}
          {operations(detail.effectiveRequestedOperations)}
        </dd>
        {decided ? (
          <>
            <dt className="font-medium">{t('subscriptions.approvedOperations')}</dt>
            <dd>{operations(detail.approvedOperations)}</dd>
            <dt className="font-medium">{t('subscriptions.validity')}</dt>
            <dd>
              {date(detail.validFrom)} – {date(detail.validUntil)}
            </dd>
          </>
        ) : (
          <>
            <dt className="font-medium">{t('subscriptions.requestedValidity')}</dt>
            <dd>{t('subscriptions.months', { count: detail.requestedValidityMonths })}</dd>
          </>
        )}
        <dt className="font-medium">{t('subscriptions.rateLimit')}</dt>
        <dd>
          {(detail.rateLimitPerMinute ?? detail.requestedRateLimit)
            ? t('subscriptions.perMinute', {
                limit: detail.rateLimitPerMinute ?? detail.requestedRateLimit ?? 0,
              })
            : t('subscriptions.defaultRateLimit', { limit: detail.defaultRateLimit })}
        </dd>
        <dt className="font-medium">{t('subscriptions.endUser')}</dt>
        <dd>
          {detail.endUserIdentificationRequired
            ? t('subscriptions.endUserRequired')
            : t('subscriptions.endUserNotRequired')}
        </dd>
      </dl>

      <div>
        <h2 className="text-xl font-semibold">{t('subscriptions.decisions')}</h2>
        {detail.decisions.length === 0 ? (
          <p className="mt-2 text-sm">{t('subscriptions.noDecisions')}</p>
        ) : (
          <ol className="mt-2 space-y-2 text-sm">
            {detail.decisions.map((d) => (
              <li key={d.decidedAt + d.decision}>
                <span className="font-medium">{t(`subscriptions.decision.${d.decision}`)}</span>{' '}
                {t(`subscriptions.by.${d.by}`)} ·{' '}
                {format.dateTime(new Date(d.decidedAt), {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                })}
                {d.comment ? <p className="whitespace-pre-line">{d.comment}</p> : null}
              </li>
            ))}
          </ol>
        )}
      </div>
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
    <table className="w-full text-left text-sm">
      <thead>
        <tr className="border-b border-border">
          <th scope="col" className="py-2 pr-4">
            {t('subscriptions.api')}
          </th>
          <th scope="col" className="py-2 pr-4">
            {side === 'consumer' ? t('subscriptions.provider') : t('subscriptions.consumer')}
          </th>
          <th scope="col" className="py-2 pr-4">
            {t('subscriptions.application')}
          </th>
          <th scope="col" className="py-2 pr-4">
            {t('subscriptions.purpose')}
          </th>
          <th scope="col" className="py-2 pr-4">
            {t('subscriptions.requestedAt')}
          </th>
          <th scope="col" className="py-2">
            {t('subscriptions.status')}
          </th>
        </tr>
      </thead>
      <tbody>
        {items.map((s) => (
          <tr key={s.id} className="border-b border-border">
            <td className="py-2 pr-4">
              <Link href={`${hrefBase}/${s.id}`} className="underline">
                {s.api.name} · {s.version.version}
              </Link>
            </td>
            <td className="py-2 pr-4">
              {side === 'consumer' ? s.api.entity.shortName : s.application.entity.shortName}
            </td>
            <td className="py-2 pr-4">{s.application.name}</td>
            <td className="py-2 pr-4">{localize(s.purpose.name, locale)}</td>
            <td className="py-2 pr-4">
              {format.dateTime(new Date(s.requestedAt), { dateStyle: 'medium' })}
            </td>
            <td className="py-2">{t(`subscriptionStatus.${s.status}`)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
