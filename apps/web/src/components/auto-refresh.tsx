'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

/**
 * Re-renders the page from the server every 2 s, for at most a minute, while something is being
 * applied in the background (a Keycloak client, a subscription reaching the gateway). Render it
 * only while the state is transitional: once the server shows the final state it disappears.
 */
export function AutoRefresh({ intervalMs = 2_000, maxTicks = 30 }) {
  const router = useRouter();
  useEffect(() => {
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
      if (ticks > maxTicks) clearInterval(timer);
      router.refresh();
    }, intervalMs);
    return () => clearInterval(timer);
  }, [router, intervalMs, maxTicks]);
  return null;
}
