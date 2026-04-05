import { err, ok, type Result } from 'neverthrow';

import {
  buildPublicDebateEntityUpdateDeliveryKey,
  buildPublicDebateEntityUpdateScopeKey,
  type DeliveryRepository,
  type DeliveryRecord,
  type ExtendedNotificationsRepository,
} from '@/modules/notification-delivery/index.js';

import { createDatabaseError, type InstitutionCorrespondenceError } from '../errors.js';
import { PUBLIC_DEBATE_REQUEST_TYPE } from '../types.js';
import { deriveCurrentPlatformSendSnapshot } from './derive-current-platform-send-snapshot.js';

import type {
  InstitutionCorrespondenceRepository,
  PublicDebateEntityUpdatePublisher,
} from '../ports.js';

export interface RecoverMissingPublicDebateSnapshotsDeps {
  repo: Pick<InstitutionCorrespondenceRepository, 'findLatestPlatformSendThreadByEntity'>;
  notificationsRepo: Pick<ExtendedNotificationsRepository, 'findActiveByType'>;
  deliveryRepo: Pick<DeliveryRepository, 'findByDeliveryKey'>;
  updatePublisher: PublicDebateEntityUpdatePublisher;
}

export interface RecoverMissingPublicDebateSnapshotsResult {
  entityCount: number;
  derivedCount: number;
  publishedCount: number;
  alreadyMaterializedCount: number;
  skippedCount: number;
  publishedEntityCuis: string[];
  alreadyMaterializedEntityCuis: string[];
  skippedEntityCuis: string[];
  errors: Record<string, string>;
}

const needsSnapshotRepublish = (
  delivery: Pick<
    DeliveryRecord,
    'status' | 'renderedSubject' | 'renderedHtml' | 'renderedText'
  > | null
): boolean => {
  if (delivery === null) {
    return true;
  }

  return (
    (delivery.status === 'pending' || delivery.status === 'failed_transient') &&
    (delivery.renderedSubject === null ||
      delivery.renderedHtml === null ||
      delivery.renderedText === null)
  );
};

export const recoverMissingPublicDebateSnapshots = async (
  deps: RecoverMissingPublicDebateSnapshotsDeps
): Promise<Result<RecoverMissingPublicDebateSnapshotsResult, InstitutionCorrespondenceError>> => {
  const notificationsResult = await deps.notificationsRepo.findActiveByType(
    'funky:notification:entity_updates'
  );
  if (notificationsResult.isErr()) {
    return err(
      createDatabaseError(
        'Failed to load active public debate entity update notifications',
        notificationsResult.error
      )
    );
  }

  const notificationsByEntity = new Map<string, (typeof notificationsResult.value)[number][]>();

  for (const notification of notificationsResult.value) {
    const entityCui = notification.entityCui?.trim();
    if (entityCui === undefined || entityCui === '') {
      continue;
    }

    const entityNotifications = notificationsByEntity.get(entityCui);
    if (entityNotifications === undefined) {
      notificationsByEntity.set(entityCui, [notification]);
      continue;
    }

    entityNotifications.push(notification);
  }

  const errors: Record<string, string> = {};
  const publishedEntityCuis: string[] = [];
  const alreadyMaterializedEntityCuis: string[] = [];
  const skippedEntityCuis: string[] = [];
  let derivedCount = 0;

  for (const [entityCui, entityNotifications] of notificationsByEntity) {
    const threadResult = await deps.repo.findLatestPlatformSendThreadByEntity({
      entityCui,
      campaign: PUBLIC_DEBATE_REQUEST_TYPE,
    });
    if (threadResult.isErr()) {
      errors[entityCui] = threadResult.error.message;
      continue;
    }

    const derivedSnapshot = deriveCurrentPlatformSendSnapshot(threadResult.value);
    if (derivedSnapshot.status !== 'derived') {
      skippedEntityCuis.push(entityCui);
      continue;
    }

    derivedCount++;
    const notification = derivedSnapshot.notification;
    if (notification === undefined) {
      errors[entityCui] = 'Derived platform-send snapshot is missing notification payload';
      continue;
    }

    const scopeKey = buildPublicDebateEntityUpdateScopeKey({
      eventType: notification.eventType,
      threadId: notification.thread.id,
      ...(notification.reply !== undefined ? { replyEntryId: notification.reply.id } : {}),
      ...(notification.basedOnEntryId !== undefined
        ? { basedOnEntryId: notification.basedOnEntryId }
        : {}),
    });

    let hasMissingOutbox = false;
    let entityHasError = false;

    for (const notification of entityNotifications) {
      const deliveryResult = await deps.deliveryRepo.findByDeliveryKey(
        buildPublicDebateEntityUpdateDeliveryKey({
          userId: notification.userId,
          notificationId: notification.id,
          scopeKey,
        })
      );
      if (deliveryResult.isErr()) {
        errors[entityCui] = createDatabaseError(
          'Failed to load existing public debate snapshot delivery',
          deliveryResult.error
        ).message;
        entityHasError = true;
        break;
      }

      if (needsSnapshotRepublish(deliveryResult.value)) {
        hasMissingOutbox = true;
      }
    }

    if (entityHasError) {
      continue;
    }

    if (!hasMissingOutbox) {
      alreadyMaterializedEntityCuis.push(entityCui);
      continue;
    }

    const publishResult = await deps.updatePublisher.publish(notification);
    if (publishResult.isErr()) {
      errors[entityCui] = publishResult.error.message;
      continue;
    }

    publishedEntityCuis.push(entityCui);
  }

  return ok({
    entityCount: notificationsByEntity.size,
    derivedCount,
    publishedCount: publishedEntityCuis.length,
    alreadyMaterializedCount: alreadyMaterializedEntityCuis.length,
    skippedCount: skippedEntityCuis.length,
    publishedEntityCuis,
    alreadyMaterializedEntityCuis,
    skippedEntityCuis,
    errors,
  });
};
