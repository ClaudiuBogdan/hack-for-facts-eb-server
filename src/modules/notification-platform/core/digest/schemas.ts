import { Type, type Static } from '@sinclair/typebox';

import {
  DateTimeSchema,
  DigestCadenceSchema,
  ExternalChannelSchema,
  NonEmptyStringSchema,
} from '../shared/schemas.js';

export const DigestBatchStatusSchema = Type.Union([
  Type.Literal('open'),
  Type.Literal('materializing'),
  Type.Literal('rendered'),
  Type.Literal('cancelled'),
]);
export type DigestBatchStatus = Static<typeof DigestBatchStatusSchema>;

export const DigestWindowSchema = Type.Object(
  {
    windowStartUtc: DateTimeSchema,
    windowEndUtc: DateTimeSchema,
    dispatchAtUtc: DateTimeSchema,
  },
  { additionalProperties: false }
);
export type DigestWindow = Static<typeof DigestWindowSchema>;

export const DigestBatchSchema = Type.Object(
  {
    id: NonEmptyStringSchema,
    userId: NonEmptyStringSchema,
    channel: ExternalChannelSchema,
    cadence: DigestCadenceSchema,
    windowStartUtc: DateTimeSchema,
    windowEndUtc: DateTimeSchema,
    dispatchAtUtc: DateTimeSchema,
    status: DigestBatchStatusSchema,
    renderedItemIds: Type.Union([Type.Array(NonEmptyStringSchema), Type.Null()]),
    overflowCount: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
    deliveryId: Type.Union([Type.String(), Type.Null()]),
    claimToken: Type.Union([Type.String(), Type.Null()]),
    claimExpiresAt: Type.Union([DateTimeSchema, Type.Null()]),
    createdAt: DateTimeSchema,
    updatedAt: DateTimeSchema,
  },
  { additionalProperties: false }
);
export type DigestBatch = Static<typeof DigestBatchSchema>;

export const DigestMaterializeJobPayloadSchema = Type.Object(
  { limit: Type.Integer({ minimum: 1 }) },
  { additionalProperties: false }
);
export type DigestMaterializeJobPayload = Static<typeof DigestMaterializeJobPayloadSchema>;
