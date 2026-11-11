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
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-3 px-4 py-3">
        <Link
          href="/"
          className="flex items-center gap-2 font-semibold"
          aria-label={t('a11y.homeLink', { productName: site.productName })}
        >
          <Image src="/branding/logo" alt="" width={32} height={32} unoptimized />
          <span>{site.productName}</span>
        </Link>
        <nav aria-label={t('a11y.mainNavigation')}>
          <ul className="flex flex-wrap gap-1">
            {items.map((item) => (
              <li key={item.key}>
                <NavLink href={item.href}>{t(`nav.${item.key}`)}</NavLink>
              </li>
            ))}
          </ul>
        </nav>
        <div className="ml-auto flex flex-wrap items-center gap-4">
          {viewer.memberships.length > 1 ? (
            <EntitySelector
              memberships={viewer.memberships}
              activeEntityId={viewer.activeEntity?.entity.id}
            />
          ) : viewer.activeEntity ? (
            <span className="text-sm text-muted-foreground">
              {t('entity.current', { name: viewer.activeEntity.entity.shortName })}
            </span>
          ) : null}
          <LocaleSwitcher />
          <UserMenu />
        </div>
      </div>
    </header>
  );
}
