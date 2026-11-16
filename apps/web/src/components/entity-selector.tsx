'use client';

import type { MembershipSummary } from '@rid/contracts';
import { useTranslations } from 'next-intl';
import { useId } from 'react';
import { usePathname } from 'next/navigation';
import { setActiveEntityAction } from '../lib/entity-actions';
import { Button } from './ui/button';

/**
 * Lets a user who belongs to several entities choose which one they act for. Submitted with an
 * explicit button (no change-on-select), so keyboard and screen-reader users are not surprised
 * by a context change (WCAG 3.2.2).
 */
export function EntitySelector({
  memberships,
  activeEntityId,
}: {
  memberships: MembershipSummary[];
  activeEntityId?: string;
}) {
  const t = useTranslations('entity');
  // Full path including the locale prefix (/en/...), so the user comes back to the same page.
  const pathname = usePathname();
  const id = useId();
  return (
    // Wraps on narrow screens: nothing scrolls sideways at 320 CSS pixels (WCAG 1.4.10, M6-02).
    <form action={setActiveEntityAction} className="flex max-w-full flex-wrap items-center gap-2">
      <label htmlFor={id} className="text-sm text-muted-foreground">
        {t('label')}
      </label>
      <select
        id={id}
        name="entityId"
        defaultValue={activeEntityId}
        className="h-9 max-w-full min-w-0 rounded-full border border-border-control bg-background px-3 text-sm text-foreground-strong hover:border-foreground"
      >
        {memberships.map((m) => (
          <option key={m.entity.id} value={m.entity.id}>
            {m.entity.shortName}
          </option>
        ))}
      </select>
      <input type="hidden" name="returnTo" value={pathname} />
      <Button type="submit" variant="outline" size="sm">
        {t('change')}
      </Button>
    </form>
  );
}
