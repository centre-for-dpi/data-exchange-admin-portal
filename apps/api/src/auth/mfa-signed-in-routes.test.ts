import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import { MfaRequiredError, NotFoundError } from '../common/errors.js';
import { EntityRequestsController } from '../entities/entity-requests.controller.js';
import { EntityRequestsService } from '../entities/entity-requests.service.js';
import { EntityReviewsController } from '../entities/entity-reviews.controller.js';
import { AuthGuard } from './auth.guard.js';
import type { Principal } from './principal.service.js';

/**
 * M-01 and B-23. @SignedIn routes skip the second factor (ADR-0021) because they only reach the
 * caller's own resources, so they must not serve platform reviewers: those read an onboarding file
 * through the `/review/entities/:id` routes, which demand the factor. After the decision the
 * applicant keeps reading the file only while they hold a membership in the approved entity.
 */
const person = (over: Partial<Principal>): Principal => ({
  userId: 'user',
  keycloakSub: 'sub',
  email: 'u@example.org',
  emailVerified: true,
  fullName: 'User',
  platformRoles: [],
  memberships: [],
  mfaRequired: false,
  mfa: false,
  ...over,
});

const reviewer = (mfa: boolean) =>
  person({
    userId: 'reviewer-user',
    keycloakSub: 'reviewer-sub',
    platformRoles: ['platform_reviewer'],
    mfaRequired: true,
    mfa,
  });

const contextFor = (controller: { prototype: object }, handler: string): ExecutionContext =>
  ({
    getHandler: () => (controller.prototype as Record<string, unknown>)[handler],
    getClass: () => controller,
    switchToHttp: () => ({
      getRequest: () => ({ headers: { authorization: 'Bearer token' }, params: {}, id: 'r1' }),
    }),
  }) as unknown as ExecutionContext;

const guardFor = (principal: Principal) =>
  new AuthGuard(
    new Reflector(),
    {
      verifyToken: vi.fn().mockResolvedValue({ sub: principal.keycloakSub }),
      load: vi.fn().mockResolvedValue(principal),
    } as never,
    {} as never,
  );

describe('reviewers read onboarding files only with the second factor (M-01)', () => {
  it('control: the operator queue demands the second factor', async () => {
    await expect(
      guardFor(reviewer(false)).canActivate(contextFor(EntityReviewsController, 'queue')),
    ).rejects.toBeInstanceOf(MfaRequiredError);
  });

  it.each(['get', 'download'])(
    'the review route %s demands it too, and serves the session that has it',
    async (handler) => {
      await expect(
        guardFor(reviewer(false)).canActivate(contextFor(EntityReviewsController, handler)),
      ).rejects.toBeInstanceOf(MfaRequiredError);
      await expect(
        guardFor(reviewer(true)).canActivate(contextFor(EntityReviewsController, handler)),
      ).resolves.toBe(true);
    },
  );

  const entity = (over: Record<string, unknown> = {}) => ({
    id: '0193a6c0-0000-7000-8000-00000000aaaa',
    applicantId: 'applicant-user',
    status: 'under_review',
    slug: 'victim',
    legalName: 'Victim',
    shortName: 'V',
    taxIdType: 'NIT',
    taxId: '900123456',
    kind: 'national',
    sector: 'salud',
    contactEmail: 'c@example.org',
    website: null,
    dpoName: 'Dora',
    dpoEmail: 'dpo@example.org',
    designees: [{ role: 'data_steward', fullName: 'Lucia Datos', email: 'lucia@example.org' }],
    designationDocumentId: 'doc-1',
    designationDocument: {
      id: 'doc-1',
      fileName: 'designation.pdf',
      mimeType: 'application/pdf',
      size: 4,
      sha256: 'x',
      createdAt: new Date(),
    },
    reviews: [],
    submittedAt: null,
    decidedAt: null,
    createdAt: new Date(),
    ...over,
  });

  const serviceFor = (row: ReturnType<typeof entity>) => {
    const prisma = {
      entity: { findUnique: vi.fn().mockResolvedValue(row), findMany: vi.fn() },
      user: {
        findUnique: vi
          .fn()
          .mockResolvedValue({ id: 'applicant-user', fullName: 'Ana', email: 'ana@example.org' }),
      },
    };
    const documents = {
      read: vi.fn().mockResolvedValue({ document: {}, bytes: Buffer.from('%PDF') }),
    };
    return {
      documents,
      service: new EntityRequestsService(
        prisma as never,
        {} as never,
        documents as never,
        {} as never,
      ),
    };
  };

  it("the @SignedIn routes answer 404 to a reviewer, even with the factor: another applicant's file is not theirs", async () => {
    const row = entity();
    const { service, documents } = serviceFor(row);
    await expect(service.get(row.id, reviewer(true))).rejects.toBeInstanceOf(NotFoundError);
    await expect(service.designationDocument(row.id, reviewer(true))).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(documents.read).not.toHaveBeenCalled();
  });

  it('the review routes hand the file and the document to a reviewer', async () => {
    const row = entity();
    const { service, documents } = serviceFor(row);
    const view = await service.getForReview(row.id, reviewer(true));
    expect(view.applicant?.email).toBe('ana@example.org');
    await service.designationDocumentForReview(row.id, reviewer(true));
    expect(documents.read).toHaveBeenCalledWith('doc-1');
  });

  it('the review routes refuse a session without a review role', async () => {
    const row = entity();
    const { service } = serviceFor(row);
    await expect(service.getForReview(row.id, person({}))).rejects.toBeInstanceOf(NotFoundError);
  });

  it('the applicant reads their own file, and the SignedIn routes skip the factor as before', async () => {
    const row = entity();
    const { service } = serviceFor(row);
    const view = await service.get(row.id, person({ userId: 'applicant-user' }));
    expect(view.id).toBe(row.id);
    await expect(
      guardFor(person({})).canActivate(contextFor(EntityRequestsController, 'get')),
    ).resolves.toBe(true);
  });
});

