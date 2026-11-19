import { notFound } from 'next/navigation';

/**
 * Any path under a locale that no page serves: without this, Next.js answers with its own
 * English 404 outside the layout instead of `not-found.tsx` (B-24).
 */
export default function UnknownPage(): never {
  notFound();
}
