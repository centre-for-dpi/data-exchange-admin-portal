import { getLocale, getTranslations } from 'next-intl/server';
import { auth } from '../auth';
import { signInAction, signOutAction } from '../lib/auth-actions';
import { Button } from './ui/button';

export async function UserMenu() {
  const session = await auth();
  const locale = await getLocale();
  const t = await getTranslations('auth');

  if (!session?.user) {
    return (
      <form action={signInAction.bind(null, locale)}>
        <Button type="submit">{t('signIn')}</Button>
      </form>
    );
  }

  return (
    <div className="flex items-center gap-3">
      <span className="text-sm text-muted-foreground">
        {t('signedInAs', { name: session.user.name ?? session.user.email ?? '' })}
      </span>
      <form action={signOutAction.bind(null, locale)}>
        <Button type="submit" variant="outline" size="sm">
          {t('signOut')}
        </Button>
      </form>
    </div>
  );
}
