import { createHash } from 'node:crypto';
import rateLimit from '@fastify/rate-limit';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyRequest } from 'fastify';

/**
 * Rate limits of the portal API (M6-01, ASVS 2.4.1): anti-automation in front of every handler,
 * before the body is read (onRequest), so a flood of large uploads is refused before buffering.
 *
 * - Every caller: RID_RATE_LIMIT_PER_MINUTE (600) by its session token, or by its address
 *   without one. Pages of the portal call the API server-side with the user's own token.
 * - Expensive routes (PDF uploads, a new version and its OpenAPI lint, onboarding requests,
 *   invitations): RID_RATE_LIMIT_STRICT_PER_MINUTE (30), per user. The portal's pages reach the
 *   API from the web server (one address for everyone), so the bucket is the token; a made-up
 *   token buys nothing: uploads verify it before reading the body (app.ts), the rest answer 401.
 * - Not limited: the internal endpoints of the platform's own services (the transparency
 *   collector, OPA's bundle and status, the nodes' control channel through the gateway), each
 *   with its own credential, the metrics and the health check.
 */
const STRICT = [
  /^\/api\/v1\/entity-requests\/:requestId\/designation-document$/,
  /^\/api\/v1\/entities\/:entityId\/subscriptions\/:subscriptionId\/agreement$/,
  /^\/api\/v1\/entities\/:entityId\/apis\/:apiId\/versions$/,
  /^\/api\/v1\/entity-requests$/,
  /^\/api\/v1\/entities\/:entityId\/invitations$/,
];
const EXEMPT = [
  /^\/api\/v1\/internal\//,
  /^\/api\/v1\/opa\//,
  /^\/api\/v1\/nodes\//,
  /^\/metrics$/,
];

const route = (request: FastifyRequest) => request.routeOptions.url ?? '';
const strict = (request: FastifyRequest) =>
  request.method !== 'GET' && STRICT.some((r) => r.test(route(request)));

const perMinute = (name: string, fallback: number) => {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
};

export async function registerRateLimit(app: NestFastifyApplication): Promise<void> {
  const general = perMinute('RID_RATE_LIMIT_PER_MINUTE', 600);
  const tight = perMinute('RID_RATE_LIMIT_STRICT_PER_MINUTE', 30);
  await app.register(rateLimit, {
    global: true,
    hook: 'onRequest',
    timeWindow: '1 minute',
    max: (request) => (strict(request) ? tight : general),
    allowList: (request) =>
      request.url === '/api/v1/health' ||
      EXEMPT.some((r) => r.test(request.url.split('?')[0] ?? '')),
    keyGenerator: (request) => {
      const authorization = request.headers.authorization;
      // The token itself never stays in memory: its hash is the bucket.
      const bucket = authorization
        ? `token:${createHash('sha256').update(authorization).digest('hex').slice(0, 32)}`
        : `ip:${request.ip}`;
      return strict(request) ? `strict:${bucket}` : bucket;
    },
    // Thrown as an error: the problem filter answers RFC 9457 (code rate_limited).
    errorResponseBuilder: (_request, context) => ({
      statusCode: context.statusCode,
      message: `Too many requests: retry in ${context.after}`,
    }),
  });
}
