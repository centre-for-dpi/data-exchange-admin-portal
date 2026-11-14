import { Module } from '@nestjs/common';
import { ApisController } from './apis/apis.controller.js';
import { ApplicationsController } from './applications/applications.controller.js';
import { ApplicationsService } from './applications/applications.service.js';
import {
  AccessRequestsController,
  SubscriptionsController,
} from './subscriptions/subscriptions.controller.js';
import { SubscriptionsService } from './subscriptions/subscriptions.service.js';
import { AuditController, EntityAuditController } from './audit/audit.controller.js';
import { AuditQueryService } from './audit/audit-query.service.js';
import { OpaController } from './opa/opa.controller.js';
import { OpaService } from './opa/opa.service.js';
import { ApisService } from './apis/apis.service.js';
import { AuthModule } from './auth/auth.module.js';
import { CatalogController } from './catalog/catalog.controller.js';
import { CatalogService } from './catalog/catalog.service.js';
import { CoreModule } from './core.module.js';
import { DocumentsService } from './documents/documents.service.js';
import { StorageService } from './documents/storage.service.js';
import { EntitiesController } from './entities/entities.controller.js';
import { EntityMembersController } from './entities/entity-members.controller.js';
import { MembersService } from './entities/members.service.js';
import { EntityRequestsController } from './entities/entity-requests.controller.js';
import { EntityRequestsService } from './entities/entity-requests.service.js';
import { EntityReviewsController } from './entities/entity-reviews.controller.js';
import { InvitationsController } from './entities/invitations.controller.js';
import { InvitationsService } from './entities/invitations.service.js';
import { createSmtpTransport, MAIL_TRANSPORT } from './mail/mail.service.js';
import { HealthController } from './health/health.controller.js';
import { MeController } from './me/me.controller.js';
import { PurposesController } from './purposes/purposes.controller.js';
import { ReconcilersModule } from './reconcilers/reconcilers.module.js';
import { ReviewsController } from './reviews/reviews.controller.js';
import { ReviewsService } from './reviews/reviews.service.js';
import {
  CITIZEN_TOKEN_VERIFIER,
  citizenTokenOptions,
  createCitizenTokenVerifier,
} from './transparency/citizen/citizen-token-verifier.js';
import { CitizenGuard } from './transparency/citizen/citizen.guard.js';
import { DataSubjectsController } from './transparency/citizen/data-subjects.controller.js';
import { DataSubjectsService } from './transparency/citizen/data-subjects.service.js';
import { TransparencySigningKey } from './transparency/evidence/signing-key.js';
import { SubjectAlertsService } from './transparency/alerts/subject-alerts.service.js';
import { TransparencyEvidenceService } from './transparency/evidence/transparency-evidence.service.js';
import { TransparencyController } from './transparency/evidence/transparency.controller.js';
import { TsaClient } from './transparency/evidence/tsa.client.js';
import { SubjectAccessController } from './transparency/subject-access.controller.js';
import { SubjectAccessService } from './transparency/subject-access.service.js';

@Module({
  imports: [CoreModule, AuthModule, ReconcilersModule],
  controllers: [
    HealthController,
    MeController,
    InvitationsController,
    EntitiesController,
    EntityMembersController,
    EntityRequestsController,
    EntityReviewsController,
    PurposesController,
    ApisController,
    ReviewsController,
    CatalogController,
    ApplicationsController,
    SubscriptionsController,
    AccessRequestsController,
    OpaController,
    AuditController,
    EntityAuditController,
    SubjectAccessController,
    TransparencyController,
    DataSubjectsController,
  ],
  providers: [
    StorageService,
    DocumentsService,
    EntityRequestsService,
    InvitationsService,
    MembersService,
    { provide: MAIL_TRANSPORT, useFactory: createSmtpTransport },
    ApisService,
    ReviewsService,
    CatalogService,
    ApplicationsService,
    SubscriptionsService,
    OpaService,
    AuditQueryService,
    SubjectAccessService,
    TransparencyEvidenceService,
    TransparencySigningKey,
    TsaClient,
    DataSubjectsService,
    SubjectAlertsService,
    CitizenGuard,
    {
      provide: CITIZEN_TOKEN_VERIFIER,
      useFactory: () => createCitizenTokenVerifier(citizenTokenOptions()),
    },
  ],
})
export class AppModule {}
