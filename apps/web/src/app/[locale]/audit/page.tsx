import { auditEventPageSchema, chainCheckSchema } from '@rid/contracts';
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
  const [check, events] = await Promise.all([
    query.verify === '1' ? apiGet('/audit/verify', chainCheckSchema) : undefined,
    apiGet(`/audit/events?limit=50${cursor ? `&cursor=${cursor}` : ''}`, auditEventPageSchema),
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
            {t('verify.checkedAt', {
              date: format.dateTime(new Date(check.checkedAt), {
                dateStyle: 'medium',
                timeStyle: 'medium',
              }),
            })}
          </p>
        </Notice>
      ) : null}

      <Section id="recent-heading" title={t('recent')}>
        {events.items.length === 0 ? (
          <EmptyState>{t('noEvents')}</EmptyState>
        ) : (
          <AuditEventTable items={events.items} />
        )}
        {events.nextCursor ? (
          <div className="flex justify-center">
            <Button asChild variant="outline">
              <Link href={`/audit?cursor=${events.nextCursor}`}>{t('older')}</Link>
            </Button>
          </div>
        ) : null}
      </Section>
    </Page>
  );
}
