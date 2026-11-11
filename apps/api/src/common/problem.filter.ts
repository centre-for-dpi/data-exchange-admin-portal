import { type ArgumentsHost, Catch, type ExceptionFilter, Logger } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { PROBLEM_CONTENT_TYPE, toProblem } from './problem.js';

/** Path without query string: the query may carry identifiers (ARCHITECTURE.md §8). */
export const instancePath = (url: string): string => url.split('?')[0] ?? url;

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
