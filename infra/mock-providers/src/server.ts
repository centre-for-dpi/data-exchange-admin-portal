import Fastify, { type FastifyInstance } from 'fastify';
import type { Provider } from './providers.js';

export function buildServer(provider: Provider): FastifyInstance {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
    // Request logs include the URL, which may carry an identifier. Never log it (ADR-0006/0009).
    disableRequestLogging: true,
  });

  app.get('/health', () => ({ status: 'ok', provider }));

  return app;
}
