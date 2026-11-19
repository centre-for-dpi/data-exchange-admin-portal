'use client';

import { NextIntlClientProvider } from 'next-intl';
import { ErrorPanel } from '../components/error-panel';
import { routing } from '../i18n/routing';
import en from '../../messages/en.json';
import es from '../../messages/es.json';
import './globals.css';

const MESSAGES = { es, en } as const;

/**
 * The layout itself failed (B-24): there is no provider and no locale from the route, so the
 * language is read from the address (`/en/...`) and the messages are bundled here.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const first = typeof window === 'undefined' ? '' : window.location.pathname.split('/')[1];
  const locale = (routing.locales as readonly string[]).includes(first ?? '')
    ? (first as keyof typeof MESSAGES)
    : routing.defaultLocale;
  return (
    <html lang={locale}>
      <body className="flex min-h-screen flex-col antialiased">
        <NextIntlClientProvider locale={locale} messages={MESSAGES[locale]}>
          <main id="main-content">
            <ErrorPanel
              digest={error.digest}
              homeHref={locale === routing.defaultLocale ? '/' : `/${locale}`}
              onRetry={reset}
            />
          </main>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
