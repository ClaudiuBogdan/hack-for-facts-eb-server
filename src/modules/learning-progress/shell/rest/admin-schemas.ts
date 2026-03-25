import { Type, type Static } from '@sinclair/typebox';

import {
  ErrorResponseSchema,
  InteractionResultSchema,
  InteractionValueSchema,
  InteractiveStateRecordSchema,
} from './schemas.js';

export const ReviewQueueQuerySchema = Type.Object(
  {
    status: Type.Optional(
      Type.Union([Type.Literal('pending'), Type.Literal('approved'), Type.Literal('rejected')])
    ),
    userId: Type.Optional(Type.String({ minLength: 1 })),
    recordKey: Type.Optional(Type.String({ minLength: 1 })),
    recordKeyPrefix: Type.Optional(Type.String({ minLength: 16 })),
    interactionId: Type.Optional(Type.String({ minLength: 1 })),
    lessonId: Type.Optional(Type.String({ minLength: 1 })),
    limit: Type.Optional(Type.Number({ minimum: 1, maximum: 100 })),
    offset: Type.Optional(Type.Number({ minimum: 0 })),
  },
  { additionalProperties: false }
);

export type ReviewQueueQuery = Static<typeof ReviewQueueQuerySchema>;

const StoredSubmittedAuditEventSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    recordKey: Type.String({ minLength: 1 }),
    lessonId: Type.String({ minLength: 1 }),
    interactionId: Type.String({ minLength: 1 }),
    type: Type.Literal('submitted'),
    at: Type.String({ format: 'date-time' }),
    actor: Type.Literal('user'),
    value: InteractionValueSchema,
    seq: Type.String({ minLength: 1 }),
    sourceClientEventId: Type.String({ minLength: 1 }),
    sourceClientId: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false }
);

const StoredEvaluatedAuditEventSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    recordKey: Type.String({ minLength: 1 }),
    lessonId: Type.String({ minLength: 1 }),
    interactionId: Type.String({ minLength: 1 }),
    type: Type.Literal('evaluated'),
    at: Type.String({ format: 'date-time' }),
    actor: Type.Literal('system'),
    phase: Type.Union([Type.Literal('resolved'), Type.Literal('failed')]),
    result: InteractionResultSchema,
    seq: Type.String({ minLength: 1 }),
    sourceClientEventId: Type.String({ minLength: 1 }),
    sourceClientId: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false }
);

export const StoredInteractiveAuditEventSchema = Type.Union([
  StoredSubmittedAuditEventSchema,
  StoredEvaluatedAuditEventSchema,
]);

export const LearningProgressRecordRowSchema = Type.Object(
  {
    userId: Type.String({ minLength: 1 }),
    recordKey: Type.String({ minLength: 1 }),
    record: InteractiveStateRecordSchema,
    auditEvents: Type.Array(StoredInteractiveAuditEventSchema),
    updatedSeq: Type.String({ minLength: 1 }),
    createdAt: Type.String({ format: 'date-time' }),
    updatedAt: Type.String({ format: 'date-time' }),
  },
  { additionalProperties: false }
);

const ApproveReviewDecisionSchema = Type.Object(
  {
    userId: Type.String({ minLength: 1 }),
    recordKey: Type.String({ minLength: 1 }),
    expectedUpdatedAt: Type.String({ format: 'date-time' }),
    status: Type.Literal('approved'),
    feedbackText: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false }
);

const RejectReviewDecisionSchema = Type.Object(
  {
    userId: Type.String({ minLength: 1 }),
    recordKey: Type.String({ minLength: 1 }),
    expectedUpdatedAt: Type.String({ format: 'date-time' }),
    status: Type.Literal('rejected'),
    feedbackText: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false }
);

export const ReviewDecisionSchema = Type.Union([
  ApproveReviewDecisionSchema,
  RejectReviewDecisionSchema,
]);

export type ReviewDecisionBody = Static<typeof ReviewDecisionSchema>;

export const SubmitInteractionReviewsBodySchema = Type.Object(
  {
    items: Type.Array(ReviewDecisionSchema, {
      minItems: 1,
      maxItems: 100,
    }),
  },
  { additionalProperties: false }
);

export type SubmitInteractionReviewsBody = Static<typeof SubmitInteractionReviewsBodySchema>;

export const ReviewQueueResponseSchema = Type.Object(
  {
    ok: Type.Literal(true),
    data: Type.Object(
      {
        items: Type.Array(LearningProgressRecordRowSchema),
        page: Type.Object(
          {
            offset: Type.Number({ minimum: 0 }),
            limit: Type.Number({ minimum: 1, maximum: 100 }),
            hasMore: Type.Boolean(),
          },
          { additionalProperties: false }
        ),
      },
      { additionalProperties: false }
    ),
  },
  { additionalProperties: false }
);

export const SubmitInteractionReviewsResponseSchema = Type.Object(
  {
    ok: Type.Literal(true),
    data: Type.Object(
      {
        items: Type.Array(LearningProgressRecordRowSchema),
      },
      { additionalProperties: false }
    ),
  },
  { additionalProperties: false }
);

export { ErrorResponseSchema };
