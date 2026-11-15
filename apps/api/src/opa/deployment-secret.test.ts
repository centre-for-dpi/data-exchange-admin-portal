import { describe, expect, it } from 'vitest';
import { deploymentSecret } from './deployment-secret.js';

describe('deployment secrets of the OPA bundle (M3-06)', () => {
  it('requires a minimum length', () => {
    expect(() => deploymentSecret('RID_END_USER_HASH_SALT', undefined, 16, false)).toThrow(
      /shorter than 16/,
    );
    expect(() => deploymentSecret('RID_END_USER_HASH_SALT', 'short', 16, false)).toThrow();
    expect(deploymentSecret('RID_END_USER_HASH_SALT', 'x'.repeat(16), 16, false)).toBe(
      'x'.repeat(16),
    );
  });

  it('refuses the example value in production, accepts it in development', () => {
    const example = 'rid-dev-end-user-salt-change-me';
    expect(deploymentSecret('RID_END_USER_HASH_SALT', example, 16, false)).toBe(example);
    expect(() => deploymentSecret('RID_END_USER_HASH_SALT', example, 16, true)).toThrow(
      /per deployment/,
    );
    expect(deploymentSecret('RID_END_USER_HASH_SALT', 'Zq8v3k2mXr7tL0pa', 16, true)).toBe(
      'Zq8v3k2mXr7tL0pa',
    );
  });
});
