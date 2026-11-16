'use client';

import { useTranslations } from 'next-intl';
import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Button } from './ui/button';

const WARN_BEFORE_MS = 2 * 60 * 1000;

/**
 * Warns before the session ends for inactivity and lets the user keep it (WCAG 2.2.1, M6-02).
 * Keycloak ends an SSO session after `idleSeconds` without a token refresh; the portal refreshes
 * on every navigation and form submission, which restart the count here too. "Stay signed in"
 * asks the server for the session, which refreshes the tokens with Keycloak.
 */
export function SessionTimeout({ idleSeconds }: { idleSeconds: number }) {
  // A navigation reaches the server, which refreshes the session: the count starts again.
  return <Countdown key={usePathname()} idleSeconds={idleSeconds} />;
}

function Countdown({ idleSeconds }: { idleSeconds: number }) {
  const t = useTranslations('session');
  const [phase, setPhase] = useState<'active' | 'warning' | 'expired'>('active');
  const [deadline, setDeadline] = useState(() => Date.now() + idleSeconds * 1000);
  const button = useRef<HTMLButtonElement>(null);
  const marker = useRef<HTMLSpanElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const bodyId = useId();

  const restart = useCallback(() => {
    setDeadline(Date.now() + idleSeconds * 1000);
    setPhase('active');
  }, [idleSeconds]);

  // So does a form submission.
  useEffect(() => {
    const onSubmit = () => restart();
    document.addEventListener('submit', onSubmit);
    return () => document.removeEventListener('submit', onSubmit);
  }, [restart]);

  useEffect(() => {
    const now = Date.now();
    const warn = setTimeout(
      () => {
        previousFocus.current = document.activeElement as HTMLElement | null;
        setPhase('warning');
      },
      Math.max(0, deadline - WARN_BEFORE_MS - now),
    );
    const end = setTimeout(() => setPhase('expired'), Math.max(0, deadline - now));
    // The countdown runs from here (after hydration): tests wait for this to move the clock.
    marker.current?.setAttribute('data-testid', 'session-timeout');
    return () => {
      clearTimeout(warn);
      clearTimeout(end);
    };
  }, [deadline]);

  // The dialog takes the focus when it appears, and gives it back when the user stays.
  useEffect(() => {
    if (phase === 'warning') button.current?.focus();
  }, [phase]);

  const stay = async () => {
    const response = await fetch('/api/auth/session', { cache: 'no-store' }).catch(() => null);
    if (!response?.ok) {
      setPhase('expired');
      return;
    }
    restart();
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
