import type { ClerkWebhookEventVerifiedHandler } from '../../core/ports.js';
import type { ClerkWebhookEvent } from '../../core/types.js';
import type { NotificationsRepository } from '@/modules/notifications/index.js';
import type { Logger } from 'pino';

const USER_DELETED_EVENT_TYPE = 'user.deleted';

export interface ClerkUserDeletedNotificationsHandlerDeps {
  notificationsRepo: Pick<NotificationsRepository, 'deactivateGlobalUnsubscribe'>;
  logger: Logger;
}

const getDeletedUserId = (event: ClerkWebhookEvent): string | undefined => {
  const value = event.data['id'];
  if (typeof value !== 'string') {
    return undefined;
  }

  const userId = value.trim();
  return userId.length > 0 ? userId : undefined;
};

export const makeClerkUserDeletedNotificationsHandler = (
  deps: ClerkUserDeletedNotificationsHandlerDeps
): ClerkWebhookEventVerifiedHandler => {
  const log = deps.logger.child({ handler: 'clerk-user-deleted-notifications' });

  return async ({ event, svixId }) => {
    if (event.type !== USER_DELETED_EVENT_TYPE) {
      return;
    }

    const userId = getDeletedUserId(event);
    if (userId === undefined) {
      throw new Error('Clerk user.deleted webhook is missing a usable data.id');
    }

    const deactivateResult = await deps.notificationsRepo.deactivateGlobalUnsubscribe(userId);
    if (deactivateResult.isErr()) {
      throw new Error(deactivateResult.error.message);
    }

    log.info({ svixId, userId }, 'Disabled notifications for deleted Clerk user');
  };
};
