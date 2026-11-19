import type { NodeContract, NodeContractStatus } from '@den/contracts';
import { getFormatter, getTranslations } from 'next-intl/server';
import { Badge, type Tone } from '../ui/badge';

const TONE: Record<NodeContractStatus, Tone> = {
  matches: 'success',
  differs: 'warning',
  not_reported: 'neutral',
};

/** Status of what a node serves against a version's published contract (P-02). */
export async function NodeContractBadge({ status }: { status: NodeContractStatus }) {
  const t = await getTranslations('nodeContract');
  return (
    <Badge tone={TONE[status]} dot>
      {t(`status.${status}`)}
    </Badge>
  );
}

/**
 * What the status means and what to do: for `differs`, both hashes and since when; for
 * `not_reported`, whether the node has no service on the path or the service has no OpenAPI.
 * Traffic is never affected: the gateway keeps routing by the published contract.
 */
export async function NodeContractDetails({ contract }: { contract: NodeContract }) {
  const t = await getTranslations('nodeContract');
  const format = await getFormatter();
  const when = (iso: string) =>
    format.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'short' });
  const path = contract.servicePath;

  if (contract.status === 'matches') {
    return <p className="text-sm">{t('matches', { path })}</p>;
  }
  if (contract.status === 'not_reported') {
    return (
      <p className="text-sm">
        {contract.serviceName
          ? t('notReportedNoOpenapi', { service: contract.serviceName, path })
          : t('notReportedNoService', { path })}
      </p>
    );
  }
  return (
    <div className="space-y-2 text-sm">
      <p>{t('differs', { path })}</p>
      <dl className="grid gap-x-3 gap-y-1 sm:grid-cols-[max-content_1fr]">
        {contract.since ? (
          <>
            <dt className="font-medium">{t('since')}</dt>
            <dd>{when(contract.since)}</dd>
          </>
        ) : null}
        <dt className="font-medium">{t('expected')}</dt>
        <dd>
          <code className="break-all text-xs">{contract.expectedSha256}</code>
        </dd>
        <dt className="font-medium">{t('reported')}</dt>
        <dd>
          <code className="break-all text-xs">{contract.reportedSha256}</code>
        </dd>
      </dl>
      <p>{t('differsNext')}</p>
    </div>
  );
}
