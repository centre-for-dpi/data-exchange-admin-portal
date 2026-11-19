/** Runs once when the server starts (Next.js instrumentation). */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { assertWebSecretsAreNotExamples } = await import('./lib/example-secrets');
  try {
    assertWebSecretsAreNotExamples();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  // The interface languages are fixed when the image is built; a country configuration that asks
  // for others would silently be ignored (B-27).
  if (process.env.DEN_COUNTRY?.trim()) {
    const { getCountryConfig } = await import('@den/config');
    const { routing } = await import('./i18n/routing');
    const { ui } = getCountryConfig().country;
    const same =
      ui.defaultLocale === routing.defaultLocale &&
      ui.locales.length === routing.locales.length &&
      ui.locales.every((l) => (routing.locales as readonly string[]).includes(l));
    if (!same) {
      console.error(
        `country.ui (${ui.locales.join(',')}, default ${ui.defaultLocale}) differs from the ` +
          `languages this web image was built with (${routing.locales.join(',')}, default ` +
          `${routing.defaultLocale}). Rebuild the image with DEN_COUNTRY set.`,
      );
      process.exit(1);
    }
  }
}
