import type { AuditItem } from '@rid/contracts';
import { getFormatter, getTranslations } from 'next-intl/server';
import { Link } from '../../i18n/navigation';

type T = Awaited<ReturnType<typeof getTranslations>>;

/** Translated action name; the raw code when no translation exists yet. */
const actionLabel = (t: T, action: string): string =>
  t.has(`audit.actions.${action}`) ? t(`audit.actions.${action}`) : action;

/** A status of a subscription or an API version, translated when known. */
const statusLabel = (t: T, status: string): string => {
  for (const ns of ['subscriptionStatus', 'versionStatus']) {
    if (t.has(`${ns}.${status}`)) return t(`${ns}.${status}`);
  }
  return status;
};

function actorLabel(t: T, actor: AuditItem['actor']): string {
  if (actor.type === 'system') return t('audit.system', { name: actor.system ?? '' });
  const entity = actor.entity?.shortName;
  if (actor.name) return entity ? `${actor.name} (${entity})` : actor.name;
  return entity ? t('audit.entityActor', { entity }) : actor.type;
}

/** Link to the platform timeline of the event's object, for the kinds that have one. */
const timelineHref = (target: AuditItem['target']): string | undefined =>
  target.type === 'subscription' || target.type === 'api'
    ? `/audit/${target.type}/${target.id}`
    : undefined;

/** Events of one object, oldest first, as an ordered list (SPEC.md §6). */
export async function AuditTimeline({
  items,
  headingLevel = 2,
}: {
  items: readonly AuditItem[];
  headingLevel?: 2 | 3;
}) {
  const t = await getTranslations();
  const format = await getFormatter();
  const Heading = headingLevel === 2 ? 'h2' : 'h3';
  return (
    <section aria-labelledby="audit-timeline" className="space-y-3">
      <Heading id="audit-timeline" className="text-xl font-semibold">
        {t('audit.timeline')}
      </Heading>
      {items.length === 0 ? (
        <p className="text-sm">{t('audit.noEvents')}</p>
      ) : (
        <ol className="space-y-3 border-l border-border pl-4 text-sm" data-testid="audit-timeline">
          {items.map((item) => (
            <li key={item.seq}>
              <p>
                <span className="font-medium">{actionLabel(t, item.action)}</span>
                {' · '}
                <time dateTime={item.occurredAt}>
                  {format.dateTime(new Date(item.occurredAt), {
                    dateStyle: 'medium',
                    timeStyle: 'short',
                  })}
                </time>
              </p>
              <p className="text-muted-foreground">{actorLabel(t, item.actor)}</p>
              {item.status?.to ? (
                <p>
                  {t('audit.statusChange', {
                    from: item.status.from ? statusLabel(t, item.status.from) : '—',
                    to: statusLabel(t, item.status.to),
                  })}
                </p>
              ) : null}
              {item.comment ? <p className="whitespace-pre-line">{item.comment}</p> : null}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/** Network-wide events, newest first (platform view). */
export async function AuditEventTable({ items }: { items: readonly AuditItem[] }) {
  const t = await getTranslations();
  const format = await getFormatter();
  return (
    <table className="w-full text-left text-sm">
      <thead>
        <tr className="border-b border-border">
          <th scope="col" className="py-2 pr-4">
            {t('audit.columns.seq')}
          </th>
          <th scope="col" className="py-2 pr-4">
            {t('audit.columns.when')}
          </th>
          <th scope="col" className="py-2 pr-4">
            {t('audit.columns.action')}
          </th>
          <th scope="col" className="py-2 pr-4">
            {t('audit.columns.actor')}
          </th>
          <th scope="col" className="py-2">
            {t('audit.columns.target')}
          </th>
        </tr>
      </thead>
      <tbody>
        {items.map((item) => {
          const href = timelineHref(item.target);
          return (
            <tr key={item.seq} className="border-b border-border">
              <td className="py-2 pr-4 font-mono">{item.seq}</td>
              <td className="py-2 pr-4">
                {format.dateTime(new Date(item.occurredAt), {
                  dateStyle: 'short',
                  timeStyle: 'short',
                })}
              </td>
              <td className="py-2 pr-4">{actionLabel(t, item.action)}</td>
              <td className="py-2 pr-4">{actorLabel(t, item.actor)}</td>
              <td className="py-2 font-mono text-xs break-all">
                {href ? (
                  <Link href={href} className="underline">
                    {item.target.type} {item.target.id}
                  </Link>
                ) : (
                  `${item.target.type} ${item.target.id}`
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
