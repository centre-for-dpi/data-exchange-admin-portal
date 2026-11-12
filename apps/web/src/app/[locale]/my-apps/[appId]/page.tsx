import { applicationDetailSchema } from '@rid/contracts';
import type { Metadata } from 'next';
import { getFormatter, getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { AutoRefresh } from '../../../../components/auto-refresh';
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
    <section className="mx-auto max-w-6xl space-y-8 px-4 py-10">
      <h1 className="text-2xl font-bold">{app.name}</h1>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1 text-sm">
        <dt className="font-medium">{t('environment')}</dt>
        <dd>{t(`environments.${app.environment}`)}</dd>
        <dt className="font-medium">{t('status')}</dt>
        <dd>{t(`appStatus.${app.status}`)}</dd>
        <dt className="font-medium">{t('provisioning')}</dt>
        <dd>
          <span role="status" data-testid="provisioning">
            {t(`provisioningStatus.${app.provisioning}`)}
          </span>
        </dd>
        <dt className="font-medium">{t('detail.clientId')}</dt>
        <dd className="font-mono break-all">{app.clientId}</dd>
        <dt className="font-medium">{t('detail.tokenUrl')}</dt>
        <dd className="font-mono break-all">{app.tokenUrl}</dd>
        <dt className="font-medium">{t('detail.technicalContact')}</dt>
        <dd>{app.technicalContact}</dd>
      </dl>
      {app.provisioning === 'pending' ? (
        <>
          <p className="text-sm text-muted-foreground">{t('detail.pendingNote')}</p>
          <AutoRefresh />
        </>
      ) : null}

      <div>
        <h2 className="text-xl font-semibold">{t('detail.credentials')}</h2>
        <ul className="mt-2 space-y-1 text-sm">
          {app.credentials.map((c) => (
            <li key={c.id}>
              {t(`detail.credentialKind.${c.kind}`)} · {t(`detail.credentialStatus.${c.status}`)} ·{' '}
              {t('detail.created')}{' '}
              {format.dateTime(new Date(c.createdAt), { dateStyle: 'medium', timeStyle: 'short' })}
            </li>
          ))}
        </ul>
      </div>

      <div className="space-y-3">
        <h2 className="text-xl font-semibold">{t('detail.guide')}</h2>
        <p className="text-sm">{t('detail.guideToken')}</p>
        <pre className="overflow-x-auto rounded-md bg-muted p-3 text-sm" tabIndex={0}>
          <code>{tokenCommand}</code>
        </pre>
        <p className="text-sm">{t('detail.guideCall')}</p>
        <pre className="overflow-x-auto rounded-md bg-muted p-3 text-sm" tabIndex={0}>
          <code>{callCommand}</code>
        </pre>
        <p className="text-sm text-muted-foreground">{t('detail.guideNote')}</p>
      </div>
    </section>
  );
}
