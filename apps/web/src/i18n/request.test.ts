import { createFormatter } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';

// The real one throws outside Next's server environment; it only returns the function it is given.
vi.mock('next-intl/server', () => ({ getRequestConfig: (fn: unknown) => fn }));
vi.stubEnv('DEN_COUNTRY', 'co');

const { default: requestConfig } = await import('./request');

describe('request config (M-22)', () => {
  it('formats dates in the time zone of the country, not in UTC', async () => {
    const config = await requestConfig({ requestLocale: Promise.resolve('es'), locale: 'es' });
    expect(config.timeZone).toBe('America/Bogota');

    // 20:30 on 14 November in Bogota (UTC-5) is 01:30 on the 15th in UTC.
    const instant = new Date('2026-11-15T01:30:00Z');
    const options = { dateStyle: 'short', timeStyle: 'short' } as const;
    const shown = createFormatter({ locale: 'en', timeZone: config.timeZone }).dateTime(
      instant,
      options,
    );
    expect(shown).toContain('11/14/26');
    expect(shown).toContain('8:30');
    expect(createFormatter({ locale: 'en', timeZone: 'UTC' }).dateTime(instant, options)).toContain(
      '11/15/26',
    );
  });
});
