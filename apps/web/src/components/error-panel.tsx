'use client';

import { useTranslations } from 'next-intl';
import { DocumentTitle } from './document-title';
import { Button } from './ui/button';

/**
 * What the user sees when a page fails (B-24): the same words in either interface language, a
 * way to try again and a way out, and the digest Next.js gives the error so the operator can
 * find it in the server's log. The error itself is never shown.
 */
export function ErrorPanel({
  digest,
  homeHref,
  onRetry,
}: {
  digest?: string;
  homeHref: string;
  onRetry: () => void;
}) {
  const t = useTranslations('errorPage');
  const title = t('title');
  return (
    <section
      role="alert"
      className="mx-auto w-full max-w-2xl space-y-4 px-4 py-16 sm:px-6"
      data-testid="error-panel"
    >
      <DocumentTitle title={title} />
      <h1 className="text-3xl leading-tight font-bold md:text-4xl">{title}</h1>
      <p>{t('body')}</p>
      {digest ? (
        <p className="text-sm text-muted-foreground">{t('reference', { digest })}</p>
      ) : null}
      <div className="flex flex-wrap gap-3">
        <Button type="button" onClick={onRetry}>
          {t('retry')}
        </Button>
        <Button asChild variant="outline">
          <a href={homeHref}>{t('home')}</a>
        </Button>
      </div>
    </section>
  );
}
