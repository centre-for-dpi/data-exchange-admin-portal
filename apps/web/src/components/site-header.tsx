import Image from 'next/image';
import { getTranslations } from 'next-intl/server';
import { Link } from '../i18n/navigation';
import { visibleNavItems } from '../lib/navigation';
import { getSite } from '../lib/site';
import { getViewer } from '../lib/viewer';
import { EntitySelector } from './entity-selector';
import { LocaleSwitcher } from './locale-switcher';
import { NavLink } from './nav-link';
import { UserMenu } from './user-menu';

export async function SiteHeader() {
  const viewer = await getViewer();
  const site = getSite();
  const t = await getTranslations();
  const items = visibleNavItems(viewer, { publicCatalog: site.publicCatalog });

  return (
    <header className="border-b border-border bg-background">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-3 px-4 pt-4 pb-3 sm:px-6">
        <Link
          href="/"
          className="flex items-center gap-3 rounded-lg"
          aria-label={t('a11y.homeLink', { productName: site.productName })}
        >
          <Image
            src="/branding/logo"
            alt=""
            width={36}
            height={36}
            unoptimized
            className="rounded-lg"
          />
          <span className="font-serif text-lg leading-tight font-bold text-foreground-strong">
            {site.productName}
          </span>
        </Link>
        <div className="ml-auto flex flex-wrap items-center gap-x-4 gap-y-2">
          {viewer.memberships.length > 1 ? (
            <EntitySelector
              memberships={viewer.memberships}
              activeEntityId={viewer.activeEntity?.entity.id}
            />
          ) : viewer.activeEntity ? (
            <span className="rounded-full bg-surface-app px-3 py-1 text-sm text-muted-foreground">
              {t('entity.current', { name: viewer.activeEntity.entity.shortName })}
            </span>
          ) : null}
          <LocaleSwitcher />
          <UserMenu />
        </div>
      </div>
      {items.length > 0 ? (
        <nav aria-label={t('a11y.mainNavigation')} className="mx-auto max-w-6xl px-4 sm:px-6">
          <ul className="-mx-1 flex gap-1 overflow-x-auto pb-2">
            {items.map((item) => (
              <li key={item.key} className="shrink-0">
                <NavLink href={item.href}>{t(`nav.${item.key}`)}</NavLink>
              </li>
            ))}
          </ul>
        </nav>
      ) : null}
    </header>
  );
}
