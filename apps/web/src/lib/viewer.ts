import {
  meResponseSchema,
  type MembershipSummary,
  type PlatformRole,
  type Role,
} from '@rid/contracts';
import { cookies } from 'next/headers';
import { cache } from 'react';
import { auth } from '../auth';
import { apiGet } from './api';
import { redirectToStepUp } from './step-up';

export const ACTIVE_ENTITY_COOKIE = 'rid-active-entity';

export interface Viewer {
  authenticated: boolean;
  /** Portal user id (from /me); absent for anonymous visitors or when the API is unavailable. */
  userId?: string;
  name?: string;
  platformRoles: PlatformRole[];
  memberships: MembershipSummary[];
  /** Entity the user is acting for (cookie), defaulting to the first membership. */
  activeEntity?: MembershipSummary;
  /** Platform roles plus the roles of the active membership: what the UI may offer. */
  roles: Role[];
  /** The portal API could not be reached or rejected the session. */
  apiUnavailable: boolean;
  /**
   * The roles need a second factor this session does not have, and the step-up just tried did
   * not get it (M3-08): the header offers to try again; the roles are not offered meanwhile.
   */
  mfaPending: boolean;
}

const anonymous: Viewer = {
  authenticated: false,
  platformRoles: [],
  memberships: [],
  roles: [],
  apiUnavailable: false,
  mfaPending: false,
};

export function chooseActiveEntity(
  memberships: MembershipSummary[],
  requestedId: string | undefined,
): MembershipSummary | undefined {
  return memberships.find((m) => m.entity.id === requestedId) ?? memberships[0];
}

/**
 * Who is looking at the page, once per request. Roles come from the portal API (/me), which
 * reads them from PostgreSQL every time (ADR-0004); the UI only uses them to shape navigation:
 * every API endpoint checks authorization again (CLAUDE.md, rule 3).
 */
export const getViewer = cache(async (): Promise<Viewer> => {
  const session = await auth();
  if (!session?.user) return anonymous;
  const name = session.user.name ?? session.user.email ?? undefined;
  let me;
  try {
    me = await apiGet('/me', meResponseSchema);
  } catch (error) {
    console.error(
      'Could not load the viewer from the portal API',
      error instanceof Error ? error.message : error,
    );
    return { ...anonymous, authenticated: true, name, apiUnavailable: true };
  }
  if (me.mfa.required && !me.mfa.satisfied) {
    // Outside the try: redirect() works by throwing.
    await redirectToStepUp();
    return { ...anonymous, authenticated: true, userId: me.user.id, name, mfaPending: true };
  }
  const requested = (await cookies()).get(ACTIVE_ENTITY_COOKIE)?.value;
  const activeEntity = chooseActiveEntity(me.memberships, requested);
  return {
    authenticated: true,
    userId: me.user.id,
    name: me.user.fullName,
    platformRoles: me.platformRoles,
    memberships: me.memberships,
    activeEntity,
    roles: [...me.platformRoles, ...(activeEntity?.roles ?? [])],
    apiUnavailable: false,
    mfaPending: false,
  };
});
