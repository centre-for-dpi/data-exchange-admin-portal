import { getCountryConfig } from '@den/config';
import { IntegrationGuide } from '../../../../components/apps/integration-guide';
import { guideSnippets } from '../../../../lib/integration-guide';
import { applicationDetailSchema } from '@den/contracts';
import type { Metadata } from 'next';
import { getFormatter, getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { CertificateRequestForm } from '../../../../components/apps/certificate-form';
import { CsrCommands } from '../../../../components/apps/csr-commands';
import {
  RevokeCredentialForm,
  RotateSecretForm,
} from '../../../../components/apps/credential-forms';
import { AutoRefresh } from '../../../../components/auto-refresh';
import { Badge, StatusBadge } from '../../../../components/ui/badge';
import { Button } from '../../../../components/ui/button';
import { Notice } from '../../../../components/ui/notice';
import { Card, Page, PageHeader, Section } from '../../../../components/ui/page';
import { ApiError, apiGet } from '../../../../lib/api';
import { csrCommands, csrScriptCommand } from '../../../../lib/csr-commands';
import { getViewer } from '../../../../lib/viewer';

interface PageProps {
  params: Promise<{ locale: string; appId: string }>;
}

async function load(appId: string) {
  const entity = (await getViewer()).activeEntity;
  if (!entity) notFound();
  try {
    const app = await apiGet(
      `/entities/${entity.entity.id}/applications/${appId}`,
      applicationDetailSchema,
    );
    return Object.assign(app, {
      entityId: entity.entity.id,
      canWrite: entity.roles.includes('app_developer'),
    });
  } catch (error) {
    if (error instanceof ApiError && [400, 403, 404].includes(error.status)) notFound();
    throw error;
  }
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { appId } = await params;
  return { title: (await load(appId)).name };
}

export default async function ApplicationPage({ params }: PageProps) {
  const { locale, appId } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('myApps');
  const format = await getFormatter();
  const app = await load(appId);
  const mtlsRequired = getCountryConfig().features.mtls.required;
  const downloadBase = `/files/entities/${app.entityId}/applications/${app.id}/credentials`;
  const rotationDays = getCountryConfig().lifecycle.credentialRotationDays;
  const has = (kind: 'client_secret' | 'mtls_certificate', status: 'active' | 'rotating') =>
    app.credentials.some((c) => c.kind === kind && c.status === status);
  const activeCertificate = has('mtls_certificate', 'active');
  const rotatingCertificate = has('mtls_certificate', 'rotating');
  const rotatingSecret = has('client_secret', 'rotating');
  const writable = app.canWrite && app.status === 'active';
  // A credential that can be revoked: a certificate that still works, or the previous secret.
  const revocable = (c: (typeof app.credentials)[number]) =>
    app.canWrite &&
    (c.status === 'rotating' || (c.status === 'active' && c.kind === 'mtls_certificate'));
  // The key and CSR are made on the application's server, never in the browser (P-05).
  const csr = csrCommands({
    clientId: app.clientId,
    keyExists: t('certificates.keyExists', { file: `${app.clientId}.key` }),
    opensslMissing: t('certificates.opensslMissing'),
  });
  const gateway = process.env.DEN_GATEWAY_PUBLIC_URL ?? 'http://localhost:9080';
  // The guide's programs (M5-08); with mTLS (M3-10) both calls present the application's
  // certificate and trust the gateway through the network CA.
  const snippets = guideSnippets({
    clientId: app.clientId,
    tokenUrl: app.tokenUrl,
    gateway,
    mtls: mtlsRequired,
    path: t('guide.path'),
    purpose: t('guide.purpose'),
    endUser: t('guide.endUser'),
  });

  return (
    <Page>
      <PageHeader title={app.name} />
      {app.provisioning === 'pending' ? (
        <>
          <Notice tone="info">{t('detail.pendingNote')}</Notice>
          <AutoRefresh />
        </>
      ) : null}

      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Card>
          <dl className="facts">
            <dt>{t('environment')}</dt>
            <dd>
              <Badge tone={app.environment === 'production' ? 'brand' : 'neutral'}>
                {t(`environments.${app.environment}`)}
              </Badge>
            </dd>
            <dt>{t('status')}</dt>
            <dd>
              <StatusBadge status={app.status}>{t(`appStatus.${app.status}`)}</StatusBadge>
            </dd>
            <dt>{t('provisioning')}</dt>
            <dd>
              <StatusBadge status={app.provisioning} role="status" data-testid="provisioning">
                {t(`provisioningStatus.${app.provisioning}`)}
              </StatusBadge>
            </dd>
            <dt>{t('detail.clientId')}</dt>
            <dd className="font-mono break-all">{app.clientId}</dd>
            <dt>{t('detail.tokenUrl')}</dt>
            <dd className="font-mono break-all">{app.tokenUrl}</dd>
            <dt>{t('detail.technicalContact')}</dt>
            <dd>{app.technicalContact}</dd>
          </dl>
        </Card>

        <Section title={t('detail.credentials')}>
          <ul className="space-y-3">
            {app.credentials.map((c) => (
              <li
                key={c.id}
                className="card flex flex-wrap items-center justify-between gap-3 px-5 py-4 text-sm"
              >
                <div className="min-w-0 space-y-0.5">
                  <span className="block font-medium text-foreground-strong">
                    {t(`detail.credentialKind.${c.kind}`)}
                  </span>
                  <span className="block text-muted-foreground">
                    {t('detail.created')}{' '}
                    {format.dateTime(new Date(c.createdAt), {
                      dateStyle: 'medium',
                      timeStyle: 'short',
                    })}
                  </span>
                  {c.rotationEndsAt ? (
                    <span className="block text-muted-foreground" data-testid="works-until">
                      {t('rotation.worksUntil', {
                        date: format.dateTime(new Date(c.rotationEndsAt), {
                          dateStyle: 'long',
                          timeStyle: 'short',
                        }),
                      })}
                    </span>
                  ) : null}
                  {c.certificate ? (
                    <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-muted-foreground">
                      <dt>{t('certificates.validUntil')}</dt>
                      <dd data-testid="certificate-not-after">
                        {format.dateTime(new Date(c.certificate.notAfter), {
                          dateStyle: 'long',
                        })}
                      </dd>
                      <dt>{t('certificates.serial')}</dt>
                      <dd className="font-mono break-all">{c.certificate.serial}</dd>
                      <dt>{t('certificates.fingerprint')}</dt>
                      <dd className="font-mono break-all" data-testid="certificate-fingerprint">
                        {c.certificate.fingerprint}
                      </dd>
                    </dl>
                  ) : null}
                </div>
                <span className="flex flex-wrap items-center gap-2">
                  {c.certificate?.expiringSoon ? (
                    <Badge tone="warning">{t('certificates.expiringSoon')}</Badge>
                  ) : null}
                  <StatusBadge status={c.status}>
                    {t(`detail.credentialStatus.${c.status}`)}
                  </StatusBadge>
                  {c.certificate ? (
                    <Button asChild variant="outline" size="sm">
                      <a
                        href={`${downloadBase}/${c.id}/certificate`}
                        download
                        aria-label={t('certificates.downloadSerial', {
                          serial: c.certificate.serial,
                        })}
                      >
                        {t('certificates.download')}
                      </a>
                    </Button>
                  ) : null}
                </span>
                {app.canWrite ? (
                  // Mounted for every credential: once revoked, the page re-renders and the
                  // form must stay to confirm it ("Credencial revocada.").
                  <RevokeCredentialForm
                    applicationId={app.id}
                    credentialId={c.id}
                    available={revocable(c)}
                    label={
                      c.certificate
                        ? t('rotation.certificateLabel', { serial: c.certificate.serial })
                        : t('rotation.secretLabel')
                    }
                  />
                ) : null}
              </li>
            ))}
          </ul>
          {writable ? (
            // Always mounted: after a rotation the page re-renders with the rotation in
            // progress, and the form must keep showing the new secret it just received.
            <RotateSecretForm
              applicationId={app.id}
              days={rotationDays}
              inProgress={Boolean(rotatingSecret)}
            />
          ) : null}
        </Section>
      </div>

      <Section id="certificates" title={t('certificates.title')}>
        <div className="space-y-5">
          <Notice tone={mtlsRequired ? 'warning' : 'info'}>
            {mtlsRequired ? t('certificates.required') : t('certificates.optional')}
          </Notice>
          {app.status !== 'active' ? (
            <p className="text-sm">{t('certificates.inactive')}</p>
          ) : !app.canWrite ? (
            <p className="text-sm">{t('certificates.readOnly')}</p>
          ) : rotatingCertificate ? (
            <p className="text-sm">{t('certificates.rotationInProgress')}</p>
          ) : (
            <>
              {activeCertificate ? (
                <p className="text-sm">{t('certificates.renewHint', { days: rotationDays })}</p>
              ) : null}
              <div className="space-y-3">
                <p className="text-sm">{t('certificates.howTo')}</p>
                <CsrCommands
                  commands={csr}
                  clientId={app.clientId}
                  scriptCommand={csrScriptCommand(app.clientId)}
                />
                <p className="text-sm">{t('certificates.paste')}</p>
              </div>
              <CertificateRequestForm applicationId={app.id} downloadBase={downloadBase} />
            </>
          )}
        </div>
      </Section>

      <Section title={t('detail.guide')}>
        <p className="text-sm">{t('guide.lead')}</p>
        <IntegrationGuide snippets={snippets} />
        <p className="text-sm text-muted-foreground">{t('detail.guideNote')}</p>
        {mtlsRequired ? (
          <p className="text-sm text-muted-foreground">
            {t('detail.guideMtls')}{' '}
            <a href="/files/network-ca" className="link font-semibold" download>
              {t('detail.guideCa')}
            </a>
          </p>
        ) : null}
        <p className="text-sm text-muted-foreground">{t('detail.guideEndUser')}</p>
        <p className="text-sm text-muted-foreground">{t('detail.guideLimit')}</p>
      </Section>
    </Page>
  );
}
