import { Global, Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { AuditService } from './audit/audit.service.js';
import { CERTIFICATE_AUTHORITY, StepCaClient } from './credentials/step-ca.client.js';
import { OpenApiService } from './openapi/openapi.service.js';
import { OutboxService } from './outbox/outbox.service.js';
import { PrismaService } from './prisma/prisma.service.js';
import { QueueService } from './queue/queue.service.js';

/** Cross-cutting services every domain module uses (M0-08). */
@Global()
@Module({
  imports: [DiscoveryModule],
  providers: [
    PrismaService,
    AuditService,
    OutboxService,
    QueueService,
    OpenApiService,
    // The network CA (step-ca, ARCHITECTURE.md §4.4): application and gateway certificates.
    { provide: CERTIFICATE_AUTHORITY, useFactory: () => new StepCaClient() },
  ],
  exports: [
    PrismaService,
    AuditService,
    OutboxService,
    QueueService,
    OpenApiService,
    CERTIFICATE_AUTHORITY,
  ],
})
export class CoreModule {}
