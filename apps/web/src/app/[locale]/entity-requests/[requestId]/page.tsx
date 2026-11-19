import { getCountryConfig } from '@den/config';
import { entityRequestSchema } from '@den/contracts';
import type { Metadata } from 'next';
import { getFormatter, getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import {
  DesignationUpload,
  EntityDecisionForms,
  SubmitRequestForm,
} from '../../../../components/entity-requests/forms';
import { StatusBadge } from '../../../../components/ui/badge';
import { buttonVariants } from '../../../../components/ui/button';
import { Notice } from '../../../../components/ui/notice';
import { Card, EmptyState, Page, PageHeader, Section } from '../../../../components/ui/page';
import { Link } from '../../../../i18n/navigation';
import { ApiError, apiGet } from '../../../../lib/api';
import { localize } from '../../../../lib/localize';
import { getViewer } from '../../../../lib/viewer';

interface PageProps {
  params: Promise<{ locale: string; requestId: string }>;
}

/**
 * The applicant reads their own file on `/entity-requests/:id`; platform roles that review read any
 * file on `/review/entities/:id`, where the API demands the second factor (M-01).
 */
async function load(requestId: string) {
  try {
    try {
      return await apiGet(`/entity-requests/${requestId}`, entityRequestSchema);
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 404) throw error;
      return await apiGet(`/review/entities/${requestId}`, entityRequestSchema);
    }
  } catch (error) {
    if (error instanceof ApiError && [400, 403, 404].includes(error.status)) notFound();
    throw error;
  }
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { requestId } = await params;
  return { title: (await load(requestId)).legalName };
}

const DECIDE_ROLES = ['platform_admin', 'platform_reviewer'];

