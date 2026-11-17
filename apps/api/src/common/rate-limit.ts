import rateLimit from '@fastify/rate-limit';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyRequest } from 'fastify';

/**
 * Rate limits of the portal API (M6-01, ASVS 2.4.1): anti-automation in front of every handler,
 * before the body is read (onRequest), so a flood of large uploads is refused before buffering.
 *
 * - Every caller: DEN_RATE_LIMIT_PER_MINUTE (600) by its verified user (the `sub` of a token the
 *   API accepts), or by its address otherwise. A made-up or expired token is not a bucket of its
 *   own: rotating invented tokens lands on the address's quota. Pages of the portal call the API
 *   server-side with the user's own token, all from one address, hence the user as the key.
 * - Expensive routes (PDF uploads, a new version and its OpenAPI lint, onboarding requests,
 *   invitations, a node's enrollment): DEN_RATE_LIMIT_STRICT_PER_MINUTE (30), per user or address.
 * - Not limited: only the routes of the platform's own services, each with its own credential
 *   (the transparency collector, OPA's bundle and status, a node's control channel after its
 *   enrollment, which needs the node's certificate), the metrics and the health check. Matched
 *   on the route template, so an unknown path is limited like any other.
 */
const STRICT = new Set([
  '/api/v1/entity-requests/:requestId/designation-document',
  '/api/v1/entities/:entityId/subscriptions/:subscriptionId/agreement',
  '/api/v1/entities/:entityId/apis/:apiId/versions',
  '/api/v1/entity-requests',
  '/api/v1/entities/:entityId/invitations',
  '/api/v1/nodes/enroll',
]);
const EXEMPT = new Set([
  '/api/v1/health',
  '/api/v1/internal/subject-access',
  '/api/v1/opa/bundle.tar.gz',
  '/api/v1/opa/status',
  '/api/v1/nodes/:nodeId/heartbeat',
  '/api/v1/nodes/:nodeId/renew',
  '/api/v1/nodes/:nodeId/config',
  '/metrics',
]);

export const rateLimitedRoute = (template: string | undefined): 'exempt' | 'strict' | 'general' =>
  template && EXEMPT.has(template)
    ? 'exempt'
    : template && STRICT.has(template)
      ? 'strict'
      : 'general';

const strict = (request: FastifyRequest) =>
  request.method !== 'GET' && rateLimitedRoute(request.routeOptions.url) === 'strict';

const perMinute = (name: string, fallback: number) => {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
};

/** The `sub` of a bearer token the API accepts, or null (no token, or not a valid one). */
export type VerifiedSubject = (token: string) => Promise<string | null>;

export async function registerRateLimit(
  app: NestFastifyApplication,
  verifiedSubject: VerifiedSubject,
): Promise<void> {
  const general = perMinute('DEN_RATE_LIMIT_PER_MINUTE', 600);
  const tight = perMinute('DEN_RATE_LIMIT_STRICT_PER_MINUTE', 30);
  await app.register(rateLimit, {
    global: true,
    hook: 'onRequest',
    timeWindow: '1 minute',
    max: (request) => (strict(request) ? tight : general),
    allowList: (request) => rateLimitedRoute(request.routeOptions.url) === 'exempt',
    keyGenerator: async (request) => {
      // The key is computed before the allow list is read: skip verifying the services' tokens.
      if (rateLimitedRoute(request.routeOptions.url) === 'exempt') return 'exempt';
      const token = /^Bearer (\S+)$/.exec(request.headers.authorization ?? '')?.[1];
      const sub = token ? await verifiedSubject(token) : null;
      const bucket = sub ? `sub:${sub}` : `ip:${request.ip}`;
      return strict(request) ? `strict:${bucket}` : bucket;
    },
    // Thrown as an error: the problem filter answers RFC 9457 (code rate_limited).
    errorResponseBuilder: (_request, context) => ({
      statusCode: context.statusCode,
      message: `Too many requests: retry in ${context.after}`,
    }),
  });
}
