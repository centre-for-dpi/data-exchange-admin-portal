import { purposeAdminListSchema } from '@rid/contracts';
import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { PurposeActiveButton, PurposeForm } from '../../../../components/purposes/forms';
import { Badge } from '../../../../components/ui/badge';
import { Page, PageHeader, Section } from '../../../../components/ui/page';
import { apiGet } from '../../../../lib/api';
import { localize } from '../../../../lib/localize';
import { getViewer } from '../../../../lib/viewer';

interface PageProps {
  params: Promise<{ locale: string }>;
}

const READ_ROLES = ['platform_admin', 'platform_reviewer', 'regulator'];
const MANAGE_ROLES = ['platform_admin', 'platform_reviewer'];

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'purposes' });
  return { title: t('title') };
}

const both = (text: string | { es?: string; en?: string }) =>
  typeof text === 'string' ? { es: text, en: text } : { es: text.es ?? '', en: text.en ?? '' };

/** Operator console: the purpose catalogue (SPEC.md §3, §6; M2-10). */
export default async function PurposesPage({ params }: PageProps) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('purposes');
  const viewer = await getViewer();
  if (!viewer.platformRoles.some((r) => READ_ROLES.includes(r))) notFound();
  const canManage = viewer.platformRoles.some((r) => MANAGE_ROLES.includes(r));
  const catalogue = await apiGet('/admin/purposes', purposeAdminListSchema);

  return (
    <Page>
      <PageHeader title={t('title')} description={t('lead')} />
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">{t('purpose')}</th>
              <th scope="col">{t('source')}</th>
              <th scope="col">{t('usage')}</th>
              <th scope="col">{t('state')}</th>
              {canManage ? <th scope="col">{t('actions')}</th> : null}
            </tr>
          </thead>
          <tbody>
            {catalogue.items.map((p) => (
              <tr key={p.code}>
                <td>
                  <span className="block font-medium">{localize(p.name, locale)}</span>
                  <span className="block font-mono text-xs text-muted-foreground">{p.code}</span>
                  <span className="block text-sm text-muted-foreground">
                    {localize(p.description, locale)}
                  </span>
                </td>
                <td>{t(`sources.${p.source}`)}</td>
                <td className="whitespace-nowrap text-sm">
                  {t('usageCount', {
                    versions: p.usage.versions,
                    subscriptions: p.usage.subscriptions,
                  })}
                </td>
                <td>
                  <Badge tone={p.active ? 'success' : 'neutral'}>
                    {p.active ? t('active') : t('inactive')}
                  </Badge>
                </td>
                {canManage ? (
                  <td className="space-y-2">
                    <PurposeActiveButton code={p.code} active={p.active} />
                    {p.source === 'operator' ? (
                      <details>
                        <summary className="link cursor-pointer text-sm">
                          {t('editFor', { code: p.code })}
                        </summary>
                        <div className="mt-3 min-w-72">
                          <PurposeForm
                            code={p.code}
                            initial={{
                              name: both(p.name),
                              description: both(p.description),
                              legalReference: p.legalReference,
                            }}
                          />
                        </div>
                      </details>
                    ) : null}
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {canManage ? (
        <Section title={t('form.create')} description={t('createLead')}>
          <div className="card max-w-3xl p-6 md:p-8">
            <PurposeForm />
          </div>
        </Section>
      ) : null}
    </Page>
  );
}
