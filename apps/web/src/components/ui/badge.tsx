import type { ComponentProps } from 'react';
import { cn } from '../../lib/utils';

export type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'info' | 'brand';

const toneClass: Record<Tone, string> = {
  neutral: 'bg-[#ececec] text-[#333333]',
  success: 'bg-success-bg text-success-fg',
  warning: 'bg-warning-bg text-warning-fg',
  danger: 'bg-danger-bg text-danger-fg',
  info: 'bg-info-bg text-info-fg',
  brand: 'bg-surface-panel text-foreground-strong',
};

const dotClass: Record<Tone, string> = {
  neutral: 'bg-[#777777]',
  success: 'bg-success-border',
  warning: 'bg-warning-border',
  danger: 'bg-danger-border',
  info: 'bg-info-border',
  brand: 'bg-primary',
};

/** Pill label. The dot is decorative: the text always carries the meaning (WCAG 1.4.1). */
export function Badge({
  tone = 'neutral',
  dot = false,
  className,
  children,
  ...props
}: ComponentProps<'span'> & { tone?: Tone; dot?: boolean }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap',
        toneClass[tone],
        className,
      )}
      {...props}
    >
      {dot ? (
        <span aria-hidden="true" className={cn('size-1.5 rounded-full', dotClass[tone])} />
      ) : null}
      {children}
    </span>
  );
}

/**
 * Tone of a lifecycle status (API, version, application, provisioning, credential, subscription).
 * Unknown codes are neutral.
 */
export function statusTone(status: string): Tone {
  switch (status) {
    case 'published':
    case 'active':
    case 'ready':
    case 'approved':
    case 'approved_operator':
    case 'approved_regulator':
      return 'success';
    case 'in_review':
    case 'pending':
    case 'pending_provider':
    case 'pending_regulator':
    case 'changes_requested':
    case 'rotating':
    case 'suspended':
      return 'warning';
    case 'rejected':
    case 'revoked':
    case 'error':
    case 'deleted':
      return 'danger';
    case 'draft':
      return 'info';
    default:
      return 'neutral';
  }
}

/** Status pill with the tone derived from the status code. */
export function StatusBadge({
  status,
  children,
  ...props
}: ComponentProps<'span'> & { status: string }) {
  return (
    <Badge tone={statusTone(status)} dot {...props}>
      {children}
    </Badge>
  );
}

/** Tone of a data classification: the more sensitive, the warmer. */
export function classificationTone(classification: string): Tone {
  switch (classification) {
    case 'public':
      return 'success';
    case 'internal':
      return 'neutral';
    case 'personal':
      return 'info';
    case 'sensitive':
      return 'warning';
    default:
      return 'neutral';
  }
}
