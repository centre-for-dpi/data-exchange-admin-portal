import { currentKitReleaseSchema, kitReleaseListSchema } from '@den/contracts';
import type { Metadata } from 'next';
import { getFormatter, getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import {
  KitBundleUploadForm,
  KitReleaseForm,
  MakeKitCurrentButton,
} from '../../../../components/kit/kit-forms';
import { KitReleasePanel } from '../../../../components/kit/kit-release';
import { Badge } from '../../../../components/ui/badge';
import { EmptyState, Page, PageHeader, Section } from '../../../../components/ui/page';
import { apiGet } from '../../../../lib/api';
import { megabytes } from '../../../../lib/kit-install';
import { getViewer } from '../../../../lib/viewer';

interface PageProps {
  params: Promise<{ locale: string }>;
}

const READ_ROLES = ['platform_admin', 'platform_reviewer'];
const MANAGE_ROLES = ['platform_admin'];

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'kitAdmin' });
  return { title: t('title') };
}

/** Operator console: the node kit's current version, its history and its mirror (P-03). */
export default async function KitAdminPage({ params }: PageProps) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('kitAdmin');
  const format = await getFormatter();
  const viewer = await getViewer();
  if (!viewer.platformRoles.some((r) => READ_ROLES.includes(r))) notFound();
  const canManage = viewer.platformRoles.some((r) => MANAGE_ROLES.includes(r));
  const [releases, current] = await Promise.all([
    apiGet('/admin/kit-releases', kitReleaseListSchema),
    apiGet('/kit/current', currentKitReleaseSchema, { anonymous: true }),
  ]);

  return (
    <Page>
      <PageHeader title={t('title')} description={t('lead')} />
      <Section id="kit-current" title={t('currentTitle')}>
        <KitReleasePanel release={current.release} locale={locale} />
      </Section>
      <Section id="kit-history" title={t('historyTitle')}>
        {releases.items.length === 0 ? (
          <EmptyState>{t('historyEmpty')}</EmptyState>
        ) : (
          <div className="table-wrap" data-testid="kit-releases">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">{t('version')}</th>
                  <th scope="col">{t('state')}</th>
                  <th scope="col">{t('size')}</th>
                  <th scope="col">{t('mirror')}</th>
                  {canManage ? <th scope="col">{t('actions')}</th> : null}
                </tr>
              </thead>
              <tbody>
                {releases.items.map((release) => (
                  <tr key={release.version}>
                    <td>
                      <span className="block font-mono font-medium">{release.version}</span>
                      <span className="block font-mono text-xs break-all text-muted-foreground">
                        {release.sha256}
                      </span>
                    </td>
                    <td>
                      <Badge tone={release.current ? 'success' : 'neutral'}>
                        {release.current ? t('isCurrent') : t('previous')}
                      </Badge>
                    </td>
                    <td className="text-sm whitespace-nowrap">
                      {t('sizeMb', { megabytes: megabytes(release.sizeBytes, locale) })}
                    </td>
                    <td className="text-sm">
                      {release.mirroredAt
                        ? t('mirroredOn', {
                            date: format.dateTime(new Date(release.mirroredAt), {
                              dateStyle: 'medium',
                            }),
                          })
                        : t('notMirrored')}
                    </td>
                    {canManage ? (
                      <td className="min-w-64 space-y-3">
                        {release.current ? null : (
                          <MakeKitCurrentButton version={release.version} />
                        )}
                        {release.mirrored ? null : (
                          <KitBundleUploadForm
                            version={release.version}
                            fileName={release.fileName}
                            sizeBytes={release.sizeBytes}
                          />
                        )}
                        <details>
                          <summary className="link cursor-pointer text-sm">
                            {t('correctFor', { version: release.version })}
                          </summary>
                          <div className="mt-3 min-w-72 space-y-2">
                            {release.mirrored ? (
                              <p className="text-sm text-muted-foreground">{t('mirroredLocked')}</p>
                            ) : null}
                            <KitReleaseForm
                              locked={release.mirrored}
                              initial={{
                                version: release.version,
                                url: release.url,
                                sizeBytes: String(release.sizeBytes),
                                sha256: release.sha256,
                                signatureUrl: release.signatureUrl ?? '',
                                allowedSigners: release.allowedSigners ?? '',
                              }}
                            />
                          </div>
                        </details>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
      {canManage ? (
        <Section id="kit-set" title={t('form.title')} description={t('form.lead')}>
          <div className="card max-w-3xl p-6 md:p-8">
            <KitReleaseForm />
          </div>
        </Section>
      ) : null}
    </Page>
  );
}
