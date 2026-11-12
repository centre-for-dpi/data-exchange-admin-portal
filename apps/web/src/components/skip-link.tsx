import { getTranslations } from 'next-intl/server';

export async function SkipLink() {
  const t = await getTranslations('a11y');
  return (
    <a
      href="#main-content"
      className="sr-only focus:not-sr-only focus:absolute focus:top-3 focus:left-3 focus:z-50 focus:rounded-full focus:bg-background focus:px-5 focus:py-2.5 focus:font-medium focus:text-foreground-strong focus:shadow-raised"
    >
      {t('skipToContent')}
    </a>
  );
}
