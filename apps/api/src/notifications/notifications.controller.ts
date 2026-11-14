import { Body, Controller, Get, HttpCode, Param, Post, Put, Query, Req } from '@nestjs/common';
import {
  type NotificationKind,
  notificationIdParamsSchema,
  notificationListQuerySchema,
  notificationPageSchema,
  notificationPreferencesSchema,
  notificationSchema,
  updateNotificationPreferencesSchema,
} from '@rid/contracts';
import { z } from 'zod';
import { type AuthenticatedRequest, CurrentPrincipal, SignedIn } from '../auth/decorators.js';
import type { Principal } from '../auth/principal.service.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { ApiOperation } from '../openapi/api-operation.decorator.js';
import { NotificationsService } from './notifications.service.js';

/** The caller's notifications and e-mail preferences (SPEC.md §7, M2-08). */
@SignedIn()
@Controller('me')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get('notifications')
  @ApiOperation({
    operationId: 'listMyNotifications',
    summary: 'The caller’s notifications, newest first, with the unread count',
    tags: ['session'],
    query: notificationListQuerySchema,
    responses: { 200: { description: 'A page of notifications', schema: notificationPageSchema } },
    errors: [400, 401, 403],
  })
  list(
    @CurrentPrincipal() principal: Principal,
    @Query(new ZodValidationPipe(notificationListQuerySchema))
    query: { cursor?: string; limit: number; unread?: 'true' | 'false' },
  ) {
    return this.notifications.list(principal, query);
  }

  @Post('notifications/:notificationId/read')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'markNotificationRead',
    summary: 'Mark a notification as read',
    tags: ['session'],
    params: notificationIdParamsSchema,
    responses: { 200: { description: 'The notification', schema: notificationSchema } },
    errors: [401, 403, 404],
  })
  markRead(
    @CurrentPrincipal() principal: Principal,
    @Param('notificationId', new ZodValidationPipe(z.uuid())) notificationId: string,
  ) {
    return this.notifications.markRead(principal, notificationId);
  }

  @Post('notifications/read-all')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'markAllNotificationsRead',
    summary: 'Mark every notification as read',
    tags: ['session'],
    responses: {
      200: { description: 'How many changed', schema: z.object({ updated: z.number().int() }) },
    },
    errors: [401, 403],
  })
  markAllRead(@CurrentPrincipal() principal: Principal) {
    return this.notifications.markAllRead(principal);
  }

  @Get('notification-preferences')
  @ApiOperation({
    operationId: 'getMyNotificationPreferences',
    summary: 'Which notifications the caller gets by e-mail',
    tags: ['session'],
    responses: { 200: { description: 'The preferences', schema: notificationPreferencesSchema } },
    errors: [401, 403],
  })
  preferences(@CurrentPrincipal() principal: Principal) {
    return this.notifications.preferences(principal);
  }

  @Put('notification-preferences')
  @ApiOperation({
    operationId: 'updateMyNotificationPreferences',
    summary: 'Choose which notifications arrive by e-mail',
    description: 'Security notices (access suspended or revoked) are always e-mailed.',
    tags: ['session'],
    body: updateNotificationPreferencesSchema,
    responses: { 200: { description: 'The preferences', schema: notificationPreferencesSchema } },
    errors: [400, 401, 403],
  })
  updatePreferences(
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodValidationPipe(updateNotificationPreferencesSchema))
    body: { items: Array<{ kind: NotificationKind; email: boolean }> },
    @Req() request: AuthenticatedRequest,
  ) {
    return this.notifications.updatePreferences(principal, body.items, request.id);
  }
}
