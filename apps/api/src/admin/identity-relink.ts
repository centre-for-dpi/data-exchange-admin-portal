import type { AuditService } from '../audit/audit.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';

/**
 * Re-linking a portal account to a new identity (B-22). The account is tied to the `sub` and the
 * e-mail of the first sign-in; when the person loses their Keycloak user (it was deleted, the realm
 * was rebuilt) or changes address, they would register as a stranger and get none of their
 * memberships or roles. The operator, from the server's command line, points the same portal account
 * at the new Keycloak user (its `sub` from the Keycloak console) and/or the new address. Audited in
 * the same transaction as `user.identity_relinked`, with the reason (rule 4). It is a command line
 * procedure, not a screen, because it decides who is who: the one who runs it has the server.
 */
export const RELINK_ACTOR = { type: 'system' as const, id: 'cli:identity-relink' };

export class IdentityRelinkError extends Error {}

type Db = Pick<PrismaService, '$transaction'>;
type Audit = Pick<AuditService, 'record'>;

export interface IdentityRelink {
  /** The e-mail the account has now. */
  email: string;
  /** The `sub` of the Keycloak user it should be linked to (Keycloak console, user ID). */
  newSub?: string;
  /** The address it should have from now on (the new Keycloak user's, verified there). */
  newEmail?: string;
  /** Why: who asked, how the person was recognised. Required, it goes into the audit trail. */
  reason: string;
}

export interface IdentityRelinkResult {
  outcome: 'relinked' | 'unchanged';
  userId: string;
  email: string;
  keycloakSub: string;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function relinkIdentity(
  prisma: Db,
  audit: Audit,
  change: IdentityRelink,
): Promise<IdentityRelinkResult> {
  const email = change.email.trim().toLowerCase();
  const newEmail = change.newEmail?.trim().toLowerCase();
  const newSub = change.newSub?.trim();
  const reason = change.reason.trim();
  if (!EMAIL.test(email))
    throw new IdentityRelinkError(`"${change.email}" is not an e-mail address`);
  if (newEmail !== undefined && !EMAIL.test(newEmail)) {
    throw new IdentityRelinkError(`"${change.newEmail}" is not an e-mail address`);
  }
  if (newSub !== undefined && !UUID.test(newSub)) {
    throw new IdentityRelinkError(
      `"${newSub}" is not a Keycloak user ID: copy it from the user's page in the Keycloak console`,
    );
  }
  if (newSub === undefined && newEmail === undefined) {
    throw new IdentityRelinkError(
      'Give the new Keycloak user (--sub) and/or the new address (--new-email)',
    );
  }
  if (reason.length < 10) {
    throw new IdentityRelinkError(
      'Give the reason (--reason, 10+ characters): it goes into the audit trail',
    );
  }
  return prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { email } });
    if (!user) throw new IdentityRelinkError(`No portal account with ${email}`);
    const sub = newSub ?? user.keycloakSub;
    const address = newEmail ?? user.email;
    if (sub === user.keycloakSub && address === user.email) {
      return {
        outcome: 'unchanged' as const,
        userId: user.id,
        email: user.email,
        keycloakSub: sub,
      };
    }
    if (sub !== user.keycloakSub && (await tx.user.findUnique({ where: { keycloakSub: sub } }))) {
      throw new IdentityRelinkError(
        'Another portal account already uses that Keycloak user: the person signed in with it ' +
          'before the re-link. Resolve that account first',
      );
    }
    if (address !== user.email && (await tx.user.findUnique({ where: { email: address } }))) {
      throw new IdentityRelinkError(`Another portal account already uses ${address}`);
    }
    await tx.user.update({ where: { id: user.id }, data: { keycloakSub: sub, email: address } });
    await audit.record(tx, {
      actor: RELINK_ACTOR,
      action: 'user.identity_relinked',
      target: { type: 'user', id: user.id },
      before: { keycloakSub: user.keycloakSub, email: user.email },
      after: { keycloakSub: sub, email: address, reason },
    });
    return { outcome: 'relinked' as const, userId: user.id, email: address, keycloakSub: sub };
  });
}
