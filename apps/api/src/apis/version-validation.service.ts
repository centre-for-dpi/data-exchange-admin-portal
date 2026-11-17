import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { type VersionValidation, versionValidationSchema } from '@den/contracts';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { ConflictError } from '../common/errors.js';
import { OutboxService } from '../outbox/outbox.service.js';
import { PrismaService, type Tx } from '../prisma/prisma.service.js';
import { QueueService } from '../queue/queue.service.js';
import { GATEWAY_SYNC_TOPIC } from '../reconcilers/apisix/apisix.reconciler.js';
import {
  checkRoutePath,
  sandboxCheckRoutePath,
  VALIDATION_TOKEN_HEADER,
  versionCheckToken,
} from '../reconcilers/apisix/desired-state.js';

/** Outbox topic of the validations at submission (aggregate apiVersion:<id>). */
export const VERSION_VALIDATION_TOPIC = 'version.validate';

const SYSTEM = { type: 'system' as const, id: 'system:version-validation' };

/** Validations run unless DEN_VERSION_VALIDATION=off (the API's integration tests). */
export const validationEnabled = (): boolean => process.env.DEN_VERSION_VALIDATION !== 'off';

export function validationSettings(env: NodeJS.ProcessEnv = process.env) {
  return {
    token: env.DEN_VALIDATION_TOKEN || undefined,
    /** APISIX as the API reaches it (plain HTTP inside the platform). */
    gatewayUrl: (env.DEN_GATEWAY_INTERNAL_URL ?? 'http://localhost:9080').replace(/\/+$/, ''),
    runnerUrl: env.DEN_CONTRACT_RUNNER_URL?.replace(/\/+$/, '') || undefined,
    runnerToken: env.DEN_CONTRACT_RUNNER_TOKEN || undefined,
    /** APISIX as the runner reaches it. */
    runnerGatewayUrl: (env.DEN_CONTRACT_RUNNER_GATEWAY_URL ?? 'http://apisix:9080').replace(
      /\/+$/,
      '',
    ),
    maxExamples: Number(env.DEN_CONTRACT_MAX_EXAMPLES ?? 20),
    timeoutSeconds: Number(env.DEN_CONTRACT_TIMEOUT_SECONDS ?? 120),
  };
}

