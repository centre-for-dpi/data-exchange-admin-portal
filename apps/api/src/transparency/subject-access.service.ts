import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { getCountryConfig } from '@den/config';
import { z } from 'zod';
import { listOperations } from '../apis/lint/openapi-lint.js';
import { AuditService } from '../audit/audit.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { QueueService } from '../queue/queue.service.js';
import { routeId } from '../reconcilers/apisix/desired-state.js';
import { SubjectAlertsService } from './alerts/subject-alerts.service.js';

const HEX_64 = /^[0-9a-f]{64}$/;
/** Optional gateway field: APISIX sends "" (or nothing) when the variable is empty. */
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === '' || value === '-' ? undefined : value), schema.optional());

/**
 * One record of the transparency pipeline (TRANSPARENCY_LOG_FORMAT in the APISIX reconciler):
 * metadata only, the data subject as OPA's keyed pseudonym.
 */
export const gatewayRecordSchema = z.object({
  ts: z.coerce.number<string | number>().positive(),
  gateway_node: z.string().trim().min(1).max(255),
  gateway_request_id: z.string().regex(/^[0-9a-f]{32}$/),
  request_id: optional(z.string().max(200)),
  route_id: z.string().max(100),
  operation: z.string().trim().min(1).max(200),
  subscription_id: z.uuid(),
  subject_ref: z.string().regex(HEX_64),
  end_user_hash: optional(z.string().regex(HEX_64)),
  status: z.coerce.number<string | number>().int().min(100).max(599),
  // Set by nginx when it proxied the call: the proof OPA let it through.
  upstream_status: z.string().trim().min(1).max(200),
});
type GatewayRecord = z.infer<typeof gatewayRecordSchema>;

export type DropReason = 'invalid' | 'unknown_subscription' | 'route_mismatch' | 'no_subject';

export interface IngestResult {
  accepted: number;
  duplicates: number;
  dropped: Partial<Record<DropReason, number>>;
}

const INSERT_SLICE = 1_000;
const PURGE_EVERY_MS = 6 * 60 * 60 * 1000;

/**
 * Transparency register (ADR-0015, MT-03): stores, insert-only, who consulted whose data, when,
 * which operation and for what purpose. Records come from the gateway through Fluent Bit; this
 * service validates them, enriches them from the subscription OPA authorized (provider, API,
 * exposed data, purpose, consumer) and drops anything that does not add up. Duplicates from
 * retries are ignored by the idempotency key (gateway node + nginx request id).
 *
 * Never logs record values: only counts per reason.
 */
