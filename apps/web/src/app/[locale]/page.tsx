import { ArrowRight } from 'lucide-react';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { auth } from '../../auth';
import { Button } from '../../components/ui/button';
import { Notice } from '../../components/ui/notice';
import { Link } from '../../i18n/navigation';
import { signInAction } from '../../lib/auth-actions';
import { invitationListSchema } from '@rid/contracts';
import { apiGet } from '../../lib/api';
import { homeQuickLinks } from '../../lib/navigation';
import { getSite } from '../../lib/site';
import { getViewer } from '../../lib/viewer';

const STEPS = ['publish', 'request', 'trace'] as const;

export default async function HomePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const session = await auth();
  const site = getSite();
  const t = await getTranslations();

  const viewer = await getViewer();
  const quickLinks = homeQuickLinks(viewer, { publicCatalog: site.publicCatalog });
  // Pending invitations are announced on the home page (ADR-0018); a failure only hides them.
  const invitations =
    viewer.authenticated && !viewer.apiUnavailable
      ? await apiGet('/me/invitations', invitationListSchema).catch(() => ({ items: [] }))
      : { items: [] };

  return (
    <div className="mx-auto w-full max-w-6xl space-y-12 px-4 py-10 sm:px-6 md:py-12">
      <section className="relative overflow-hidden rounded-[2.5rem] bg-surface-panel px-6 py-12 sm:px-10 md:px-14 md:py-16">
        {/* Decorative brand glow. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -top-24 -right-24 size-80 rounded-full opacity-40 blur-3xl"
          style={{ background: 'var(--primary)' }}
        />
        <div className="relative max-w-3xl space-y-5">
          <p className="eyebrow">{t('home.eyebrow')}</p>
          <h1 className="text-4xl leading-tight font-bold md:text-5xl md:leading-tight">
            {site.productName}
          </h1>
          <p className="text-lg leading-relaxed text-foreground md:text-xl">{t('home.lead')}</p>
          {!session?.user ? (
            <div className="flex flex-wrap items-center gap-4 pt-2">
              <form action={signInAction.bind(null, locale)}>
                <Button type="submit" size="lg">
                  {t('auth.signIn')}
                </Button>
              </form>
              <p className="text-sm text-muted-foreground">{t('home.anonymousCta')}</p>
            </div>
          ) : null}
        </div>
      </section>

      {session?.user ? (
        <section className="space-y-6">
          <h2 className="text-3xl font-bold">
            {t('home.welcome', { name: viewer.name ?? session.user.name ?? '' })}
          </h2>
          {viewer.apiUnavailable ? (
            <Notice tone="warning" role="status">
              {t('home.apiUnavailable')}
            </Notice>
          ) : viewer.roles.length === 0 && invitations.items.length === 0 ? (
            <Notice tone="info">{t('home.noRoles')}</Notice>
          ) : null}
          {invitations.items.length > 0 ? (
            <Notice tone="info" role="status">
              {t('home.invitations', { count: invitations.items.length })}{' '}
              <Link href="/invitations" className="link font-semibold">
                {t('home.seeInvitations')}
              </Link>
            </Notice>
          ) : null}
          <h3 className="eyebrow font-sans">{t('home.quickAccess')}</h3>
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {quickLinks.map((item) => (
              <li key={item.key}>
                <Link
                  href={item.href}
                  className="group card flex h-full items-start justify-between gap-4 p-6 transition-[transform,border-color] duration-150 hover:-translate-y-0.5 hover:border-primary"
                >
                  <span className="space-y-1">
                    <span className="block font-serif text-xl font-bold text-foreground-strong">
                      {t(`nav.${item.key}`)}
                    </span>
                    <span className="block text-sm text-muted-foreground">
                      {t(`navHint.${item.key}`)}
                    </span>
                  </span>
                  <ArrowRight
                    aria-hidden="true"
                    className="mt-1 size-5 shrink-0 text-primary-ink transition-transform duration-150 group-hover:translate-x-1"
                  />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <section aria-labelledby="how-heading" className="space-y-6">
          <h2 id="how-heading" className="text-3xl font-bold">
            {t('home.howTitle')}
          </h2>
          <ol className="grid gap-4 md:grid-cols-3">
            {STEPS.map((step, index) => (
              <li key={step} className="card space-y-3 p-6">
                <span
                  aria-hidden="true"
                  className="block font-serif text-4xl font-bold text-primary-ink"
                >
                  {String(index + 1).padStart(2, '0')}
                </span>
                <p className="font-serif text-xl font-bold text-foreground-strong">
                  {t(`home.steps.${step}.title`)}
                </p>
                <p className="text-sm leading-relaxed text-muted-foreground">
                  {t(`home.steps.${step}.body`)}
                </p>
              </li>
            ))}
          </ol>
        </section>
      )}
    </div>
  );
}
