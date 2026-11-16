'use client';

import { useTranslations } from 'next-intl';
import { type KeyboardEvent, useId, useRef, useState } from 'react';
import type { Snippet } from '../../lib/integration-guide';
import { Button } from '../ui/button';

/**
 * The integration guide's snippets (M5-08), one tab per language: a WAI-ARIA tab list (arrow keys,
 * Home and End move between tabs), each panel with its file name and a copy button.
 */
export function IntegrationGuide({ snippets }: { snippets: Snippet[] }) {
  const t = useTranslations('myApps.guide');
  const base = useId();
  const [selected, setSelected] = useState(0);
  const [copied, setCopied] = useState<string | null>(null);
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);

  const select = (index: number) => {
    const next = (index + snippets.length) % snippets.length;
    setSelected(next);
    tabs.current[next]?.focus();
  };
  const onKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    const moves: Record<string, number> = {
      ArrowRight: selected + 1,
      ArrowLeft: selected - 1,
      Home: 0,
      End: snippets.length - 1,
    };
    const target = moves[event.key];
    if (target === undefined) return;
    event.preventDefault();
    select(target);
  };
  const copy = async (snippet: Snippet) => {
    try {
      await navigator.clipboard.writeText(snippet.code);
      setCopied(snippet.language);
    } catch {
      setCopied(null);
    }
  };

  return (
    <div className="space-y-3">
      <div role="tablist" aria-label={t('languages')} className="flex flex-wrap gap-2">
        {snippets.map((s, i) => (
          <button
            key={s.language}
            ref={(el) => {
              tabs.current[i] = el;
            }}
            id={`${base}-tab-${s.language}`}
            type="button"
            role="tab"
            aria-selected={i === selected}
            aria-controls={`${base}-panel-${s.language}`}
            tabIndex={i === selected ? 0 : -1}
            onClick={() => setSelected(i)}
            onKeyDown={onKey}
            className={
              i === selected
                ? 'rounded-full bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground'
                : 'rounded-full border border-border px-4 py-1.5 text-sm font-medium hover:bg-muted'
            }
          >
            {t(`language.${s.language}`)}
          </button>
        ))}
      </div>
      {snippets.map((s, i) => (
        <div
          key={s.language}
          id={`${base}-panel-${s.language}`}
          role="tabpanel"
          aria-labelledby={`${base}-tab-${s.language}`}
          hidden={i !== selected}
          className="space-y-2"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-muted-foreground">{t('saveAs', { file: s.file })}</p>
            <Button type="button" size="sm" variant="outline" onClick={() => void copy(s)}>
              {t('copy', { language: t(`language.${s.language}`) })}
            </Button>
          </div>
          <pre
            className="overflow-x-auto rounded-2xl bg-surface-inverse p-5 text-sm leading-relaxed text-[#f6f8fa]"
            tabIndex={0}
            aria-label={t('code', { language: t(`language.${s.language}`) })}
            data-testid={`guide-${s.language}`}
          >
            <code>{s.code}</code>
          </pre>
          <p role="status" className="text-sm text-success-fg">
            {copied === s.language ? t('copied') : ''}
          </p>
        </div>
      ))}
    </div>
  );
}
