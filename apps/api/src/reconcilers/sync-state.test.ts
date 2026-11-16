import { describe, expect, it } from 'vitest';
import { isDrift } from './sync-state.js';

describe('drift (M5-07)', () => {
  const applied = { appliedHash: 'h1', status: 'in_sync' };

  it('is a write while the desired state was already applied', () => {
    expect(isDrift(applied, 'h1', true)).toBe(true);
  });

  it('is not a write for a new desired state, nor a pass that wrote nothing', () => {
    expect(isDrift(applied, 'h2', true)).toBe(false);
    expect(isDrift(applied, 'h1', false)).toBe(false);
    expect(isDrift(null, 'h1', true)).toBe(false);
    expect(isDrift({ appliedHash: 'h1', status: 'error' }, 'h1', true)).toBe(false);
  });
});
