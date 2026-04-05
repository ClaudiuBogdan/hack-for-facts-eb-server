import { err, ok, type Result } from 'neverthrow';

import {
  createDatabaseError,
  createValidationError,
  type InstitutionCorrespondenceError,
} from '../errors.js';
import { deriveCurrentPlatformSendSnapshot } from './derive-current-platform-send-snapshot.js';

import type {
  InstitutionCorrespondenceRepository,
  PublicDebateEntityUpdatePublishResult,
  PublicDebateEntityUpdatePublisher,
} from '../ports.js';
import type { ThreadRecord } from '../types.js';

export interface PublishCurrentPlatformSendUpdateDeps {
  repo: Pick<InstitutionCorrespondenceRepository, 'findLatestPlatformSendThreadByEntity'>;
  updatePublisher: PublicDebateEntityUpdatePublisher;
}

export interface PublishCurrentPlatformSendUpdateInput {
  entityCui: string;
  campaign: string;
}

export interface PublishCurrentPlatformSendUpdateResult {
  status:
    | 'no_thread'
    | 'skipped_phase'
    | 'skipped_missing_reply'
    | 'skipped_missing_review'
    | 'published';
  eventType?: 'thread_started' | 'thread_failed' | 'reply_received' | 'reply_reviewed';
  thread?: ThreadRecord;
  publishResult?: PublicDebateEntityUpdatePublishResult;
}

export async function publishCurrentPlatformSendUpdate(
  deps: PublishCurrentPlatformSendUpdateDeps,
  input: PublishCurrentPlatformSendUpdateInput
): Promise<Result<PublishCurrentPlatformSendUpdateResult, InstitutionCorrespondenceError>> {
  const entityCui = input.entityCui.trim();
  if (entityCui === '') {
    return err(createValidationError('entityCui is required.'));
  }

  const threadResult = await deps.repo.findLatestPlatformSendThreadByEntity({
    entityCui,
    campaign: input.campaign,
  });
  if (threadResult.isErr()) {
    return err(threadResult.error);
  }

  const thread = threadResult.value;
  if (thread === null) {
    return ok({ status: 'no_thread' });
  }

  try {
    const derivedSnapshot = deriveCurrentPlatformSendSnapshot(thread);
    if (derivedSnapshot.status !== 'derived') {
      return ok({ status: derivedSnapshot.status });
    }

    const notification = derivedSnapshot.notification;
    if (notification === undefined) {
      return err(
        createDatabaseError('Derived platform-send snapshot is missing notification payload.')
      );
    }
    const publishResult = await deps.updatePublisher.publish(notification);

    if (publishResult.isErr()) {
      return err(publishResult.error);
    }

    return ok({
      status: 'published',
      eventType: notification.eventType,
      thread: notification.thread,
      publishResult: publishResult.value,
    });
  } catch (error) {
    return err(createDatabaseError('Failed to publish current platform-send update', error));
  }
}
