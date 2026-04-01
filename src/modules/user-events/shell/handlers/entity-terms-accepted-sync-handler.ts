import {
  isInteractiveUpdatedEvent,
  type LearningProgressEvent,
} from '@/modules/learning-progress/index.js';
import {
  ensurePublicDebateAutoSubscriptions,
  type Hasher,
  type NotificationsRepository,
} from '@/modules/notifications/index.js';

import type { LearningProgressAppliedEventHandler } from '../../core/ports.js';
import type { Logger } from 'pino';

const ENTITY_TERMS_KEY_PREFIX = 'system:campaign:buget:accepted-terms:entity:';

export interface EntityTermsAcceptedSyncHandlerDeps {
  notificationsRepo: NotificationsRepository;
  hasher: Hasher;
  logger: Logger;
}

export const makeEntityTermsAcceptedSyncHandler = (
  deps: EntityTermsAcceptedSyncHandlerDeps
): LearningProgressAppliedEventHandler => {
  const log = deps.logger.child({ handler: 'entity-terms-accepted-sync' });

  return {
    name: 'entity-terms-accepted-sync',

    matches(event: LearningProgressEvent): boolean {
      return (
        isInteractiveUpdatedEvent(event) &&
        event.payload.record.key.startsWith(ENTITY_TERMS_KEY_PREFIX)
      );
    },

    async handle(input): Promise<void> {
      if (!isInteractiveUpdatedEvent(input.event)) {
        return;
      }

      const record = input.event.payload.record;
      if (record.value?.kind !== 'json') {
        return;
      }

      const payload = record.value.json.value as Record<string, unknown>;
      const entityCui =
        typeof payload['entityCui'] === 'string' ? payload['entityCui'].trim() : null;
      const acceptedTermsAt =
        typeof payload['acceptedTermsAt'] === 'string' ? payload['acceptedTermsAt'] : null;

      if (entityCui === null || acceptedTermsAt === null) {
        return;
      }

      const subscriptionResult = await ensurePublicDebateAutoSubscriptions(
        {
          notificationsRepo: deps.notificationsRepo,
          hasher: deps.hasher,
        },
        {
          userId: input.userId,
          entityCui,
        }
      );

      if (subscriptionResult.isErr()) {
        throw new Error(subscriptionResult.error.message);
      }

      log.info(
        {
          userId: input.userId,
          entityCui,
          eventId: input.event.eventId,
          globalPreferenceId: subscriptionResult.value.globalPreference.id,
          entityNotificationId: subscriptionResult.value.entitySubscription.id,
          globalPreferenceActive: subscriptionResult.value.globalPreference.isActive,
          entityNotificationActive: subscriptionResult.value.entitySubscription.isActive,
        },
        'Created or enabled campaign notifications after entity terms acceptance'
      );
    },
  };
};
