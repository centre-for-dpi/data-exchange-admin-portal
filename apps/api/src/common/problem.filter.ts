import { type ArgumentsHost, Catch, type ExceptionFilter, Logger } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AuthenticatedRequest } from '../auth/decorators.js';
import { PROBLEM_CONTENT_TYPE, toProblem } from './problem.js';

/** Path without query string: the query may carry identifiers (ARCHITECTURE.md §8). */
export const instancePath = (url: string): string => url.split('?')[0] ?? url;

/**
 * Refusals worth an attributable record (M6-01, ASVS 16.3): no session or a bad one, a role or an
 * entity the caller does not have, ids probed outside its entity, invalid input, rate limiting.
 */
const SECURITY_STATUSES = new Set([400, 401, 403, 404, 409, 429]);

/**
 * One JSON line per refusal: who (the session's subject when there is one), from where, what
 * (route template and path without the query string, which may carry identifiers) and why.
 * Never the body, the query or the token.
 */
export function securityEvent(request: FastifyRequest, status: number, code: string): string {
  const principal = (request as FastifyRequest & AuthenticatedRequest).principal;
  return JSON.stringify({
    event: 'request_refused',
    status,
    code,
    method: request.method,
    route: request.routeOptions.url ?? null,
    path: instancePath(request.url),
    requestId: request.id,
    sub: principal?.keycloakSub ?? null,
    ip: request.ip,
    userAgent: request.headers['user-agent']?.slice(0, 200) ?? null,
  });
}

export function sendProblem(
  exception: unknown,
  request: FastifyRequest,
  reply: FastifyReply,
  logger: Logger,
): void {
  const problem = toProblem(exception, instancePath(request.url));
  if (problem.status >= 500) {
    // Log the real error server side only; the client gets a generic problem.
    logger.error(exception instanceof Error ? (exception.stack ?? exception.message) : exception);
  } else if (SECURITY_STATUSES.has(problem.status)) {
    logger.warn(securityEvent(request, problem.status, problem.code));
  }
  void reply.status(problem.status).header('content-type', PROBLEM_CONTENT_TYPE).send(problem);
}

/** Every error leaves the API as application/problem+json (RFC 9457). */
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ProblemDetails');

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    sendProblem(
      exception,
      http.getRequest<FastifyRequest>(),
      http.getResponse<FastifyReply>(),
      this.logger,
    );
  }
}
