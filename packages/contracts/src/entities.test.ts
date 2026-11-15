import { describe, expect, it } from 'vitest';
import { entitySlugSchema } from './entities.js';

describe('entity slugs', () => {
  it('never take a first path segment of the platform, the sandbox included (M4-08)', () => {
    for (const slug of ['sandbox', 'oauth-x', 'api', 'gw']) {
      const ok = entitySlugSchema.safeParse(slug).success;
      expect(ok, slug).toBe(slug === 'oauth-x');
    }
  });
});
