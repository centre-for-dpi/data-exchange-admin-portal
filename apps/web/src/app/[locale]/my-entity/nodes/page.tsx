import { nodeListSchema } from '@rid/contracts';
import type { Metadata } from 'next';
import { getFormatter, getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import {
  CreateNodeForm,
  ReissueTokenForm,
  RevokeTokenButton,
} from '../../../../components/nodes/node-forms';
import { StatusBadge } from '../../../../components/ui/badge';
import { EmptyState, Page, PageHeader, Section } from '../../../../components/ui/page';
import { Link } from '../../../../i18n/navigation';
import { apiGet } from '../../../../lib/api';
import { getViewer } from '../../../../lib/viewer';

interface PageProps {
  params: Promise<{ locale: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'nodes' });
  return { title: t('title') };
}

/** Nodes of the kit of the active entity and their enrollment tokens (SPEC.md §4.6, M4-01). */
export default async function EntityNodesPage({ params }: PageProps) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations();
  const format = await getFormatter();
  const viewer = await getViewer();
  const active = viewer.activeEntity;
  if (!active) notFound();
  const canManage =
    active.roles.includes('entity_admin') || viewer.platformRoles.includes('platform_admin');
  const nodes = await apiGet(`/entities/${active.entity.id}/nodes`, nodeListSchema);
  const when = (value: string | null) =>
    value ? format.dateTime(new Date(value), { dateStyle: 'medium', timeStyle: 'short' }) : '—';

  return (
    <Page>
      <PageHeader
        eyebrow={active.entity.shortName}
        title={t('nodes.title')}
        description={t('nodes.lead')}
        actions={
          <Link href="/my-entity" className="link">
            {t('nav.myEntity')}
          </Link>
        }
      />
      <Section title={t('nodes.listTitle')}>
        {nodes.items.length === 0 ? (
          <EmptyState>{t('nodes.empty')}</EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">{t('nodes.name')}</th>
                  <th scope="col">{t('nodes.status')}</th>
                  <th scope="col">{t('nodes.enrollment')}</th>
                  <th scope="col">{t('nodes.lastHeartbeat')}</th>
                  <th scope="col">{t('nodes.kitVersion')}</th>
                  {canManage ? <th scope="col">{t('nodes.actions')}</th> : null}
                </tr>
              </thead>
              <tbody>
                {nodes.items.map((node) => {
                  const token = node.enrollmentToken;
                  return (
                    <tr key={node.id}>
                      <td className="font-medium">{node.name}</td>
                      <td>
                        <StatusBadge status={node.status}>
                          {t(`nodeStatus.${node.status}`)}
                        </StatusBadge>
                      </td>
                      <td className="text-sm">
                        {token ? (
                          <>
                            <StatusBadge status={token.status}>
                              {t(`nodes.tokenStatus.${token.status}`)}
                            </StatusBadge>
                            {token.status === 'active' ? (
                              <span className="block text-muted-foreground">
                                {t('nodes.expires', { date: when(token.expiresAt) })}
                              </span>
                            ) : null}
                          </>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="whitespace-nowrap text-muted-foreground">
                        {when(node.lastHeartbeatAt)}
                      </td>
                      <td className="font-mono text-sm">{node.kitVersion ?? '—'}</td>
                      {canManage ? (
                        <td>
                          {node.status === 'enrollment_issued' ? (
                            <div className="flex flex-col gap-2">
                              {token?.status === 'active' ? (
                                <RevokeTokenButton
                                  entityId={active.entity.id}
                                  nodeId={node.id}
                                  tokenId={token.id}
                                  nodeName={node.name}
                                />
                              ) : null}
                              <ReissueTokenForm
                                entityId={active.entity.id}
                                nodeId={node.id}
                                nodeName={node.name}
                              />
                            </div>
                          ) : null}
                        </td>
                      ) : null}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Section>
      {canManage ? (
        <Section title={t('nodes.create.title')} description={t('nodes.create.lead')}>
          <div className="card max-w-3xl p-6 md:p-8">
            <CreateNodeForm entityId={active.entity.id} />
          </div>
        </Section>
      ) : null}
    </Page>
  );
}
