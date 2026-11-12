import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { CreateApplicationForm } from '../../../../components/apps/app-forms';
import { getViewer } from '../../../../lib/viewer';

interface PageProps {
  params: Promise<{ locale: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'myApps.create' });
  return { title: t('title') };
}

export default async function NewApplicationPage({ params }: PageProps) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('myApps.create');
  if (!(await getViewer()).activeEntity?.roles.includes('app_developer')) notFound();
  return (
    <section className="mx-auto max-w-6xl space-y-6 px-4 py-10">
      <h1 className="text-2xl font-bold">{t('title')}</h1>
      <CreateApplicationForm />
    </section>
  );
}
