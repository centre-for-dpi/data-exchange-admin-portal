import { AsyncLocalStorage } from 'node:async_hooks';
import type { FastifyInstance } from 'fastify';

/** What the audit log records about the request that caused an event (SPEC.md §3, M-27). */
interface RequestContext {
  /** The caller's address: request.ip, which follows X-Forwarded-For only from DEN_TRUST_PROXY. */
  ip: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/**
 * Keeps the request's context for the code its handler runs. Set before the handler (preHandler:
 * after the body is read, whose stream events would otherwise lose it).
 */
export function registerRequestContext(fastify: FastifyInstance): void {
  fastify.addHook('preHandler', (request, _reply, done) => {
    storage.run({ ip: request.ip }, done);
  });
}

/** The address of the request being handled, if any (none in background jobs). */
export const requestIp = (): string | undefined => storage.getStore()?.ip;

/** Runs `fn` as if handling a request from `ip` (tests). */
export const withRequestIp = <T>(ip: string, fn: () => T): T => storage.run({ ip }, fn);
