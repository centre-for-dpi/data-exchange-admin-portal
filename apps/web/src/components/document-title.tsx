'use client';

import { useEffect } from 'react';

/**
 * Sets the tab title of a page that has no metadata of its own (the error and not-found pages,
 * whose metadata Next.js does not apply over the layout's): WCAG 2.4.2.
 */
export function DocumentTitle({ title }: { title: string }) {
  useEffect(() => {
    document.title = title;
  }, [title]);
  return null;
}
