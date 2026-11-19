import { purposeListSchema, reviewDetailSchema } from '@den/contracts';
import { getCountryConfig } from '@den/config';
import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { VersionSheet } from '../../../../../components/apis/version-sheet';
import { RegulatorDecisionForms } from '../../../../../components/regulator/decision-forms';
import { DecisionForms } from '../../../../../components/review/decision-forms';
import { Badge, classificationTone } from '../../../../../components/ui/badge';
import { Notice } from '../../../../../components/ui/notice';
import { Card, EmptyState, Page, PageHeader, Section } from '../../../../../components/ui/page';
import { ApiError, apiGet } from '../../../../../lib/api';
import { localize } from '../../../../../lib/localize';
import { approvalBlock } from '../../../../../lib/validation-hints';
import { getViewer } from '../../../../../lib/viewer';
import { uuidParams } from '../../../../../lib/route-params';

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
  const { locale, versionId } = uuidParams(await params, 'versionId');
  const review = await load(versionId);
  const t = await getTranslations({ locale, namespace: 'operator.review' });
  return { title: t('title', { api: review.api.name, version: review.version.version }) };
}

export default async function ReviewPage({ params }: PageProps) {
  const { locale, versionId } = uuidParams(await params, 'versionId');
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
  const regulatorTurn =
    review.version.status === 'approved_operator' &&
    review.requiresRegulator &&
    viewer.platformRoles.includes('regulator');

  return (
    <Page>
      <PageHeader
        eyebrow={review.entity.legalName}
        title={t('operator.review.title', {
          api: review.api.name,
          version: review.version.version,
        })}
        description={review.api.summary}
      />

      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Card>
          <dl className="facts">
            <dt>{t('operator.review.entity')}</dt>
            <dd>{review.entity.legalName}</dd>
            <dt>{t('operator.classification')}</dt>
            <dd>
              <Badge tone={classificationTone(review.api.classification)}>
                {t(`classification.${review.api.classification}`)}
              </Badge>
            </dd>
            <dt>{t('operator.review.sector')}</dt>
            <dd>{sector ? localize(sector.name, locale) : review.api.sector}</dd>
            <dt>{t('operator.review.owner')}</dt>
            <dd>{review.api.ownerContact}</dd>
            <dt>{t('operator.review.summary')}</dt>
            <dd>{review.api.summary}</dd>
          </dl>
        </Card>
        <div className="space-y-4">
          <Section title={t('operator.review.description')}>
            <p className="leading-relaxed whitespace-pre-line">{review.api.description}</p>
          </Section>
          <Notice tone="info">{t('operator.review.minimization')}</Notice>
          {review.requiresRegulator ? (
            <Notice tone="warning">{t('operator.review.requiresRegulator')}</Notice>
          ) : null}
        </div>
      </div>

      <VersionSheet version={review.version} purposeNames={purposeNames} />

      {regulatorTurn ? (
        <Section title={t('regulator.decision.title')}>
          <div className="card p-6 md:p-8">
            <RegulatorDecisionForms target="api-versions" id={versionId} />
          </div>
        </Section>
      ) : null}

      <Section title={t('operator.review.decision')}>
        {!inReview ? (
          <Notice tone="success" role="status">
            {t('operator.review.decided')}
          </Notice>
        ) : canDecide ? (
          <div className="card p-6 md:p-8">
            <DecisionForms
              versionId={versionId}
              approvalBlock={approvalBlock(review.version.validation)}
            />
          </div>
        ) : (
          <EmptyState>{t('operator.review.readOnly')}</EmptyState>
        )}
      </Section>
    </Page>
  );
}
