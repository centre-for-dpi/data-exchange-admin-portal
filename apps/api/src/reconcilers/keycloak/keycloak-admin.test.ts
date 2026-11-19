import { describe, expect, it } from 'vitest';
import { HttpKeycloakGatewayAdmin } from './keycloak-admin.js';

describe('Keycloak admin client (B-14)', () => {
  it('cuts a call Keycloak never answers after the timeout', async () => {
    // A Keycloak that accepts the connection and never answers: only the signal ends the call.
    const hung: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted by timeout')));
      });
    const admin = new HttpKeycloakGatewayAdmin({
      baseUrl: 'http://keycloak:8080',
      realm: 'den-gateway',
      clientId: 'den-portal-provisioner',
      clientSecret: 'secret',
      fetchFn: hung,
      timeoutMs: 50,
    });
    const started = Date.now();
    await expect(admin.findClient('den-app-x')).rejects.toThrow(/timeout|aborted/i);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
