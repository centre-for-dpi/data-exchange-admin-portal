import { getCountryConfig } from '@rid/config';
import { CLASSIFICATIONS, catalogEntitiesSchema, catalogPageSchema } from '@rid/contracts';
import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { Badge, classificationTone } from '../../../components/ui/badge';
import { Button } from '../../../components/ui/button';
import { Page, PageHeader } from '../../../components/ui/page';
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
      <Page>
        <PageHeader title={t('nav.catalog')} description={t('catalog.signInRequired')} />
        <form action={signInAction.bind(null, locale)}>
          <Button type="submit" size="lg">
            {t('auth.signIn')}
          </Button>
        </form>
      </Page>
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
  const labelClass = 'block text-sm font-medium text-foreground-strong';

  return (
    <Page>
      <PageHeader title={t('nav.catalog')} description={t('catalog.lead')} />

      <form
        method="get"
        role="search"
        className="card grid gap-4 p-5 md:grid-cols-[2fr_1fr_1fr_1fr_auto] md:p-6"
      >
        <div>
          <label htmlFor="q" className={labelClass}>
            {t('catalog.searchLabel')}
          </label>
          <input id="q" name="q" type="search" defaultValue={filters.q} className={inputClass} />
        </div>
        <div>
          <label htmlFor="sector" className={labelClass}>
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
          <label htmlFor="entity" className={labelClass}>
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
          <label htmlFor="classification" className={labelClass}>
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
          <Button type="submit" className="w-full md:w-auto">
            {t('catalog.apply')}
          </Button>
        </div>
      </form>

      <p role="status" className="text-sm font-medium text-muted-foreground">
        {t('catalog.results', { count: page.items.length })}
      </p>

      {page.items.length > 0 ? (
        <ul className="grid gap-5 md:grid-cols-2">
          {page.items.map((item) => (
            <li
              key={item.api.id}
              className="card relative flex flex-col gap-4 p-6 transition-[transform,border-color] duration-150 focus-within:border-primary hover:-translate-y-0.5 hover:border-primary"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="eyebrow">{sectorName.get(item.api.sector) ?? item.api.sector}</p>
                <Badge tone={classificationTone(item.api.classification)}>
                  {t(`classification.${item.api.classification}`)}
                </Badge>
              </div>
              <div className="space-y-2">
                <h2 className="text-xl leading-snug font-bold">
                  {/* The link covers the whole card (::after), so the card is one click target. */}
                  <Link
                    href={`/catalog/${item.api.id}`}
                    className="text-foreground-strong underline decoration-transparent underline-offset-4 transition-colors after:absolute after:inset-0 after:rounded-[var(--radius-card)] hover:decoration-current focus-visible:decoration-current"
                  >
                    {item.api.name}
                  </Link>
                </h2>
                <p className="text-sm text-muted-foreground">
                  {t('catalog.providedBy', { entity: item.entity.shortName })}
                </p>
                <p className="leading-relaxed">{item.api.summary}</p>
              </div>
              <div className="mt-auto space-y-1 border-t border-border pt-4 text-sm">
                <p>
                  {item.personalFields.length > 0
                    ? t('catalog.personalData', { fields: item.personalFields.join(', ') })
                    : t('catalog.noPersonalData')}
                </p>
                {item.sensitiveFields.length > 0 ? (
                  <p className="font-medium text-warning-fg">
                    {t('catalog.sensitiveData', { fields: item.sensitiveFields.join(', ') })}
                  </p>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      {nextQuery ? (
        <div className="flex justify-center">
          <Button asChild variant="outline">
            <Link href={`/catalog?${nextQuery.toString()}`}>{t('catalog.more')}</Link>
          </Button>
        </div>
      ) : null}
    </Page>
  );
}
