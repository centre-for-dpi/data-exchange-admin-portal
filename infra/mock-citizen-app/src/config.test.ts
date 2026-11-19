import { afterEach, describe, expect, it, vi } from 'vitest';
import { configFromEnv, developmentTsaTrust } from './config.js';

describe('citizen app: which TSA its receipts trust (M-14, ADR-0032)', () => {
  afterEach(() => vi.unstubAllEnvs());
  const config = (env: Record<string, string>) => {
    vi.stubEnv('DEN_CITIZEN_APP_CLIENT_SECRET', 'secret');
    vi.stubEnv('CITIZEN_APP_WEBHOOK_SECRET', 'whsec_x');
    vi.stubEnv('CITIZEN_APP_TSA_ROOT_URL', undefined);
    vi.stubEnv('CITIZEN_APP_TSA_ROOTS_FILE', '');
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
    return configFromEnv();
  };

  it("by default, the development TSA's own chain, and says so", () => {
    const dev = config({ DEN_TSA_URL: 'http://tsa:3004/api/v1/timestamp' });
    expect(dev.portal.tsaRootUrl).toBe('http://tsa:3004/api/v1/timestamp/certchain');
    expect(developmentTsaTrust(dev)).toMatch(/development TSA itself/);
  });

  it("the accredited TSA's roots, pinned by file or published by its accreditation", () => {
    const pinned = config({ CITIZEN_APP_TSA_ROOTS_FILE: '/etc/den/tsa-roots.pem' });
    expect(pinned.portal.tsaRootsFile).toBe('/etc/den/tsa-roots.pem');
    expect(developmentTsaTrust(pinned)).toBeNull();
    const published = config({ CITIZEN_APP_TSA_ROOT_URL: 'https://pki.example.org/tsa-root.pem' });
    expect(developmentTsaTrust(published)).toBeNull();
  });
});
