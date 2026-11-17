import { networkNodeListSchema } from '@den/contracts';
import type { Metadata } from 'next';
import { getFormatter, getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
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
  const t = await getTranslations({ locale, namespace: 'nodes.network' });
  return { title: t('title') };
}

const ROLES = ['platform_admin', 'platform_reviewer', 'regulator'];

/** Operator console: every node of the network (SPEC.md §6, "nodos (estado, versión, heartbeat)"). */
export default async function NetworkNodesPage({ params }: PageProps) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations();
  const format = await getFormatter();
  const viewer = await getViewer();
  if (!viewer.platformRoles.some((r) => ROLES.includes(r))) notFound();
  const nodes = await apiGet('/admin/nodes', networkNodeListSchema);
  const when = (value: string | null) =>
    value ? format.dateTime(new Date(value), { dateStyle: 'medium', timeStyle: 'short' }) : '—';

  return (
    <Page>
      <PageHeader
        eyebrow={t('nav.operator')}
        title={t('nodes.network.title')}
        description={t('nodes.network.lead')}
        actions={
          <Link href="/operator" className="link">
            {t('nav.operator')}
          </Link>
        }
      />
      <Section title={t('nodes.listTitle')}>
        {nodes.items.length === 0 ? (
          <EmptyState>{t('nodes.network.empty')}</EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">{t('operator.entity')}</th>
                  <th scope="col">{t('nodes.name')}</th>
                  <th scope="col">{t('nodes.status')}</th>
                  <th scope="col">{t('nodes.kitVersion')}</th>
                  <th scope="col">{t('nodes.lastHeartbeat')}</th>
                  <th scope="col">{t('nodes.tunnelAddress')}</th>
                </tr>
              </thead>
              <tbody>
                {nodes.items.map((node) => (
                  <tr key={node.id}>
                    <td>{node.entity.shortName}</td>
                    <td className="font-medium">{node.name}</td>
                    <td>
                      <StatusBadge status={node.status}>
                        {t(`nodeStatus.${node.status}`)}
                      </StatusBadge>
                    </td>
                    <td className="font-mono text-sm">{node.kitVersion ?? '—'}</td>
                    <td className="whitespace-nowrap text-muted-foreground">
                      {when(node.lastHeartbeatAt)}
                    </td>
                    <td className="font-mono text-sm">{node.tunnelAddress ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </Page>
  );
}
