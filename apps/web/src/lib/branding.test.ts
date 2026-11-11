import { describe, expect, it } from 'vitest';
import { WCAG_AA_NORMAL_TEXT, contrastRatio, readableForeground } from './branding';

describe('branding contrast', () => {
  it('computes known WCAG contrast ratios', () => {
    expect(contrastRatio('#FFFFFF', '#000000')).toBeCloseTo(21, 0);
    expect(contrastRatio('#777777', '#FFFFFF')).toBeCloseTo(4.48, 1);
  });

  it.each(['#6564DB', '#2F6F8F', '#FFD400', '#0B3D91', '#E6F4EA'])(
    'picks a foreground that meets AA on %s',
    (color) => {
      expect(contrastRatio(color, readableForeground(color))).toBeGreaterThanOrEqual(
        WCAG_AA_NORMAL_TEXT,
      );
    },
  );
});