describe('after the decision the applicant needs a membership to keep reading (B-23)', () => {
  const approved = {
    id: '0193a6c0-0000-7000-8000-00000000bbbb',
    applicantId: 'applicant-user',
    status: 'active',
    designees: [],
    designationDocumentId: 'doc-1',
    designationDocument: null,
    reviews: [],
    submittedAt: null,
    decidedAt: new Date(),
    createdAt: new Date(),
    slug: 's',
    legalName: 'L',
    shortName: 'S',
    taxIdType: 'NIT',
    taxId: '1',
    kind: 'national',
    sector: 'salud',
    contactEmail: 'c@example.org',
    website: null,
    dpoName: 'D',
    dpoEmail: 'd@example.org',
  };
  const service = (row: Record<string, unknown>, rows: Array<Record<string, unknown>> = [row]) => {
    const prisma = {
      entity: {
        findUnique: vi.fn().mockResolvedValue(row),
        findMany: vi.fn().mockResolvedValue(rows),
      },
      user: { findUnique: vi.fn().mockResolvedValue(null) },
    };
    const documents = { read: vi.fn().mockResolvedValue({ document: {}, bytes: Buffer.alloc(0) }) };
    return new EntityRequestsService(prisma as never, {} as never, documents as never, {} as never);
  };
  const member = person({
    userId: 'applicant-user',
    memberships: [
      { entityId: approved.id, entitySlug: 's', entityShortName: 'S', roles: ['entity_admin'] },
    ],
  });
  const expelled = person({ userId: 'applicant-user' });

  it('reads while the applicant is a member, 404 once the membership is gone', async () => {
    const s = service(approved);
    await expect(s.get(approved.id, member)).resolves.toMatchObject({ id: approved.id });
    await expect(s.get(approved.id, expelled)).rejects.toBeInstanceOf(NotFoundError);
    await expect(s.designationDocument(approved.id, expelled)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it.each(['suspended', 'offboarded'])('the same holds for a %s entity', async (status) => {
    const s = service({ ...approved, status });
    await expect(s.get(approved.id, expelled)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('a rejected applicant keeps reading the reasons: nothing was ever granted', async () => {
    const s = service({ ...approved, status: 'rejected' });
    await expect(s.get(approved.id, expelled)).resolves.toMatchObject({ status: 'rejected' });
  });

  it('the list hides an approved request the caller no longer belongs to', async () => {
    const draft = { ...approved, id: 'draft-id', status: 'requested' };
    const s = service(approved, [approved, draft]);
    expect((await s.mine(expelled)).items.map((i) => i.id)).toEqual(['draft-id']);
    expect((await s.mine(member)).items.map((i) => i.id)).toEqual([approved.id, 'draft-id']);
  });
});
