import type { Metadata } from 'next';
import { hasLocale, NextIntlClientProvider } from 'next-intl';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import type { CSSProperties, ReactNode } from 'react';
import { SiteFooter } from '../../components/site-footer';
import { SiteHeader } from '../../components/site-header';
import { SkipLink } from '../../components/skip-link';
import { routing } from '../../i18n/routing';
import { getSite } from '../../lib/site';
import '../globals.css';

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
    <html lang={locale} style={brand}>
      <body className="min-h-screen antialiased">
        <NextIntlClientProvider>
          <SkipLink />
          <SiteHeader />
          <main id="main-content" tabIndex={-1} className="focus:outline-none">
            {children}
          </main>
          <SiteFooter />
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
