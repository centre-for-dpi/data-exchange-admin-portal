import { getTranslations } from 'next-intl/server';

/** Placeholder for sections delivered by later backlog stories. */
export async function ComingSoon({ navKey }: { navKey: string }) {
  const t = await getTranslations();
  return (
    <section className="mx-auto max-w-6xl px-4 py-10">
      <h1 className="text-2xl font-bold">{t(`nav.${navKey}`)}</h1>
      <p className="mt-3 text-muted-foreground">{t('comingSoon.body')}</p>
    </section>
  );
}
