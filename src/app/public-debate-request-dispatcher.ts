import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

import {
  PUBLIC_DEBATE_REQUEST_TYPE,
  sendPlatformRequest,
  type CorrespondenceEmailSender,
  type CorrespondenceTemplateRenderer,
  type InstitutionCorrespondenceRepository,
} from '@/modules/institution-correspondence/index.js';
import {
  isInteractiveUpdatedEvent,
  type InteractiveStateRecord,
  type LearningInteractiveUpdatedEvent,
  type LearningProgressEvent,
} from '@/modules/learning-progress/index.js';

import type { Logger } from 'pino';

export const DEBATE_REQUEST_INTERACTION_ID = 'campaign:debate-request' as const;

export const DebateRequestPayloadSchema = Type.Object(
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

export type DebateRequestPayload = Static<typeof DebateRequestPayloadSchema>;

export interface PublicDebateRequestDispatchDeps {
  repo: InstitutionCorrespondenceRepository;
  emailSender: CorrespondenceEmailSender;
  templateRenderer: CorrespondenceTemplateRenderer;
  auditCcRecipients: string[];
  platformBaseUrl: string;
  captureAddress: string;
  logger: Logger;
}

export interface PublicDebateRequestDispatchInput {
  userId: string;
  events: readonly LearningProgressEvent[];
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

function compareTimestampInstants(leftTimestamp: string, rightTimestamp: string): number {
  const leftMilliseconds = Date.parse(leftTimestamp);
  const rightMilliseconds = Date.parse(rightTimestamp);

  if (!Number.isNaN(leftMilliseconds) && !Number.isNaN(rightMilliseconds)) {
    if (leftMilliseconds < rightMilliseconds) return -1;
    if (leftMilliseconds > rightMilliseconds) return 1;
    return 0;
  }

  return leftTimestamp.localeCompare(rightTimestamp);
}

function getLatestInteractiveUpdatesByKey(
  events: readonly LearningProgressEvent[]
): LearningInteractiveUpdatedEvent[] {
  const updatesByKey = new Map<string, LearningInteractiveUpdatedEvent>();

  for (const event of events) {
    if (!isInteractiveUpdatedEvent(event)) {
      continue;
    }

    const existing = updatesByKey.get(event.payload.record.key);
    if (
      existing === undefined ||
      compareTimestampInstants(event.payload.record.updatedAt, existing.payload.record.updatedAt) >=
        0
    ) {
      updatesByKey.set(event.payload.record.key, event);
    }
  }

  return [...updatesByKey.values()];
}

export function makePublicDebateRequestSyncHook(deps: PublicDebateRequestDispatchDeps) {
  return async (input: PublicDebateRequestDispatchInput): Promise<void> => {
    const latestUpdates = getLatestInteractiveUpdatesByKey(input.events);

    for (const event of latestUpdates) {
      const record = event.payload.record;
      if (!isEligibleDebateRequestRecord(record)) {
        continue;
      }

      if (record.scope.type !== 'entity') {
        continue;
      }

      const payload = parseDebateRequestPayload(record);
      if (payload?.submissionPath !== 'request_platform') {
        continue;
      }

      const entityCui = record.scope.entityCui;
      const existingThreadResult = await deps.repo.findPlatformSendThreadByEntity({
        entityCui,
        campaign: PUBLIC_DEBATE_REQUEST_TYPE,
      });

      if (existingThreadResult.isErr()) {
        deps.logger.error(
          {
            error: existingThreadResult.error,
            eventId: event.eventId,
            recordKey: record.key,
            entityCui,
            userId: input.userId,
          },
          'Failed to check existing public debate correspondence thread'
        );
        continue;
      }

      if (existingThreadResult.value !== null) {
        deps.logger.info(
          {
            eventId: event.eventId,
            recordKey: record.key,
            entityCui,
            threadId: existingThreadResult.value.id,
            userId: input.userId,
          },
          'Skipping public debate platform send because a thread already exists'
        );
        continue;
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
          ownerUserId: input.userId,
          entityCui,
          institutionEmail: payload.primariaEmail,
          requesterOrganizationName: payload.organizationName,
          budgetPublicationDate: null,
          consentCapturedAt: payload.submittedAt,
        }
      );

      if (sendResult.isErr()) {
        deps.logger.warn(
          {
            error: sendResult.error,
            eventId: event.eventId,
            recordKey: record.key,
            entityCui,
            userId: input.userId,
          },
          'Public debate platform send failed after learning progress sync'
        );
      }
    }
  };
}
