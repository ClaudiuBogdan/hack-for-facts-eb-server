/**
 * Entity Terms Accepted User Event Handler
 *
 * After the authoritative learning-progress transaction commits and the
 * synchronous handler creates campaign notification preferences, this queued
 * handler enqueues the matching campaign email:
 * - first entity acceptance -> campaign welcome email
 * - later entity acceptances -> entity subscription confirmation email
 */

import {
  enqueuePublicDebateTermsAcceptedNotifications,
  type ComposeJobScheduler,
  type DeliveryRepository,
  type ExtendedNotificationsRepository,
  getErrorMessage,
} from '@/modules/notification-delivery/index.js';

import type { UserEventHandler } from '../../core/ports.js';
import type { UserEventJobPayload } from '../../core/types.js';
import type { EntityRepository } from '@/modules/entity/index.js';
import type { LearningProgressRepository } from '@/modules/learning-progress/index.js';
import type { NotificationsRepository } from '@/modules/notifications/index.js';
import type { Logger } from 'pino';

const ENTITY_TERMS_KEY_PREFIX = 'funky:progress:terms_accepted::entity:';
const PUBLIC_DEBATE_GLOBAL_TYPE = 'funky:notification:global';
const PUBLIC_DEBATE_ENTITY_UPDATES_TYPE = 'funky:notification:entity_updates';
const PUBLIC_DEBATE_CAMPAIGN_SOURCE = 'funky:source:terms_accepted';

const loadSelectedEntityNames = async (
  deps: Pick<EntityTermsAcceptedUserEventHandlerDeps, 'notificationsRepo' | 'entityRepo'>,
  input: {
    userId: string;
    currentEntityCui: string;
    currentEntityName: string;
  },
  log: Logger
): Promise<string[] | undefined> => {
  const notificationsResult = await deps.notificationsRepo.findByUserId(input.userId, true);
  if (notificationsResult.isErr()) {
    log.warn(
      { error: notificationsResult.error, userId: input.userId },
      'Failed to load active public debate subscriptions for email enrichment'
    );
    return undefined;
  }

  const additionalEntityCuis = notificationsResult.value.flatMap((notification) => {
    if (
      notification.notificationType !== PUBLIC_DEBATE_ENTITY_UPDATES_TYPE ||
      typeof notification.entityCui !== 'string' ||
      notification.entityCui === input.currentEntityCui
    ) {
      return [];
    }

    return [notification.entityCui];
  });

  const entityNames: string[] = [input.currentEntityName];
  const seenEntityCuis = new Set<string>([input.currentEntityCui]);

  for (const entityCui of additionalEntityCuis) {
    if (seenEntityCuis.has(entityCui)) {
      continue;
    }

    seenEntityCuis.add(entityCui);

    const entityResult = await deps.entityRepo.getById(entityCui);
    if (entityResult.isErr()) {
      log.warn(
        { error: entityResult.error, entityCui, userId: input.userId },
        'Failed to load entity name for public debate subscription email enrichment'
      );
      entityNames.push(entityCui);
      continue;
    }

    const entityName = entityResult.value?.name.trim();
    entityNames.push(entityName !== undefined && entityName !== '' ? entityName : entityCui);
  }

  return entityNames;
};

export interface EntityTermsAcceptedUserEventHandlerDeps {
  learningProgressRepo: LearningProgressRepository;
  notificationsRepo: NotificationsRepository;
  extendedNotificationsRepo: Pick<ExtendedNotificationsRepository, 'isUserGloballyUnsubscribed'>;
  deliveryRepo: DeliveryRepository;
  composeJobScheduler: ComposeJobScheduler;
  entityRepo: EntityRepository;
  logger: Logger;
}

