import Image from 'next/image';
import { getTranslations } from 'next-intl/server';
import { getSite } from '../lib/site';

export async function SiteFooter() {
  const site = getSite();
  const t = await getTranslations('footer');
  return (
    <footer className="mt-16 bg-surface-inverse text-white print:hidden">
      <div className="mx-auto grid max-w-6xl gap-6 px-4 py-10 sm:px-6 md:grid-cols-[1fr_2fr]">
        <div className="flex items-center gap-3">
          <Image
            src="/branding/logo"
            alt=""
            width={32}
            height={32}
            unoptimized
            className="rounded-lg"
          />
          <p className="font-serif text-lg font-bold">{site.productName}</p>
        </div>
        <div className="space-y-2 text-sm text-[#d2d2d2]">
          <p>
            {t('operatedBy', { operator: site.operator.name })} ·{' '}
            {t('supervisedBy', { regulator: site.regulator.name })}
          </p>
          <p>{t('privacy')}</p>
        </div>
      </div>
    </footer>
  );
}
