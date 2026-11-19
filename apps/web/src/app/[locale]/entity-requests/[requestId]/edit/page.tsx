import { getCountryConfig } from '@den/config';
import { entityRequestSchema } from '@den/contracts';
import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { EntityRequestForm } from '../../../../../components/entity-requests/forms';
import { Page, PageHeader } from '../../../../../components/ui/page';
import { ApiError, apiGet } from '../../../../../lib/api';
import { localize } from '../../../../../lib/localize';
import { getViewer } from '../../../../../lib/viewer';
import { uuidParams } from '../../../../../lib/route-params';

interface PageProps {
  params: Promise<{ locale: string; requestId: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'entityRequests' });
  return { title: t('edit') };
}

export default async function EditEntityRequestPage({ params }: PageProps) {
  const { locale, requestId } = uuidParams(await params, 'requestId');
  setRequestLocale(locale);
  const t = await getTranslations('entityRequests');
  const viewer = await getViewer();
  if (!viewer.authenticated) notFound();
  let request;
  try {
    request = await apiGet(`/entity-requests/${requestId}`, entityRequestSchema);
  } catch (error) {
    if (error instanceof ApiError && [400, 404].includes(error.status)) notFound();
    throw error;
  }
  // Only the applicant corrects the request, and only while it is with them (the API enforces it).
  if (request.status !== 'requested' || request.applicant?.id !== viewer.userId) notFound();
  const config = getCountryConfig();
  return (
    <Page>
      <PageHeader eyebrow={request.legalName} title={t('edit')} />
      <div className="card max-w-3xl p-6 md:p-8">
        <EntityRequestForm
          locale={locale}
          sectors={config.sectors.map((s) => ({ value: s.code, label: localize(s.name, locale) }))}
          taxIdTypes={config.identifiers.organization}
          request={request}
        />
      </div>
    </Page>
  );
}
