import { UnrecoverableError } from 'bullmq';
import { err, ok, type Result } from 'neverthrow';

import {
  DEBATE_REQUEST_INTERACTION_ID,
  parseDebateRequestPayloadValue,
  type DebateRequestPayload,
} from '@/common/public-debate-request.js';
import {
  EMAIL_REGEX,
  normalizeOptionalString,
  type CorrespondenceEmailSender,
  type CorrespondenceTemplateRenderer,
  type InstitutionCorrespondenceError,
  type InstitutionCorrespondenceRepository,
  type PublicDebateEntitySubscriptionService,
  type PublicDebateEntityUpdatePublisher,
} from '@/modules/institution-correspondence/index.js';
import {
  updateInteractionReview,
  type InteractiveStateRecord,
  type LearningProgressError,
  type LearningProgressRecordRow,
  type LearningProgressRepository,
} from '@/modules/learning-progress/index.js';

import {
  executePreparedPublicDebateRequestDispatch,
  preparePublicDebateRequestDispatch,
  type PreparedPublicDebateRequestDispatch,
} from './public-debate-request-dispatch.js';

import type { UserEventHandler } from '../../core/ports.js';
import type { UserEventJobPayload } from '../../core/types.js';
import type { EntityProfileRepository, EntityRepository } from '@/modules/entity/index.js';
import type { Logger } from 'pino';
export interface PublicDebateRequestUserEventHandlerDeps {
  learningProgressRepo: LearningProgressRepository;
  entityRepo: EntityRepository;
  entityProfileRepo: EntityProfileRepository;
  repo: InstitutionCorrespondenceRepository;
  emailSender: CorrespondenceEmailSender;
  templateRenderer: CorrespondenceTemplateRenderer;
  auditCcRecipients: string[];
  platformBaseUrl: string;
  captureAddress: string;
  subscriptionService?: PublicDebateEntitySubscriptionService;
  updatePublisher?: PublicDebateEntityUpdatePublisher;
  logger: Logger;
}

type DebateDispatchTransactionResult =
  | { kind: 'skipped' }
  | {
      kind: 'dispatch_failed';
      error: InstitutionCorrespondenceError;
    }
  | {
      kind: 'approved';
      created: boolean;
      threadId: string;
    };

function isEligibleDebateRequestRecord(record: InteractiveStateRecord): boolean {
  return (
    record.interactionId === DEBATE_REQUEST_INTERACTION_ID &&
    record.scope.type === 'entity' &&
    record.phase === 'pending' &&
    record.value?.kind === 'json'
  );
}

function parseDebateRequestPayload(record: InteractiveStateRecord): DebateRequestPayload | null {
  if (record.value?.kind !== 'json') {
    return null;
  }

  return parseDebateRequestPayloadValue(record.value.json.value);
}

const getErrorMessage = (error: { message: string }): string => {
  return error.message;
};

const isRetryableCorrespondenceError = (error: InstitutionCorrespondenceError): boolean => {
  switch (error.type) {
    case 'CorrespondenceDatabaseError':
      return error.retryable;
    case 'CorrespondenceEmailSendError':
      return error.retryable;
    case 'CorrespondenceValidationError':
    case 'CorrespondenceConflictError':
    case 'CorrespondenceNotFoundError':
      return false;
    default:
      return false;
  }
};

function getTimestampMilliseconds(timestamp: string): number | null {
  const parsedTimestamp = Date.parse(timestamp);
  return Number.isNaN(parsedTimestamp) ? null : parsedTimestamp;
}

function compareTimestampInstants(leftTimestamp: string, rightTimestamp: string): number {
  const leftMilliseconds = getTimestampMilliseconds(leftTimestamp);
  const rightMilliseconds = getTimestampMilliseconds(rightTimestamp);

  if (leftMilliseconds !== null && rightMilliseconds !== null) {
    if (leftMilliseconds < rightMilliseconds) return -1;
    if (leftMilliseconds > rightMilliseconds) return 1;
    return 0;
  }

  return leftTimestamp.localeCompare(rightTimestamp);
}

