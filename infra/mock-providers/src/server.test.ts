import { describe, expect, it } from 'vitest';
import { parseProvider } from './providers.js';
import { buildServer } from './server.js';

describe('mock provider server', () => {
  it('reports health with the provider name', async () => {
    const app = buildServer('salud');
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', provider: 'salud' });
    await app.close();
  });

  it('rejects an unknown provider', () => {
    expect(() => parseProvider('banco')).toThrow(/PROVIDER must be one of/);
    expect(() => parseProvider(undefined)).toThrow(/PROVIDER must be one of/);
  });
});