/** A stored report, validated again (jsonb is not trusted blindly); null if absent or invalid. */
export function storedValidation(value: unknown): VersionValidation | null {
  const parsed = versionValidationSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

const runnerAnswerSchema = z.object({
  status: z.enum(['passed', 'failed', 'error']),
  reason: z.string().max(200).optional(),
  durationMs: z.number().int().optional(),
  operations: z
    .array(
      z.object({
        operation: z.string().max(200),
        passed: z.boolean(),
        codes: z.array(z.string().regex(/^ST\d{3}$/)).max(20),
        receivedStatus: z.number().int().nullable(),
      }),
    )
    .max(500),
});

/** Health and contract checks against the version's check routes (M4-06). Injectable for tests. */
export interface ValidationProbes {
  healthcheck(versionId: string): Promise<NonNullable<VersionValidation['healthcheck']>>;
  contract(
    versionId: string,
    openapi: Record<string, unknown>,
  ): Promise<NonNullable<VersionValidation['contract']>>;
}

export const VALIDATION_PROBES = Symbol('VALIDATION_PROBES');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The real probes: APISIX's check routes and the contract runner (infra/contract-runner). */
@Injectable()
export class GatewayValidationProbes implements ValidationProbes {
  async healthcheck(versionId: string) {
    const s = validationSettings();
    if (!s.token)
      return {
        status: 'failed' as const,
        httpStatus: null,
        latencyMs: null,
        reason: 'not configured',
      };
    const url = `${s.gatewayUrl}${checkRoutePath(versionId)}`;
    // The check route appears with the reconcile of the submission: wait for it a little.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const started = Date.now();
      try {
        const res = await fetch(url, {
          headers: { [VALIDATION_TOKEN_HEADER]: versionCheckToken(s.token, versionId) },
          // A redirect is an answer of the service; following it would carry the token away.
          redirect: 'manual',
          signal: AbortSignal.timeout(15_000),
        });
        await res.arrayBuffer();
        const latencyMs = Date.now() - started;
        const noRoute = res.status === 404 && res.headers.get('server')?.startsWith('APISIX');
        if (noRoute && !res.headers.get('x-request-id')) {
          await sleep(1_500);
          continue;
        }
        // Any answer of the service proves the gateway reaches it; 5xx is the gateway (502/504:
        // unreachable upstream, TLS or tunnel) or the service failing.
        return res.status < 500
          ? { status: 'passed' as const, httpStatus: res.status, latencyMs }
          : {
              status: 'failed' as const,
              httpStatus: res.status,
              latencyMs,
              reason: 'server error',
            };
      } catch (error) {
        return {
          status: 'failed' as const,
          httpStatus: null,
          latencyMs: null,
          reason: (error as Error).name === 'TimeoutError' ? 'timeout' : 'unreachable',
        };
      }
    }
    return { status: 'failed' as const, httpStatus: null, latencyMs: null, reason: 'no route' };
  }

  async contract(versionId: string, openapi: Record<string, unknown>) {
    const s = validationSettings();
    if (!s.runnerUrl || !s.runnerToken || !s.token) {
      return { status: 'skipped' as const, reason: 'runner not configured', operations: [] };
    }
    try {
      const res = await fetch(`${s.runnerUrl}/v1/runs`, {
        method: 'POST',
        headers: { authorization: `Bearer ${s.runnerToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          openapi,
          baseUrl: `${s.runnerGatewayUrl}${sandboxCheckRoutePath(versionId)}`,
          headers: { [VALIDATION_TOKEN_HEADER]: versionCheckToken(s.token, versionId) },
          maxExamples: s.maxExamples,
          timeoutSeconds: s.timeoutSeconds,
        }),
        signal: AbortSignal.timeout((s.timeoutSeconds + 30) * 1000),
      });
      if (!res.ok)
        return { status: 'error' as const, reason: `runner HTTP ${res.status}`, operations: [] };
      // Only the parsed fields are kept; anything else the runner might add is dropped.
      return runnerAnswerSchema.parse(await res.json());
    } catch {
      return { status: 'error' as const, reason: 'runner unreachable', operations: [] };
    }
  }
}

/**
 * Validations when a version is sent to review (SPEC.md §4.2 step 2, M4-06): a healthcheck of the
 * production upstream through the gateway (its check route, GET on the service root only) and a
 * contract test with Schemathesis against the sandbox upstream through the gateway. Both blocking:
 * the operator approves only a version whose validations passed (a contract test skipped because
 * the version has no sandbox does not block). Results go with the review.
 */
@Injectable()
export class VersionValidationService implements OnApplicationBootstrap {
  private readonly logger = new Logger(VersionValidationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly queue: QueueService,
    private readonly probes: GatewayValidationProbes,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!QueueService.enabled() || !validationEnabled()) return;
    await this.queue.work(VERSION_VALIDATION_TOPIC, (data) => {
      const [, id] = (typeof data.aggregate === 'string' ? data.aggregate : '').split(':');
      return id ? this.run(id) : Promise.resolve();
    });
  }

  /** Marks the validations running and queues them (and the check routes), inside `tx`. */
  async queueInTx(tx: Tx, versionId: string, reason: string): Promise<void> {
    if (!validationEnabled()) return;
    const report: VersionValidation = {
      status: 'running',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      healthcheck: null,
      contract: null,
    };
    await tx.apiVersion.updateMany({
      where: { id: versionId },
      data: { validationReport: report },
    });
    for (const topic of [GATEWAY_SYNC_TOPIC, VERSION_VALIDATION_TOPIC]) {
      await this.outbox.enqueue(tx, {
        topic,
        aggregate: `apiVersion:${versionId}`,
        payload: { reason },
      });
    }
  }

  /** Runs both validations for a version still in review and stores the parsed results. */
  async run(
    versionId: string,
    probes: ValidationProbes = this.probes,
  ): Promise<VersionValidation | null> {
    const version = await this.prisma.apiVersion.findUnique({
      where: { id: versionId },
      include: { api: { select: { entityId: true } } },
    });
    if (!version || version.status !== 'in_review') return null;
    const started =
      storedValidation(version.validationReport)?.startedAt ?? new Date().toISOString();
    const healthcheck = await probes.healthcheck(versionId);
    const contract = version.sandboxUpstream
      ? await probes.contract(versionId, version.openapiSpec as Record<string, unknown>)
      : { status: 'skipped' as const, reason: 'no sandbox upstream', operations: [] };
    const passed =
      healthcheck.status === 'passed' &&
      (contract.status === 'passed' || contract.status === 'skipped');
    const report: VersionValidation = {
      status: passed ? 'passed' : 'failed',
      startedAt: started,
      finishedAt: new Date().toISOString(),
      healthcheck,
      contract,
    };
    await this.prisma.$transaction(async (tx) => {
      // Only if it is still the run that was queued for a version in review.
      const changed = await tx.apiVersion.updateMany({
        where: { id: versionId, status: 'in_review' },
        data: { validationReport: report },
      });
      if (changed.count === 0) return;
      await this.audit.record(tx, {
        actor: { ...SYSTEM, entityId: version.api.entityId },
        action: 'api_version.validated',
        target: { type: 'api_version', id: versionId },
        after: {
          status: report.status,
          healthcheck: healthcheck.status,
          contract: contract.status,
          failedOperations: contract.operations.filter((o) => !o.passed).length,
        },
      });
    });
    this.logger.log(`Validations of version ${versionId}: ${report.status}`);
    return report;
  }

  /** The operator's gate (M4-06): approving needs validations that passed. */
  static assertPassed(validationReport: unknown): void {
    if (!validationEnabled()) return;
    const report = storedValidation(validationReport);
    if (report?.status !== 'passed') {
      throw new ConflictError(
        report?.status === 'failed'
          ? 'The automatic validations failed: the provider must fix them and run them again'
          : 'The automatic validations have not finished yet',
      );
    }
  }
}