async function approvePendingRecord(
  repo: LearningProgressRepository,
  recordRow: LearningProgressRecordRow,
  logger: Logger
): Promise<Result<'approved' | 'skipped', LearningProgressError>> {
  const reviewResult = await updateInteractionReview(
    { repo },
    {
      userId: recordRow.userId,
      recordKey: recordRow.recordKey,
      expectedUpdatedAt: recordRow.updatedAt,
      status: 'approved',
      actor: {
        actor: 'system',
        actorSource: 'user_event_worker',
      },
    }
  );

  if (reviewResult.isOk()) {
    return ok('approved');
  }

  if (
    reviewResult.error.type === 'ConflictError' &&
    reviewResult.error.message.includes('is no longer reviewable because it is not pending')
  ) {
    logger.debug(
      { recordKey: recordRow.recordKey, userId: recordRow.userId },
      'Skipping approval because the debate-request record is no longer pending'
    );
    return ok('skipped');
  }

  return err(reviewResult.error);
}

async function rejectPendingRecord(
  deps: PublicDebateRequestUserEventHandlerDeps,
  recordRow: LearningProgressRecordRow,
  feedbackText: string,
  logger: Logger
): Promise<void> {
  const reviewResult = await updateInteractionReview(
    { repo: deps.learningProgressRepo },
    {
      userId: recordRow.userId,
      recordKey: recordRow.recordKey,
      expectedUpdatedAt: recordRow.updatedAt,
      status: 'rejected',
      feedbackText,
      actor: {
        actor: 'system',
        actorSource: 'user_event_worker',
      },
    }
  );

  if (reviewResult.isOk()) {
    return;
  }

  if (
    reviewResult.error.type === 'ConflictError' &&
    reviewResult.error.message.includes('is no longer reviewable because it is not pending')
  ) {
    logger.debug(
      { recordKey: recordRow.recordKey, userId: recordRow.userId },
      'Skipping rejection because the debate-request record is no longer pending'
    );
    return;
  }

  throw new Error(getErrorMessage(reviewResult.error));
}

