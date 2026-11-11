'use client';

import { useLocale, useTranslations } from 'next-intl';
import { Link, usePathname } from '../i18n/navigation';
import { routing } from '../i18n/routing';
import { cn } from '../lib/utils';

export function LocaleSwitcher() {
  const t = useTranslations();
  const pathname = usePathname();
  const current = useLocale();
  return (
    <nav aria-label={t('a11y.language')}>
      <ul className="flex gap-1">
        {routing.locales.map((locale) => (
          <li key={locale}>
            <Link
              href={pathname}
              locale={locale}
              lang={locale}
              aria-current={locale === current ? 'true' : undefined}
              className={cn(
                'block rounded-md px-2 py-1 text-sm',
                locale === current ? 'font-semibold underline' : 'hover:bg-muted',
              )}
            >
              {t(`locale.${locale}`)}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
