import { invitationListSchema } from '@rid/contracts';
import type { Metadata } from 'next';
import { getFormatter, getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { InvitationActions } from '../../../components/entity-requests/forms';
import { EmptyState, Page, PageHeader } from '../../../components/ui/page';
import { apiGet } from '../../../lib/api';
import { getViewer } from '../../../lib/viewer';

interface PageProps {
  params: Promise<{ locale: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'invitations' });
  return { title: t('title') };
}

/** Invitations addressed to the signed-in person's verified e-mail (ADR-0018). */
export default async function InvitationsPage({ params }: PageProps) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations();
  const format = await getFormatter();
  if (!(await getViewer()).authenticated) notFound();
  const invitations = await apiGet('/me/invitations', invitationListSchema);

  return (
    <Page>
      <PageHeader title={t('invitations.title')} description={t('invitations.lead')} />
      {invitations.items.length === 0 ? (
        <EmptyState>{t('invitations.empty')}</EmptyState>
      ) : (
        <ul className="space-y-4">
          {invitations.items.map((invitation) => (
            <li key={invitation.id} className="card space-y-4 p-6">
              <div className="space-y-1">
                <h2 className="text-xl font-bold">{invitation.entity.legalName}</h2>
                <p className="text-sm text-muted-foreground">
                  {t('invitations.roles', {
                    roles: invitation.roles.map((r) => t(`roles.${r}`)).join(', '),
                  })}
                </p>
                <p className="text-sm text-muted-foreground">
                  {t('invitations.expires', {
                    date: format.dateTime(new Date(invitation.expiresAt), { dateStyle: 'long' }),
                  })}
                </p>
              </div>
              <InvitationActions
                invitationId={invitation.id}
                locale={locale}
                entityName={invitation.entity.shortName}
              />
            </li>
          ))}
        </ul>
      )}
    </Page>
  );
}
