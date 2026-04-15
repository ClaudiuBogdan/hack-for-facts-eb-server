import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { err, ok, type Result } from 'neverthrow';

import { createInvalidEventError, type LearningProgressError } from '../errors.js';
import {
  INTERNAL_FUNKY_WEEKLY_DIGEST_INTERACTION_ID,
  INTERNAL_FUNKY_WEEKLY_DIGEST_KEY,
} from '../internal-records.js';

import type { LearningProgressRepository } from '../ports.js';
import type { InteractiveStateRecord } from '../types.js';

export const WeeklyDigestCursorPayloadSchema = Type.Object(
  {
    campaignKey: Type.Literal('funky'),
    lastSentAt: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    watermarkAt: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    weekKey: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    outboxId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  },
  { additionalProperties: false }
);

export type WeeklyDigestCursorPayload = Static<typeof WeeklyDigestCursorPayloadSchema>;

const DEFAULT_CURSOR_PAYLOAD: WeeklyDigestCursorPayload = {
  campaignKey: 'funky',
  lastSentAt: null,
  watermarkAt: null,
  weekKey: null,
  outboxId: null,
};

function createCursorRecord(input: {
  payload: WeeklyDigestCursorPayload;
  updatedAt: string;
}): InteractiveStateRecord {
  return {
    key: INTERNAL_FUNKY_WEEKLY_DIGEST_KEY,
    interactionId: INTERNAL_FUNKY_WEEKLY_DIGEST_INTERACTION_ID,
    lessonId: 'internal',
    kind: 'custom',
    scope: { type: 'global' },
    completionRule: { type: 'resolved' },
    phase: 'resolved',
    value: {
      kind: 'json',
      json: {
        value: input.payload,
      },
    },
    result: null,
    updatedAt: input.updatedAt,
  };
}

function parseCursorPayload(
  candidate: unknown
): Result<WeeklyDigestCursorPayload, LearningProgressError> {
  if (!Value.Check(WeeklyDigestCursorPayloadSchema, candidate)) {
    const [firstError] = [...Value.Errors(WeeklyDigestCursorPayloadSchema, candidate)];
    return err(
      createInvalidEventError(firstError?.message ?? 'Invalid weekly digest cursor payload.')
    );
  }

  return ok(candidate);
}

export const getWeeklyDigestCursor = async (
  deps: { repo: LearningProgressRepository },
  input: { userId: string }
): Promise<Result<WeeklyDigestCursorPayload, LearningProgressError>> => {
  const rowResult = await deps.repo.getRecord(input.userId, INTERNAL_FUNKY_WEEKLY_DIGEST_KEY);
  if (rowResult.isErr()) {
    return err(rowResult.error);
  }

  const row = rowResult.value;
  if (row === null) {
    return ok(DEFAULT_CURSOR_PAYLOAD);
  }

  if (row.record.value?.kind !== 'json') {
    return err(createInvalidEventError('Invalid weekly digest cursor record.'));
  }

  return parseCursorPayload(row.record.value.json.value);
};

export const upsertWeeklyDigestCursor = async (
  deps: { repo: LearningProgressRepository },
  input: {
    userId: string;
    payload: WeeklyDigestCursorPayload;
    occurredAt?: string;
  }
): Promise<Result<void, LearningProgressError>> => {
  const payloadResult = parseCursorPayload(input.payload);
  if (payloadResult.isErr()) {
    return err(payloadResult.error);
  }

  const occurredAt = input.occurredAt ?? new Date().toISOString();
  const upsertResult = await deps.repo.upsertInteractiveRecord({
    userId: input.userId,
    eventId: `internal:weekly-digest:${input.payload.weekKey ?? 'none'}:${input.payload.outboxId ?? 'none'}`,
    clientId: 'server-internal-weekly-digest',
    occurredAt,
    record: createCursorRecord({
      payload: payloadResult.value,
      updatedAt: occurredAt,
    }),
    auditEvents: [],
  });
  if (upsertResult.isErr()) {
    return err(upsertResult.error);
  }

  return ok(undefined);
};
