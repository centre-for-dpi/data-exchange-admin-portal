import { getTranslations } from 'next-intl/server';
import { getSite } from '../lib/site';

export async function SiteFooter() {
  const site = getSite();
  const t = await getTranslations('footer');
  return (
    <footer className="mt-16 border-t border-border bg-muted">
      <div className="mx-auto max-w-6xl space-y-1 px-4 py-6 text-sm text-muted-foreground">
        <p>
          {t('operatedBy', { operator: site.operator.name })} ·{' '}
          {t('supervisedBy', { regulator: site.regulator.name })}
        </p>
        <p>{t('privacy')}</p>
      </div>
    </footer>
  );
}
