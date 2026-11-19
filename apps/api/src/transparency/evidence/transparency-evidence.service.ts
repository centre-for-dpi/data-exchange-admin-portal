import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { getCountryConfig } from '@den/config';
import type {
  TransparencyCheckpoint,
  TransparencyCheckpointsQuery,
  TransparencyReceipt,
  TransparencyVerification,
} from '@den/contracts';
import {
  type AccessRecord,
  type CheckpointPayload,
  checkpointHash,
  fromHex,
  inclusionProof,
  entryLeafHash,
  leafEntryOf,
  recordDigest,
  recordLeafHash,
  signCheckpoint,
  toHex,
  treeRoot,
  verifyCheckpoint,
  verifyTimestampToken,
} from '@den/transparency-verifier';
import { AuditService } from '../../audit/audit.service.js';
import { ConflictError, NotFoundError } from '../../common/errors.js';
import type { SubjectAccessRecord } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { QueueService } from '../../queue/queue.service.js';
import { TransparencySigningKey } from './signing-key.js';
import { TsaClient } from './tsa.client.js';

/** Serializes sealing across API instances. */
const SEAL_LOCK = 0x7269645f7365616cn; // "den_seal"
/** Batches sealed per round at most, so a large backlog does not hold the lock for long. */
const MAX_BATCHES_PER_ROUND = 20;
const STAMPS_PER_ROUND = 20;

type Problem = TransparencyVerification['problems'][number];

/** The record as a leaf commits to it (packages/transparency-verifier AccessRecord). */
export function toAccessRecord(row: SubjectAccessRecord): AccessRecord {
  return {
    v: 1,
    id: row.id,
    occurredAt: row.occurredAt.toISOString(),
    subjectRef: row.subjectRef,
    subjectSource: row.subjectSource,
    providerEntityId: row.providerEntityId,
    apiId: row.apiId,
    apiVersionId: row.apiVersionId,
    operationId: row.operationId,
    exposedFields: row.exposedFields,
    consumerEntityId: row.consumerEntityId,
    applicationId: row.applicationId,
    subscriptionId: row.subscriptionId,
    purposeCode: row.purposeCode,
    endUserHash: row.endUserHash,
    status: row.status,
    gatewayNode: row.gatewayNode,
    gatewayRequestId: row.gatewayRequestId,
  };
}

const batchMax = () => {
  const n = Number(process.env.DEN_TRANSPARENCY_BATCH_MAX ?? 1000);
  return Number.isInteger(n) && n >= 1 && n <= 100_000 ? n : 1000;
};
const intervalMs = () => {
  const s = Number(process.env.DEN_TRANSPARENCY_SEAL_INTERVAL_SECONDS ?? 10);
  return (Number.isFinite(s) && s >= 1 ? s : 10) * 1000;
};
const logId = () => process.env.DEN_TRANSPARENCY_LOG_ID ?? 'den-transparency';

/**
 * Verifiable evidence of the transparency register (ADR-0016, MT-04).
 *
 * Every few seconds the records not sealed yet are grouped into a batch: a Merkle tree (RFC 9162)
 * over their canonical JSON, a checkpoint {seq, size, root, previous checkpoint's hash} signed by
 * the operator (JWS, EdDSA), and an entry in the audit chain, all in one transaction. Then an
 * independent TSA stamps the signed checkpoint (RFC 3161); while it does not answer, the batch
 * stays pending and the next round retries. Anyone can check a receipt with the open verifier.
 */
