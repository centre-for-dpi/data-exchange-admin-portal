import { Global, Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { AuditService } from './audit/audit.service.js';
import { OpenApiService } from './openapi/openapi.service.js';
import { OutboxService } from './outbox/outbox.service.js';
import { PrismaService } from './prisma/prisma.service.js';
import { QueueService } from './queue/queue.service.js';

/** Cross-cutting services every domain module uses (M0-08). */
@Global()
@Module({
  imports: [DiscoveryModule],
  providers: [PrismaService, AuditService, OutboxService, QueueService, OpenApiService],
  exports: [PrismaService, AuditService, OutboxService, QueueService, OpenApiService],
})
export class CoreModule {}
