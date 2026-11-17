import { networkBootcampSchema } from '@den/contracts';
import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { Badge } from '../../../../components/ui/badge';
import { EmptyState, Page, PageHeader } from '../../../../components/ui/page';
import { Link } from '../../../../i18n/navigation';
import { apiGet } from '../../../../lib/api';
import { getViewer } from '../../../../lib/viewer';

interface PageProps {
  params: Promise<{ locale: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'bootcamp.network' });
  return { title: t('title') };
}

const ROLES = ['platform_admin', 'platform_reviewer', 'regulator'];

/** Operator: who is ready for the bootcamp and what each entity still lacks (M4-07). */
export default async function NetworkBootcampPage({ params }: PageProps) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations();
  const viewer = await getViewer();
  if (!viewer.platformRoles.some((r) => ROLES.includes(r))) notFound();
  const list = await apiGet('/admin/bootcamp', networkBootcampSchema);

  return (
    <Page>
      <PageHeader
        eyebrow={t('nav.operator')}
        title={t('bootcamp.network.title')}
        description={t('bootcamp.network.lead')}
        actions={
          <Link href="/operator" className="link">
            {t('nav.operator')}
          </Link>
        }
      />
      {list.items.length === 0 ? (
        <EmptyState>{t('bootcamp.network.empty')}</EmptyState>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">{t('operator.entity')}</th>
                <th scope="col">{t('bootcamp.network.progress')}</th>
                <th scope="col">{t('bootcamp.network.missing')}</th>
              </tr>
            </thead>
            <tbody>
              {list.items.map((row) => {
                const missing = row.checklist.items.filter((i) => i.status !== 'done');
                return (
                  <tr key={row.entity.id}>
                    <td className="font-medium">{row.entity.shortName}</td>
                    <td>
                      <Badge tone={row.checklist.ready ? 'success' : 'warning'}>
                        {t('bootcamp.network.count', { done: row.done, total: row.total })}
                      </Badge>
                    </td>
                    <td className="text-sm">
                      {missing.length === 0
                        ? t('bootcamp.ready')
                        : missing.map((i) => t(`bootcamp.items.${i.item}.title`)).join(', ')}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Page>
  );
}
