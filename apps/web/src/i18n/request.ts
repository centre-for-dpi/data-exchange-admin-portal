import { getCountryConfig } from '@den/config';
import { hasLocale } from 'next-intl';
import { getRequestConfig } from 'next-intl/server';
import { routing } from './routing';

export default getRequestConfig(async ({ requestLocale }) => {
  const requested = await requestLocale;
  const locale = hasLocale(routing.locales, requested) ? requested : routing.defaultLocale;
  return {
    locale,
    // Dates are stored in UTC and shown in the country's zone (CLAUDE.md, Conventions); without
    // it the server's own zone (UTC) is used and an evening event lands on the next day (M-22).
    timeZone: getCountryConfig().country.timezone,
    // `.default`: the module namespace object itself cannot be passed to client components.
    messages: (
      (await import(`../../messages/${locale}.json`)) as { default: Record<string, unknown> }
    ).default,
  };
});
