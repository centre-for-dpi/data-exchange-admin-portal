import {
  applyDecorators,
  type CanActivate,
  createParamDecorator,
  type ExecutionContext,
  Inject,
  Injectable,
  Logger,
  SetMetadata,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { CITIZEN, Public } from '../../auth/decorators.js';
import {
  CITIZEN_TOKEN_VERIFIER,
  type CitizenIdentity,
  type CitizenTokenVerifier,
} from './citizen-token-verifier.js';

interface CitizenRequest {
  citizen?: CitizenIdentity;
}

/**
 * Authenticates citizens (ADR-0015): only a token of the national identity provider issued to an
 * authorized citizen app. Portal tokens, gateway tokens and anything else get 401. Never logs the
 * token or its claims: they carry the citizen's document number.
 */
@Injectable()
export class CitizenGuard implements CanActivate {
  private readonly logger = new Logger(CitizenGuard.name);

  constructor(@Inject(CITIZEN_TOKEN_VERIFIER) private readonly verifier: CitizenTokenVerifier) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FastifyRequest & CitizenRequest>();
    const token = /^Bearer (.+)$/.exec(request.headers.authorization ?? '')?.[1];
    if (!token) throw new UnauthorizedException();
    try {
      request.citizen = await this.verifier.verify(token);
    } catch (error) {
      // The reason only (a jose error code or our message), never the token.
      const reason = (error as { code?: string }).code ?? (error as Error).message;
      this.logger.debug(`Citizen token rejected: ${reason}`);
      throw new UnauthorizedException();
    }
    return true;
  }
}

/**
 * Endpoint for citizens only. Skips the portal's guard (people of the entities) and requires a
 * citizen token instead.
 */
export const CitizenAccess = () =>
  applyDecorators(Public(), SetMetadata(CITIZEN, true), UseGuards(CitizenGuard));

export const CurrentCitizen = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  const citizen = ctx.switchToHttp().getRequest<CitizenRequest>().citizen;
  if (!citizen) throw new Error('CurrentCitizen used without @CitizenAccess');
  return citizen;
});
