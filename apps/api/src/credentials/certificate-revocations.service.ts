import { createHash, X509Certificate } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  type CertificateRevocationFilter,
  type CertificateRevocationPreview,
  certificateRevocationFilterSchema,
  type ExecuteCertificateRevocationInput,
  executeCertificateRevocationSchema,
} from '@den/contracts';
import { AuditService } from '../audit/audit.service.js';
import type { Principal } from '../auth/principal.service.js';
import { ConflictError } from '../common/errors.js';
import { uuidv7 } from '../common/uuidv7.js';
import { assertTransition } from '../domain/credential/state-machine.js';
import type { Prisma } from '../generated/prisma/client.js';
import { OutboxService } from '../outbox/outbox.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { POLICY_SYNC_TOPIC } from '../subscriptions/subscriptions.service.js';

const PEM_CERT = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;
const LIVE = ['active', 'rotating'] as const;

interface Candidate {
  id: string;
  status: (typeof LIVE)[number];
  fingerprint: string | null;
  applicationId: string;
  entityId: string;
  entityShortName: string;
  issuer: { fingerprint: string; subject: string; notAfter: string | null } | null;
}

/** The first issuer of a stored chain (leaf, then its issuers): its SHA-256 and subject. */
function issuerOf(chainPem: string | null): Candidate['issuer'] {
  const pem = (chainPem?.match(PEM_CERT) ?? [])[1];
  if (!pem) return null;
  const der = Buffer.from(pem.replace(/-----[^-]+-----|\s/g, ''), 'base64');
  const fingerprint = createHash('sha256').update(der).digest('hex');
  try {
    const cert = new X509Certificate(der);
    return { fingerprint, subject: cert.subject, notAfter: cert.validToDate.toISOString() };
  } catch {
    return { fingerprint, subject: '', notAfter: null };
  }
}

/**
 * The operator's mass revocation of client certificates (M6-07, docs/RUNBOOK.md §4): every live
 * certificate matching the filters, at once, for an incident (a compromised entity, a flawed
 * batch, the CA's intermediate). Each certificate is revoked as the application itself would
 * (`credential.revoked`, with the revocation's id), the whole set is audited once more
 * (`certificate_revocation.executed`), the applications' developers are told, and one OPA sync
 * takes them all off the gateway's lists with the next bundle.
 *
 * The operator previews first and sends the count it saw: if the set changed meanwhile (a new
 * certificate, one revoked by its owner) nothing is revoked and it previews again.
 */
