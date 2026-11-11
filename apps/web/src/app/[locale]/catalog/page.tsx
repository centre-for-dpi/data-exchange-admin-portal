import { getCountryConfig } from '@rid/config';
import { CLASSIFICATIONS, catalogEntitiesSchema, catalogPageSchema } from '@rid/contracts';
import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { Button } from '../../../components/ui/button';
import { inputClass } from '../../../components/form/field';
import { Link } from '../../../i18n/navigation';
import { apiGet } from '../../../lib/api';
import { signInAction } from '../../../lib/auth-actions';
import { localize } from '../../../lib/localize';
import { getViewer } from '../../../lib/viewer';

interface PageProps {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'nav' });
  return { title: t('catalog') };
}

const one = (value: string | string[] | undefined): string =>
  (Array.isArray(value) ? value[0] : value)?.trim() ?? '';

export default async function CatalogPage({ params, searchParams }: PageProps) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations();
  const raw = await searchParams;
  const filters = {
    q: one(raw.q),
    sector: one(raw.sector),
    entity: one(raw.entity),
    classification: one(raw.classification),
    cursor: one(raw.cursor),
  };
  const query = new URLSearchParams(
    Object.entries({ ...filters, limit: '24' }).filter(([, v]) => v !== ''),
  );
  const config = getCountryConfig();
  const viewer = await getViewer();
  if (!viewer.authenticated && !config.features.publicCatalog) {
    return (
      <section className="mx-auto max-w-6xl space-y-4 px-4 py-10">
        <h1 className="text-2xl font-bold">{t('nav.catalog')}</h1>
        <p>{t('catalog.signInRequired')}</p>
        <form action={signInAction.bind(null, locale)}>
          <Button type="submit">{t('auth.signIn')}</Button>
        </form>
      </section>
    );
  }
  const anonymous = !viewer.authenticated;
  const [page, entities] = await Promise.all([
    apiGet(`/catalog/apis?${query.toString()}`, catalogPageSchema, { anonymous }),
    apiGet('/catalog/entities', catalogEntitiesSchema, { anonymous }),
  ]);
  const sectors = config.sectors;
  const sectorName = new Map(sectors.map((s) => [s.code, localize(s.name, locale)]));
  const nextQuery = page.nextCursor
    ? new URLSearchParams({ ...Object.fromEntries(query), cursor: page.nextCursor })
    : undefined;

  return (
    <section className="mx-auto max-w-6xl space-y-6 px-4 py-10">
      <div>
        <h1 className="text-2xl font-bold">{t('nav.catalog')}</h1>
        <p className="mt-2 max-w-3xl text-muted-foreground">{t('catalog.lead')}</p>
      </div>

      <form method="get" role="search" className="grid gap-4 md:grid-cols-[2fr_1fr_1fr_1fr_auto]">
        <div>
          <label htmlFor="q" className="block text-sm font-medium">
            {t('catalog.searchLabel')}
          </label>
          <input id="q" name="q" type="search" defaultValue={filters.q} className={inputClass} />
        </div>
        <div>
          <label htmlFor="sector" className="block text-sm font-medium">
            {t('catalog.sector')}
          </label>
          <select id="sector" name="sector" defaultValue={filters.sector} className={inputClass}>
            <option value="">{t('catalog.all')}</option>
            {sectors.map((s) => (
              <option key={s.code} value={s.code}>
                {localize(s.name, locale)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="entity" className="block text-sm font-medium">
            {t('catalog.entity')}
          </label>
          <select id="entity" name="entity" defaultValue={filters.entity} className={inputClass}>
            <option value="">{t('catalog.all')}</option>
            {entities.items.map((e) => (
              <option key={e.id} value={e.slug}>
                {e.shortName}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="classification" className="block text-sm font-medium">
            {t('catalog.classification')}
          </label>
          <select
            id="classification"
            name="classification"
            defaultValue={filters.classification}
            className={inputClass}
          >
            <option value="">{t('catalog.all')}</option>
            {CLASSIFICATIONS.map((c) => (
              <option key={c} value={c}>
                {t(`classification.${c}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="flex items-end">
          <Button type="submit">{t('catalog.apply')}</Button>
        </div>
      </form>

      <p role="status" className="text-sm text-muted-foreground">
        {t('catalog.results', { count: page.items.length })}
      </p>

      <ul className="grid gap-4 md:grid-cols-2">
        {page.items.map((item) => (
          <li key={item.api.id} className="rounded-md border border-border p-4">
            <h2 className="text-lg font-semibold">
              <Link href={`/catalog/${item.api.id}`} className="underline">
                {item.api.name}
              </Link>
            </h2>
            <p className="text-sm text-muted-foreground">
              {t('catalog.providedBy', { entity: item.entity.shortName })} ·{' '}
              {sectorName.get(item.api.sector) ?? item.api.sector} ·{' '}
              {t(`classification.${item.api.classification}`)}
            </p>
            <p className="mt-2">{item.api.summary}</p>
            <p className="mt-2 text-sm">
              {item.personalFields.length > 0
                ? t('catalog.personalData', { fields: item.personalFields.join(', ') })
                : t('catalog.noPersonalData')}
            </p>
            {item.sensitiveFields.length > 0 ? (
              <p className="text-sm font-medium">
                {t('catalog.sensitiveData', { fields: item.sensitiveFields.join(', ') })}
              </p>
            ) : null}
          </li>
        ))}
      </ul>

      {nextQuery ? (
        <Link href={`/catalog?${nextQuery.toString()}`} className="underline">
          {t('catalog.more')}
        </Link>
      ) : null}
    </section>
  );
}
