export type LocalizedText = string | { es?: string; en?: string };

/** Text in the requested UI language, falling back to the other (country config / API data). */
export function localize(text: LocalizedText, locale: string): string {
  if (typeof text === 'string') return text;
  return (locale === 'en' ? text.en : text.es) ?? text.es ?? text.en ?? '';
}
