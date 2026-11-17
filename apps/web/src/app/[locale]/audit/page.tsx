import { auditEventPageSchema, chainCheckSchema } from '@den/contracts';
import type { Metadata } from 'next';
import { getFormatter, getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { AuditEventTable } from '../../../components/audit/audit-views';
import { Button } from '../../../components/ui/button';
import { Notice } from '../../../components/ui/notice';
import { EmptyState, Page, PageHeader, Section } from '../../../components/ui/page';
import { Link } from '../../../i18n/navigation';
import { apiGet } from '../../../lib/api';
import { getViewer } from '../../../lib/viewer';

interface PageProps {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/** Platform roles that read the network-wide trail (the API checks it again). */
const AUDIT_ROLES = ['platform_admin', 'platform_reviewer', 'regulator', 'auditor'];

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'audit' });
  return { title: t('title') };
}

export default async function AuditPage({ params, searchParams }: PageProps) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('audit');
  const format = await getFormatter();
  const viewer = await getViewer();
  if (!viewer.authenticated) notFound();

  // Entity members see the timelines on each object's page.
  if (!viewer.platformRoles.some((r) => AUDIT_ROLES.includes(r))) {
    return (
      <Page>
        <PageHeader title={t('title')} />
        <EmptyState>{t('entityNote')}</EmptyState>
      </Page>
    );
  }

  const query = await searchParams;
  const cursor = typeof query.cursor === 'string' && /^\d+$/.test(query.cursor) ? query.cursor : '';
  // Filters (M2-09): kept in the URL so a filtered view and its export can be shared.
  const text = (key: string) => {
    const value = query[key];
    return typeof value === 'string' ? value.trim() : '';
  };
  const day = (key: string) => (/^\d{4}-\d{2}-\d{2}$/.test(text(key)) ? text(key) : '');
  const filters = new URLSearchParams();
  if (/^[a-z_]+(\.[a-z_]+)?$/.test(text('action'))) filters.set('action', text('action'));
  if (/^[a-z_]+$/.test(text('targetType'))) filters.set('targetType', text('targetType'));
  if (text('targetId')) filters.set('targetId', text('targetId').slice(0, 100));
  if (day('from')) filters.set('from', `${day('from')}T00:00:00Z`);
  if (day('to')) filters.set('to', `${day('to')}T23:59:59Z`);
  const filtered = filters.toString();
  // The same filters as the user typed them, for links back to this page.
  const shown = new URLSearchParams();
  for (const key of ['action', 'targetType', 'targetId'] as const) {
    if (filters.get(key)) shown.set(key, filters.get(key) ?? '');
  }
  if (day('from')) shown.set('from', day('from'));
  if (day('to')) shown.set('to', day('to'));
  const kept = shown.toString();
  const [check, events] = await Promise.all([
    query.verify === '1' ? apiGet('/audit/verify', chainCheckSchema) : undefined,
    apiGet(
      `/audit/events?limit=50${cursor ? `&cursor=${cursor}` : ''}${filtered ? `&${filtered}` : ''}`,
      auditEventPageSchema,
    ),
  ]);

  return (
    <Page>
      <PageHeader title={t('title')} />

      <section
        aria-labelledby="verify-heading"
        className="card flex flex-col gap-5 bg-surface-panel p-6 md:flex-row md:items-start md:justify-between md:p-8"
      >
        <div className="max-w-3xl space-y-2">
          <h2 id="verify-heading" className="text-2xl font-bold">
            {t('verify.title')}
          </h2>
          <p className="text-sm leading-relaxed">{t('verify.description')}</p>
        </div>
        {/* A plain GET form: works without JavaScript and the result is a shareable URL. */}
        <form method="get" className="shrink-0">
          <input type="hidden" name="verify" value="1" />
          <Button type="submit">{t('verify.button')}</Button>
        </form>
      </section>
      {check ? (
        <Notice
          tone={check.valid ? 'success' : 'danger'}
          role="status"
          data-testid="chain-check"
          className="max-w-3xl space-y-1"
        >
          <p className="font-semibold">
            {check.valid
              ? t('verify.valid', { verified: check.verified })
              : t('verify.invalid', {
                  seq: check.brokenAt?.seq ?? '',
                  reason: check.brokenAt ? t(`verify.reasons.${check.brokenAt.reason}`) : '',
                })}
          </p>
          {check.lastSeq && check.lastHash ? (
            <p className="font-mono text-xs break-all">
              {t('verify.head', { seq: check.lastSeq, hash: check.lastHash })}
            </p>
          ) : null}
          {check.unchained > 0 ? <p>{t('verify.unchained', { count: check.unchained })}</p> : null}
          <p>
            {check.anchors.problems.length > 0
              ? t('verify.anchorsBroken', {
                  days: check.anchors.problems.map((p) => p.day).join(', '),
                })
              : t('verify.anchors', {
                  count: check.anchors.checked,
                  day: check.anchors.lastDay ?? '-',
                })}
          </p>
          <p>
            {t('verify.checkedAt', {
              date: format.dateTime(new Date(check.checkedAt), {
                dateStyle: 'medium',
                timeStyle: 'medium',
              }),
            })}
          </p>
        </Notice>
      ) : null}

      <Section title={t('filters.title')}>
        <form
          method="get"
          className="card grid gap-4 p-6 md:grid-cols-3"
          aria-label={t('filters.title')}
        >
          {(
            [
              ['action', 'text'],
              ['targetType', 'text'],
              ['targetId', 'text'],
              ['from', 'date'],
              ['to', 'date'],
            ] as const
          ).map(([name, type]) => (
            <label key={name} className="block text-sm font-medium text-foreground-strong">
              {t(`filters.${name}`)}
              <input
                type={type}
                name={name}
                defaultValue={type === 'date' ? day(name) : text(name)}
                className="mt-1.5 block w-full rounded-[var(--radius-control)] border border-border-control bg-background px-3.5 py-2.5 text-sm"
              />
            </label>
          ))}
          <div className="flex flex-wrap items-end gap-3">
            <Button type="submit">{t('filters.apply')}</Button>
            <Button asChild variant="outline">
              <Link href="/audit">{t('filters.clear')}</Link>
            </Button>
          </div>
        </form>
        <p className="flex flex-wrap items-center gap-4 text-sm">
          <span>{t('export.lead')}</span>
          <a
            href={`/files/audit/export?format=csv${filtered ? `&${filtered}` : ''}`}
            className="link"
            download
          >
            {t('export.csv')}
          </a>
          <a
            href={`/files/audit/export?format=json${filtered ? `&${filtered}` : ''}`}
            className="link"
            download
          >
            {t('export.json')}
          </a>
        </p>
      </Section>

      <Section id="recent-heading" title={t('recent')}>
        {events.items.length === 0 ? (
          <EmptyState>{t('noEvents')}</EmptyState>
        ) : (
          <AuditEventTable items={events.items} />
        )}
        {events.nextCursor ? (
          <div className="flex justify-center">
            <Button asChild variant="outline">
              <Link href={`/audit?cursor=${events.nextCursor}${kept ? `&${kept}` : ''}`}>
                {t('older')}
              </Link>
            </Button>
          </div>
        ) : null}
      </Section>
    </Page>
  );
}
