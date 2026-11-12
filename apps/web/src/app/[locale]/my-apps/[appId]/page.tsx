import { applicationDetailSchema } from '@rid/contracts';
import type { Metadata } from 'next';
import { getFormatter, getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { AutoRefresh } from '../../../../components/auto-refresh';
import { Badge, StatusBadge } from '../../../../components/ui/badge';
import { Notice } from '../../../../components/ui/notice';
import { Card, Page, PageHeader, Section } from '../../../../components/ui/page';
import { ApiError, apiGet } from '../../../../lib/api';
import { getViewer } from '../../../../lib/viewer';

interface PageProps {
  params: Promise<{ locale: string; appId: string }>;
}

async function load(appId: string) {
  const entity = (await getViewer()).activeEntity;
  if (!entity) notFound();
  try {
    return await apiGet(
      `/entities/${entity.entity.id}/applications/${appId}`,
      applicationDetailSchema,
    );
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
  const gateway = process.env.RID_GATEWAY_PUBLIC_URL ?? 'http://localhost:9080';
  const tokenCommand = [
    `TOKEN=$(curl -s -u "${app.clientId}:TU_SECRETO" \\`,
    '  -d grant_type=client_credentials \\',
    `  ${app.tokenUrl} | jq -r .access_token)`,
  ].join('\n');
  const callCommand = [
    `curl ${gateway}/{entidad}/{api}/v1/... \\`,
    '  -H "Authorization: Bearer $TOKEN" \\',
    '  -H "X-RID-Purpose: {finalidad}"',
  ].join('\n');

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
                <span className="space-y-0.5">
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
                </span>
                <StatusBadge status={c.status}>
                  {t(`detail.credentialStatus.${c.status}`)}
                </StatusBadge>
              </li>
            ))}
          </ul>
        </Section>
      </div>

      <Section title={t('detail.guide')}>
        <div className="space-y-6">
          <div className="space-y-3">
            <p className="text-sm">{t('detail.guideToken')}</p>
            <pre
              className="overflow-x-auto rounded-2xl bg-surface-inverse p-5 text-sm leading-relaxed text-[#f6f8fa]"
              tabIndex={0}
            >
              <code>{tokenCommand}</code>
            </pre>
          </div>
          <div className="space-y-3">
            <p className="text-sm">{t('detail.guideCall')}</p>
            <pre
              className="overflow-x-auto rounded-2xl bg-surface-inverse p-5 text-sm leading-relaxed text-[#f6f8fa]"
              tabIndex={0}
            >
              <code>{callCommand}</code>
            </pre>
          </div>
        </div>
        <p className="text-sm text-muted-foreground">{t('detail.guideNote')}</p>
      </Section>
    </Page>
  );
}
