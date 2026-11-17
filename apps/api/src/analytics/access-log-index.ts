import { createHash } from 'node:crypto';
import {
  Inject,
  Injectable,
  Logger,
  Optional,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { getCountryConfig } from '@den/config';
import { PrismaService } from '../prisma/prisma.service.js';
import { QueueService } from '../queue/queue.service.js';
import { recordSyncError, recordSyncSuccess } from '../reconcilers/sync-state.js';
import { ACCESS_LOG_INDICES, OPENSEARCH, type OpenSearch } from './opensearch.js';

export const ACCESS_LOG_TEMPLATE = 'den-access';
/** Outbox topic of a reconcile on demand (the operator's sync console, M5-07). */
export const OPENSEARCH_SYNC_TOPIC = 'opensearch.sync';
export const ACCESS_LOG_POLICY = 'den-access-retention';
export const templateTarget = `opensearch:index-template:${ACCESS_LOG_TEMPLATE}`;
export const policyTarget = `opensearch:ism-policy:${ACCESS_LOG_POLICY}`;
const FULL_RECONCILE_MS = 60 * 60 * 1000;

const keyword = { type: 'keyword' } as const;

/**
 * Index template of the access logs (ARCHITECTURE.md §8, M5-01): the allowlisted fields with
 * their types, and nothing else. `strict` makes OpenSearch reject a document with any other
 * field, a third barrier after APISIX's log_format and Fluent Bit's allowlist.
 */
export function desiredIndexTemplate() {
  const template = {
    index_patterns: [ACCESS_LOG_INDICES],
    priority: 100,
    template: {
      settings: {
        number_of_shards: 1,
        // One replica when the cluster has a second node; none on a single node.
        auto_expand_replicas: '0-1',
      },
      mappings: {
        dynamic: 'strict',
        properties: {
          // Added by Fluent Bit's OpenSearch output (arrival time); `ts` is the gateway's.
          '@timestamp': { type: 'date' },
          ts: { type: 'date' },
          request_id: keyword,
          route_id: keyword,
          operation: keyword,
          method: keyword,
          status: { type: 'short' },
          latency_ms: { type: 'float' },
          upstream_latency_ms: { type: 'float' },
          consumer_entity: keyword,
          consumer_app: keyword,
          subscription_id: keyword,
          purpose: keyword,
          end_user_hash: keyword,
          bytes_sent: { type: 'long' },
          gateway_node: keyword,
          deny_reason: keyword,
        },
      },
    },
  };
  const hash = digest(template);
  return { hash, body: { ...template, _meta: { den_hash: hash } } };
}

/**
 * Retention of the access logs (config retention.accessLogMonths). One index per month: it is
 * deleted when it is a month older than the retention, so every call is kept for at least the
 * configured months and at most one month more.
 */
export function desiredRetentionPolicy(months: number) {
  const policy = {
    default_state: 'hot',
    states: [
      {
        name: 'hot',
        actions: [],
        transitions: [
          { state_name: 'delete', conditions: { min_index_age: `${(months + 1) * 31}d` } },
        ],
      },
      { name: 'delete', actions: [{ delete: {} }], transitions: [] },
    ],
    ism_template: [{ index_patterns: [ACCESS_LOG_INDICES], priority: 100 }],
  };
  const hash = digest(policy);
  return {
    hash,
    body: {
      policy: {
        // OpenSearch adds defaults to what it returns; the hash in the description is compared.
        description: `DEN access logs: kept ${months} months (den_hash ${hash})`,
        ...policy,
      },
    },
  };
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}

interface TemplateResponse {
  index_templates?: Array<{ index_template?: { _meta?: { den_hash?: string } } }>;
}

interface PolicyResponse {
  _seq_no?: number;
  _primary_term?: number;
  policy?: { description?: string };
}

export type IndexSetupResult = 'created' | 'updated' | 'unchanged';

/**
 * Keeps the access-log index template and its retention policy in OpenSearch (M5-01), like the
 * other reconcilers: desired state from the code and the country config, idempotent calls, the
 * outcome in sync_state. On start and every hour; OpenSearch is optional (observability
 * profile), so a failure is recorded and retried, never fatal.
 */
@Injectable()
export class AccessLogIndexReconciler implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(AccessLogIndexReconciler.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(OPENSEARCH) private readonly openSearch: OpenSearch,
    @Optional() private readonly queue?: QueueService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!QueueService.enabled()) return;
    await this.queue?.work(OPENSEARCH_SYNC_TOPIC, () => this.reconcileAll());
    void this.reconcileAll();
    this.timer = setInterval(() => void this.reconcileAll(), FULL_RECONCILE_MS);
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async reconcileAll(): Promise<void> {
    for (const [target, step] of [
      [templateTarget, () => this.reconcileTemplate()],
      [policyTarget, () => this.reconcilePolicy()],
    ] as const) {
      try {
        await step();
      } catch (error) {
        this.logger.warn(`OpenSearch reconcile of ${target} failed: ${String(error)}`);
      }
    }
  }

  async reconcileTemplate(): Promise<IndexSetupResult> {
    const { hash, body } = desiredIndexTemplate();
    try {
      const current = await this.openSearch.request<TemplateResponse>(
        'GET',
        `/_index_template/${ACCESS_LOG_TEMPLATE}`,
      );
      const applied = current.body?.index_templates?.[0]?.index_template?._meta?.den_hash;
      if (current.status === 200 && applied === hash) {
        await recordSyncSuccess(this.prisma, 'opensearch', templateTarget, hash);
        return 'unchanged';
      }
      const put = await this.openSearch.request(
        'PUT',
        `/_index_template/${ACCESS_LOG_TEMPLATE}`,
        body,
      );
      if (put.status !== 200)
        throw new Error(`PUT index template: ${put.status} ${JSON.stringify(put.body)}`);
      await recordSyncSuccess(this.prisma, 'opensearch', templateTarget, hash);
      return current.status === 404 ? 'created' : 'updated';
    } catch (error) {
      await recordSyncError(this.prisma, 'opensearch', templateTarget, hash, error);
      throw error;
    }
  }

  async reconcilePolicy(): Promise<IndexSetupResult> {
    const { hash, body } = desiredRetentionPolicy(getCountryConfig().retention.accessLogMonths);
    const path = `/_plugins/_ism/policies/${ACCESS_LOG_POLICY}`;
    try {
      const current = await this.openSearch.request<PolicyResponse>('GET', path);
      let result: IndexSetupResult = 'unchanged';
      if (current.status === 404) {
        const put = await this.openSearch.request('PUT', path, body);
        if (put.status !== 201 && put.status !== 200) {
          throw new Error(`PUT ISM policy: ${put.status} ${JSON.stringify(put.body)}`);
        }
        result = 'created';
      } else if (current.status !== 200) {
        throw new Error(`GET ISM policy: ${current.status}`);
      } else if (!current.body?.policy?.description?.includes(`den_hash ${hash}`)) {
        const put = await this.openSearch.request(
          'PUT',
          `${path}?if_seq_no=${current.body._seq_no}&if_primary_term=${current.body._primary_term}`,
          body,
        );
        if (put.status !== 200)
          throw new Error(`PUT ISM policy: ${put.status} ${JSON.stringify(put.body)}`);
        result = 'updated';
      }
      // New monthly indices get the policy from its ism_template; existing ones are attached here
      // (indices that already have it are reported as failures and left alone), and moved to its
      // latest version when it changed.
      await this.openSearch.request('POST', `/_plugins/_ism/add/${ACCESS_LOG_INDICES}`, {
        policy_id: ACCESS_LOG_POLICY,
      });
      if (result === 'updated') {
        await this.openSearch.request(
          'POST',
          `/_plugins/_ism/change_policy/${ACCESS_LOG_INDICES}`,
          {
            policy_id: ACCESS_LOG_POLICY,
          },
        );
      }
      await recordSyncSuccess(this.prisma, 'opensearch', policyTarget, hash);
      return result;
    } catch (error) {
      await recordSyncError(this.prisma, 'opensearch', policyTarget, hash, error);
      throw error;
    }
  }
}
