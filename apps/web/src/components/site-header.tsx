import Image from 'next/image';
import { getLocale, getTranslations } from 'next-intl/server';
import { Bell } from 'lucide-react';
import { notificationPageSchema } from '@den/contracts';
import { Link } from '../i18n/navigation';
import { apiGet } from '../lib/api';
import { stepUpAction } from '../lib/auth-actions';
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
  const locale = await getLocale();
  // Unread notices (M2-08); a failure only hides the count.
  const unread =
    viewer.authenticated && !viewer.apiUnavailable
      ? await apiGet('/me/notifications?limit=1&unread=true', notificationPageSchema)
          .then((p) => p.unread)
          .catch(() => 0)
      : 0;

  return (
    <header className="border-b border-border bg-background print:hidden">
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
        <div className="ml-auto flex max-w-full min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
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
          {viewer.authenticated ? (
            <Link
              href="/notifications"
              className="relative inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm text-foreground-strong hover:bg-surface-app"
            >
              <Bell aria-hidden="true" className="size-4" />
              <span>{t('notifications.short')}</span>
              {unread > 0 ? (
                <>
                  <span
                    aria-hidden="true"
                    className="rounded-full bg-primary px-1.5 text-xs font-semibold text-primary-foreground"
                  >
                    {unread > 99 ? '99+' : unread}
                  </span>
                  {/* The visible label stays the start of the accessible name (WCAG 2.5.3). */}
                  <span className="sr-only">
                    {t('notifications.unreadSuffix', { count: unread })}
                  </span>
                </>
              ) : null}
            </Link>
          ) : null}
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
      {viewer.mfaPending ? (
        // The roles need the second factor and the last try did not get it (M3-08).
        <div role="alert" className="border-t border-border bg-surface-app">
          <form
            action={stepUpAction.bind(null, locale)}
            className="mx-auto flex max-w-6xl flex-wrap items-center gap-3 px-4 py-3 text-sm sm:px-6"
          >
            <p className="text-foreground-strong">{t('session.mfaRequired')}</p>
            <button
              type="submit"
              className="rounded-full bg-primary px-4 py-1.5 font-semibold text-primary-foreground"
            >
              {t('session.mfaAction')}
            </button>
          </form>
        </div>
      ) : null}
    </header>
  );
}
