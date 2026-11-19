'use client';

import { useLocale, useTranslations } from 'next-intl';
import { Link, usePathname } from '../i18n/navigation';
import { routing } from '../i18n/routing';
import { cn } from '../lib/utils';

export function LocaleSwitcher() {
  const t = useTranslations();
  const pathname = usePathname();
  const current = useLocale();
  // A country with a single interface language has nothing to switch.
  if (routing.locales.length < 2) return null;
  return (
    <nav aria-label={t('a11y.language')}>
      <ul className="flex rounded-full border border-border bg-surface-app p-0.5">
        {routing.locales.map((locale) => (
          <li key={locale}>
            <Link
              href={pathname}
              locale={locale}
              lang={locale}
              aria-current={locale === current ? 'true' : undefined}
              className={cn(
                'block rounded-full px-3 py-1 text-sm transition-colors duration-150',
                locale === current
                  ? 'bg-background font-semibold text-foreground-strong shadow-sm'
                  : 'text-muted-foreground hover:text-foreground-strong',
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
