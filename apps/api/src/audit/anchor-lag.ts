import { getCountryConfig } from '@den/config';
import { localDay, nextDay, startOfLocalDay } from '../common/local-day.js';
import type { PrismaService } from '../prisma/prisma.service.js';

/**
 * Seconds a finished day has gone without its anchor (B-02); 0 when nothing waits. It follows the
 * rule of `AuditAnchorService.anchorDue`: the first chained event after the latest anchor (by day)
 * belongs to a day that should have been anchored once it ended. An anchor dated in the future
 * covers every later event, so after it the lag grows until someone notices: that is the point.
 */
export async function anchorOverdueSeconds(
  prisma: Pick<PrismaService, 'auditAnchor' | 'auditEvent'>,
  now = new Date(),
): Promise<number> {
  const timeZone = getCountryConfig().country.timezone;
  const last = await prisma.auditAnchor.findFirst({
    orderBy: { day: 'desc' },
    select: { lastSeq: true },
  });
  const next = await prisma.auditEvent.findFirst({
    where: { hash: { not: null }, ...(last ? { seq: { gt: last.lastSeq } } : {}) },
    orderBy: { seq: 'asc' },
    select: { occurredAt: true },
  });
  if (!next) return 0;
  const dayEnded = startOfLocalDay(nextDay(localDay(next.occurredAt, timeZone)), timeZone);
  return Math.max(0, Math.round((now.getTime() - dayEnded.getTime()) / 1000));
}
