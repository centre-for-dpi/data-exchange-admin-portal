'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';

export interface UsageDay {
  date: string;
  calls: number;
  errors: number;
}

/** One column: its axis label, value, and what the tooltip and assistive tech say about it. */
export interface Column {
  key: string;
  label: string;
  value: number;
  /** The whole reading, for assistive tech ("2 mar: 12 llamadas, 1 con error"). */
  description: string;
  tooltip: ReactNode;
}

const HEIGHT = 180;
const AXIS = 36;
const BOTTOM = 22;
const TOP = 8;
const MAX_BAR = 24;

/** Round axis maximum and ticks: 0 and up to four steps of 1, 2 or 5 × 10ⁿ. */
function ticksFor(max: number): number[] {
  if (max <= 0) return [0, 1];
  const raw = max / 4;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * magnitude).find((s) => s >= raw) ?? raw;
  const top = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = 0; v <= top + step / 2; v += step) ticks.push(Math.round(v));
  return ticks;
}

/**
 * A single-series column chart (M5): no legend box (the title names the series). Drawn at the
 * container's real width, so bars keep their 24px cap and text its size. Each column is a hit
 * target wider than the bar, with the same tooltip on hover and keyboard focus; the table view
 * (`table`) carries every value without hovering.
 */
export function ColumnChart({
  title,
  columns,
  table,
}: {
  title: string;
  columns: Column[];
  table: ReactNode;
}) {
  const t = useTranslations('usage');
  const format = useFormatter();
  const titleId = useId();
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
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.max(240, Math.floor(entry.contentRect.width)));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const plot = width - AXIS;
  const slot = plot / Math.max(columns.length, 1);
  const bar = Math.min(MAX_BAR, Math.max(2, slot - 2));
  const ticks = ticksFor(Math.max(...columns.map((c) => c.value), 0));
  const top = ticks.at(-1) ?? 1;
  const y = (v: number) => TOP + (HEIGHT - TOP - BOTTOM) * (1 - v / top);
  // As many axis labels as fit, about 56px each.
  const every = Math.max(1, Math.ceil(columns.length / Math.max(1, Math.floor(plot / 56))));
  const current = active === null ? undefined : columns[active];

  return (
    <figure className="usage-chart">
      <figcaption id={titleId} className="text-sm font-medium">
        {title}
      </figcaption>
      <div className="relative" ref={box}>
        <svg
          width={width}
          height={HEIGHT}
          viewBox={`0 0 ${width} ${HEIGHT}`}
          // Never wider than its container, even for the instant before the width is measured again
          // (a window or zoom change): 1.4.10 reflow.
          className="block h-auto max-w-full"
          role="group"
          aria-labelledby={titleId}
          onPointerLeave={() => setActive(null)}
        >
          {ticks.map((tick) => (
            <g key={tick}>
              <line x1={AXIS} x2={width} y1={y(tick)} y2={y(tick)} className="usage-chart-grid" />
              <text x={AXIS - 6} y={y(tick) + 4} textAnchor="end" className="usage-chart-tick">
                {format.number(tick, { notation: tick >= 10_000 ? 'compact' : 'standard' })}
              </text>
            </g>
          ))}
          {columns.map((c, i) => {
            const x = AXIS + i * slot + (slot - bar) / 2;
            const h = HEIGHT - BOTTOM - y(c.value);
            const r = Math.min(4, h / 2, bar / 2);
            const base = HEIGHT - BOTTOM;
            // 4px rounded data end, square at the baseline.
            const path =
              h <= 0
                ? ''
                : `M${x},${base} V${base - h + r} Q${x},${base - h} ${x + r},${base - h} H${x + bar - r} Q${x + bar},${base - h} ${x + bar},${base - h + r} V${base} Z`;
            return (
              <g
                key={c.key}
                role="img"
                tabIndex={0}
                aria-label={c.description}
                onPointerEnter={() => setActive(i)}
                onFocus={() => setActive(i)}
                onBlur={() => setActive(null)}
                className="usage-chart-bar"
              >
                {/* The hit target: the whole slot, taller than the bar. */}
                <rect
                  x={AXIS + i * slot}
                  y={TOP}
                  width={slot}
                  height={HEIGHT - TOP - BOTTOM}
                  fill="transparent"
                />
                {path && (
                  <path
                    d={path}
                    className={active === i ? 'usage-chart-mark is-active' : 'usage-chart-mark'}
                  />
                )}
                {i % every === 0 && (
                  <text
                    x={x + bar / 2}
                    y={HEIGHT - 6}
                    textAnchor="middle"
                    className="usage-chart-tick"
                  >
                    {c.label}
                  </text>
                )}
              </g>
            );
          })}
          <line
            x1={AXIS}
            x2={width}
            y1={HEIGHT - BOTTOM}
            y2={HEIGHT - BOTTOM}
            className="usage-chart-axis"
          />
        </svg>
        {current && active !== null && (
          <div
            className="usage-chart-tooltip"
            style={{ left: `${((AXIS + (active + 0.5) * slot) / width) * 100}%` }}
            aria-hidden="true"
          >
            {current.tooltip}
          </div>
        )}
      </div>
      <details className="mt-2 text-sm">
        <summary className="cursor-pointer">{t('chart.asTable')}</summary>
        <div className="table-wrap mt-2">{table}</div>
      </details>
    </figure>
  );
}

