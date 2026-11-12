import { timelineKindSchema, timelineSchema } from '@rid/contracts';
import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { AuditTimeline } from '../../../../../components/audit/audit-views';
import { Page, PageHeader } from '../../../../../components/ui/page';
import { Link } from '../../../../../i18n/navigation';
import { ApiError, apiGet } from '../../../../../lib/api';

interface PageProps {
  params: Promise<{ locale: string; kind: string; id: string }>;
}

async function load(kind: string, id: string) {
  const parsed = timelineKindSchema.safeParse(kind);
  if (!parsed.success) notFound();
  try {
    return {
      kind: parsed.data,
      timeline: await apiGet(`/audit/timeline/${parsed.data}/${id}`, timelineSchema),
    };
  } catch (error) {
    // 403 (not a platform audit role) and 404 look the same from outside.
    if (error instanceof ApiError && [400, 401, 403, 404].includes(error.status)) notFound();
    throw error;
  }
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale, kind } = await params;
  const t = await getTranslations({ locale, namespace: 'audit' });
  return { title: t('timeline') + (kind === 'api' ? ' · API' : '') };
}

/** Platform timeline of one subscription or API (DEMO.md step 10). */
export default async function AuditTimelinePage({ params }: PageProps) {
  const { locale, kind, id } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('audit');
  const { kind: k, timeline } = await load(kind, id);
  return (
    <Page>
      <Link href="/audit" className="link inline-block text-sm">
        <span aria-hidden="true">← </span>
        {t('title')}
      </Link>
      <PageHeader
        title={t('timelineTitle', { kind: t(`kinds.${k}`), id })}
        titleClassName="break-all text-2xl md:text-3xl"
      />
      <div className="max-w-3xl">
        <AuditTimeline items={timeline.items} />
      </div>
    </Page>
  );
}
