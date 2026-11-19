'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Button } from '../ui/button';

/** Commands to paste on the entity's server, with a copy button (P-03). */
export function CommandBlock({
  label,
  code,
  testId,
}: {
  label: string;
  code: string;
  testId?: string;
}) {
  const t = useTranslations('kit');
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium text-foreground-strong">{label}</p>
        <Button
          type="button"
          size="sm"
          variant="outline"
          aria-label={t('copyCommands', { source: label })}
          onClick={() => {
            void navigator.clipboard
              ?.writeText(code)
              .then(() => setCopied(true))
              .catch(() => setCopied(false));
          }}
        >
          {t('copy')}
        </Button>
      </div>
      <pre
        className="overflow-x-auto rounded-2xl bg-surface-inverse p-5 text-sm leading-relaxed text-[#f6f8fa]"
        tabIndex={0}
        aria-label={label}
        data-testid={testId}
      >
        <code>{code}</code>
      </pre>
      <p role="status" className="text-sm text-success-fg">
        {copied ? t('copied') : ''}
      </p>
    </div>
  );
}
