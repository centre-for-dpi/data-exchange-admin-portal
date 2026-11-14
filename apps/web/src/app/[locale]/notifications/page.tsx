import { notificationPageSchema, notificationPreferencesSchema } from '@rid/contracts';
import type { Metadata } from 'next';
import { getFormatter, getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { MarkAllReadForm, PreferencesForm } from '../../../components/notifications/forms';
import { EmptyState, Page, PageHeader, Section } from '../../../components/ui/page';
import { apiGet } from '../../../lib/api';
import { getViewer } from '../../../lib/viewer';

interface PageProps {
  params: Promise<{ locale: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'notifications' });
  return { title: t('title') };
}

/** The signed-in person's notices and their e-mail choices (SPEC.md §7, M2-08). */
export default async function NotificationsPage({ params }: PageProps) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('notifications');
  const format = await getFormatter();
  if (!(await getViewer()).authenticated) notFound();
  const [page, preferences] = await Promise.all([
    apiGet('/me/notifications?limit=50', notificationPageSchema),
    apiGet('/me/notification-preferences', notificationPreferencesSchema),
  ]);

  return (
    <Page>
      <PageHeader
        title={t('title')}
        description={t('lead', { count: page.unread })}
        actions={page.unread > 0 ? <MarkAllReadForm /> : null}
      />
      {page.items.length === 0 ? (
        <EmptyState>{t('empty')}</EmptyState>
      ) : (
        <ul className="space-y-3">
          {page.items.map((n) => {
            const params = {
              entity: n.params.entity ?? '',
              api: n.params.api ?? '',
              version: n.params.version ?? '',
              application: n.params.application ?? '',
              decision: n.params.decision ?? '',
              what: n.params.what ?? '',
              date: n.params.date
                ? format.dateTime(new Date(n.params.date), { dateStyle: 'long' })
                : '',
            };
            return (
              <li key={n.id} className={`card p-4 ${n.readAt ? '' : 'border-primary'}`}>
                <a
                  href={`/files/notifications/${n.id}/open?locale=${locale}`}
                  className="link font-semibold"
                >
                  {t(`kinds.${n.kind}`, params)}
                </a>
                <p className="mt-1 text-sm text-muted-foreground">
                  {format.dateTime(new Date(n.createdAt), {
                    dateStyle: 'medium',
                    timeStyle: 'short',
                  })}
                  {n.readAt ? '' : ` · ${t('unread')}`}
                </p>
              </li>
            );
          })}
        </ul>
      )}
      <Section title={t('preferencesTitle')} description={t('preferencesLead')}>
        <div className="card max-w-3xl p-6 md:p-8">
          <PreferencesForm items={preferences.items} />
        </div>
      </Section>
    </Page>
  );
}
