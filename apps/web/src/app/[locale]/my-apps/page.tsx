import { applicationPageSchema } from '@rid/contracts';
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
  return { title: t('myApps') };
}

export default async function MyAppsPage({ params }: PageProps) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations();
  const entity = (await getViewer()).activeEntity;

  if (!entity) {
    return (
      <section className="mx-auto max-w-6xl px-4 py-10">
        <h1 className="text-2xl font-bold">{t('nav.myApps')}</h1>
        <p className="mt-3">{t('myApps.noEntity')}</p>
      </section>
    );
  }
  const canWrite = entity.roles.includes('app_developer');
  const page = await apiGet(
    `/entities/${entity.entity.id}/applications?limit=100`,
    applicationPageSchema,
  );

  return (
    <section className="mx-auto max-w-6xl space-y-6 px-4 py-10">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-2xl font-bold">{t('nav.myApps')}</h1>
        {canWrite ? (
          <Button asChild>
            <Link href="/my-apps/new">{t('myApps.newApp')}</Link>
          </Button>
        ) : null}
      </div>
      {!canWrite ? <p className="text-muted-foreground">{t('myApps.readOnly')}</p> : null}
      {page.items.length === 0 ? (
        <p>{t('myApps.empty')}</p>
      ) : (
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-border">
              <th scope="col" className="py-2">
                {t('myApps.name')}
              </th>
              <th scope="col" className="py-2">
                {t('myApps.environment')}
              </th>
              <th scope="col" className="py-2">
                {t('myApps.status')}
              </th>
              <th scope="col" className="py-2">
                {t('myApps.provisioning')}
              </th>
            </tr>
          </thead>
          <tbody>
            {page.items.map((app) => (
              <tr key={app.id} className="border-b border-border">
                <td className="py-2">
                  <Link href={`/my-apps/${app.id}`} className="underline">
                    {app.name}
                  </Link>
                </td>
                <td className="py-2">{t(`myApps.environments.${app.environment}`)}</td>
                <td className="py-2">{t(`myApps.appStatus.${app.status}`)}</td>
                <td className="py-2">{t(`myApps.provisioningStatus.${app.provisioning}`)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
