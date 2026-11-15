import { getCountryConfig } from '@rid/config';
import {
  entityInvitationListSchema,
  entityMembersPageSchema,
  entitySummarySchema,
} from '@rid/contracts';
import type { Metadata } from 'next';
import { getFormatter, getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import {
  InviteMemberForm,
  MemberActions,
  RevokeInvitationButton,
} from '../../../components/members/forms';
import { StatusBadge } from '../../../components/ui/badge';
import { Card, EmptyState, Page, PageHeader, Section } from '../../../components/ui/page';
import { Link } from '../../../i18n/navigation';
import { apiGet, apiGetAll } from '../../../lib/api';
import { localize } from '../../../lib/localize';
import { getViewer } from '../../../lib/viewer';

interface PageProps {
  params: Promise<{ locale: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'nav' });
  return { title: t('myEntity') };
}

/** Entity data, members and invitations of the active entity (SPEC.md §6, M2-02). */
export default async function MyEntityPage({ params }: PageProps) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations();
  const format = await getFormatter();
  const viewer = await getViewer();
  const active = viewer.activeEntity;
  if (!active) notFound();
  const isAdmin = active.roles.includes('entity_admin');
  const seesMembers = isAdmin || active.roles.includes('entity_viewer');

  const [entity, members, invitations] = await Promise.all([
    apiGet(`/entities/${active.entity.id}`, entitySummarySchema),
    seesMembers
      ? apiGetAll(`/entities/${active.entity.id}/members`, entityMembersPageSchema)
      : Promise.resolve(null),
    seesMembers
      ? apiGet(`/entities/${active.entity.id}/invitations`, entityInvitationListSchema)
      : Promise.resolve(null),
  ]);
  const sector = getCountryConfig().sectors.find((s) => s.code === entity.sector);
  const pending = invitations?.items.filter((i) => i.status === 'pending' && !i.expired) ?? [];
  const activeMembers = members?.items.filter((m) => m.status === 'active') ?? [];
  const roleNames = (roles: readonly string[]) => roles.map((r) => t(`roles.${r}`)).join(', ');

  return (
    <Page>
      <PageHeader
        eyebrow={t('nav.myEntity')}
        title={entity.legalName}
        description={
          <StatusBadge status={entity.status}>{t(`entityStatus.${entity.status}`)}</StatusBadge>
        }
        actions={
          <Link href="/my-entity/nodes" className="link">
            {t('nodes.title')}
          </Link>
        }
      />
      <Card>
        <dl className="facts">
          <dt>{t('entityRequests.form.shortName')}</dt>
          <dd>{entity.shortName}</dd>
          <dt>{t('entityRequests.form.slug')}</dt>
          <dd className="font-mono">{entity.slug}</dd>
          <dt>{t('entityRequests.form.kind')}</dt>
          <dd>{t(`entityKind.${entity.kind}`)}</dd>
          <dt>{t('entityRequests.form.sector')}</dt>
          <dd>{sector ? localize(sector.name, locale) : entity.sector}</dd>
          <dt>{t('entityRequests.form.contactEmail')}</dt>
          <dd>{entity.contactEmail}</dd>
          <dt>{t('myEntity.myRoles')}</dt>
          <dd>{roleNames(active.roles)}</dd>
        </dl>
      </Card>

      {members ? (
        <Section title={t('myEntity.members.title')} description={t('myEntity.members.lead')}>
          {activeMembers.length === 0 ? (
            <EmptyState>{t('myEntity.members.empty')}</EmptyState>
          ) : (
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th scope="col">{t('myEntity.members.name')}</th>
                    <th scope="col">{t('myEntity.members.roles')}</th>
                    {isAdmin ? <th scope="col">{t('myEntity.members.actions')}</th> : null}
                  </tr>
                </thead>
                <tbody>
                  {activeMembers.map((m) => (
                    <tr key={m.membershipId}>
                      <td>
                        <span className="block font-medium">{m.user.fullName}</span>
                        <span className="block text-sm text-muted-foreground">{m.user.email}</span>
                      </td>
                      <td>{roleNames(m.roles)}</td>
                      {isAdmin ? (
                        <td>
                          <MemberActions
                            entityId={entity.id}
                            membershipId={m.membershipId}
                            name={m.user.fullName}
                            roles={m.roles}
                          />
                        </td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>
      ) : null}

      {invitations ? (
        <Section title={t('myEntity.invitations.title')}>
          {pending.length === 0 ? (
            <EmptyState>{t('myEntity.invitations.empty')}</EmptyState>
          ) : (
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th scope="col">{t('myEntity.invitations.email')}</th>
                    <th scope="col">{t('myEntity.members.roles')}</th>
                    <th scope="col">{t('myEntity.invitations.expires')}</th>
                    {isAdmin ? <th scope="col">{t('myEntity.members.actions')}</th> : null}
                  </tr>
                </thead>
                <tbody>
                  {pending.map((i) => (
                    <tr key={i.id}>
                      <td>
                        {i.fullName ? (
                          <span className="block font-medium">{i.fullName}</span>
                        ) : null}
                        <span className="block text-sm">{i.email}</span>
                      </td>
                      <td>{roleNames(i.roles)}</td>
                      <td className="whitespace-nowrap text-muted-foreground">
                        {format.dateTime(new Date(i.expiresAt), { dateStyle: 'medium' })}
                      </td>
                      {isAdmin ? (
                        <td>
                          <RevokeInvitationButton
                            entityId={entity.id}
                            invitationId={i.id}
                            email={i.email}
                          />
                        </td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>
      ) : null}

      {isAdmin ? (
        <Section title={t('myEntity.invite.title')} description={t('myEntity.invite.lead')}>
          <div className="card max-w-3xl p-6 md:p-8">
            <InviteMemberForm entityId={entity.id} />
          </div>
        </Section>
      ) : null}
    </Page>
  );
}
