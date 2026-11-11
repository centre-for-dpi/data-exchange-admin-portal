import { getTranslations, setRequestLocale } from 'next-intl/server';
import { auth } from '../../auth';
import { Button } from '../../components/ui/button';
import { Link } from '../../i18n/navigation';
import { signInAction } from '../../lib/auth-actions';
import { visibleNavItems } from '../../lib/navigation';
import { getSite } from '../../lib/site';

export default async function HomePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const session = await auth();
  const site = getSite();
  const t = await getTranslations();

  // Roles come from the portal API starting with M1-02 (ADR-0004).
  const roles = [] as const;
  const quickLinks = visibleNavItems(
    { authenticated: Boolean(session?.user), roles },
    { publicCatalog: site.publicCatalog },
  ).filter((item) => item.key !== 'home');

  return (
    <section className="mx-auto max-w-6xl px-4 py-10">
      <h1 className="text-3xl font-bold">{site.productName}</h1>
      <p className="mt-3 max-w-3xl text-lg text-muted-foreground">{t('home.lead')}</p>

      {session?.user ? (
        <div className="mt-10 space-y-4">
          <h2 className="text-xl font-semibold">
            {t('home.welcome', { name: session.user.name ?? session.user.email ?? '' })}
          </h2>
          <h3 className="font-medium">{t('home.quickAccess')}</h3>
          <ul className="flex flex-wrap gap-2">
            {quickLinks.map((item) => (
              <li key={item.key}>
                <Button asChild variant="outline">
                  <Link href={item.href}>{t(`nav.${item.key}`)}</Link>
                </Button>
              </li>
            ))}
          </ul>
          {roles.length === 0 && <p className="text-muted-foreground">{t('home.noRoles')}</p>}
        </div>
      ) : (
        <div className="mt-10 space-y-4">
          <p>{t('home.anonymousCta')}</p>
          <form action={signInAction.bind(null, locale)}>
            <Button type="submit">{t('auth.signIn')}</Button>
          </form>
        </div>
      )}
    </section>
  );
}
