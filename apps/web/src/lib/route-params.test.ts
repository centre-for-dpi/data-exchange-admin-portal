import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));
const { isUuid, uuidParams } = await import('./route-params');

const ID = '0192f0f2-1c3e-7a3b-8d2f-3f1c1b7d9a10';

describe('uuidParams (B-26)', () => {
  it('lets valid ids through, with the rest of the params', () => {
    expect(uuidParams({ locale: 'es', apiId: ID }, 'apiId')).toEqual({ locale: 'es', apiId: ID });
  });

  it.each(['..', '../admin', `${ID}?x=1`, `${ID}/versions`, '', 'not-a-uuid'])(
    'answers 404 for %s',
    (value) => {
      expect(isUuid(value)).toBe(false);
      expect(() => uuidParams({ apiId: value }, 'apiId')).toThrow('NEXT_NOT_FOUND');
    },
  );
});
