import { Type, type Static } from '@sinclair/typebox';

import { DateTimeSchema, NonEmptyStringSchema, UnknownRecordSchema } from '../shared/schemas.js';

export const SubscriptionStateSchema = Type.Union([
  Type.Literal('active'),
  Type.Literal('paused'),
  Type.Literal('removed'),
]);
export type SubscriptionState = Static<typeof SubscriptionStateSchema>;

export const SubscriptionSchema = Type.Object(
  {
    id: NonEmptyStringSchema,
    userId: NonEmptyStringSchema,
    kindId: NonEmptyStringSchema,
    subjectType: NonEmptyStringSchema,
    subjectId: NonEmptyStringSchema,
    config: UnknownRecordSchema,
    normalizedKey: NonEmptyStringSchema,
    state: SubscriptionStateSchema,
    createdAt: DateTimeSchema,
    updatedAt: DateTimeSchema,
    removedAt: Type.Union([DateTimeSchema, Type.Null()]),
  },
  { additionalProperties: false }
);
export type Subscription = Static<typeof SubscriptionSchema>;

export const CreateSubscriptionBodySchema = Type.Object(
  {
    kindId: NonEmptyStringSchema,
    subjectType: NonEmptyStringSchema,
    subjectId: NonEmptyStringSchema,
    config: UnknownRecordSchema,
  },
  { additionalProperties: false }
);
export type CreateSubscriptionBody = Static<typeof CreateSubscriptionBodySchema>;

export const SubscriptionIdParamsSchema = Type.Object(
  { id: NonEmptyStringSchema },
  { additionalProperties: false }
);
export type SubscriptionIdParams = Static<typeof SubscriptionIdParamsSchema>;

export const SubscriptionListQuerySchema = Type.Object(
  {
    kindId: Type.Optional(NonEmptyStringSchema),
    cursor: Type.Optional(NonEmptyStringSchema),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 50 })),
  },
  { additionalProperties: false }
);
export type SubscriptionListQuery = Static<typeof SubscriptionListQuerySchema>;

export const SubscriptionResponseSchema = Type.Object(
  { ok: Type.Literal(true), data: SubscriptionSchema },
  { additionalProperties: false }
);
export type SubscriptionResponse = Static<typeof SubscriptionResponseSchema>;

export const SubscriptionListResponseSchema = Type.Object(
  {
    ok: Type.Literal(true),
    data: Type.Object({
      items: Type.Array(SubscriptionSchema),
      nextCursor: Type.Union([Type.String(), Type.Null()]),
    }),
  },
  { additionalProperties: false }
);
export type SubscriptionListResponse = Static<typeof SubscriptionListResponseSchema>;
