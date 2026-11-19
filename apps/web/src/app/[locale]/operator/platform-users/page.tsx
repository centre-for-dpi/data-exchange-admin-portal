import { platformRoleHolderListSchema } from '@den/contracts';
import type { Metadata } from 'next';
import { getFormatter, getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import {
  AccountStatusForm,
  GrantRoleForm,
  RevokeRoleForm,
} from '../../../../components/platform-users/forms';
import { Badge } from '../../../../components/ui/badge';
import { Notice } from '../../../../components/ui/notice';
import { EmptyState, Page, PageHeader, Section } from '../../../../components/ui/page';
import { apiGet } from '../../../../lib/api';
import { getViewer } from '../../../../lib/viewer';

interface PageProps {
  params: Promise<{ locale: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'platformUsers' });
  return { title: t('title') };
}

/**
 * Operator console: who holds the platform roles, granting and revoking them, and disabling an
 * account (M-03). Platform administrators only; the API audits each change.
 */
export default async function PlatformUsersPage({ params }: PageProps) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('platformUsers');
  const format = await getFormatter();
  const viewer = await getViewer();
  if (!viewer.platformRoles.includes('platform_admin')) notFound();
  const holders = await apiGet('/admin/platform-roles', platformRoleHolderListSchema);

  return (
    <Page>
      <PageHeader title={t('title')} description={t('lead')} />

      <Section title={t('holders.title')}>
        {holders.items.length === 0 ? (
          <EmptyState>{t('holders.empty')}</EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <caption className="sr-only">{t('holders.title')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('holders.person')}</th>
                  <th scope="col">{t('role')}</th>
                  <th scope="col">{t('holders.status')}</th>
                  <th scope="col">{t('holders.granted')}</th>
                  <th scope="col">{t('holders.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {holders.items.map((h) => (
                  <tr key={`${h.userId}-${h.role}`}>
                    <td>
                      <span className="block font-medium">{h.fullName}</span>
                      <span className="block text-xs break-all text-muted-foreground">
                        {h.email}
                      </span>
                    </td>
                    <td>{t(`roles.${h.role}`)}</td>
                    <td>
                      <Badge tone={h.status === 'active' ? 'success' : 'danger'} dot>
                        {t(`holders.${h.status}`)}
                      </Badge>
                    </td>
                    <td className="text-sm">
                      {format.dateTime(new Date(h.grantedAt), { dateStyle: 'medium' })}
                      <span className="block text-xs text-muted-foreground">
                        {h.grantedBy.startsWith('cli:') || h.grantedBy === 'seed'
                          ? t('holders.byCommandLine')
                          : t('holders.byAdministrator')}
                      </span>
                    </td>
                    <td>
                      <RevokeRoleForm
                        email={h.email}
                        role={h.role}
                        name={h.fullName}
                        roleLabel={t(`roles.${h.role}`)}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Notice tone="info">{t('holders.lastAdmin')}</Notice>
      </Section>

      <Section title={t('grant.title')} description={t('grant.lead')}>
        <GrantRoleForm />
      </Section>

      <Section title={t('status.title')} description={t('status.lead')}>
        <AccountStatusForm />
      </Section>
    </Page>
  );
}