@Injectable()
export class CertificateRevocationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  /** Live client certificates matching every filter but the issuer, with what they belong to. */
  private async candidates(
    db: Prisma.TransactionClient,
    filter: CertificateRevocationFilter,
  ): Promise<Candidate[]> {
    const issued: Prisma.DateTimeFilter = {};
    if (filter.issuedFrom) issued.gte = new Date(filter.issuedFrom);
    if (filter.issuedTo) issued.lt = new Date(filter.issuedTo);
    const rows = await db.credential.findMany({
      where: {
        kind: 'mtls_certificate',
        status: { in: [...LIVE] },
        // When the portal issued it: step-ca backdates notBefore.
        ...(filter.issuedFrom || filter.issuedTo ? { createdAt: issued } : {}),
        ...(filter.entityId ? { application: { entityId: filter.entityId } } : {}),
      },
      select: {
        id: true,
        status: true,
        fingerprint: true,
        applicationId: true,
        certificatePem: true,
        application: { select: { entityId: true, entity: { select: { shortName: true } } } },
      },
      orderBy: { id: 'asc' },
    });
    return rows.map((r) => ({
      id: r.id,
      status: r.status as Candidate['status'],
      fingerprint: r.fingerprint,
      applicationId: r.applicationId,
      entityId: r.application.entityId,
      entityShortName: r.application.entity.shortName,
      issuer: issuerOf(r.certificatePem),
    }));
  }

  private static matching(all: Candidate[], filter: CertificateRevocationFilter) {
    return filter.issuer ? all.filter((c) => c.issuer?.fingerprint === filter.issuer) : all;
  }

  async preview(input: CertificateRevocationFilter): Promise<CertificateRevocationPreview> {
    const filter = certificateRevocationFilterSchema.parse(input);
    const all = await this.candidates(this.prisma, filter);
    const selected = CertificateRevocationsService.matching(all, filter);

    const entities = new Map<
      string,
      { id: string; shortName: string; apps: Set<string>; certificates: number }
    >();
    for (const c of selected) {
      const e = entities.get(c.entityId) ?? {
        id: c.entityId,
        shortName: c.entityShortName,
        apps: new Set<string>(),
        certificates: 0,
      };
      e.apps.add(c.applicationId);
      e.certificates += 1;
      entities.set(c.entityId, e);
    }
    const issuers = new Map<string, CertificateRevocationPreview['issuers'][number]>();
    for (const c of all) {
      if (!c.issuer) continue;
      const i = issuers.get(c.issuer.fingerprint) ?? { ...c.issuer, certificates: 0 };
      i.certificates += 1;
      issuers.set(c.issuer.fingerprint, i);
    }
    return {
      count: selected.length,
      entities: [...entities.values()]
        .map((e) => ({
          id: e.id,
          shortName: e.shortName,
          applications: e.apps.size,
          certificates: e.certificates,
        }))
        .sort((a, b) => b.certificates - a.certificates || a.shortName.localeCompare(b.shortName)),
      issuers: [...issuers.values()].sort((a, b) => b.certificates - a.certificates),
    };
  }

  async execute(
    principal: Principal,
    input: ExecuteCertificateRevocationInput,
    requestId?: string,
  ): Promise<{ id: string; revoked: number }> {
    const { reason, expectedCount, ...filter } = executeCertificateRevocationSchema.parse(input);
    const id = uuidv7();
    const actor = { type: 'user' as const, id: principal.keycloakSub };

    const revoked = await this.prisma.$transaction(
      async (tx) => {
        const selected = CertificateRevocationsService.matching(
          await this.candidates(tx, filter),
          filter,
        );
        if (selected.length !== expectedCount) {
          throw new ConflictError(
            `The certificates changed since the preview (${selected.length} now, ` +
              `${expectedCount} expected): preview again`,
          );
        }
        for (const c of selected) assertTransition(c.status, 'revoked');
        // Only rows still live: a concurrent revocation by the owner makes the counts differ.
        const changed = await tx.credential.updateMany({
          where: { id: { in: selected.map((c) => c.id) }, status: { in: [...LIVE] } },
          data: { status: 'revoked', rotationEndsAt: null },
        });
        if (changed.count !== selected.length) {
          throw new ConflictError('The certificates changed meanwhile: preview again');
        }
        for (const c of selected) {
          await this.audit.record(tx, {
            actor,
            action: 'credential.revoked',
            target: { type: 'credential', id: c.id },
            before: { status: c.status },
            after: {
              status: 'revoked',
              kind: 'mtls_certificate',
              ...(c.fingerprint ? { fingerprint: c.fingerprint } : {}),
              reason,
              revocationId: id,
            },
            requestId,
          });
        }
        await this.audit.record(tx, {
          actor,
          action: 'certificate_revocation.executed',
          target: { type: 'certificate_revocation', id },
          after: {
            filter,
            reason,
            revoked: selected.length,
            entities: [...new Set(selected.map((c) => c.entityId))].length,
          },
          requestId,
        });
        // One rebuild of the OPA data for all of them (the bundle drops revoked fingerprints).
        await this.outbox.enqueue(tx, {
          topic: POLICY_SYNC_TOPIC,
          aggregate: `certificate_revocation:${id}`,
          payload: { reason: 'certificates_revoked' },
        });
        return selected.length;
      },
      // Thousands of rows and their audit events: more than Prisma's 5-second default.
      { timeout: 120_000 },
    );
    return { id, revoked };
  }
}
