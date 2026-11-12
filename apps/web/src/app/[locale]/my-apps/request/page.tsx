import { getCountryConfig } from '@rid/config';
import { applicationPageSchema, catalogDetailSchema } from '@rid/contracts';
import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { RequestAccessForm } from '../../../../components/subscriptions/subscription-forms';
import { Button } from '../../../../components/ui/button';
import { Link } from '../../../../i18n/navigation';
import { ApiError, apiGet } from '../../../../lib/api';
import { localize } from '../../../../lib/localize';
import { getViewer } from '../../../../lib/viewer';

interface PageProps {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const param = (value: string | string[] | undefined) => (typeof value === 'string' ? value : '');

async function loadApi(apiId: string) {
  try {
    return await apiGet(`/catalog/apis/${apiId}`, catalogDetailSchema);
  } catch (error) {
    if (error instanceof ApiError && [400, 404].includes(error.status)) notFound();
    throw error;
  }
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'subscriptions' });
  return { title: t('requestAccess') };
}

export default async function RequestAccessPage({ params, searchParams }: PageProps) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('subscriptions');
  const entity = (await getViewer()).activeEntity;
  if (!entity?.roles.includes('app_developer')) notFound();

  const query = await searchParams;
  const detail = await loadApi(param(query.api));
  const version = detail.versions.find((v) => v.id === param(query.version)) ?? detail.versions[0];
  // Only published versions take new requests.
  if (!version || version.status !== 'published') notFound();

  const apps = await apiGet(
    `/entities/${entity.entity.id}/applications?limit=100`,
    applicationPageSchema,
  );
  const active = apps.items.filter((a) => a.status === 'active');
  const maxMonths = getCountryConfig().subscriptionMaxValidityMonths[detail.api.classification];

  return (
    <section className="mx-auto max-w-6xl space-y-6 px-4 py-10">
      <div>
        <h1 className="text-2xl font-bold">{t('form.title', { api: detail.api.name })}</h1>
        <p className="mt-2 text-muted-foreground">
          {t('form.version', { version: version.version, provider: detail.entity.legalName })}
        </p>
      </div>
      {active.length === 0 ? (
        <div className="space-y-3">
          <p>{t('form.noApplications')}</p>
          <Button asChild>
            <Link href="/my-apps/new">{(await getTranslations('myApps'))('newApp')}</Link>
          </Button>
        </div>
      ) : (
        <RequestAccessForm
          apiVersionId={version.id}
          applications={active.map((a) => ({ id: a.id, name: a.name }))}
          purposes={version.allowedPurposes.map((p) => ({
            code: p.code,
            label: localize(p.name, locale),
          }))}
          operations={version.operations}
          maxMonths={maxMonths}
        />
      )}
    </section>
  );
}
