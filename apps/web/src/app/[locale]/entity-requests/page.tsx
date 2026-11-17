import { entityRequestListSchema } from '@den/contracts';
import type { Metadata } from 'next';
import { getFormatter, getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { StatusBadge } from '../../../components/ui/badge';
import { buttonVariants } from '../../../components/ui/button';
import { EmptyState, Page, PageHeader, Section } from '../../../components/ui/page';
import { Link } from '../../../i18n/navigation';
import { apiGet } from '../../../lib/api';
import { getViewer } from '../../../lib/viewer';

interface PageProps {
  params: Promise<{ locale: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'entityRequests' });
  return { title: t('title') };
}

/** Onboarding requests the signed-in person filed (SPEC.md §4.1, ADR-0018). */
export default async function EntityRequestsPage({ params }: PageProps) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations();
  const format = await getFormatter();
  if (!(await getViewer()).authenticated) notFound();
  const requests = await apiGet('/entity-requests', entityRequestListSchema);

  const newLink = (
    <Link href="/entity-requests/new" className={buttonVariants()}>
      {t('entityRequests.new')}
    </Link>
  );

  return (
    <Page>
      <PageHeader
        title={t('entityRequests.title')}
        description={t('entityRequests.lead')}
        actions={newLink}
      />
      <Section title={t('entityRequests.mine')}>
        {requests.items.length === 0 ? (
          <EmptyState>{t('entityRequests.empty')}</EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">{t('entityRequests.entity')}</th>
                  <th scope="col">{t('entityRequests.status')}</th>
                  <th scope="col">{t('entityRequests.createdAt')}</th>
                </tr>
              </thead>
              <tbody>
                {requests.items.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <Link href={`/entity-requests/${r.id}`} className="link">
                        {r.legalName}
                      </Link>
                    </td>
                    <td>
                      <StatusBadge status={r.status}>{t(`entityStatus.${r.status}`)}</StatusBadge>
                    </td>
                    <td className="whitespace-nowrap text-muted-foreground">
                      {format.dateTime(new Date(r.createdAt), { dateStyle: 'medium' })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </Page>
  );
}
