import { Type } from '@sinclair/typebox';

const UserEventBaseSchema = {
  source: Type.Literal('learning_progress'),
  userId: Type.String({ minLength: 1 }),
  eventId: Type.String({ minLength: 1, maxLength: 200 }),
  occurredAt: Type.String({ minLength: 1 }),
};

export const LearningProgressInteractiveUpdatedUserEventSchema = Type.Object(
  {
    ...UserEventBaseSchema,
    eventType: Type.Literal('interactive.updated'),
    recordKey: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false }
);

export const LearningProgressResetUserEventSchema = Type.Object(
  {
    ...UserEventBaseSchema,
    eventType: Type.Literal('progress.reset'),
  },
  { additionalProperties: false }
);

export const UserEventJobPayloadSchema = Type.Union([
  LearningProgressInteractiveUpdatedUserEventSchema,
  LearningProgressResetUserEventSchema,
]);
