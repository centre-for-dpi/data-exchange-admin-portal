import { adminEntityListSchema } from '@rid/contracts';
import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { EntityStatusActions, XroadMemberForm } from '../../../../components/entity-admin/forms';
import { StatusBadge } from '../../../../components/ui/badge';
import { inputClass } from '../../../../components/form/field';
import { EmptyState, Page, PageHeader } from '../../../../components/ui/page';
import { Button } from '../../../../components/ui/button';
import { Link } from '../../../../i18n/navigation';
import { apiGet } from '../../../../lib/api';
import { getViewer } from '../../../../lib/viewer';

interface PageProps {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const READ_ROLES = ['platform_admin', 'platform_reviewer', 'regulator'];

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'entityAdmin' });
  return { title: t('title') };
}

/** Operator console: entities of the network, their suspension and offboarding (M2-11). */
export default async function EntitiesAdminPage({ params, searchParams }: PageProps) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations();
  const viewer = await getViewer();
  if (!viewer.platformRoles.some((r) => READ_ROLES.includes(r))) notFound();
  const canDecide = viewer.platformRoles.includes('platform_admin');
  // By pages and with a search (M6-11): a national network can have thousands of entities.
  const query = await searchParams;
  const q = typeof query.q === 'string' ? query.q.trim().slice(0, 100) : '';
  const cursor =
    typeof query.cursor === 'string' && /^[0-9a-f-]{36}$/.test(query.cursor) ? query.cursor : '';
  const filters = new URLSearchParams();
  if (q) filters.set('q', q);
  const kept = filters.toString();
  if (cursor) filters.set('cursor', cursor);
  const entities = await apiGet(`/admin/entities?${filters.toString()}`, adminEntityListSchema);

  return (
    <Page>
      <PageHeader
        title={t('entityAdmin.title')}
        description={t('entityAdmin.lead')}
        actions={
          canDecide ? (
            <Button asChild>
              <Link href="/operator/entities/new">{t('entityAdmin.create.title')}</Link>
            </Button>
          ) : null
        }
      />
      <form method="get" className="flex flex-wrap items-end gap-3" role="search">
        <label className="block text-sm font-medium text-foreground-strong">
          {t('entityAdmin.search')}
          <input
            type="search"
            name="q"
            defaultValue={q}
            maxLength={100}
            className={`${inputClass} mt-1.5 min-w-72`}
          />
        </label>
        <Button type="submit" variant="outline">
          {t('entityAdmin.searchButton')}
        </Button>
        {q ? (
          <Link href="/operator/entities" className="link text-sm">
            {t('entityAdmin.searchClear')}
          </Link>
        ) : null}
      </form>
      {entities.items.length === 0 ? (
        <EmptyState>{q ? t('entityAdmin.noMatch', { q }) : t('entityAdmin.empty')}</EmptyState>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">{t('entityAdmin.entity')}</th>
                <th scope="col">{t('entityAdmin.status')}</th>
                <th scope="col">{t('entityAdmin.activity')}</th>
                {canDecide ? <th scope="col">{t('entityAdmin.actions')}</th> : null}
              </tr>
            </thead>
            <tbody>
              {entities.items.map((e) => (
                <tr key={e.id}>
                  <td>
                    <span className="block font-medium">{e.legalName}</span>
                    <span className="block font-mono text-xs text-muted-foreground">{e.slug}</span>
                  </td>
                  <td>
                    <StatusBadge status={e.status}>{t(`entityStatus.${e.status}`)}</StatusBadge>
                    {e.providerSuspended && e.status === 'suspended' ? (
                      <span className="mt-1 block text-xs text-muted-foreground">
                        {t('entityAdmin.providerToo')}
                      </span>
                    ) : null}
                  </td>
                  <td className="text-sm">
                    {t('entityAdmin.counts', {
                      members: e.counts.members,
                      apis: e.counts.publishedApis,
                      subscriptions: e.counts.liveSubscriptions,
                    })}
                    {e.xroadMember ? (
                      <span className="mt-1 block font-mono text-xs text-muted-foreground">
                        X-Road: {e.xroadMember.memberClass}/{e.xroadMember.memberCode}
                      </span>
                    ) : null}
                  </td>
                  {canDecide ? (
                    <td>
                      <EntityStatusActions entityId={e.id} name={e.shortName} status={e.status} />
                      {e.status !== 'offboarded' ? (
                        <XroadMemberForm
                          entityId={e.id}
                          name={e.shortName}
                          member={e.xroadMember}
                        />
                      ) : null}
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {entities.nextCursor ? (
        <p>
          <Link
            href={`/operator/entities?${kept ? `${kept}&` : ''}cursor=${entities.nextCursor}`}
            className="link"
          >
            {t('entityAdmin.next')}
          </Link>
        </p>
      ) : null}
    </Page>
  );
}
