import { getTranslations } from 'next-intl/server';

export async function SkipLink() {
  const t = await getTranslations('a11y');
  return (
    <a
      href="#main-content"
      className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-background focus:px-4 focus:py-2 focus:text-foreground focus:shadow"
    >
      {t('skipToContent')}
    </a>
  );
}
