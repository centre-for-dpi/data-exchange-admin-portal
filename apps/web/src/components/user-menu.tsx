import { getLocale, getTranslations } from 'next-intl/server';
import { auth } from '../auth';
import { signInAction, signOutAction } from '../lib/auth-actions';
import { Button } from './ui/button';

/** First letter of the first two words, for the avatar. */
const initials = (name: string): string =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? '')
    .join('');

export async function UserMenu() {
  const session = await auth();
  const locale = await getLocale();
  const t = await getTranslations('auth');

  if (!session?.user) {
    return (
      <form action={signInAction.bind(null, locale)}>
        <Button type="submit" size="sm">
          {t('signIn')}
        </Button>
      </form>
    );
  }

  const name = session.user.name ?? session.user.email ?? '';
  return (
    <div className="flex items-center gap-3">
      <span className="flex items-center gap-2 text-sm text-muted-foreground">
        <span
          aria-hidden="true"
          className="grid size-8 place-items-center rounded-full bg-primary text-xs font-semibold text-primary-foreground"
        >
          {initials(name)}
        </span>
        <span>{t('signedInAs', { name })}</span>
      </span>
      <form action={signOutAction.bind(null, locale)}>
        <Button type="submit" variant="outline" size="sm">
          {t('signOut')}
        </Button>
      </form>
    </div>
  );
}
