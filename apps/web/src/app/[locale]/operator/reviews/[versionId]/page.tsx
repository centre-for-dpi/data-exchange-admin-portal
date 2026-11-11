import { purposeListSchema, reviewDetailSchema } from '@rid/contracts';
import { getCountryConfig } from '@rid/config';
import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { VersionSheet } from '../../../../../components/apis/version-sheet';
import { DecisionForms } from '../../../../../components/review/decision-forms';
import { ApiError, apiGet } from '../../../../../lib/api';
import { localize } from '../../../../../lib/localize';
import { getViewer } from '../../../../../lib/viewer';

interface PageProps {
  params: Promise<{ locale: string; versionId: string }>;
}

async function load(versionId: string) {
  try {
    return await apiGet(`/review/api-versions/${versionId}`, reviewDetailSchema);
  } catch (error) {
    if (error instanceof ApiError && [400, 403, 404].includes(error.status)) notFound();
    throw error;
  }
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale, versionId } = await params;
  const review = await load(versionId);
  const t = await getTranslations({ locale, namespace: 'operator.review' });
  return { title: t('title', { api: review.api.name, version: review.version.version }) };
}

export default async function ReviewPage({ params }: PageProps) {
  const { locale, versionId } = await params;
  setRequestLocale(locale);
  const t = await getTranslations();
  const viewer = await getViewer();
  const review = await load(versionId);
  const purposeNames = new Map(
    (await apiGet('/purposes', purposeListSchema)).items.map((p) => [
      p.code,
      localize(p.name, locale),
    ]),
  );
  const sector = getCountryConfig().sectors.find((s) => s.code === review.api.sector);
  const canDecide = viewer.platformRoles.some(
    (r) => r === 'platform_admin' || r === 'platform_reviewer',
  );
  const inReview = review.version.status === 'in_review';

  return (
    <section className="mx-auto max-w-6xl space-y-8 px-4 py-10">
      <h1 className="text-2xl font-bold">
        {t('operator.review.title', { api: review.api.name, version: review.version.version })}
      </h1>

      <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1 text-sm">
        <dt className="font-medium">{t('operator.review.entity')}</dt>
        <dd>{review.entity.legalName}</dd>
        <dt className="font-medium">{t('operator.classification')}</dt>
        <dd>{t(`classification.${review.api.classification}`)}</dd>
        <dt className="font-medium">{t('operator.review.sector')}</dt>
        <dd>{sector ? localize(sector.name, locale) : review.api.sector}</dd>
        <dt className="font-medium">{t('operator.review.owner')}</dt>
        <dd>{review.api.ownerContact}</dd>
        <dt className="font-medium">{t('operator.review.summary')}</dt>
        <dd>{review.api.summary}</dd>
      </dl>
      <div>
        <h2 className="text-xl font-semibold">{t('operator.review.description')}</h2>
        <p className="mt-2 whitespace-pre-line">{review.api.description}</p>
      </div>

      <p className="rounded-md border border-border bg-muted p-3 text-sm">
        {t('operator.review.minimization')}
      </p>
      {review.requiresRegulator ? (
        <p className="rounded-md border border-border p-3 text-sm">
          {t('operator.review.requiresRegulator')}
        </p>
      ) : null}

      <VersionSheet version={review.version} purposeNames={purposeNames} />

      <div className="space-y-3">
        <h2 className="text-xl font-semibold">{t('operator.review.decision')}</h2>
        {!inReview ? (
          <p role="status">{t('operator.review.decided')}</p>
        ) : canDecide ? (
          <DecisionForms versionId={versionId} />
        ) : (
          <p>{t('operator.review.readOnly')}</p>
        )}
      </div>
    </section>
  );
}
