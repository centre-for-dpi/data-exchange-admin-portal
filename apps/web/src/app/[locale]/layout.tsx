import type { Metadata } from 'next';
import { hasLocale, NextIntlClientProvider } from 'next-intl';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { Lora, Outfit } from 'next/font/google';
import { notFound } from 'next/navigation';
import type { CSSProperties, ReactNode } from 'react';
import { SessionTimeout } from '../../components/session-timeout';
import { SiteFooter } from '../../components/site-footer';
import { SiteHeader } from '../../components/site-header';
import { SkipLink } from '../../components/skip-link';
import { routing } from '../../i18n/routing';
import { auth } from '../../auth';
import { sessionIdleSeconds } from '../../lib/session-idle';
import { getSite } from '../../lib/site';
import { idleSecondsLeft } from '../../lib/token-refresh';
import { getViewer } from '../../lib/viewer';
import '../globals.css';

// Brand typefaces (SIL OFL 1.1). next/font downloads them at build time and serves them from our
// own origin, so the browser never contacts a third-party host.
const outfit = Outfit({ subsets: ['latin', 'latin-ext'], variable: '--font-outfit' });
const lora = Lora({
  subsets: ['latin', 'latin-ext'],
  variable: '--font-lora',
  weight: ['600', '700'],
});

interface LayoutProps {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}

export async function generateMetadata({ params }: LayoutProps): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'metadata' });
  const { productName } = getSite();
  return {
    title: { default: productName, template: `%s · ${productName}` },
    description: t('description'),
    icons: { icon: '/branding/logo' },
  };
}

export default async function LocaleLayout({ children, params }: LayoutProps) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);

  const site = getSite();
  // Brand tokens from config/country/<code>.yaml; the foreground is chosen for WCAG AA contrast.
  const brand = {
    '--primary': site.primaryColor,
    '--primary-foreground': site.primaryForeground,
  } as CSSProperties;

  return (
    <html lang={locale} style={brand} className={`${outfit.variable} ${lora.variable}`}>
      <body className="flex min-h-screen flex-col antialiased">
        <NextIntlClientProvider>
          <SkipLink />
          <SiteHeader />
          <main id="main-content" tabIndex={-1} className="flex-1 focus:outline-none">
            {children}
          </main>
          <SiteFooter />
          {/* WCAG 2.2.1 (M6-02): the realm's idle timeout, DEN_SESSION_IDLE_SECONDS. */}
          {(await getViewer()).authenticated ? (
            <SessionTimeout
              remainingSeconds={idleSecondsLeft((await auth())?.refreshedAt, sessionIdleSeconds())}
            />
          ) : null}
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