/** One onboarding request, for its applicant and for the operator (SPEC.md §4.1). */
export default async function EntityRequestPage({ params }: PageProps) {
  const { locale, requestId } = await params;
  setRequestLocale(locale);
  const t = await getTranslations();
  const format = await getFormatter();
  const viewer = await getViewer();
  const request = await load(requestId);
  const isApplicant = request.applicant?.id === viewer.userId;
  const canDecide = viewer.platformRoles.some((r) => DECIDE_ROLES.includes(r)) && !isApplicant;
  const editable = isApplicant && request.status === 'requested';
  const sector = getCountryConfig().sectors.find((s) => s.code === request.sector);
  const lastReview = request.reviews.at(-1);
  const when = (iso: string) =>
    format.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'short' });
  const doc = request.designationDocument;

  return (
    <Page>
      <PageHeader
        eyebrow={t('entityRequests.eyebrow')}
        title={request.legalName}
        description={
          <StatusBadge status={request.status}>{t(`entityStatus.${request.status}`)}</StatusBadge>
        }
        actions={
          editable ? (
            <Link
              href={`/entity-requests/${request.id}/edit`}
              className={buttonVariants({ variant: 'outline' })}
            >
              {t('entityRequests.edit')}
            </Link>
          ) : null
        }
      />

      {isApplicant ? (
        <Notice tone={request.status === 'rejected' ? 'warning' : 'info'} role="status">
          {t(`entityRequests.next.${request.status}`)}
        </Notice>
      ) : null}
      {lastReview && lastReview.decision !== 'approved' && lastReview.comment ? (
        <Notice tone="warning">
          <p className="font-semibold">{t(`entityRequests.decision.${lastReview.decision}`)}</p>
          <p className="whitespace-pre-line">{lastReview.comment}</p>
        </Notice>
      ) : null}

      <div className="grid gap-8 lg:grid-cols-2">
        <Card>
          <h2 className="mb-4 text-xl font-bold">{t('entityRequests.form.entity')}</h2>
          <dl className="facts">
            <dt>{t('entityRequests.form.shortName')}</dt>
            <dd>{request.shortName}</dd>
            <dt>{t('entityRequests.form.slug')}</dt>
            <dd className="font-mono">{request.slug}</dd>
            <dt>{t('entityRequests.form.taxId')}</dt>
            <dd>
              {request.taxIdType} {request.taxId}
            </dd>
            <dt>{t('entityRequests.form.kind')}</dt>
            <dd>{t(`entityKind.${request.kind}`)}</dd>
            <dt>{t('entityRequests.form.sector')}</dt>
            <dd>{sector ? localize(sector.name, locale) : request.sector}</dd>
            <dt>{t('entityRequests.form.contactEmail')}</dt>
            <dd>{request.contactEmail}</dd>
            {request.website ? (
              <>
                <dt>{t('entityRequests.form.website')}</dt>
                <dd>{request.website}</dd>
              </>
            ) : null}
            <dt>{t('entityRequests.form.dpo')}</dt>
            <dd>
              {request.dpoName} · {request.dpoEmail}
            </dd>
            {request.applicant ? (
              <>
                <dt>{t('entityRequests.applicant')}</dt>
                <dd>
                  {request.applicant.fullName} · {request.applicant.email}
                </dd>
              </>
            ) : null}
          </dl>
        </Card>
        <div className="space-y-8">
          <Card>
            <h2 className="mb-4 text-xl font-bold">{t('entityRequests.designees')}</h2>
            <p className="mb-4 text-sm text-muted-foreground">
              {t('entityRequests.designeesHint')}
            </p>
            <dl className="facts">
              {request.designees.map((d) => (
                <div key={d.role} className="contents">
                  <dt>{t(`entityRequests.form.designee.${d.role}.title`)}</dt>
                  <dd>
                    {d.fullName} · {d.email}
                  </dd>
                </div>
              ))}
            </dl>
          </Card>
          <Card>
            <h2 className="mb-4 text-xl font-bold">{t('entityRequests.document.title')}</h2>
            {doc ? (
              <dl className="facts">
                <dt>{t('entityRequests.document.file')}</dt>
                <dd>
                  <a
                    href={`/files/entity-requests/${request.id}/designation`}
                    className="link"
                    download
                  >
                    {doc.fileName}
                  </a>{' '}
                  <span className="text-muted-foreground">
                    ({format.number(doc.size / 1024, { maximumFractionDigits: 0 })} KB)
                  </span>
                </dd>
                <dt>{t('entityRequests.document.sha256')}</dt>
                <dd className="font-mono text-xs break-all">{doc.sha256}</dd>
                <dt>{t('entityRequests.document.uploadedAt')}</dt>
                <dd>{when(doc.uploadedAt)}</dd>
              </dl>
            ) : (
              <p className="text-sm text-muted-foreground">{t('entityRequests.document.none')}</p>
            )}
            {editable ? (
              <div className="mt-6">
                <DesignationUpload requestId={request.id} hasDocument={Boolean(doc)} />
              </div>
            ) : null}
          </Card>
        </div>
      </div>

      {editable ? (
        <Section
          title={t('entityRequests.detail.submitTitle')}
          description={t('entityRequests.detail.submitHint')}
        >
          <SubmitRequestForm requestId={request.id} />
        </Section>
      ) : null}

      {!isApplicant ? (
        <Section title={t('entityRequests.review.title')}>
          {request.status !== 'under_review' ? (
            <EmptyState>{t('entityRequests.review.notPending')}</EmptyState>
          ) : canDecide ? (
            <div className="card p-6 md:p-8">
              <EntityDecisionForms requestId={request.id} />
            </div>
          ) : (
            <EmptyState>{t('entityRequests.review.readOnly')}</EmptyState>
          )}
        </Section>
      ) : null}

      {request.reviews.length > 0 ? (
        <Section title={t('entityRequests.history')}>
          <ol className="space-y-3">
            {request.reviews.map((r) => (
              <li key={r.createdAt} className="card p-4">
                <p className="font-semibold">
                  {t(`entityRequests.decision.${r.decision}`)}{' '}
                  <span className="font-normal text-muted-foreground">
                    · {t(`entityRequests.reviewerRole.${r.reviewerRole}`)} · {when(r.createdAt)}
                  </span>
                </p>
                {r.comment ? <p className="mt-1 whitespace-pre-line">{r.comment}</p> : null}
              </li>
            ))}
          </ol>
        </Section>
      ) : null}
    </Page>
  );
}
