'use client';

import { useTranslations } from 'next-intl';
import { type KeyboardEvent, useId, useRef, useState } from 'react';
import { type CsrCommands as Commands, ENTITY_CHECK_PATH } from '../../lib/csr-commands';
import { CommandBlock } from '../kit/command-block';

/**
 * The commands that make the application's key and CSR on its server (P-05), one tab per shell:
 * a WAI-ARIA tab list (arrow keys, Home and End move between tabs), each panel with its copyable
 * commands and the check to make before pasting. Next to them, entity-check.sh for download.
 */
export function CsrCommands({
  commands,
  clientId,
  scriptCommand,
}: {
  commands: Commands[];
  clientId: string;
  scriptCommand: string;
}) {
  const t = useTranslations('myApps.certificates');
  const base = useId();
  const [selected, setSelected] = useState(0);
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);

  const select = (index: number) => {
    const next = (index + commands.length) % commands.length;
    setSelected(next);
    tabs.current[next]?.focus();
  };
  const onKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    const moves: Record<string, number> = {
      ArrowRight: selected + 1,
      ArrowLeft: selected - 1,
      Home: 0,
      End: commands.length - 1,
    };
    const target = moves[event.key];
    if (target === undefined) return;
    event.preventDefault();
    select(target);
  };

  return (
    <div className="space-y-4">
      <div className="space-y-3">
        <div role="tablist" aria-label={t('shells')} className="flex flex-wrap gap-2">
          {commands.map((c, i) => (
            <button
              key={c.shell}
              ref={(el) => {
                tabs.current[i] = el;
              }}
              id={`${base}-tab-${c.shell}`}
              type="button"
              role="tab"
              aria-selected={i === selected}
              aria-controls={`${base}-panel-${c.shell}`}
              tabIndex={i === selected ? 0 : -1}
              onClick={() => setSelected(i)}
              onKeyDown={onKey}
              className={
                i === selected
                  ? 'rounded-full bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground'
                  : 'rounded-full border border-border px-4 py-1.5 text-sm font-medium hover:bg-muted'
              }
            >
              {t(`shell.${c.shell}`)}
            </button>
          ))}
        </div>
        {commands.map((c, i) => (
          <div
            key={c.shell}
            id={`${base}-panel-${c.shell}`}
            role="tabpanel"
            aria-labelledby={`${base}-tab-${c.shell}`}
            hidden={i !== selected}
            className="space-y-2"
          >
            <p className="text-sm text-muted-foreground">{t(`shellNote.${c.shell}`)}</p>
            <CommandBlock
              label={t('commands', { shell: t(`shell.${c.shell}`) })}
              code={c.code}
              testId={`csr-${c.shell}`}
            />
          </div>
        ))}
        <p className="text-sm">
          {t.rich('check', {
            clientId,
            code: (chunks) => <code className="font-mono font-semibold">{chunks}</code>,
          })}
        </p>
      </div>
      <div className="space-y-2">
        <p className="text-sm">
          {t.rich('script', {
            link: (chunks) => (
              <a href={ENTITY_CHECK_PATH} className="link font-semibold" download>
                {chunks}
              </a>
            ),
          })}
        </p>
        <CommandBlock label={t('scriptCommand')} code={scriptCommand} testId="csr-script" />
      </div>
    </div>
  );
}
