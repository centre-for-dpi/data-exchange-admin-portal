import type { AuditItem } from '@den/contracts';
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
    <section aria-labelledby="audit-timeline" className="space-y-4">
      <Heading
        id="audit-timeline"
        className={headingLevel === 2 ? 'text-2xl font-bold' : 'text-lg font-semibold'}
      >
        {t('audit.timeline')}
      </Heading>
      {items.length === 0 ? (
        <p className="card p-6 text-sm text-muted-foreground">{t('audit.noEvents')}</p>
      ) : (
        <div className="card p-6">
          <ol
            className="relative space-y-5 text-sm before:absolute before:top-2 before:bottom-2 before:left-[5px] before:w-px before:bg-border"
            data-testid="audit-timeline"
          >
            {items.map((item) => (
              <li key={item.seq} className="relative space-y-0.5 pl-7">
                <span
                  aria-hidden="true"
                  className="absolute top-1.5 left-0 size-[11px] rounded-full border-2 border-background bg-primary ring-1 ring-primary"
                />
                <p>
                  <span className="font-semibold text-foreground-strong">
                    {actionLabel(t, item.action)}
                  </span>
                  <span className="text-muted-foreground">{' · '}</span>
                  <time dateTime={item.occurredAt} className="text-muted-foreground">
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
                {item.comment ? (
                  <p className="mt-1 rounded-xl bg-surface-app px-3 py-2 whitespace-pre-line">
                    {item.comment}
                  </p>
                ) : null}
              </li>
            ))}
          </ol>
        </div>
      )}
    </section>
  );
}

/** Network-wide events, newest first (platform view). */
export async function AuditEventTable({ items }: { items: readonly AuditItem[] }) {
  const t = await getTranslations();
  const format = await getFormatter();
  return (
    <div className="table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            <th scope="col">{t('audit.columns.seq')}</th>
            <th scope="col">{t('audit.columns.when')}</th>
            <th scope="col">{t('audit.columns.action')}</th>
            <th scope="col">{t('audit.columns.actor')}</th>
            <th scope="col">{t('audit.columns.target')}</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => {
            const href = timelineHref(item.target);
            return (
              <tr key={item.seq}>
                <td className="font-mono text-muted-foreground">{item.seq}</td>
                <td className="whitespace-nowrap">
                  {format.dateTime(new Date(item.occurredAt), {
                    dateStyle: 'short',
                    timeStyle: 'short',
                  })}
                </td>
                <td className="font-medium text-foreground-strong">
                  {actionLabel(t, item.action)}
                </td>
                <td>{actorLabel(t, item.actor)}</td>
                <td className="font-mono text-xs break-all">
                  {href ? (
                    <Link href={href} className="link">
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
    </div>
  );
}
