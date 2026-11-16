'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { useEffect, useId, useRef, useState } from 'react';

export interface UsageDay {
  date: string;
  calls: number;
  errors: number;
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

/** UTC noon of a calendar day: formatting it never moves it to the day before. */
const asDate = (day: string) => new Date(`${day}T12:00:00Z`);

/**
 * Calls per day (M5-02, M5-03): one series, so no legend box (the title names it). Each bar is a
 * hit target wider than the bar, with the same tooltip on hover and keyboard focus; the table
 * view carries every value without hovering.
 */
export function DailyChart({ days, title }: { days: UsageDay[]; title: string }) {
  const t = useTranslations('usage');
  const format = useFormatter();
  const titleId = useId();
  const [active, setActive] = useState<number | null>(null);
  // Drawn at the container's real width: bars keep their 24px cap and text its size.
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.max(280, Math.floor(entry.contentRect.width)));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const plot = width - AXIS;
  const slot = plot / Math.max(days.length, 1);
  const bar = Math.min(MAX_BAR, Math.max(2, slot - 2));
  const ticks = ticksFor(Math.max(...days.map((d) => d.calls), 0));
  const top = ticks.at(-1) ?? 1;
  const y = (v: number) => TOP + (HEIGHT - TOP - BOTTOM) * (1 - v / top);
  const day = (d: string) =>
    format.dateTime(asDate(d), { day: 'numeric', month: 'short', timeZone: 'UTC' });
  // As many date labels as fit, about 56px each.
  const every = Math.max(1, Math.ceil(days.length / Math.max(1, Math.floor(plot / 56))));
  const current = active === null ? undefined : days[active];

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
          className="block"
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
          {days.map((d, i) => {
            const x = AXIS + i * slot + (slot - bar) / 2;
            const h = HEIGHT - BOTTOM - y(d.calls);
            const r = Math.min(4, h / 2, bar / 2);
            const base = HEIGHT - BOTTOM;
            // 4px rounded data end, square at the baseline.
            const path =
              h <= 0
                ? ''
                : `M${x},${base} V${base - h + r} Q${x},${base - h} ${x + r},${base - h} H${x + bar - r} Q${x + bar},${base - h} ${x + bar},${base - h + r} V${base} Z`;
            return (
              <g
                key={d.date}
                role="img"
                tabIndex={0}
                aria-label={t('chart.point', {
                  date: day(d.date),
                  calls: d.calls,
                  errors: d.errors,
                })}
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
                    {day(d.date)}
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
            <strong>{format.number(current.calls)}</strong> {t('chart.calls')}
            <br />
            <span className="text-muted-foreground">
              {format.number(current.errors)} {t('chart.errors')} · {day(current.date)}
            </span>
          </div>
        )}
      </div>
      <details className="mt-2 text-sm">
        <summary className="cursor-pointer">{t('chart.asTable')}</summary>
        <div className="table-wrap mt-2">
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
                  <td>
                    {format.dateTime(asDate(d.date), { dateStyle: 'medium', timeZone: 'UTC' })}
                  </td>
                  <td className="text-right tabular-nums">{format.number(d.calls)}</td>
                  <td className="text-right tabular-nums">{format.number(d.errors)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}
