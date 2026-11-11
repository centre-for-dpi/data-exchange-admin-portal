import { apiPageSchema } from '@rid/contracts';
import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { Button } from '../../../components/ui/button';
import { Link } from '../../../i18n/navigation';
import { apiGet } from '../../../lib/api';
import { getViewer } from '../../../lib/viewer';

interface PageProps {
  params: Promise<{ locale: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'nav' });
  return { title: t('myApis') };
}

export default async function MyApisPage({ params }: PageProps) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations();
  const viewer = await getViewer();
  const entity = viewer.activeEntity;

  if (!entity) {
    return (
      <section className="mx-auto max-w-6xl px-4 py-10">
        <h1 className="text-2xl font-bold">{t('nav.myApis')}</h1>
        <p className="mt-3">{t('myApis.noEntity')}</p>
      </section>
    );
  }

  const canWrite = entity.roles.includes('api_publisher');
  const page = await apiGet(`/entities/${entity.entity.id}/apis?limit=100`, apiPageSchema);

  return (
    <section className="mx-auto max-w-6xl px-4 py-10">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-2xl font-bold">{t('nav.myApis')}</h1>
        {canWrite ? (
          <Button asChild>
            <Link href="/my-apis/new">{t('myApis.newApi')}</Link>
          </Button>
        ) : null}
      </div>
      {!canWrite ? <p className="mt-3 text-muted-foreground">{t('myApis.readOnly')}</p> : null}

      {page.items.length === 0 ? (
        <p className="mt-6">{t('myApis.empty')}</p>
      ) : (
        <table className="mt-6 w-full text-left text-sm">
          <thead>
            <tr className="border-b border-border">
              <th scope="col" className="py-2">
                {t('myApis.name')}
              </th>
              <th scope="col" className="py-2">
                {t('myApis.classification')}
              </th>
              <th scope="col" className="py-2">
                {t('myApis.status')}
              </th>
            </tr>
          </thead>
          <tbody>
            {page.items.map((api) => (
              <tr key={api.id} className="border-b border-border">
                <td className="py-2">
                  <Link href={`/my-apis/${api.id}`} className="underline">
                    {api.name}
                  </Link>
                </td>
                <td className="py-2">{t(`classification.${api.classification}`)}</td>
                <td className="py-2">{t(`apiStatus.${api.status}`)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
