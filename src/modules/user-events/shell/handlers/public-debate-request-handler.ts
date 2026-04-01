import { UnrecoverableError } from 'bullmq';

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
  type LearningProgressRecordRow,
  type LearningProgressRepository,
} from '@/modules/learning-progress/index.js';

import {
  executePreparedPublicDebateRequestDispatch,
  preparePublicDebateRequestDispatch,
} from './public-debate-request-dispatch.js';

import type { UserEventHandler } from '../../core/ports.js';
import type { UserEventJobPayload } from '../../core/types.js';
import type { EntityProfileRepository } from '@/modules/entity/index.js';
import type { Logger } from 'pino';
export interface PublicDebateRequestUserEventHandlerDeps {
  learningProgressRepo: LearningProgressRepository;
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

async function approvePendingRecord(
  deps: PublicDebateRequestUserEventHandlerDeps,
  recordRow: LearningProgressRecordRow,
  logger: Logger
): Promise<void> {
  const reviewResult = await updateInteractionReview(
    { repo: deps.learningProgressRepo },
    {
      userId: recordRow.userId,
      recordKey: recordRow.recordKey,
      expectedUpdatedAt: recordRow.updatedAt,
      status: 'approved',
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
      'Skipping approval because the debate-request record is no longer pending'
    );
    return;
  }

  throw new Error(getErrorMessage(reviewResult.error));
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

      const sendResult = await executePreparedPublicDebateRequestDispatch(
        deps,
        preparationResult.value
      );
      if (sendResult.isErr()) {
        log.warn(
          {
            error: sendResult.error,
            entityCui,
            eventId: event.eventId,
            recordKey: record.key,
            userId: event.userId,
          },
          'Public debate platform send failed after user event processing'
        );
        if (!isRetryableCorrespondenceError(sendResult.error)) {
          throw new UnrecoverableError(getErrorMessage(sendResult.error));
        }

        throw new Error(getErrorMessage(sendResult.error));
      }

      await approvePendingRecord(deps, recordRow, log);

      if (preparationResult.value.existingThread !== undefined || !sendResult.value.created) {
        log.info(
          {
            entityCui,
            eventId: event.eventId,
            recordKey: record.key,
            threadId: sendResult.value.thread.id,
            userId: event.userId,
          },
          'Skipping public debate platform send because a thread already exists'
        );
      }
    },
  };
};
