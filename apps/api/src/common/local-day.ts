/** Calendar days in a time zone (the country's, CLAUDE.md: store UTC, show local). */

/** YYYY-MM-DD of an instant in a time zone. */
export function localDay(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Offset (ms) of the time zone from UTC at an instant: local wall time minus UTC. */
function offsetAt(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const wall = Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second'));
  return wall - Math.floor(instant.getTime() / 1000) * 1000;
}

/** The instant a local day starts (00:00 in that time zone). */
export function startOfLocalDay(day: string, timeZone: string): Date {
  const [y = 0, m = 1, d = 1] = day.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d);
  // Two passes settle days where the offset changes (DST) near midnight.
  let start = guess - offsetAt(new Date(guess), timeZone);
  start = guess - offsetAt(new Date(start), timeZone);
  return new Date(start);
}

/** The next calendar day (YYYY-MM-DD). */
export function nextDay(day: string): string {
  const [y = 0, m = 1, d = 1] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}
