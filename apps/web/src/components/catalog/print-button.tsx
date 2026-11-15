'use client';

import { useTranslations } from 'next-intl';
import { Button } from '../ui/button';

/** Prints the service sheet; the browser's dialog also saves it as PDF (M4-09). */
export function PrintButton() {
  const t = useTranslations('serviceSheet');
  return (
    <Button type="button" className="print:hidden" onClick={() => window.print()}>
      {t('print')}
    </Button>
  );
}
