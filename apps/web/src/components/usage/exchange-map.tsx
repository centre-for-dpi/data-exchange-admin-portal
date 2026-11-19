'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { useEffect, useId, useRef, useState } from 'react';

export interface Exchange {
  consumerId: string;
  consumerName: string;
  providerId: string;
  providerName: string;
  calls: number;
  errors: number;
  activeSubscriptions: number;
}

const ROW = 40;
const PAD = 16;
const MAX_STROKE = 16;
const MIN_STROKE = 2;

/** Short enough for the label column; the full name stays in the table and the tooltip. */
const short = (name: string, max: number) =>
  name.length > max ? `${name.slice(0, Math.max(1, max - 1))}…` : name;

interface Side {
  id: string;
  name: string;
  calls: number;
}

function side(exchanges: Exchange[], pick: 'consumer' | 'provider'): Side[] {
  const totals = new Map<string, Side>();
  for (const e of exchanges) {
    const id = pick === 'consumer' ? e.consumerId : e.providerId;
    const name = pick === 'consumer' ? e.consumerName : e.providerName;
    const row = totals.get(id) ?? { id, name, calls: 0 };
    row.calls += e.calls;
    totals.set(id, row);
  }
  return [...totals.values()].sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name));
}

/**
 * The exchange map (M5-05): consumer entities on the left, providers on the right, one link per
 * pair. The link's width is the volume of calls (square-root scale, one hue); an agreed exchange
 * without calls in the period is a thin dotted gray line. A legend names both encodings; each
 * link has the same tooltip on hover and keyboard focus; the table below has every value.
 */
export function ExchangeMap({ exchanges, title }: { exchanges: Exchange[]; title: string }) {
  const t = useTranslations('exchangeMap');
  const format = useFormatter();
  const titleId = useId();
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(720);
  const [active, setActive] = useState<number | null>(null);
  // Escape hides the tooltip without moving the pointer or the focus (WCAG 1.4.13, M6-02).
  useEffect(() => {
    if (active === null) return;
    const hide = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setActive(null);
    };
    document.addEventListener('keydown', hide);
    return () => document.removeEventListener('keydown', hide);
  }, [active]);
  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.max(240, Math.floor(entry.contentRect.width)));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const consumers = side(exchanges, 'consumer');
  const providers = side(exchanges, 'provider');
  const rows = Math.max(consumers.length, providers.length, 1);
  const height = rows * ROW + PAD * 2;
  const label = Math.min(180, Math.floor(width * 0.3));
  const chars = Math.max(8, Math.floor(label / 7.5));
  const left = label;
  const right = width - label;
  const yOf = (list: Side[], id: string) => {
    const i = list.findIndex((s) => s.id === id);
    // Each side centred in the height.
    const offset = ((rows - list.length) * ROW) / 2;
    return PAD + offset + i * ROW + ROW / 2;
  };
  const max = Math.max(1, ...exchanges.map((e) => e.calls));
  const stroke = (calls: number) =>
    calls === 0 ? 1.5 : MIN_STROKE + (MAX_STROKE - MIN_STROKE) * Math.sqrt(calls / max);
  const current = active === null ? undefined : exchanges[active];
  const describe = (e: Exchange) =>
    t('link', {
      consumer: e.consumerName,
      provider: e.providerName,
      calls: e.calls,
      errors: e.errors,
      subscriptions: e.activeSubscriptions,
    });

  return (
    <figure className="usage-chart">
      <figcaption id={titleId} className="text-sm font-medium">
        {title}
      </figcaption>
      <div className="exchange-legend text-sm" aria-hidden="true">
        <span>
          <svg width="28" height="10">
            <line x1="0" x2="28" y1="5" y2="5" className="exchange-link" strokeWidth="6" />
          </svg>
          {t('legend.calls')}
        </span>
        <span>
          <svg width="28" height="10">
            <line
              x1="0"
              x2="28"
              y1="5"
              y2="5"
              className="exchange-link is-idle"
              strokeWidth="1.5"
            />
          </svg>
          {t('legend.idle')}
        </span>
      </div>
      <div className="relative" ref={box}>
        <svg
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          // Never wider than its container, even for the instant before the width is measured again
          // (a window or zoom change): 1.4.10 reflow.
          className="block h-auto max-w-full"
          role="group"
          aria-labelledby={titleId}
          onPointerLeave={() => setActive(null)}
        >
          <text x={left} y={PAD - 4} textAnchor="end" className="usage-chart-tick">
            {t('consumers')}
          </text>
          <text x={right} y={PAD - 4} className="usage-chart-tick">
            {t('providers')}
          </text>
          {exchanges.map((e, i) => {
            const y1 = yOf(consumers, e.consumerId);
            const y2 = yOf(providers, e.providerId);
            const mid = (left + right) / 2;
            const d = `M${left + 8},${y1} C${mid},${y1} ${mid},${y2} ${right - 8},${y2}`;
            return (
              <g
                key={`${e.consumerId}-${e.providerId}`}
                role="img"
                tabIndex={0}
                aria-label={describe(e)}
                onPointerEnter={() => setActive(i)}
                onFocus={() => setActive(i)}
                onBlur={() => setActive(null)}
                className="exchange-hit"
              >
                {/* Hit target wider than the link. */}
                <path
                  d={d}
                  stroke="transparent"
                  strokeWidth={Math.max(14, stroke(e.calls) + 8)}
                  fill="none"
                />
                <path
                  d={d}
                  fill="none"
                  strokeWidth={stroke(e.calls)}
                  strokeLinecap="round"
                  className={[
                    'exchange-link',
                    e.calls === 0 ? 'is-idle' : '',
                    active === i ? 'is-active' : '',
                  ].join(' ')}
                />
              </g>
            );
          })}
          {consumers.map((c) => (
            <g key={`c-${c.id}`}>
              <circle cx={left + 4} cy={yOf(consumers, c.id)} r={5} className="exchange-node" />
              <text
                x={left - 6}
                y={yOf(consumers, c.id) + 4}
                textAnchor="end"
                className="exchange-label"
              >
                {short(c.name, chars)}
              </text>
            </g>
          ))}
          {providers.map((p) => (
            <g key={`p-${p.id}`}>
              <circle cx={right - 4} cy={yOf(providers, p.id)} r={5} className="exchange-node" />
              <text x={right + 6} y={yOf(providers, p.id) + 4} className="exchange-label">
                {short(p.name, chars)}
              </text>
            </g>
          ))}
        </svg>
        {current && (
          <div
            className="usage-chart-tooltip"
            style={{
              left: '50%',
              top: `${Math.max(0, (yOf(consumers, current.consumerId) + yOf(providers, current.providerId)) / 2 - 40)}px`,
            }}
            aria-hidden="true"
          >
            <strong>{format.number(current.calls)}</strong> {t('tooltip.calls')}
            <br />
            <span className="text-muted-foreground">
              {current.consumerName} → {current.providerName}
            </span>
            <br />
            <span className="text-muted-foreground">
              {t('tooltip.detail', {
                errors: current.errors,
                subscriptions: current.activeSubscriptions,
              })}
            </span>
          </div>
        )}
      </div>
    </figure>
  );
}
