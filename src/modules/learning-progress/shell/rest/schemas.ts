/**
 * Learning Progress REST API Schemas
 */

import { Type, type Static } from '@sinclair/typebox';

import { MAX_EVENTS_PER_REQUEST } from '../../core/types.js';

export const InteractionScopeSchema = Type.Union([
  Type.Object({
    type: Type.Literal('entity'),
    entityCui: Type.String({ minLength: 1 }),
  }),
  Type.Object({
    type: Type.Literal('global'),
  }),
]);

export const InteractionValueSchema = Type.Union([
  Type.Object({
    kind: Type.Literal('choice'),
    choice: Type.Object({
      selectedId: Type.Union([Type.String(), Type.Null()]),
    }),
  }),
  Type.Object({
    kind: Type.Literal('text'),
    text: Type.Object({
      value: Type.String(),
    }),
  }),
  Type.Object({
    kind: Type.Literal('url'),
    url: Type.Object({
      value: Type.String(),
    }),
  }),
  Type.Object({
    kind: Type.Literal('number'),
    number: Type.Object({
      value: Type.Union([Type.Number(), Type.Null()]),
    }),
  }),
  Type.Object({
    kind: Type.Literal('json'),
    json: Type.Object({
      value: Type.Record(Type.String(), Type.Unknown()),
    }),
  }),
]);

export const InteractionResultSchema = Type.Object(
  {
    outcome: Type.Union([Type.Literal('correct'), Type.Literal('incorrect'), Type.Null()]),
    score: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    feedbackText: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    response: Type.Optional(Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Null()])),
    evaluatedAt: Type.Optional(Type.Union([Type.String({ format: 'date-time' }), Type.Null()])),
  },
  { additionalProperties: false }
);

export const InteractionReviewSchema = Type.Object(
  {
    status: Type.Union([
      Type.Literal('pending'),
      Type.Literal('approved'),
      Type.Literal('rejected'),
    ]),
    reviewedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
    feedbackText: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  },
  { additionalProperties: false }
);

export const InteractionCompletionRuleSchema = Type.Union([
  Type.Object({
    type: Type.Literal('outcome'),
    outcome: Type.Union([Type.Literal('correct'), Type.Literal('incorrect')]),
  }),
  Type.Object({
    type: Type.Literal('resolved'),
  }),
  Type.Object({
    type: Type.Literal('score-threshold'),
    minScore: Type.Number(),
  }),
  Type.Object({
    type: Type.Literal('component-flag'),
    flag: Type.String({ minLength: 1 }),
  }),
]);

export const InteractiveStateRecordSchema = Type.Object(
  {
    key: Type.String({ minLength: 1 }),
    interactionId: Type.String({ minLength: 1 }),
    lessonId: Type.String({ minLength: 1 }),
    kind: Type.Union([
      Type.Literal('quiz'),
      Type.Literal('url'),
      Type.Literal('text-input'),
      Type.Literal('custom'),
    ]),
    scope: InteractionScopeSchema,
    completionRule: InteractionCompletionRuleSchema,
    phase: Type.Union([
      Type.Literal('idle'),
      Type.Literal('draft'),
      Type.Literal('pending'),
      Type.Literal('resolved'),
      Type.Literal('failed'),
    ]),
    value: Type.Union([InteractionValueSchema, Type.Null()]),
    result: Type.Union([InteractionResultSchema, Type.Null()]),
    // Public GET responses may include server-owned review state. Public PUT
    // accepts this field only as an unchanged echo from the server; sync strips
    // echoed values and rejects client-authored changes.
    review: Type.Optional(Type.Union([InteractionReviewSchema, Type.Null()])),
    updatedAt: Type.String({ format: 'date-time' }),
    submittedAt: Type.Optional(Type.Union([Type.String({ format: 'date-time' }), Type.Null()])),
  },
  { additionalProperties: false }
);

export const InteractiveAuditEventSchema = Type.Union([
  Type.Object({
    id: Type.String({ minLength: 1 }),
    recordKey: Type.String({ minLength: 1 }),
    lessonId: Type.String({ minLength: 1 }),
    interactionId: Type.String({ minLength: 1 }),
    type: Type.Literal('submitted'),
    at: Type.String({ format: 'date-time' }),
    actor: Type.Literal('user'),
    value: InteractionValueSchema,
  }),
  Type.Object({
    id: Type.String({ minLength: 1 }),
    recordKey: Type.String({ minLength: 1 }),
    lessonId: Type.String({ minLength: 1 }),
    interactionId: Type.String({ minLength: 1 }),
    type: Type.Literal('evaluated'),
    at: Type.String({ format: 'date-time' }),
    actor: Type.Literal('system'),
    phase: Type.Union([Type.Literal('resolved'), Type.Literal('failed')]),
    result: InteractionResultSchema,
  }),
]);

const EventBaseSchema = {
  eventId: Type.String({ minLength: 1, maxLength: 200 }),
  occurredAt: Type.String({ format: 'date-time' }),
  clientId: Type.String({ minLength: 1, maxLength: 200 }),
};

export const InteractiveUpdatedEventSchema = Type.Object(
  {
    ...EventBaseSchema,
    type: Type.Literal('interactive.updated'),
    payload: Type.Object(
      {
        record: InteractiveStateRecordSchema,
        auditEvents: Type.Optional(Type.Array(InteractiveAuditEventSchema)),
      },
      { additionalProperties: false }
    ),
  },
  { additionalProperties: false }
);

export const ProgressResetEventSchema = Type.Object(
  {
    ...EventBaseSchema,
    type: Type.Literal('progress.reset'),
  },
  { additionalProperties: false }
);

export const LearningProgressEventSchema = Type.Union([
  InteractiveUpdatedEventSchema,
  ProgressResetEventSchema,
]);

export type LearningProgressEventBody = Static<typeof LearningProgressEventSchema>;

export const GetProgressQuerySchema = Type.Object(
  {
    since: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false }
);

export type GetProgressQuery = Static<typeof GetProgressQuerySchema>;

export const SyncEventsBodySchema = Type.Object(
  {
    clientUpdatedAt: Type.String({ format: 'date-time' }),
    events: Type.Array(LearningProgressEventSchema, {
      maxItems: MAX_EVENTS_PER_REQUEST,
    }),
  },
  { additionalProperties: false }
);

export type SyncEventsBody = Static<typeof SyncEventsBodySchema>;

export const LearningProgressSnapshotSchema = Type.Object(
  {
    version: Type.Number(),
    recordsByKey: Type.Record(Type.String(), InteractiveStateRecordSchema),
    lastUpdated: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  },
  { additionalProperties: false }
);

export const GetProgressResponseSchema = Type.Object(
  {
    ok: Type.Literal(true),
    data: Type.Object(
      {
        snapshot: LearningProgressSnapshotSchema,
        events: Type.Array(InteractiveUpdatedEventSchema),
        cursor: Type.String(),
      },
      { additionalProperties: false }
    ),
  },
  { additionalProperties: false }
);

export const SyncEventsResponseSchema = Type.Object(
  {
    ok: Type.Literal(true),
  },
  { additionalProperties: false }
);

export const ErrorResponseSchema = Type.Object(
  {
    ok: Type.Optional(Type.Literal(false)),
    error: Type.String(),
    message: Type.String(),
    details: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: false }
);
