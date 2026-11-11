'use server';

import { meResponseSchema } from '@rid/contracts';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { apiGet } from './api';
import { ACTIVE_ENTITY_COOKIE } from './viewer';

const safeReturnPath = (value: FormDataEntryValue | null): string => {
  const path = typeof value === 'string' ? value : '/';
  // Only same-site relative paths: no open redirect.
  return path.startsWith('/') && !path.startsWith('//') ? path : '/';
};

/** Switches the entity the user acts for. Only entities of an active membership are accepted. */
export async function setActiveEntityAction(formData: FormData): Promise<void> {
  const entityId = formData.get('entityId');
  const me = await apiGet('/me', meResponseSchema);
  if (typeof entityId === 'string' && me.memberships.some((m) => m.entity.id === entityId)) {
    (await cookies()).set(ACTIVE_ENTITY_COOKIE, entityId, {
      httpOnly: true,
      sameSite: 'lax',
      secure: (process.env.AUTH_URL ?? '').startsWith('https://'),
      path: '/',
      maxAge: 60 * 60 * 24 * 30,
    });
  }
  redirect(safeReturnPath(formData.get('returnTo')));
}
