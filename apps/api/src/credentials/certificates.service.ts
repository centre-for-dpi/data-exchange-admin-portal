import { Inject, Injectable } from '@nestjs/common';
import { getCountryConfig } from '@den/config';
import {
  CSR_ERRORS,
  type IssueCertificateInput,
  issueCertificateSchema,
  type IssuedCertificate,
} from '@den/contracts';
import { AuditService } from '../audit/audit.service.js';
import type { Principal } from '../auth/principal.service.js';
import { ConflictError, NotFoundError, ValidationError } from '../common/errors.js';
import { uuidv7 } from '../common/uuidv7.js';
import { Prisma } from '../generated/prisma/client.js';
import { OutboxService } from '../outbox/outbox.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { POLICY_SYNC_TOPIC } from '../subscriptions/subscriptions.service.js';
import { scopedRepo } from '../prisma/scoped-repo.js';
import { credentialView, leafOf, thumbprintOf } from './credential-view.js';
import { checkCsr, CsrRejected } from './csr.js';
import { CERTIFICATE_AUTHORITY, type CertificateAuthority } from './step-ca.client.js';

const DAY = 24 * 60 * 60 * 1000;

const isUniqueViolation = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';

/**
 * Client certificates of consumer applications (SPEC.md §4.3, M3-01). The developer sends a CSR
 * whose subject is CN=<clientId>; the portal checks it and has step-ca sign it through the
 * portal's JWK provisioner, for lifecycle.certificateValidityDays. The private key never leaves
 * the consumer; the portal keeps the certificate (public) and its metadata.
 */
@Injectable()
export class CertificatesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    @Inject(CERTIFICATE_AUTHORITY) private readonly ca: CertificateAuthority,
  ) {}

  private async application(entityId: string, applicationId: string) {
    const app = await scopedRepo(this.prisma.application, entityId).findFirst({
      where: { id: applicationId, status: { not: 'deleted' } },
    });
    if (!app) throw new NotFoundError('Application');
    return app;
  }

  async issue(
    entityId: string,
    principal: Principal,
    applicationId: string,
    input: IssueCertificateInput,
    requestId?: string,
  ): Promise<IssuedCertificate> {
    const { csr } = issueCertificateSchema.parse(input);
    const app = await this.application(entityId, applicationId);
    if (app.status !== 'active') {
      throw new ConflictError('Only an active application can get a certificate');
    }
    // Rotation (M3-04): a second certificate while the first one still works, one at a time.
    const current = await this.prisma.credential.findMany({
      where: { applicationId, kind: 'mtls_certificate', status: { in: ['active', 'rotating'] } },
    });
    if (current.some((c) => c.status === 'rotating')) {
      throw new ConflictError(
        'A certificate rotation is already in progress: let it end or revoke the previous one',
      );
    }
    const previous = current.find((c) => c.status === 'active');

    let checked: Awaited<ReturnType<typeof checkCsr>>;
    try {
      checked = await checkCsr(csr, app.keycloakClientId);
    } catch (error) {
      if (error instanceof CsrRejected) {
        throw new ValidationError([{ path: 'csr', message: CSR_ERRORS[error.reason] }]);
      }
      throw error;
    }

    const days = getCountryConfig().lifecycle.certificateValidityDays;
    // One check before the CA, one inside the transaction (the previous certificate must still be
    // active when it starts rotating).
    const chainPem = await this.ca.sign({
      csrPem: checked.pem,
      commonName: app.keycloakClientId,
      publicKey: checked.publicKey,
      validityHours: days * 24,
    });
    const leaf = leafOf(chainPem);
    const credentialId = uuidv7();
    const actor = { type: 'user' as const, id: principal.keycloakSub, entityId };

    const lifecycle = getCountryConfig().lifecycle;
    try {
      const credential = await this.prisma.$transaction(async (tx) => {
        if (previous) {
          const rotationEndsAt = new Date(Date.now() + lifecycle.credentialRotationDays * DAY);
          const changed = await tx.credential.updateMany({
            where: { id: previous.id, status: 'active' },
            data: { status: 'rotating', rotationEndsAt },
          });
          if (changed.count === 0) {
            throw new ConflictError('The certificates of the application changed meanwhile');
          }
          await this.audit.record(tx, {
            actor,
            action: 'credential.rotation_started',
            target: { type: 'credential', id: previous.id },
            before: { status: 'active' },
            after: { status: 'rotating', rotationEndsAt: rotationEndsAt.toISOString() },
            requestId,
          });
        }
        const created = await tx.credential.create({
          data: {
            id: credentialId,
            applicationId,
            kind: 'mtls_certificate',
            status: 'active',
            fingerprint: thumbprintOf(leaf),
            serial: leaf.serialNumber.toLowerCase(),
            certificatePem: chainPem,
            notBefore: leaf.validFromDate,
            notAfter: leaf.validToDate,
            createdBy: principal.userId,
          },
        });
        await this.audit.record(tx, {
          actor,
          action: 'credential.created',
          target: { type: 'credential', id: created.id },
          // Public facts of the certificate; the PEM itself stays out of the trail.
          after: {
            id: created.id,
            applicationId,
            kind: created.kind,
            status: created.status,
            fingerprint: created.fingerprint,
            serial: created.serial,
            subject: leaf.subject,
            notBefore: created.notBefore?.toISOString(),
            notAfter: created.notAfter?.toISOString(),
          },
          requestId,
        });
        // The thumbprint joins the application's valid certificates in the OPA bundle (M3-02).
        await this.outbox.enqueue(tx, {
          topic: POLICY_SYNC_TOPIC,
          aggregate: `credential:${created.id}`,
          payload: { reason: 'certificate_issued' },
        });
        return created;
      });
      return { credential: credentialView(credential), certificatePem: chainPem };
    } catch (error) {
      // Two requests raced (index credential_one_active_certificate): the certificate signed for
      // the second one is never handed out, and expires on its own.
      if (isUniqueViolation(error)) {
        throw new ConflictError('The application already has an active certificate');
      }
      throw error;
    }
  }

  /** The certificate and its chain (PEM) for download; public, but only for the entity. */
  async download(
    entityId: string,
    applicationId: string,
    credentialId: string,
  ): Promise<{ pem: string; fileName: string }> {
    const app = await this.application(entityId, applicationId);
    const credential = await this.prisma.credential.findFirst({
      where: { id: credentialId, applicationId, kind: 'mtls_certificate' },
    });
    if (!credential?.certificatePem) throw new NotFoundError('Certificate');
    return { pem: credential.certificatePem, fileName: `${app.keycloakClientId}.pem` };
  }
}
