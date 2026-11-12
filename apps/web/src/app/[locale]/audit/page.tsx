import { auditEventPageSchema, chainCheckSchema } from '@rid/contracts';
import type { Metadata } from 'next';
import { getFormatter, getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { AuditEventTable } from '../../../components/audit/audit-views';
import { Button } from '../../../components/ui/button';
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
      <section className="mx-auto max-w-6xl space-y-4 px-4 py-10">
        <h1 className="text-2xl font-bold">{t('title')}</h1>
        <p>{t('entityNote')}</p>
      </section>
    );
  }

  const query = await searchParams;
  const cursor = typeof query.cursor === 'string' && /^\d+$/.test(query.cursor) ? query.cursor : '';
  const [check, events] = await Promise.all([
    query.verify === '1' ? apiGet('/audit/verify', chainCheckSchema) : undefined,
    apiGet(`/audit/events?limit=50${cursor ? `&cursor=${cursor}` : ''}`, auditEventPageSchema),
  ]);

  return (
    <section className="mx-auto max-w-6xl space-y-8 px-4 py-10">
      <h1 className="text-2xl font-bold">{t('title')}</h1>

      <section aria-labelledby="verify-heading" className="space-y-3">
        <h2 id="verify-heading" className="text-xl font-semibold">
          {t('verify.title')}
        </h2>
        <p className="max-w-3xl text-sm">{t('verify.description')}</p>
        {/* A plain GET form: works without JavaScript and the result is a shareable URL. */}
        <form method="get">
          <input type="hidden" name="verify" value="1" />
          <Button type="submit">{t('verify.button')}</Button>
        </form>
        {check ? (
          <div
            role="status"
            data-testid="chain-check"
            className={`max-w-3xl space-y-1 rounded-md border p-3 text-sm ${
              check.valid ? 'border-green-700' : 'border-red-700 text-red-800'
            }`}
          >
            <p className="font-medium">
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
            {check.unchained > 0 ? (
              <p>{t('verify.unchained', { count: check.unchained })}</p>
            ) : null}
            <p className="text-muted-foreground">
              {t('verify.checkedAt', {
                date: format.dateTime(new Date(check.checkedAt), {
                  dateStyle: 'medium',
                  timeStyle: 'medium',
                }),
              })}
            </p>
          </div>
        ) : null}
      </section>

      <section aria-labelledby="recent-heading" className="space-y-3">
        <h2 id="recent-heading" className="text-xl font-semibold">
          {t('recent')}
        </h2>
        {events.items.length === 0 ? (
          <p>{t('noEvents')}</p>
        ) : (
          <AuditEventTable items={events.items} />
        )}
        {events.nextCursor ? (
          <Link href={`/audit?cursor=${events.nextCursor}`} className="underline">
            {t('older')}
          </Link>
        ) : null}
      </section>
    </section>
  );
}