export const makeEntityTermsAcceptedUserEventHandler = (
  deps: EntityTermsAcceptedUserEventHandlerDeps
): UserEventHandler => {
  const log = deps.logger.child({ handler: 'entity-terms-accepted' });

  return {
    name: 'entity-terms-accepted',

    matches(event: UserEventJobPayload): boolean {
      return (
        event.eventType === 'interactive.updated' &&
        event.recordKey.startsWith(ENTITY_TERMS_KEY_PREFIX)
      );
    },

    async handle(event: UserEventJobPayload): Promise<void> {
      if (event.eventType !== 'interactive.updated') {
        return;
      }

      const recordResult = await deps.learningProgressRepo.getRecord(event.userId, event.recordKey);

      if (recordResult.isErr()) {
        log.error(
          { error: recordResult.error, eventId: event.eventId, recordKey: event.recordKey },
          'Failed to load learning progress record for entity terms acceptance'
        );
        throw new Error(recordResult.error.message);
      }

      if (recordResult.value === null) {
        log.debug(
          { eventId: event.eventId, recordKey: event.recordKey, userId: event.userId },
          'Skipping entity terms accepted event because record is missing'
        );
        return;
      }

      const record = recordResult.value.record;
      if (record.value?.kind !== 'json') {
        log.debug(
          { eventId: event.eventId, recordKey: event.recordKey },
          'Skipping entity terms accepted event because record value is not JSON'
        );
        return;
      }

      const payload = record.value.json.value;
      const entityCui =
        typeof payload['entityCui'] === 'string' ? payload['entityCui'].trim() : null;
      const acceptedTermsAt =
        typeof payload['acceptedTermsAt'] === 'string' ? payload['acceptedTermsAt'] : null;

      if (entityCui === null || acceptedTermsAt === null) {
        log.debug(
          { eventId: event.eventId, recordKey: event.recordKey, entityCui, acceptedTermsAt },
          'Skipping entity terms accepted event: missing entityCui or acceptedTermsAt'
        );
        return;
      }

      const globalPreferenceResult = await deps.notificationsRepo.findByUserTypeAndEntity(
        event.userId,
        PUBLIC_DEBATE_GLOBAL_TYPE,
        null
      );
      if (globalPreferenceResult.isErr()) {
        log.error(
          { error: globalPreferenceResult.error, userId: event.userId, eventId: event.eventId },
          'Failed to load public debate global preference after T&C acceptance'
        );
        throw new Error(globalPreferenceResult.error.message);
      }

      const entitySubscriptionResult = await deps.notificationsRepo.findByUserTypeAndEntity(
        event.userId,
        PUBLIC_DEBATE_ENTITY_UPDATES_TYPE,
        entityCui
      );
      if (entitySubscriptionResult.isErr()) {
        log.error(
          {
            error: entitySubscriptionResult.error,
            userId: event.userId,
            eventId: event.eventId,
            entityCui,
          },
          'Failed to load public debate entity subscription after T&C acceptance'
        );
        throw new Error(entitySubscriptionResult.error.message);
      }

      const globalPreference = globalPreferenceResult.value;
      const entitySubscription = entitySubscriptionResult.value;
      if (globalPreference === null || entitySubscription === null) {
        log.debug(
          {
            userId: event.userId,
            eventId: event.eventId,
            entityCui,
            hasGlobalPreference: globalPreference !== null,
            hasEntitySubscription: entitySubscription !== null,
          },
          'Skipping public debate terms accepted emails because campaign notifications are missing'
        );
        return;
      }

      let entityName = entityCui;
      const entityResult = await deps.entityRepo.getById(entityCui);
      if (entityResult.isErr()) {
        log.warn(
          { error: entityResult.error, entityCui, eventId: event.eventId },
          'Failed to load entity name for public debate terms accepted email'
        );
      } else if (entityResult.value?.name !== undefined && entityResult.value.name.trim() !== '') {
        entityName = entityResult.value.name;
      }

      const selectedEntities = await loadSelectedEntityNames(
        {
          notificationsRepo: deps.notificationsRepo,
          entityRepo: deps.entityRepo,
        },
        {
          userId: event.userId,
          currentEntityCui: entityCui,
          currentEntityName: entityName,
        },
        log
      );

      const enqueueResult = await enqueuePublicDebateTermsAcceptedNotifications(
        {
          notificationsRepo: deps.extendedNotificationsRepo,
          deliveryRepo: deps.deliveryRepo,
          composeJobScheduler: deps.composeJobScheduler,
        },
        {
          runId: `public-debate-terms-${event.eventId}`,
          source: PUBLIC_DEBATE_CAMPAIGN_SOURCE,
          sourceEventId: event.eventId,
          userId: event.userId,
          campaignKey: 'funky',
          entityCui,
          entityName,
          acceptedTermsAt,
          ...(selectedEntities !== undefined ? { selectedEntities } : {}),
          globalPreferenceId: globalPreference.id,
          globalPreferenceActive: globalPreference.isActive,
          entitySubscriptionId: entitySubscription.id,
          entitySubscriptionActive: entitySubscription.isActive,
        }
      );

      if (enqueueResult.isErr()) {
        log.error(
          { error: enqueueResult.error, userId: event.userId, entityCui, eventId: event.eventId },
          'Failed to enqueue public debate terms accepted email'
        );
        throw new Error(getErrorMessage(enqueueResult.error));
      }

      log.info(
        {
          userId: event.userId,
          entityCui,
          entityName,
          eventId: event.eventId,
          status: enqueueResult.value.status,
          outboxId: enqueueResult.value.outbox?.id ?? null,
          created: enqueueResult.value.created,
          requeued: enqueueResult.value.requeued,
        },
        'Processed public debate terms accepted email enqueue'
      );
    },
  };
};
