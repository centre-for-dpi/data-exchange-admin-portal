import { getTranslations } from 'next-intl/server';
import { DocumentTitle } from '../../components/document-title';
import { Link } from '../../i18n/navigation';
import { Button } from '../../components/ui/button';

/** A page that does not exist, or that the viewer may not see (B-24): translated. */
export default async function NotFound() {
  const t = await getTranslations('notFound');
  return (
    <section className="mx-auto w-full max-w-2xl space-y-4 px-4 py-16 sm:px-6">
      <DocumentTitle title={t('title')} />
      <h1 className="text-3xl leading-tight font-bold md:text-4xl">{t('title')}</h1>
      <p>{t('body')}</p>
      <Button asChild>
        <Link href="/">{t('home')}</Link>
      </Button>
    </section>
  );
}
