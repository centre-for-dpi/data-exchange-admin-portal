import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { getCountryConfig } from '@rid/config';
import type {
  TransparencyCheckpoint,
  TransparencyCheckpointsQuery,
  TransparencyReceipt,
  TransparencyVerification,
} from '@rid/contracts';
import {
  type AccessRecord,
  type CheckpointPayload,
  checkpointHash,
  fromHex,
  inclusionProof,
  recordLeafHash,
  signCheckpoint,
  toHex,
  treeRoot,
  verifyCheckpoint,
  verifyTimestampToken,
} from '@rid/transparency-verifier';
import { AuditService } from '../../audit/audit.service.js';
import { ConflictError, NotFoundError } from '../../common/errors.js';
import type { SubjectAccessRecord } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { QueueService } from '../../queue/queue.service.js';
import { TransparencySigningKey } from './signing-key.js';
import { TsaClient } from './tsa.client.js';

/** Serializes sealing across API instances. */
const SEAL_LOCK = 0x7269645f7365616cn; // "rid_seal"
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
  const n = Number(process.env.RID_TRANSPARENCY_BATCH_MAX ?? 1000);
  return Number.isInteger(n) && n >= 1 && n <= 100_000 ? n : 1000;
};
const intervalMs = () => {
  const s = Number(process.env.RID_TRANSPARENCY_SEAL_INTERVAL_SECONDS ?? 10);
  return (Number.isFinite(s) && s >= 1 ? s : 10) * 1000;
};
const logId = () => process.env.RID_TRANSPARENCY_LOG_ID ?? 'rid-transparency';

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
      this.logger.error('RID_TRANSPARENCY_SIGNING_JWK is not set: the register is not sealed');
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

  /** Seals one batch of up to RID_TRANSPARENCY_BATCH_MAX records; null if none is waiting. */
  async sealOnce(): Promise<{ seq: number; size: number } | null> {
    const signingKey = await this.key.signingKey();
    const kid = this.key.kid();
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${SEAL_LOCK})`;
        const pending = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT r.id FROM subject_access_record r
          WHERE NOT EXISTS (SELECT 1 FROM transparency_leaf l WHERE l.record_id = r.id)
          ORDER BY r.received_at, r.id
          LIMIT ${batchMax()}`;
        if (pending.length === 0) return null;
        const rows = await tx.subjectAccessRecord.findMany({
          where: { id: { in: pending.map((p) => p.id) } },
        });
        const byId = new Map(rows.map((r) => [r.id, r]));
        const records = pending.map((p) => byId.get(p.id)).filter((r) => r !== undefined);
        const leaves = records.map((r) => recordLeafHash(toAccessRecord(r)));

        const last = await tx.transparencyCheckpoint.findFirst({
          orderBy: { seq: 'desc' },
          select: { seq: true, hash: true },
        });
        const payload: CheckpointPayload = {
          v: 1,
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
          })),
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
  async verify(): Promise<TransparencyVerification> {
    const problems: Problem[] = [];
    const jwks = this.key.jwks();
    let tsaRoots: string[] | null = null;
    try {
      tsaRoots = await this.tsa.certificates();
    } catch (error) {
      this.logger.warn(`TSA certificates unavailable, stamps not checked: ${String(error)}`);
    }

    const checkpoints = await this.prisma.transparencyCheckpoint.findMany({
      orderBy: { seq: 'asc' },
      include: { timestamp: true, leaves: { orderBy: { leafIndex: 'asc' } } },
    });
    let pendingTimestamps = 0;
    let previousHash: string | null = null;
    for (const [i, cp] of checkpoints.entries()) {
      if (cp.seq !== i + 1 || cp.prev !== previousHash) {
        problems.push({ kind: 'chain_broken', seq: cp.seq, recordId: null });
      }
      let payload: CheckpointPayload | undefined;
      try {
        payload = await verifyCheckpoint(cp.jws, jwks);
      } catch {
        problems.push({ kind: 'signature_invalid', seq: cp.seq, recordId: null });
      }
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
      const record = records.get(leaf.recordId);
      if (!record) {
        if (leaf.occurredAt < cutoff) purged++;
        else {
          problems.push({
            kind: 'record_deleted',
            seq: leaf.checkpointSeq,
            recordId: leaf.recordId,
          });
        }
      } else if (toHex(recordLeafHash(toAccessRecord(record))) !== leaf.leafHash) {
        problems.push({ kind: 'record_altered', seq: leaf.checkpointSeq, recordId: leaf.recordId });
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
