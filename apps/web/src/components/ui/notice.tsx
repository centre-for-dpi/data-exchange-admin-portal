import type { ComponentProps } from 'react';
import { cn } from '../../lib/utils';
import type { Tone } from './badge';

const toneClass: Record<Exclude<Tone, 'brand'>, string> = {
  neutral: 'border-border bg-background text-foreground',
  success: 'border-success-border bg-success-bg text-success-fg',
  warning: 'border-warning-border bg-warning-bg text-warning-fg',
  danger: 'border-danger-border bg-danger-bg text-danger-fg',
  info: 'border-info-border bg-info-bg text-info-fg',
};

/** Inline message box. Callers add role="status" / role="alert" when it is announced. */
export function Notice({
  tone = 'neutral',
  className,
  ...props
}: ComponentProps<'div'> & { tone?: Exclude<Tone, 'brand'> }) {
  return (
    <div
      className={cn(
        'rounded-2xl border px-4 py-3 text-sm leading-relaxed',
        toneClass[tone],
        className,
      )}
      {...props}
    />
  );
}
