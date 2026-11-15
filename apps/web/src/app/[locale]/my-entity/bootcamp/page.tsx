import { bootcampChecklistSchema } from '@rid/contracts';
import type { Metadata } from 'next';
import { getFormatter, getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { BootcampItemForm } from '../../../../components/bootcamp/bootcamp-forms';
import { StatusBadge } from '../../../../components/ui/badge';
import { Notice } from '../../../../components/ui/notice';
import { Page, PageHeader } from '../../../../components/ui/page';
import { Link } from '../../../../i18n/navigation';
import { apiGet } from '../../../../lib/api';
import { getViewer } from '../../../../lib/viewer';

interface PageProps {
  params: Promise<{ locale: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'bootcamp' });
  return { title: t('title') };
}

/** What the entity has ready for the bootcamp where its node is installed (M4-07). */
export default async function BootcampPage({ params }: PageProps) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations();
  const format = await getFormatter();
  const active = (await getViewer()).activeEntity;
  if (!active) notFound();
  const canWrite = active.roles.includes('entity_admin');
  const checklist = await apiGet(`/entities/${active.entity.id}/bootcamp`, bootcampChecklistSchema);

  return (
    <Page>
      <PageHeader
        eyebrow={active.entity.shortName}
        title={t('bootcamp.title')}
        description={t('bootcamp.lead')}
        actions={
          <Link href="/my-entity" className="link">
            {t('nav.myEntity')}
          </Link>
        }
      />
      <Notice tone={checklist.ready ? 'success' : 'info'} role="status">
        {checklist.ready ? t('bootcamp.ready') : t('bootcamp.notReady')}
      </Notice>
      <ol className="space-y-4">
        {checklist.items.map((item) => (
          <li key={item.item} className="card space-y-3 p-6" data-testid={`bootcamp-${item.item}`}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-lg font-semibold">{t(`bootcamp.items.${item.item}.title`)}</h2>
              <StatusBadge status={item.status === 'done' ? 'approved' : 'pending'}>
                {t(`bootcamp.status.${item.status}`)}
              </StatusBadge>
            </div>
            <p className="text-sm text-muted-foreground">{t(`bootcamp.items.${item.item}.hint`)}</p>
            {item.updatedAt ? (
              <p className="text-xs text-muted-foreground">
                {t('bootcamp.updated', {
                  date: format.dateTime(new Date(item.updatedAt), { dateStyle: 'medium' }),
                })}
              </p>
            ) : null}
            {item.automatic ? (
              <p className="text-sm">{t('bootcamp.automatic')}</p>
            ) : canWrite ? (
              <BootcampItemForm
                entityId={active.entity.id}
                item={item.item}
                done={item.status === 'done'}
                note={item.note}
              />
            ) : item.note ? (
              <p className="text-sm">{item.note}</p>
            ) : null}
          </li>
        ))}
      </ol>
    </Page>
  );
}
