import { Body, Controller, Get, HttpCode, Post, Query, Req } from '@nestjs/common';
import {
  retrySyncResultSchema,
  retrySyncSchema,
  syncPageSchema,
  type SyncQuery,
  syncQuerySchema,
} from '@rid/contracts';
import { type AuthenticatedRequest, CurrentPrincipal, PlatformAccess } from '../auth/decorators.js';
import type { Principal } from '../auth/principal.service.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { ApiOperation } from '../openapi/api-operation.decorator.js';
import { SyncConsoleService } from './sync-console.service.js';

/** The operator's sync console (SPEC.md §6, M5-07). */
@Controller('admin/sync')
export class SyncConsoleController {
  constructor(private readonly sync: SyncConsoleService) {}

  @Get()
  @PlatformAccess('sync.read')
  @ApiOperation({
    operationId: 'listSyncTargets',
    summary: 'What the reconcilers keep in APISIX, Keycloak, OPA, the hub and OpenSearch',
    description:
      'sync_state by system and status, the drift found in the last day, and a page of ' +
      'targets (status=problems: not in sync, or with recent drift).',
    tags: ['sync'],
    query: syncQuerySchema,
    responses: { 200: { description: 'The console', schema: syncPageSchema } },
    errors: [400, 401, 403],
  })
  list(@Query(new ZodValidationPipe(syncQuerySchema)) query: SyncQuery) {
    return this.sync.list(query);
  }

  @Post('retry')
  @HttpCode(202)
  @PlatformAccess('sync.retry')
  @ApiOperation({
    operationId: 'retrySyncTarget',
    summary: 'Reconcile one target now',
    description:
      "Queues the reconciler's job for the target (never a direct call to the system); audited.",
    tags: ['sync'],
    body: retrySyncSchema,
    responses: { 202: { description: 'Queued', schema: retrySyncResultSchema } },
    errors: [400, 401, 403, 404],
  })
  retry(
    @Body(new ZodValidationPipe(retrySyncSchema)) body: { target: string },
    @CurrentPrincipal() principal: Principal,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.sync.retry(body.target, principal, request.id);
  }
}