/** UTC noon of a calendar day: formatting it never moves it to the day before. */
const asDate = (day: string) => new Date(`${day}T12:00:00Z`);

/** Calls per day (M5-02, M5-03). */
export function DailyChart({ days, title }: { days: UsageDay[]; title: string }) {
  const t = useTranslations('usage');
  const format = useFormatter();
  const day = (d: string) =>
    format.dateTime(asDate(d), { day: 'numeric', month: 'short', timeZone: 'UTC' });
  return (
    <ColumnChart
      title={title}
      columns={days.map((d) => ({
        key: d.date,
        label: day(d.date),
        value: d.calls,
        description: t('chart.point', { date: day(d.date), calls: d.calls, errors: d.errors }),
        tooltip: (
          <>
            <strong>{format.number(d.calls)}</strong> {t('chart.calls')}
            <br />
            <span className="text-muted-foreground">
              {format.number(d.errors)} {t('chart.errors')} · {day(d.date)}
            </span>
          </>
        ),
      }))}
      table={
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">{t('chart.date')}</th>
              <th scope="col" className="text-right">
                {t('chart.callsHeader')}
              </th>
              <th scope="col" className="text-right">
                {t('chart.errorsHeader')}
              </th>
            </tr>
          </thead>
          <tbody>
            {days.map((d) => (
              <tr key={d.date}>
                <td>{format.dateTime(asDate(d.date), { dateStyle: 'medium', timeZone: 'UTC' })}</td>
                <td className="text-right tabular-nums">{format.number(d.calls)}</td>
                <td className="text-right tabular-nums">{format.number(d.errors)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      }
    />
  );
}

/** Entities that published their first API, by month (M5-04). */
export function MonthlyChart({
  months,
  title,
}: {
  months: Array<{ month: string; count: number; cumulative: number }>;
  title: string;
}) {
  const t = useTranslations('indicators');
  const format = useFormatter();
  const label = (m: string) =>
    format.dateTime(new Date(`${m}-15T12:00:00Z`), {
      month: 'short',
      year: '2-digit',
      timeZone: 'UTC',
    });
  return (
    <ColumnChart
      title={title}
      columns={months.map((m) => ({
        key: m.month,
        label: label(m.month),
        value: m.count,
        description: t('connected.point', {
          month: label(m.month),
          count: m.count,
          cumulative: m.cumulative,
        }),
        tooltip: (
          <>
            <strong>{format.number(m.count)}</strong> {t('connected.new')}
            <br />
            <span className="text-muted-foreground">
              {t('connected.cumulative', { cumulative: m.cumulative })} · {label(m.month)}
            </span>
          </>
        ),
      }))}
      table={
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">{t('connected.month')}</th>
              <th scope="col" className="text-right">
                {t('connected.newHeader')}
              </th>
              <th scope="col" className="text-right">
                {t('connected.cumulativeHeader')}
              </th>
            </tr>
          </thead>
          <tbody>
            {months.map((m) => (
              <tr key={m.month}>
                <td>{label(m.month)}</td>
                <td className="text-right tabular-nums">{format.number(m.count)}</td>
                <td className="text-right tabular-nums">{format.number(m.cumulative)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      }
    />
  );
}
