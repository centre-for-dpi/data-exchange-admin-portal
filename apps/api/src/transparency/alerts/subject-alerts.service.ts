import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import type { SubjectAccessWebhook, SubjectAlerts } from '@rid/contracts';
import { z } from 'zod';
import { AuditService } from '../../audit/audit.service.js';
import type { Classification } from '../../generated/prisma/client.js';
import { OutboxService } from '../../outbox/outbox.service.js';
import { PrismaService, type Tx } from '../../prisma/prisma.service.js';
import { QueueService } from '../../queue/queue.service.js';
import type { CitizenIdentity } from '../citizen/citizen-token-verifier.js';
import { webhookHeaders } from './webhook-signature.js';

export const ALERT_TOPIC = 'citizen.alert';
const DELIVERY_TIMEOUT_MS = 10_000;
const ALERTABLE = new Set<Classification>(['personal', 'sensitive']);
type AlertClassification = SubjectAlerts['classifications'][number];
const alertable = (values: Classification[]): AlertClassification[] =>
  values.filter((c): c is AlertClassification => ALERTABLE.has(c));

/**
 * Citizen apps that receive notices (RID_CITIZEN_APPS): by client id, where to POST and the
 * Standard Webhooks secret. Operator configuration, never user input.
 */
const citizenAppsSchema = z.record(
  z.string().min(1),
  z.object({
    webhookUrl: z.url({ protocol: /^https?$/ }),
    webhookSecret: z.string().startsWith('whsec_'),
  }),
);
export type CitizenApps = z.infer<typeof citizenAppsSchema>;

export function citizenApps(): CitizenApps {
  const raw = process.env.RID_CITIZEN_APPS;
  return raw ? citizenAppsSchema.parse(JSON.parse(raw)) : {};
}

export interface AlertableAccess {
  id: string;
  subjectRef: string;
  occurredAt: Date;
  classification: Classification;
}

const alertJobSchema = z.object({
  aggregate: z.string(),
  alertId: z.uuid(),
  accessId: z.uuid(),
  occurredAt: z.iso.datetime(),
  classification: z.enum(['personal', 'sensitive']),
});

/**
 * Notices of new consultations (ADR-0015 §5, MT-06). The citizen chooses, from their citizen
 * app, which classifications of data to be told about. When a matching consultation is
 * registered, a notice goes to the outbox in the same transaction, and a worker POSTs a signed
 * webhook (Standard Webhooks) to that app, with retries. The webhook carries an opaque alert id
 * and the consultation id: no document number, no contact data. The app notifies the person.
 */
@Injectable()
export class SubjectAlertsService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SubjectAlertsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly queue: QueueService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!QueueService.enabled()) return;
    await this.queue.work(ALERT_TOPIC, (data) => this.deliver(data));
  }

  async get(citizen: CitizenIdentity): Promise<SubjectAlerts> {
    const alert = await this.prisma.subjectAlert.findUnique({
      where: { subjectRef_clientId: { subjectRef: citizen.ref, clientId: citizen.clientId } },
    });
    return { alertId: alert?.id ?? null, classifications: alertable(alert?.classifications ?? []) };
  }

  async put(citizen: CitizenIdentity, classifications: Classification[]): Promise<SubjectAlerts> {
    const wanted = [...new Set(classifications)].sort();
    return this.prisma.$transaction(async (tx) => {
      const where = {
        subjectRef_clientId: { subjectRef: citizen.ref, clientId: citizen.clientId },
      };
      const before = await tx.subjectAlert.findUnique({ where });
      const alert = await tx.subjectAlert.upsert({
        where,
        create: { subjectRef: citizen.ref, clientId: citizen.clientId, classifications: wanted },
        update: { classifications: wanted },
      });
      // Who asked is the citizen app; the person appears only through the opaque alert id.
      await this.audit.record(tx, {
        actor: { type: 'application', id: citizen.clientId },
        action: 'subject_alert.updated',
        target: { type: 'subject_alert', id: alert.id },
        before: before ? { classifications: before.classifications } : undefined,
        after: { classifications: alert.classifications },
      });
      return { alertId: alert.id, classifications: alertable(alert.classifications) };
    });
  }

  /**
   * Queues a notice for each new consultation a citizen asked to hear about. Call it in the
   * transaction that registers the consultations, with the rows actually inserted (a retried
   * gateway record must not notify twice).
   */
  async enqueueFor(tx: Tx, accesses: AlertableAccess[]): Promise<number> {
    const candidates = accesses.filter((a) => ALERTABLE.has(a.classification));
    if (candidates.length === 0) return 0;
    const alerts = await tx.subjectAlert.findMany({
      where: { subjectRef: { in: [...new Set(candidates.map((a) => a.subjectRef))] } },
    });
    let queued = 0;
    for (const access of candidates) {
      for (const alert of alerts) {
        if (alert.subjectRef !== access.subjectRef) continue;
        if (!alert.classifications.includes(access.classification)) continue;
        await this.outbox.enqueue(tx, {
          topic: ALERT_TOPIC,
          aggregate: `alert:${alert.id}:${access.id}`,
          payload: {
            alertId: alert.id,
            accessId: access.id,
            occurredAt: access.occurredAt.toISOString(),
            classification: access.classification,
          },
        });
        queued++;
      }
    }
    return queued;
  }

  /**
   * Sends one notice. Skips it if the citizen turned notices off (or narrowed them) since it was
   * queued. A non-2xx answer throws, so the queue retries with backoff.
   */
  async deliver(data: Record<string, unknown>): Promise<'sent' | 'skipped'> {
    const job = alertJobSchema.parse(data);
    const alert = await this.prisma.subjectAlert.findUnique({ where: { id: job.alertId } });
    if (!alert?.classifications.includes(job.classification)) return 'skipped';
    const app = citizenApps()[alert.clientId];
    if (!app) {
      this.logger.warn(`No webhook configured for citizen app ${alert.clientId}; notice dropped`);
      return 'skipped';
    }
    const message: SubjectAccessWebhook = {
      type: 'subject_access.created',
      timestamp: new Date().toISOString(),
      data: {
        alertId: job.alertId,
        accessId: job.accessId,
        occurredAt: job.occurredAt,
        classification: job.classification,
      },
    };
    const body = JSON.stringify(message);
    // Stable across retries, so the app can drop duplicates.
    const id = `msg_${job.alertId}_${job.accessId}`;
    const res = await fetch(app.webhookUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...webhookHeaders(app.webhookSecret, id, body),
      },
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Citizen app answered ${res.status}`);
    return 'sent';
  }
}
