'use client';

import { useLocale } from 'next-intl';
import { ErrorPanel } from '../../components/error-panel';
import { routing } from '../../i18n/routing';

/** A page of the portal failed (B-24): translated, inside the layout. */
export default function LocaleError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const locale = useLocale();
  return (
    <ErrorPanel
      digest={error.digest}
      homeHref={locale === routing.defaultLocale ? '/' : `/${locale}`}
      onRetry={reset}
    />
  );
}