@Injectable()
export class TransparencyEvidenceService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(TransparencyEvidenceService.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly key: TransparencySigningKey,
    private readonly tsa: TsaClient,
  ) {}

  onApplicationBootstrap(): void {
    if (!QueueService.enabled()) return;
    if (!this.key.configured()) {
      this.logger.error('DEN_TRANSPARENCY_SIGNING_JWK is not set: the register is not sealed');
      return;
    }
    this.timer = setInterval(() => void this.round(), intervalMs());
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** One sealing round: seal what is pending, then ask the TSA for missing stamps. */
  async round(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.sealPending();
      await this.stampPending();
    } catch (error) {
      this.logger.error(`Transparency sealing round failed: ${String(error)}`);
    } finally {
      this.running = false;
    }
  }

  /** Seals full batches while there are records waiting. Returns the new checkpoints. */
  async sealPending(): Promise<number[]> {
    const sealed: number[] = [];
    for (let i = 0; i < MAX_BATCHES_PER_ROUND; i++) {
      const result = await this.sealOnce();
      if (!result) break;
      sealed.push(result.seq);
      if (result.size < batchMax()) break;
    }
    return sealed;
  }

  /** Seals one batch of up to DEN_TRANSPARENCY_BATCH_MAX records; null if none is waiting. */
  async sealOnce(): Promise<{ seq: number; size: number } | null> {
    const signingKey = await this.key.signingKey();
    const kid = this.key.kid();
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${SEAL_LOCK})`;
        // The queue a trigger fills on every insert (M-15), read by its index: the round costs
        // what is waiting, not the size of the register.
        const pending = await tx.transparencyPending.findMany({
          orderBy: [{ receivedAt: 'asc' }, { recordId: 'asc' }],
          take: batchMax(),
          select: { recordId: true },
        });
        if (pending.length === 0) return null;
        const rows = await tx.subjectAccessRecord.findMany({
          where: { id: { in: pending.map((p) => p.recordId) } },
        });
        const byId = new Map(rows.map((r) => [r.id, r]));
        const records = pending.map((p) => byId.get(p.recordId)).filter((r) => r !== undefined);
        const entries = records.map((r) => leafEntryOf(toAccessRecord(r)));
        const leaves = entries.map(entryLeafHash);

        const last = await tx.transparencyCheckpoint.findFirst({
          orderBy: { seq: 'desc' },
          select: { seq: true, hash: true },
        });
        const payload: CheckpointPayload = {
          v: 2,
          log: logId(),
          seq: (last?.seq ?? 0) + 1,
          treeSize: records.length,
          root: toHex(treeRoot(leaves)),
          prev: last?.hash ?? null,
          sealedAt: new Date().toISOString(),
        };
        const hash = checkpointHash(payload);
        const jws = await signCheckpoint(payload, signingKey, kid);

        await tx.transparencyCheckpoint.create({
          data: {
            seq: payload.seq,
            treeSize: payload.treeSize,
            root: payload.root,
            prev: payload.prev,
            hash,
            sealedAt: new Date(payload.sealedAt),
            kid,
            jws,
          },
        });
        await tx.transparencyLeaf.createMany({
          data: records.map((r, leafIndex) => ({
            recordId: r.id,
            checkpointSeq: payload.seq,
            leafIndex,
            leafHash: toHex(leaves[leafIndex] as Uint8Array),
            occurredAt: r.occurredAt,
            recordDigest: entries[leafIndex]?.digest ?? null,
          })),
        });
        // Out of the queue once they have a leaf: the table's trigger refuses it any earlier.
        await tx.transparencyPending.deleteMany({
          where: { recordId: { in: records.map((r) => r.id) } },
        });
        // Anchored in the audit chain too: altering a checkpoint takes breaking both chains.
        await this.audit.record(tx, {
          actor: { type: 'system', id: 'transparency-sealer' },
          action: 'transparency.checkpoint',
          target: { type: 'transparency_checkpoint', id: String(payload.seq) },
          after: { seq: payload.seq, treeSize: payload.treeSize, root: payload.root, hash, kid },
        });
        return { seq: payload.seq, size: records.length };
      },
      { timeout: 60_000 },
    );
  }

  /** Asks the TSA to stamp the checkpoints that have no stamp yet, oldest first. */
  async stampPending(): Promise<number[]> {
    const pending = await this.prisma.transparencyCheckpoint.findMany({
      where: { timestamp: null },
      orderBy: { seq: 'asc' },
      take: STAMPS_PER_ROUND,
      select: { seq: true, jws: true },
    });
    const stamped: number[] = [];
    for (const checkpoint of pending) {
      try {
        const stamp = await this.tsa.stamp(new TextEncoder().encode(checkpoint.jws));
        await this.prisma.transparencyTimestamp.create({
          data: {
            checkpointSeq: checkpoint.seq,
            token: Buffer.from(stamp.token),
            genTime: stamp.genTime,
            serialNumber: stamp.serialNumber,
          },
        });
        stamped.push(checkpoint.seq);
      } catch (error) {
        // The batch stays pending; the next round retries. The record is never lost.
        this.logger.warn(`Checkpoint ${checkpoint.seq} not stamped yet: ${String(error)}`);
        break;
      }
    }
    return stamped;
  }

  jwks() {
    return this.key.jwks();
  }

  async listCheckpoints(query: TransparencyCheckpointsQuery) {
    const rows = await this.prisma.transparencyCheckpoint.findMany({
      where: query.cursor ? { seq: { gt: Number(query.cursor) } } : {},
      orderBy: { seq: 'asc' },
      take: query.limit + 1,
      include: { timestamp: true },
    });
    const page = rows.slice(0, query.limit);
    return {
      items: page.map(toPublicCheckpoint),
      nextCursor: rows.length > query.limit ? String(page.at(-1)?.seq) : null,
    };
  }

  async checkpoint(seq: number): Promise<TransparencyCheckpoint> {
    const row = await this.prisma.transparencyCheckpoint.findUnique({
      where: { seq },
      include: { timestamp: true },
    });
    if (!row) throw new NotFoundError('Checkpoint');
    return toPublicCheckpoint(row);
  }

  /** Receipt of one call: record, audit path, signed checkpoint and time-stamp. */
  async receipt(recordId: string): Promise<TransparencyReceipt> {
    const record = await this.prisma.subjectAccessRecord.findUnique({ where: { id: recordId } });
    if (!record) throw new NotFoundError('Record');
    const leaf = await this.prisma.transparencyLeaf.findUnique({
      where: { recordId },
      include: { checkpoint: { include: { timestamp: true } } },
    });
    if (!leaf) throw new ConflictError('The record is not sealed yet; try again in a few seconds');
    const leaves = await this.prisma.transparencyLeaf.findMany({
      where: { checkpointSeq: leaf.checkpointSeq },
      orderBy: { leafIndex: 'asc' },
      select: { leafHash: true },
    });
    return {
      v: 1,
      record: toAccessRecord(record),
      leafIndex: leaf.leafIndex,
      proof: inclusionProof(
        leaves.map((l) => fromHex(l.leafHash)),
        leaf.leafIndex,
      ).map(toHex),
      checkpoint: leaf.checkpoint.jws,
      timestamp: leaf.checkpoint.timestamp
        ? Buffer.from(leaf.checkpoint.timestamp.token).toString('base64')
        : null,
    };
  }

  /**
   * Re-checks the whole register: the checkpoint chain and signatures, every batch's root from its
   * leaves, every stamp, and every record against its leaf. Detects altered, deleted and inserted
   * records and batches. Records past retention may be gone: their leaves keep the batch whole.
   */
  async verify(options: { fromSeq?: number } = {}): Promise<TransparencyVerification> {
    // From a checkpoint on: a monitor that already checked the earlier ones only checks what is
    // new, chained to the last checkpoint it trusts. Without it, the whole register.
    const fromSeq = Math.max(1, options.fromSeq ?? 1);
    const problems: Problem[] = [];
    const jwks = this.key.jwks();
    let tsaRoots: string[] | null = null;
    try {
      tsaRoots = await this.tsa.certificates();
    } catch (error) {
      this.logger.warn(`TSA certificates unavailable, stamps not checked: ${String(error)}`);
    }

    const checkpoints = await this.prisma.transparencyCheckpoint.findMany({
      where: { seq: { gte: fromSeq } },
      orderBy: { seq: 'asc' },
      include: { timestamp: true, leaves: { orderBy: { leafIndex: 'asc' } } },
    });
    let pendingTimestamps = 0;
    let previousHash: string | null =
      fromSeq > 1
        ? ((
            await this.prisma.transparencyCheckpoint.findUnique({
              where: { seq: fromSeq - 1 },
              select: { hash: true },
            })
          )?.hash ?? 'missing')
        : null;
    /** Leaf format of each batch, from its signed checkpoint. */
    const versions = new Map<number, 1 | 2>();
    for (const [i, cp] of checkpoints.entries()) {
      if (cp.seq !== fromSeq + i || cp.prev !== previousHash) {
        problems.push({ kind: 'chain_broken', seq: cp.seq, recordId: null });
      }
      let payload: CheckpointPayload | undefined;
      try {
        payload = await verifyCheckpoint(cp.jws, jwks);
      } catch {
        problems.push({ kind: 'signature_invalid', seq: cp.seq, recordId: null });
      }
      versions.set(cp.seq, payload?.v ?? (cp.leaves.some((l) => l.recordDigest !== null) ? 2 : 1));
      if (
        payload &&
        (payload.seq !== cp.seq ||
          payload.treeSize !== cp.treeSize ||
          payload.root !== cp.root ||
          payload.prev !== cp.prev ||
          checkpointHash(payload) !== cp.hash)
      ) {
        problems.push({ kind: 'signature_invalid', seq: cp.seq, recordId: null });
      }
      const indexes = cp.leaves.map((l) => l.leafIndex);
      const root = (() => {
        try {
          return toHex(treeRoot(cp.leaves.map((l) => fromHex(l.leafHash))));
        } catch {
          return null;
        }
      })();
      if (
        cp.leaves.length !== cp.treeSize ||
        indexes.some((index, position) => index !== position) ||
        root !== cp.root
      ) {
        problems.push({ kind: 'root_mismatch', seq: cp.seq, recordId: null });
      }
      if (!cp.timestamp) {
        pendingTimestamps++;
      } else if (tsaRoots) {
        try {
          await verifyTimestampToken(
            new Uint8Array(cp.timestamp.token),
            new TextEncoder().encode(cp.jws),
            tsaRoots,
          );
        } catch {
          problems.push({ kind: 'timestamp_invalid', seq: cp.seq, recordId: null });
        }
      }
      previousHash = cp.hash;
    }

    // Every sealed record against its leaf; leaves without a record are purged or deleted.
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - getCountryConfig().retention.subjectAccessMonths);
    const leaves = checkpoints.flatMap((cp) => cp.leaves);
    const records = new Map<string, SubjectAccessRecord>();
    for (let i = 0; i < leaves.length; i += 1000) {
      const ids = leaves.slice(i, i + 1000).map((l) => l.recordId);
      for (const r of await this.prisma.subjectAccessRecord.findMany({
        where: { id: { in: ids } },
      })) {
        records.set(r.id, r);
      }
    }
    let purged = 0;
    for (const leaf of leaves) {
      const version = versions.get(leaf.checkpointSeq) ?? 2;
      const problem = (kind: Problem['kind']) =>
        problems.push({ kind, seq: leaf.checkpointSeq, recordId: leaf.recordId });
      if (version === 2) {
        // The id, the time and the digest kept in the leaf row must be what the root commits to:
        // otherwise someone moved the time of a deleted record to make it look purged.
        const entry = {
          v: 1 as const,
          id: leaf.recordId,
          occurredAt: leaf.occurredAt.toISOString(),
          digest: leaf.recordDigest ?? '',
        };
        if (toHex(entryLeafHash(entry)) !== leaf.leafHash) {
          problem('leaf_altered');
          continue;
        }
      }
      const record = records.get(leaf.recordId);
      if (!record) {
        if (leaf.occurredAt < cutoff) purged++;
        else problem('record_deleted');
      } else if (
        version === 2
          ? recordDigest(toAccessRecord(record)) !== leaf.recordDigest
          : toHex(recordLeafHash(toAccessRecord(record), 1)) !== leaf.leafHash
      ) {
        problem('record_altered');
      }
    }

    // Each checkpoint is anchored in the audit chain when it is sealed: an anchor without its
    // checkpoint means batches were removed (also from the end, which the chain alone misses).
    const anchors = await this.prisma.auditEvent.findMany({
      where: { action: 'transparency.checkpoint' },
      select: { targetId: true, after: true },
    });
    const anchored = new Set<number>();
    const bySeq = new Map(checkpoints.map((cp) => [cp.seq, cp]));
    for (const anchor of anchors) {
      const seq = Number(anchor.targetId);
      if (seq < fromSeq) continue;
      const after = (anchor.after ?? {}) as { hash?: unknown; root?: unknown };
      anchored.add(seq);
      const cp = bySeq.get(seq);
      if (!cp) problems.push({ kind: 'checkpoint_missing', seq, recordId: null });
      else if (cp.hash !== after.hash || cp.root !== after.root) {
        problems.push({ kind: 'chain_broken', seq, recordId: null });
      }
    }
    for (const cp of checkpoints) {
      if (!anchored.has(cp.seq)) {
        problems.push({ kind: 'anchor_missing', seq: cp.seq, recordId: null });
      }
    }

    const [{ unsealed } = { unsealed: 0n }] = await this.prisma.$queryRaw<
      Array<{ unsealed: bigint }>
    >`SELECT count(*) AS unsealed FROM subject_access_record r
      WHERE NOT EXISTS (SELECT 1 FROM transparency_leaf l WHERE l.record_id = r.id)`;

    return {
      valid: problems.length === 0 && tsaRoots !== null,
      checkpoints: checkpoints.length,
      records: records.size,
      purged,
      unsealed: Number(unsealed),
      pendingTimestamps,
      timestampsChecked: tsaRoots !== null,
      problems,
    };
  }
}

function toPublicCheckpoint(row: {
  seq: number;
  treeSize: number;
  root: string;
  prev: string | null;
  hash: string;
  sealedAt: Date;
  kid: string;
  jws: string;
  timestamp: { token: Uint8Array; genTime: Date; serialNumber: string } | null;
}): TransparencyCheckpoint {
  return {
    seq: row.seq,
    treeSize: row.treeSize,
    root: row.root,
    prev: row.prev,
    hash: row.hash,
    sealedAt: row.sealedAt.toISOString(),
    kid: row.kid,
    jws: row.jws,
    timestamp: row.timestamp
      ? {
          token: Buffer.from(row.timestamp.token).toString('base64'),
          genTime: row.timestamp.genTime.toISOString(),
          serialNumber: row.timestamp.serialNumber,
        }
      : null,
  };
}
