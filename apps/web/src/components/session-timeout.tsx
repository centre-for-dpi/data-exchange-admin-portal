'use client';

import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Button } from './ui/button';

const WARN_BEFORE_MS = 2 * 60 * 1000;

/** What the server says about the session: seconds left, or null when there is no session. */
async function sessionRemaining(init?: RequestInit): Promise<number | null | undefined> {
  try {
    const response = await fetch('/api/session/keepalive', { cache: 'no-store', ...init });
    if (response.status === 401) return null;
    if (!response.ok) return undefined;
    const body = (await response.json()) as { remainingSeconds?: unknown };
    return typeof body.remainingSeconds === 'number' ? body.remainingSeconds : undefined;
  } catch {
    // Could not ask (network): the caller decides with its own count.
    return undefined;
  }
}

/**
 * Warns before the session ends for inactivity and lets the user keep it (WCAG 2.2.1, M6-02).
 * Keycloak ends an SSO session after `idleSeconds` without a token refresh. The portal refreshes
 * the tokens on the server, when a navigation or a form needs a new one, so the browser cannot
 * know by itself when the session was last renewed: before it warns, and before it declares the
 * session over, it asks the server how long the session really has left (B-25). "Stay signed in"
 * makes the server refresh the tokens with Keycloak right then.
 */
export function SessionTimeout({ remainingSeconds }: { remainingSeconds: number }) {
  const t = useTranslations('session');
  const [phase, setPhase] = useState<'active' | 'warning' | 'expired'>('active');
  // Our own count, from what the server last said; corrected by asking before each notice.
  const [deadline, setDeadline] = useState(() => Date.now() + remainingSeconds * 1000);
  const button = useRef<HTMLButtonElement>(null);
  const marker = useRef<HTMLSpanElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const bodyId = useId();

  /** Applies what the server answered; true when the notice may go ahead. */
  const adopt = useCallback((remaining: number | null | undefined): boolean => {
    if (remaining === null) {
      setPhase('expired');
      return false;
    }
    if (remaining !== undefined && remaining * 1000 > WARN_BEFORE_MS) {
      // Renewed since the last count (a page load refreshed the tokens): not yet.
      setDeadline(Date.now() + remaining * 1000);
      setPhase('active');
      return false;
    }
    return true;
  }, []);

  useEffect(() => {
    let cancelled = false;
    const now = Date.now();
    const warn = setTimeout(
      () => {
        void sessionRemaining().then((remaining) => {
          if (cancelled || !adopt(remaining)) return;
          previousFocus.current = document.activeElement as HTMLElement | null;
          setPhase((current) => (current === 'expired' ? current : 'warning'));
        });
      },
      Math.max(0, deadline - WARN_BEFORE_MS - now),
    );
    const end = setTimeout(
      () => {
        void sessionRemaining().then((remaining) => {
          if (cancelled) return;
          if (remaining == null || remaining <= 0) setPhase('expired');
          else setDeadline(Date.now() + remaining * 1000);
        });
      },
      Math.max(0, deadline - now),
    );
    // The countdown runs from here (after hydration): tests wait for this to move the clock.
    marker.current?.setAttribute('data-testid', 'session-timeout');
    return () => {
      cancelled = true;
      clearTimeout(warn);
      clearTimeout(end);
    };
  }, [deadline, adopt]);

  // The dialog takes the focus when it appears, and gives it back when the user stays.
  useEffect(() => {
    if (phase === 'warning') button.current?.focus();
  }, [phase]);

  const stay = async () => {
    const remaining = await sessionRemaining({ method: 'POST' });
    if (remaining === null || remaining === undefined) {
      setPhase('expired');
      return;
    }
    setDeadline(Date.now() + remaining * 1000);
    setPhase('active');
    previousFocus.current?.focus();
  };

  if (phase === 'active') return <span hidden ref={marker} />;
  return (
    <div
      role="alertdialog"
      aria-modal="false"
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      className="fixed inset-x-4 bottom-4 z-50 mx-auto max-w-lg rounded-2xl border border-warning-border bg-background p-5 shadow-raised"
    >
      <h2 id={titleId} className="font-serif text-lg font-bold text-foreground-strong">
        {phase === 'warning' ? t('expiringTitle') : t('expiredTitle')}
      </h2>
      <p id={bodyId} className="mt-1 text-sm">
        {phase === 'warning' ? t('expiringBody', { minutes: 2 }) : t('expiredBody')}
      </p>
      <div className="mt-4">
        {phase === 'warning' ? (
          <Button ref={button} type="button" onClick={() => void stay()}>
            {t('stay')}
          </Button>
        ) : (
          <Button type="button" onClick={() => window.location.reload()}>
            {t('reload')}
          </Button>
        )}
      </div>
    </div>
  );
}
