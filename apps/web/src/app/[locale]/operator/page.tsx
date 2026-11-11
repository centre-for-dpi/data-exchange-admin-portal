import { reviewQueueSchema } from '@rid/contracts';
import type { Metadata } from 'next';
import { getFormatter, getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { Link } from '../../../i18n/navigation';
import { apiGet } from '../../../lib/api';
import { getViewer } from '../../../lib/viewer';

interface PageProps {
  params: Promise<{ locale: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'nav' });
  return { title: t('operator') };
}

const REVIEW_ROLES = ['platform_admin', 'platform_reviewer', 'regulator'];

export default async function OperatorPage({ params }: PageProps) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations();
  const format = await getFormatter();
  const viewer = await getViewer();
  if (!viewer.platformRoles.some((r) => REVIEW_ROLES.includes(r))) notFound();

  const queue = await apiGet('/review/api-versions', reviewQueueSchema);

  return (
    <section className="mx-auto max-w-6xl space-y-6 px-4 py-10">
      <h1 className="text-2xl font-bold">{t('nav.operator')}</h1>
      <h2 className="text-xl font-semibold">{t('operator.queueTitle')}</h2>
      {queue.items.length === 0 ? (
        <p>{t('operator.empty')}</p>
      ) : (
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-border">
              <th scope="col" className="py-2">
                {t('operator.api')}
              </th>
              <th scope="col" className="py-2">
                {t('operator.version')}
              </th>
              <th scope="col" className="py-2">
                {t('operator.entity')}
              </th>
              <th scope="col" className="py-2">
                {t('operator.classification')}
              </th>
              <th scope="col" className="py-2">
                {t('operator.submittedAt')}
              </th>
            </tr>
          </thead>
          <tbody>
            {queue.items.map((item) => (
              <tr key={item.versionId} className="border-b border-border">
                <td className="py-2">
                  <Link href={`/operator/reviews/${item.versionId}`} className="underline">
                    {item.api.name}
                  </Link>
                </td>
                <td className="py-2">{item.version}</td>
                <td className="py-2">{item.entity.shortName}</td>
                <td className="py-2">{t(`classification.${item.api.classification}`)}</td>
                <td className="py-2">
                  {item.submittedAt
                    ? format.dateTime(new Date(item.submittedAt), {
                        dateStyle: 'medium',
                        timeStyle: 'short',
                      })
                    : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