export const makePublicDebateRequestUserEventHandler = (
  deps: PublicDebateRequestUserEventHandlerDeps
): UserEventHandler => {
  const log = deps.logger.child({ handler: 'public-debate-request-user-event' });

  return {
    name: 'public-debate-request',

    matches(event: UserEventJobPayload): boolean {
      return event.eventType === 'interactive.updated';
    },

    async handle(event: UserEventJobPayload): Promise<void> {
      if (event.eventType !== 'interactive.updated') {
        return;
      }

      const recordResult = await deps.learningProgressRepo.getRecord(event.userId, event.recordKey);

      if (recordResult.isErr()) {
        log.error(
          { error: recordResult.error, eventId: event.eventId, recordKey: event.recordKey },
          'Failed to load learning progress record for public debate user event'
        );
        throw new Error(getErrorMessage(recordResult.error));
      }

      if (recordResult.value === null) {
        log.debug(
          { eventId: event.eventId, recordKey: event.recordKey, userId: event.userId },
          'Skipping public debate user event because record is missing'
        );
        return;
      }

      const recordRow = recordResult.value;
      const record = recordRow.record;
      if (!isEligibleDebateRequestRecord(record)) {
        log.debug(
          { eventId: event.eventId, recordKey: record.key, userId: event.userId },
          'Skipping public debate user event because record is not eligible'
        );
        return;
      }

      const payload = parseDebateRequestPayload(record);
      if (payload === null) {
        log.debug(
          { eventId: event.eventId, recordKey: record.key, userId: event.userId },
          'Skipping public debate user event because payload is invalid'
        );
        return;
      }

      if (record.scope.type !== 'entity') {
        return;
      }

      const entityCui = record.scope.entityCui;
      if (payload.submissionPath === 'send_yourself') {
        const preparedSubject = normalizeOptionalString(payload.preparedSubject);
        if (preparedSubject === null) {
          await rejectPendingRecord(
            deps,
            recordRow,
            'The prepared email subject is missing. Please generate the email again.',
            log
          );
          return;
        }

        const associationEmail = normalizeOptionalString(payload.ngoSenderEmail);
        if (associationEmail === null || !EMAIL_REGEX.test(associationEmail)) {
          await rejectPendingRecord(
            deps,
            recordRow,
            'The association email is missing or invalid. Please correct it and try again.',
            log
          );
          return;
        }

        if (deps.subscriptionService !== undefined) {
          const subscribeResult = await deps.subscriptionService.ensureSubscribed(
            event.userId,
            entityCui
          );
          if (subscribeResult.isErr()) {
            log.error(
              {
                error: subscribeResult.error,
                entityCui,
                eventId: event.eventId,
                recordKey: record.key,
                userId: event.userId,
              },
              'Failed to ensure public debate notification subscription for self-send submission'
            );
            throw new Error(getErrorMessage(subscribeResult.error));
          }
        }

        return;
      }

      const preparationResult = await preparePublicDebateRequestDispatch(deps, recordRow);
      if (preparationResult.isErr()) {
        log.error(
          {
            error: preparationResult.error,
            entityCui,
            eventId: event.eventId,
            recordKey: record.key,
            userId: event.userId,
          },
          'Failed to prepare public debate platform dispatch'
        );
        throw new Error(getErrorMessage(preparationResult.error));
      }

      if (preparationResult.value.kind === 'not_applicable') {
        log.debug(
          { eventId: event.eventId, recordKey: record.key, userId: event.userId },
          'Skipping public debate user event because submission path is not request_platform'
        );
        return;
      }

      if (preparationResult.value.kind === 'blocked_invalid_institution_email') {
        await rejectPendingRecord(deps, recordRow, preparationResult.value.feedbackText, log);
        return;
      }

      if (preparationResult.value.kind === 'blocked_email_mismatch') {
        log.info(
          {
            entityCui,
            eventId: event.eventId,
            officialEmail: preparationResult.value.officialEmail,
            recordKey: record.key,
            submittedInstitutionEmail: preparationResult.value.submittedInstitutionEmail,
            userId: event.userId,
          },
          'Holding public debate request for manual review because the submitted email does not match the official profile email'
        );
        return;
      }

      const preparedDispatch: PreparedPublicDebateRequestDispatch = preparationResult.value;
      const dispatchResult =
        await deps.learningProgressRepo.withTransaction<DebateDispatchTransactionResult>(
          async (transactionalRepo) => {
            const lockedRecordResult = await transactionalRepo.getRecordForUpdate(
              recordRow.userId,
              recordRow.recordKey
            );
            if (lockedRecordResult.isErr()) {
              return err(lockedRecordResult.error);
            }

            const lockedRecordRow = lockedRecordResult.value;
            if (lockedRecordRow?.record.phase !== 'pending') {
              return ok({ kind: 'skipped' as const });
            }

            if (compareTimestampInstants(lockedRecordRow.updatedAt, recordRow.updatedAt) !== 0) {
              return ok({ kind: 'skipped' as const });
            }

            const sendResult = await executePreparedPublicDebateRequestDispatch(
              deps,
              preparedDispatch
            );
            if (sendResult.isErr()) {
              return ok({
                kind: 'dispatch_failed' as const,
                error: sendResult.error,
              });
            }

            const approveResult = await approvePendingRecord(
              transactionalRepo,
              lockedRecordRow,
              log
            );
            if (approveResult.isErr()) {
              return err(approveResult.error);
            }

            if (approveResult.value === 'skipped') {
              return ok({ kind: 'skipped' as const });
            }

            return ok({
              kind: 'approved' as const,
              created: sendResult.value.created,
              threadId: sendResult.value.thread.id,
            });
          }
        );
      if (dispatchResult.isErr()) {
        throw new Error(getErrorMessage(dispatchResult.error));
      }

      if (dispatchResult.value.kind === 'skipped') {
        log.debug(
          { eventId: event.eventId, recordKey: record.key, userId: event.userId },
          'Skipping public debate platform dispatch because the record changed before approval'
        );
        return;
      }

      if (dispatchResult.value.kind === 'dispatch_failed') {
        log.warn(
          {
            error: dispatchResult.value.error,
            entityCui,
            eventId: event.eventId,
            recordKey: record.key,
            userId: event.userId,
          },
          'Public debate platform send failed after user event processing'
        );
        if (!isRetryableCorrespondenceError(dispatchResult.value.error)) {
          throw new UnrecoverableError(getErrorMessage(dispatchResult.value.error));
        }

        throw new Error(getErrorMessage(dispatchResult.value.error));
      }

      if (preparationResult.value.existingThread !== undefined || !dispatchResult.value.created) {
        log.info(
          {
            entityCui,
            eventId: event.eventId,
            recordKey: record.key,
            threadId: dispatchResult.value.threadId,
            userId: event.userId,
          },
          'Skipping public debate platform send because a thread already exists'
        );
      }
    },
  };
};
