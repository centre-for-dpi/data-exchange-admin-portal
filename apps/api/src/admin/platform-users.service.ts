import { Injectable } from '@nestjs/common';
import {
  FieldErrorKey,
  type PlatformRoleChangeInput,
  type PlatformRoleHolder as HolderView,
  type UserStatusChangeInput,
} from '@den/contracts';
import { AuditService } from '../audit/audit.service.js';
import type { Principal } from '../auth/principal.service.js';
import { ConflictError, ValidationError } from '../common/errors.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  grantPlatformRole,
  listPlatformRoles,
  PlatformRoleError,
  type PlatformRoleErrorKind,
  revokePlatformRole,
  setUserStatus,
} from './platform-roles.js';

/**
 * Platform roles and account status from the operator console (M-03). The logic is the command
 * line's (`platform-roles.ts`); this only names the signed-in administrator as the actor and turns
 * refusals into the API's errors.
 */
@Injectable()
export class PlatformUsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private static actor(principal: Principal) {
    return { type: 'user' as const, id: principal.keycloakSub };
  }

  /** Refusals become 400 on the e-mail field (no such account) or 409 with a key the portal words. */
  private static async translate<T>(work: Promise<T>): Promise<T> {
    try {
      return await work;
    } catch (error) {
      if (!(error instanceof PlatformRoleError)) throw error;
      const keys: Record<PlatformRoleErrorKind, FieldErrorKey | undefined> = {
        invalid: undefined,
        unknown_account: FieldErrorKey.UnknownAccount,
        account_not_active: FieldErrorKey.AccountNotActive,
        last_platform_admin: FieldErrorKey.LastPlatformAdmin,
      };
      const key = keys[error.kind];
      if (error.kind === 'unknown_account') {
        throw new ValidationError([{ path: 'email', message: error.message, key }]);
      }
      if (!key) throw new ValidationError([{ path: '', message: error.message }]);
      throw new ConflictError(error.message, { key });
    }
  }

  async holders(): Promise<{ items: HolderView[] }> {
    const items = await listPlatformRoles(this.prisma);
    return {
      items: items.map((h) => ({ ...h, status: h.status === 'active' ? 'active' : 'disabled' })),
    };
  }

  grant(input: PlatformRoleChangeInput, principal: Principal) {
    return PlatformUsersService.translate(
      grantPlatformRole(this.prisma, this.audit, {
        ...input,
        actor: PlatformUsersService.actor(principal),
      }),
    );
  }

  revoke(input: PlatformRoleChangeInput, principal: Principal) {
    return PlatformUsersService.translate(
      revokePlatformRole(this.prisma, this.audit, {
        ...input,
        actor: PlatformUsersService.actor(principal),
      }),
    );
  }

  setStatus(input: UserStatusChangeInput, to: 'active' | 'disabled', principal: Principal) {
    return PlatformUsersService.translate(
      setUserStatus(
        this.prisma,
        this.audit,
        { ...input, actor: PlatformUsersService.actor(principal) },
        to,
      ),
    );
  }
}
