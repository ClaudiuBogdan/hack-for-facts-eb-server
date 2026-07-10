import { Type, type Static } from '@sinclair/typebox';

import { DateTimeSchema, NonEmptyStringSchema, UnknownRecordSchema } from '../shared/schemas.js';

export const EventStatusSchema = Type.Union([
  Type.Literal('pending'),
  Type.Literal('resolving'),
  Type.Literal('resolved'),
  Type.Literal('conflicted'),
  Type.Literal('failed'),
]);
export type EventStatus = Static<typeof EventStatusSchema>;

export const NotificationEventSchema = Type.Object(
  {
    id: NonEmptyStringSchema,
    source: NonEmptyStringSchema,
    eventType: NonEmptyStringSchema,
    eventSchemaVersion: Type.Integer({ minimum: 1 }),
    occurrenceKey: NonEmptyStringSchema,
    occurredAt: DateTimeSchema,
    facts: UnknownRecordSchema,
    payloadHash: Type.String({ pattern: '^[a-f0-9]{64}$' }),
    correlationId: Type.Union([Type.String(), Type.Null()]),
    causationId: Type.Union([Type.String(), Type.Null()]),
    streamKey: Type.Union([Type.String(), Type.Null()]),
    streamSequence: Type.Union([Type.Integer(), Type.Null()]),
    status: EventStatusSchema,
    resolutionCursor: Type.Union([Type.String(), Type.Null()]),
    claimToken: Type.Union([Type.String(), Type.Null()]),
    claimExpiresAt: Type.Union([DateTimeSchema, Type.Null()]),
    createdAt: DateTimeSchema,
    resolvedAt: Type.Union([DateTimeSchema, Type.Null()]),
    retentionExpiresAt: DateTimeSchema,
  },
  { additionalProperties: false }
);
export type NotificationEvent = Static<typeof NotificationEventSchema>;

export const CreateNotificationEventInputSchema = Type.Object(
  {
    source: NonEmptyStringSchema,
    eventType: NonEmptyStringSchema,
    eventSchemaVersion: Type.Integer({ minimum: 1 }),
    occurrenceKey: NonEmptyStringSchema,
    occurredAt: DateTimeSchema,
    facts: UnknownRecordSchema,
    correlationId: Type.Optional(NonEmptyStringSchema),
    causationId: Type.Optional(NonEmptyStringSchema),
  },
  { additionalProperties: false }
);
export type CreateNotificationEventInput = Static<typeof CreateNotificationEventInputSchema>;

export const SourceOccurrenceSchema = Type.Object(
  {
    eventType: NonEmptyStringSchema,
    occurrenceKey: NonEmptyStringSchema,
    occurredAt: DateTimeSchema,
    facts: UnknownRecordSchema,
    correlationId: Type.Optional(NonEmptyStringSchema),
  },
  { additionalProperties: false }
);
export type SourceOccurrence = Static<typeof SourceOccurrenceSchema>;

export const IngestionScanJobPayloadSchema = Type.Object(
  { sourceId: NonEmptyStringSchema },
  { additionalProperties: false }
);
export type IngestionScanJobPayload = Static<typeof IngestionScanJobPayloadSchema>;

export const EventFanOutJobPayloadSchema = Type.Object(
  { eventId: NonEmptyStringSchema },
  { additionalProperties: false }
);
export type EventFanOutJobPayload = Static<typeof EventFanOutJobPayloadSchema>;
