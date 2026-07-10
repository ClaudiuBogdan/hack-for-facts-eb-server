import { Type, type Static } from '@sinclair/typebox';

import { DateTimeSchema, ExternalChannelSchema, NonEmptyStringSchema } from '../shared/schemas.js';

export const DeliveryStateSchema = Type.Union([
  Type.Literal('pending_render'),
  Type.Literal('scheduled'),
  Type.Literal('ready'),
  Type.Literal('sending'),
  Type.Literal('retry_wait'),
  Type.Literal('accepted'),
  Type.Literal('delivered'),
  Type.Literal('bounced'),
  Type.Literal('complained'),
  Type.Literal('suppressed'),
  Type.Literal('cancelled'),
  Type.Literal('expired'),
  Type.Literal('permanent_failed'),
  Type.Literal('dead_letter'),
  Type.Literal('unknown'),
]);
export type DeliveryState = Static<typeof DeliveryStateSchema>;

export const AttemptResultSchema = Type.Union([
  Type.Literal('accepted'),
  Type.Literal('transient_failure'),
  Type.Literal('permanent_failure'),
  Type.Literal('ambiguous'),
]);
export type AttemptResult = Static<typeof AttemptResultSchema>;

export const DeliverySchema = Type.Object(
  {
    id: NonEmptyStringSchema,
    deliveryKey: NonEmptyStringSchema,
    logicalNotificationId: Type.Union([Type.String(), Type.Null()]),
    digestBatchId: Type.Union([Type.String(), Type.Null()]),
    kindId: NonEmptyStringSchema,
    userId: NonEmptyStringSchema,
    channel: ExternalChannelSchema,
    destinationFingerprint: Type.Union([Type.String(), Type.Null()]),
    destinationGeneration: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
    templateId: Type.Union([Type.String(), Type.Null()]),
    templateVersion: Type.Union([Type.String(), Type.Null()]),
    renderedSubject: Type.Union([Type.String(), Type.Null()]),
    renderedHtml: Type.Union([Type.String(), Type.Null()]),
    renderedText: Type.Union([Type.String(), Type.Null()]),
    contentHash: Type.Union([Type.String(), Type.Null()]),
    status: DeliveryStateSchema,
    notBefore: Type.Union([DateTimeSchema, Type.Null()]),
    expiresAt: Type.Union([DateTimeSchema, Type.Null()]),
    streamKey: Type.Union([Type.String(), Type.Null()]),
    streamSequence: Type.Union([Type.Integer(), Type.Null()]),
    attemptCount: Type.Integer({ minimum: 0 }),
    nextAttemptAt: Type.Union([DateTimeSchema, Type.Null()]),
    claimToken: Type.Union([Type.String(), Type.Null()]),
    claimExpiresAt: Type.Union([DateTimeSchema, Type.Null()]),
    providerIdempotencyKey: Type.Union([Type.String(), Type.Null()]),
    providerRef: Type.Union([Type.String(), Type.Null()]),
    lastErrorCode: Type.Union([Type.String(), Type.Null()]),
    lastErrorMessage: Type.Union([Type.String(), Type.Null()]),
    senderMode: Type.Union([Type.Literal('shadow'), Type.Literal('active')]),
    createdAt: DateTimeSchema,
    updatedAt: DateTimeSchema,
    acceptedAt: Type.Union([DateTimeSchema, Type.Null()]),
    terminalAt: Type.Union([DateTimeSchema, Type.Null()]),
    retentionExpiresAt: DateTimeSchema,
  },
  { additionalProperties: false }
);
export type Delivery = Static<typeof DeliverySchema>;

export const DeliveryAttemptSchema = Type.Object(
  {
    id: NonEmptyStringSchema,
    deliveryId: NonEmptyStringSchema,
    attemptNumber: Type.Integer({ minimum: 1 }),
    startedAt: DateTimeSchema,
    completedAt: Type.Union([DateTimeSchema, Type.Null()]),
    providerIdempotencyKey: NonEmptyStringSchema,
    requestCorrelationId: Type.Union([Type.String(), Type.Null()]),
    destinationFingerprint: Type.Union([Type.String(), Type.Null()]),
    result: Type.Union([AttemptResultSchema, Type.Null()]),
    errorCode: Type.Union([Type.String(), Type.Null()]),
    errorMessage: Type.Union([Type.String(), Type.Null()]),
    providerRef: Type.Union([Type.String(), Type.Null()]),
    latencyMs: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
    retryAfterMs: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  },
  { additionalProperties: false }
);
export type DeliveryAttempt = Static<typeof DeliveryAttemptSchema>;

export const ChannelDestinationSchema = Type.Object(
  {
    id: NonEmptyStringSchema,
    userId: NonEmptyStringSchema,
    channel: ExternalChannelSchema,
    fingerprint: NonEmptyStringSchema,
    generation: Type.Integer({ minimum: 1 }),
    isCurrent: Type.Boolean(),
    suppressedAt: Type.Union([DateTimeSchema, Type.Null()]),
    suppressionReason: Type.Union([Type.String(), Type.Null()]),
    createdAt: DateTimeSchema,
    updatedAt: DateTimeSchema,
  },
  { additionalProperties: false }
);
export type ChannelDestination = Static<typeof ChannelDestinationSchema>;

export const RenderJobPayloadSchema = Type.Object(
  { deliveryId: NonEmptyStringSchema },
  { additionalProperties: false }
);
export type RenderJobPayload = Static<typeof RenderJobPayloadSchema>;

export const SendJobPayloadSchema = Type.Object(
  { deliveryId: NonEmptyStringSchema },
  { additionalProperties: false }
);
export type SendJobPayload = Static<typeof SendJobPayloadSchema>;
