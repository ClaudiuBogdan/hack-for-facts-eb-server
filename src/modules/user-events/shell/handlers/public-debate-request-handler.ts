import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { UnrecoverableError } from 'bullmq';

import {
  PUBLIC_DEBATE_REQUEST_TYPE,
  sendPlatformRequest,
  type CorrespondenceEmailSender,
  type CorrespondenceTemplateRenderer,
  type InstitutionCorrespondenceError,
  type InstitutionCorrespondenceRepository,
} from '@/modules/institution-correspondence/index.js';
import {
  type InteractiveStateRecord,
  type LearningProgressRepository,
} from '@/modules/learning-progress/index.js';

import type { UserEventHandler } from '../../core/ports.js';
import type { UserEventJobPayload } from '../../core/types.js';
import type { Logger } from 'pino';

const DEBATE_REQUEST_INTERACTION_ID = 'campaign:debate-request' as const;

const DebateRequestPayloadSchema = Type.Object(
  {
    primariaEmail: Type.String({ minLength: 1 }),
    isNgo: Type.Boolean(),
    organizationName: Type.Union([Type.String(), Type.Null()]),
    threadKey: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    ngoSenderEmail: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    submissionPath: Type.Union([
      Type.Literal('send_yourself'),
      Type.Literal('request_platform'),
      Type.Null(),
    ]),
    submittedAt: Type.Union([Type.String(), Type.Null()]),
  },
  { additionalProperties: false }
);

type DebateRequestPayload = Static<typeof DebateRequestPayloadSchema>;

export interface PublicDebateRequestUserEventHandlerDeps {
  learningProgressRepo: LearningProgressRepository;
  repo: InstitutionCorrespondenceRepository;
  emailSender: CorrespondenceEmailSender;
  templateRenderer: CorrespondenceTemplateRenderer;
  auditCcRecipients: string[];
  platformBaseUrl: string;
  captureAddress: string;
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

  const candidate = record.value.json.value;
  return Value.Check(DebateRequestPayloadSchema, candidate) ? candidate : null;
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

      const record = recordResult.value.record;
      if (!isEligibleDebateRequestRecord(record)) {
        log.debug(
          { eventId: event.eventId, recordKey: record.key, userId: event.userId },
          'Skipping public debate user event because record is not eligible'
        );
        return;
      }

      const payload = parseDebateRequestPayload(record);
      if (payload?.submissionPath !== 'request_platform') {
        log.debug(
          { eventId: event.eventId, recordKey: record.key, userId: event.userId },
          'Skipping public debate user event because submission path is not request_platform'
        );
        return;
      }

      if (record.scope.type !== 'entity') {
        return;
      }

      const entityCui = record.scope.entityCui;
      const existingThreadResult = await deps.repo.findPlatformSendThreadByEntity({
        entityCui,
        campaign: PUBLIC_DEBATE_REQUEST_TYPE,
      });

      if (existingThreadResult.isErr()) {
        log.error(
          {
            error: existingThreadResult.error,
            entityCui,
            eventId: event.eventId,
            recordKey: record.key,
            userId: event.userId,
          },
          'Failed to check existing public debate correspondence thread'
        );
        throw new Error(getErrorMessage(existingThreadResult.error));
      }

      if (existingThreadResult.value !== null) {
        log.info(
          {
            entityCui,
            eventId: event.eventId,
            recordKey: record.key,
            threadId: existingThreadResult.value.id,
            userId: event.userId,
          },
          'Skipping public debate platform send because a thread already exists'
        );
        return;
      }

      const sendResult = await sendPlatformRequest(
        {
          repo: deps.repo,
          emailSender: deps.emailSender,
          templateRenderer: deps.templateRenderer,
          auditCcRecipients: deps.auditCcRecipients,
          platformBaseUrl: deps.platformBaseUrl,
          captureAddress: deps.captureAddress,
        },
        {
          ownerUserId: event.userId,
          entityCui,
          institutionEmail: payload.primariaEmail,
          requesterOrganizationName: payload.organizationName,
          budgetPublicationDate: null,
          consentCapturedAt: payload.submittedAt,
        }
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
    },
  };
};
