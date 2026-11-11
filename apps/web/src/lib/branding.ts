/** Relative luminance of a #RRGGBB color (WCAG 2.1 definition). */
export function relativeLuminance(hex: string): number {
  const channels = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r, g, b] = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
}

export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}

/** White or near-black text, whichever contrasts more with the brand color. */
export function readableForeground(background: string): '#FFFFFF' | '#111827' {
  return contrastRatio(background, '#FFFFFF') >= contrastRatio(background, '#111827')
    ? '#FFFFFF'
    : '#111827';
}

/** WCAG 2.1 AA for normal text. */
export const WCAG_AA_NORMAL_TEXT = 4.5;
