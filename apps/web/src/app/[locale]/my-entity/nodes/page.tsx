import { currentKitReleaseSchema, nodeListSchema } from '@den/contracts';
import type { Metadata } from 'next';
import { getFormatter, getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import {
  CreateNodeForm,
  DecommissionNodeButton,
  ReissueTokenForm,
  RevokeTokenButton,
} from '../../../../components/nodes/node-forms';
import { KitReleasePanel } from '../../../../components/kit/kit-release';
import { NodeContractBadge, NodeContractDetails } from '../../../../components/nodes/node-contract';
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
  const [nodes, kit] = await Promise.all([
    apiGet(`/entities/${active.entity.id}/nodes`, nodeListSchema),
    // P-03: the kit to install, public; a failure only hides it.
    apiGet('/kit/current', currentKitReleaseSchema, { anonymous: true }).catch(() => null),
  ]);
  const when = (value: string | null) =>
    value ? format.dateTime(new Date(value), { dateStyle: 'medium', timeStyle: 'short' }) : '—';
  // P-02: the published versions each node serves, differing ones first.
  const rank = { differs: 0, not_reported: 1, matches: 2 } as const;
  const contracts = nodes.items
    .flatMap((node) => node.contracts.map((contract) => ({ node, contract })))
    .sort((a, b) => rank[a.contract.status] - rank[b.contract.status]);

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
          <div className="table-wrap" data-testid="node-list">
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
                      <td>
                        <span className="block font-medium">{node.name}</span>
                        {node.services.length ? (
                          <span className="block text-sm text-muted-foreground">
                            {t('nodes.services', {
                              list: node.services.map((s) => s.path).join(', '),
                            })}
                          </span>
                        ) : null}
                      </td>
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
                          ) : node.status !== 'decommissioned' ? (
                            <DecommissionNodeButton
                              entityId={active.entity.id}
                              nodeId={node.id}
                              nodeName={node.name}
                            />
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
      {contracts.length > 0 ? (
        <Section title={t('nodeContract.nodesTitle')} description={t('nodeContract.lead')}>
          <div className="table-wrap" data-testid="node-contracts">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">{t('nodeContract.version')}</th>
                  <th scope="col">{t('nodes.name')}</th>
                  <th scope="col">{t('nodeContract.column')}</th>
                </tr>
              </thead>
              <tbody>
                {contracts.map(({ node, contract }) => (
                  <tr key={contract.apiVersionId}>
                    <td>
                      <Link
                        href={`/my-apis/${contract.apiId}/versions/${contract.apiVersionId}`}
                        className="link"
                      >
                        {contract.apiName} {contract.version}
                      </Link>
                      <span className="block font-mono text-sm text-muted-foreground">
                        {contract.servicePath}
                      </span>
                    </td>
                    <td className="text-sm">{node.name}</td>
                    <td className="space-y-2">
                      <NodeContractBadge status={contract.status} />
                      <NodeContractDetails contract={contract} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      ) : null}
      {kit ? (
        <Section id="kit-release" title={t('kit.sectionTitle')} description={t('kit.sectionLead')}>
          <KitReleasePanel release={kit.release} locale={locale} />
        </Section>
      ) : null}
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