@Injectable()
export class SubjectAccessService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(SubjectAccessService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly alerts: SubjectAlertsService,
  ) {}

  onApplicationBootstrap(): void {
    if (!QueueService.enabled()) return;
    const run = () =>
      void this.purgeExpired().catch((error: unknown) =>
        this.logger.error(`Transparency retention purge failed: ${String(error)}`),
      );
    run();
    this.timer = setInterval(run, PURGE_EVERY_MS);
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async ingest(entries: unknown[]): Promise<IngestResult> {
    const dropped: Partial<Record<DropReason, number>> = {};
    const drop = (reason: DropReason) => (dropped[reason] = (dropped[reason] ?? 0) + 1);

    const records: GatewayRecord[] = [];
    for (const entry of entries) {
      const parsed = gatewayRecordSchema.safeParse(entry);
      if (parsed.success) records.push(parsed.data);
      else drop('invalid');
    }

    const subscriptions = await this.prisma.subscription.findMany({
      where: { id: { in: [...new Set(records.map((r) => r.subscription_id))] } },
      select: {
        id: true,
        purposeCode: true,
        application: { select: { id: true, entityId: true } },
        apiVersion: {
          select: {
            id: true,
            apiId: true,
            openapiSpec: true,
            exposedFields: true,
            api: { select: { entityId: true, classification: true } },
          },
        },
      },
    });
    const byId = new Map(subscriptions.map((s) => [s.id, s]));
    const operationsOf = new Map<string, ReturnType<typeof listOperations>>();

    const rows: Prisma.SubjectAccessRecordCreateManyInput[] = [];
    for (const record of records) {
      const subscription = byId.get(record.subscription_id);
      if (!subscription) {
        drop('unknown_subscription');
        continue;
      }
      const version = subscription.apiVersion;
      // The route must be the subscription's own version: OPA decided on that pair.
      if (record.route_id !== routeId(version.id)) {
        drop('route_mismatch');
        continue;
      }
      let operations = operationsOf.get(version.id);
      if (!operations) {
        operations = listOperations(version.openapiSpec as Record<string, unknown>);
        operationsOf.set(version.id, operations);
      }
      const source = operations.find((o) => o.operationId === record.operation)?.dataSubject?.in;
      if (source !== 'path' && source !== 'body') {
        drop('no_subject');
        continue;
      }
      rows.push({
        occurredAt: new Date(Math.round(record.ts * 1000)),
        gatewayNode: record.gateway_node,
        gatewayRequestId: record.gateway_request_id,
        requestId: record.request_id ?? null,
        subjectRef: record.subject_ref,
        subjectSource: source,
        providerEntityId: version.api.entityId,
        apiId: version.apiId,
        apiVersionId: version.id,
        operationId: record.operation,
        exposedFields: version.exposedFields as Prisma.InputJsonValue,
        consumerEntityId: subscription.application.entityId,
        applicationId: subscription.application.id,
        subscriptionId: subscription.id,
        purposeCode: subscription.purposeCode,
        endUserHash: record.end_user_hash ?? null,
        status: record.status,
      });
    }

    // In slices: PostgreSQL takes at most 65,535 bind parameters per statement, and a Fluent Bit
    // chunk can hold far more rows than that allows. Each slice is idempotent, so a retry after a
    // partial failure only adds the missing ones. Notices for the citizens who asked (MT-06) go
    // to the outbox in the same transaction, only for rows actually inserted: a retried record
    // does not notify twice.
    const classificationOf = new Map(
      subscriptions.map((s) => [s.apiVersion.id, s.apiVersion.api.classification]),
    );
    let count = 0;
    for (let i = 0; i < rows.length; i += INSERT_SLICE) {
      const slice = rows.slice(i, i + INSERT_SLICE);
      count += await this.prisma.$transaction(async (tx) => {
        const inserted = await tx.subjectAccessRecord.createManyAndReturn({
          data: slice,
          skipDuplicates: true,
          select: { id: true, subjectRef: true, occurredAt: true, apiVersionId: true },
        });
        await this.alerts.enqueueFor(
          tx,
          inserted.flatMap((r) => {
            const classification = classificationOf.get(r.apiVersionId);
            return classification ? [{ ...r, classification }] : [];
          }),
        );
        return inserted.length;
      });
    }
    const result = { accepted: count, duplicates: rows.length - count, dropped };
    if (Object.keys(dropped).length > 0) {
      this.logger.warn(`Transparency records dropped: ${JSON.stringify(dropped)}`);
    }
    return result;
  }

  /**
   * Removes records past retention.subjectAccessMonths through the database function, the only
   * path that may delete them. A purge that removed something is audited.
   */
  async purgeExpired(): Promise<number> {
    const months = getCountryConfig().retention.subjectAccessMonths;
    return this.prisma.$transaction(async (tx) => {
      const [row] = await tx.$queryRaw<Array<{ deleted: bigint }>>`
        SELECT purge_subject_access_records(${months}::integer) AS deleted`;
      const deleted = Number(row?.deleted ?? 0n);
      if (deleted > 0) {
        await this.audit.record(tx, {
          actor: { type: 'system', id: 'transparency-retention' },
          action: 'subject_access.purged',
          target: { type: 'subject_access_record', id: 'retention' },
          after: { deleted, retentionMonths: months },
        });
      }
      return deleted;
    });
  }
}
