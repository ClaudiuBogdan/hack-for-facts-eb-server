import { Type, type Static } from '@sinclair/typebox';

import { AUDIT_ACTIONS } from '../audit/types.js';
import { AttemptResultSchema, DeliveryStateSchema } from '../delivery/schemas.js';
import { EventStatusSchema } from '../events/schemas.js';
import {
  DateTimeSchema,
  ExternalChannelSchema,
  LocaleSchema,
  NonEmptyStringSchema,
} from '../shared/schemas.js';

export const AuditActionSchema = Type.Union(AUDIT_ACTIONS.map((action) => Type.Literal(action)));

export const EventTraceAuditEntrySchema = Type.Object(
  {
    action: AuditActionSchema,
    actor: NonEmptyStringSchema,
    userId: Type.Optional(Type.String()),
    eventId: Type.Optional(Type.String()),
    logicalNotificationId: Type.Optional(Type.String()),
    deliveryId: Type.Optional(Type.String()),
    batchId: Type.Optional(Type.String()),
    subscriptionId: Type.Optional(Type.String()),
    reason: Type.Optional(Type.String()),
  },
  { additionalProperties: false }
);
export type EventTraceAuditEntry = Static<typeof EventTraceAuditEntrySchema>;

export const RedactedNotificationEventSchema = Type.Object(
  {
    id: NonEmptyStringSchema,
    source: NonEmptyStringSchema,
    eventType: NonEmptyStringSchema,
    schemaVersion: Type.Integer({ minimum: 1 }),
    occurrenceKey: NonEmptyStringSchema,
    payloadHash: Type.String({ pattern: '^[a-f0-9]{64}$' }),
    status: EventStatusSchema,
    occurredAt: DateTimeSchema,
    createdAt: DateTimeSchema,
    resolvedAt: Type.Union([DateTimeSchema, Type.Null()]),
    retentionExpiresAt: DateTimeSchema,
  },
  { additionalProperties: false }
);

export const RedactedLogicalNotificationSchema = Type.Object(
  {
    id: NonEmptyStringSchema,
    eventId: NonEmptyStringSchema,
    kindId: NonEmptyStringSchema,
    kindVersion: Type.Integer({ minimum: 1 }),
    userId: NonEmptyStringSchema,
    eligibilityReason: NonEmptyStringSchema,
    locale: LocaleSchema,
    inboxVisible: Type.Boolean(),
    readAt: Type.Union([DateTimeSchema, Type.Null()]),
    archivedAt: Type.Union([DateTimeSchema, Type.Null()]),
    createdAt: DateTimeSchema,
    retentionExpiresAt: DateTimeSchema,
  },
  { additionalProperties: false }
);

export const RedactedDeliverySchema = Type.Object(
  {
    id: NonEmptyStringSchema,
    deliveryKey: NonEmptyStringSchema,
    logicalNotificationId: Type.Union([Type.String(), Type.Null()]),
    digestBatchId: Type.Union([Type.String(), Type.Null()]),
    kindId: NonEmptyStringSchema,
    userId: NonEmptyStringSchema,
    channel: ExternalChannelSchema,
    status: DeliveryStateSchema,
    attemptCount: Type.Integer({ minimum: 0 }),
    notBefore: Type.Union([DateTimeSchema, Type.Null()]),
    expiresAt: Type.Union([DateTimeSchema, Type.Null()]),
    nextAttemptAt: Type.Union([DateTimeSchema, Type.Null()]),
    lastErrorCode: Type.Union([Type.String(), Type.Null()]),
    providerRef: Type.Union([Type.String(), Type.Null()]),
    senderMode: Type.Union([Type.Literal('shadow'), Type.Literal('active')]),
    createdAt: DateTimeSchema,
    updatedAt: DateTimeSchema,
    acceptedAt: Type.Union([DateTimeSchema, Type.Null()]),
    terminalAt: Type.Union([DateTimeSchema, Type.Null()]),
    retentionExpiresAt: DateTimeSchema,
  },
  { additionalProperties: false }
);

export const RedactedDeliveryAttemptSchema = Type.Object(
  {
    attemptNumber: Type.Integer({ minimum: 1 }),
    result: Type.Union([AttemptResultSchema, Type.Null()]),
    errorCode: Type.Union([Type.String(), Type.Null()]),
    latencyMs: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
    startedAt: DateTimeSchema,
    completedAt: Type.Union([DateTimeSchema, Type.Null()]),
  },
  { additionalProperties: false }
);

export const EventTraceDeliverySchema = Type.Object(
  {
    delivery: RedactedDeliverySchema,
    attempts: Type.Array(RedactedDeliveryAttemptSchema),
  },
  { additionalProperties: false }
);
export type EventTraceDelivery = Static<typeof EventTraceDeliverySchema>;

export const EventTraceLogicalNotificationSchema = Type.Object(
  {
    logicalNotification: RedactedLogicalNotificationSchema,
    deliveries: Type.Array(EventTraceDeliverySchema),
  },
  { additionalProperties: false }
);
export type EventTraceLogicalNotification = Static<typeof EventTraceLogicalNotificationSchema>;

export const EventTraceSchema = Type.Object(
  {
    event: RedactedNotificationEventSchema,
    logicalNotifications: Type.Array(EventTraceLogicalNotificationSchema),
    auditEntries: Type.Array(EventTraceAuditEntrySchema),
  },
  { additionalProperties: false }
);
export type EventTrace = Static<typeof EventTraceSchema>;

export const DeadLetterSearchFilterSchema = Type.Object(
  {
    kindId: Type.Optional(NonEmptyStringSchema),
    channel: Type.Optional(ExternalChannelSchema),
    status: Type.Optional(DeliveryStateSchema),
    eventId: Type.Optional(NonEmptyStringSchema),
    userId: Type.Optional(NonEmptyStringSchema),
  },
  { additionalProperties: false }
);
export type DeadLetterSearchFilter = Static<typeof DeadLetterSearchFilterSchema>;

export const ShadowComparisonSummarySchema = Type.Object(
  {
    kindId: NonEmptyStringSchema,
    periodKey: Type.Union([Type.String(), Type.Null()]),
    legacyRecipientCount: Type.Integer({ minimum: 0 }),
    shadowRecipientCount: Type.Integer({ minimum: 0 }),
    matchingRecipientCount: Type.Integer({ minimum: 0 }),
    legacyOnlyRecipientCount: Type.Integer({ minimum: 0 }),
    shadowOnlyRecipientCount: Type.Integer({ minimum: 0 }),
    matchingContentCount: Type.Integer({ minimum: 0 }),
    contentMismatchCount: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false }
);
export type ShadowComparisonSummary = Static<typeof ShadowComparisonSummarySchema>;

export const SuppressionViewSchema = Type.Object(
  {
    userId: NonEmptyStringSchema,
    channel: ExternalChannelSchema,
    fingerprint: NonEmptyStringSchema,
    generation: Type.Integer({ minimum: 1 }),
    suppressedAt: Type.Union([DateTimeSchema, Type.Null()]),
    suppressionReason: Type.Union([Type.String(), Type.Null()]),
  },
  { additionalProperties: false }
);
export type SuppressionView = Static<typeof SuppressionViewSchema>;

export const RevealedDeliveryContentSchema = Type.Object(
  {
    deliveryId: NonEmptyStringSchema,
    templateId: Type.Union([Type.String(), Type.Null()]),
    templateVersion: Type.Union([Type.String(), Type.Null()]),
    subject: Type.Union([Type.String(), Type.Null()]),
    html: Type.Union([Type.String(), Type.Null()]),
    text: Type.Union([Type.String(), Type.Null()]),
    contentHash: Type.Union([Type.String(), Type.Null()]),
  },
  { additionalProperties: false }
);
export type RevealedDeliveryContent = Static<typeof RevealedDeliveryContentSchema>;

export const AdminEventIdParamsSchema = Type.Object(
  { id: NonEmptyStringSchema },
  { additionalProperties: false }
);
export type AdminEventIdParams = Static<typeof AdminEventIdParamsSchema>;

export const EventTraceResponseSchema = Type.Object(
  { ok: Type.Literal(true), data: EventTraceSchema },
  { additionalProperties: false }
);
export type EventTraceResponse = Static<typeof EventTraceResponseSchema>;

export const DeadLetterSearchQuerySchema = Type.Object(
  {
    kindId: Type.Optional(NonEmptyStringSchema),
    channel: Type.Optional(ExternalChannelSchema),
    status: Type.Optional(DeliveryStateSchema),
    eventId: Type.Optional(NonEmptyStringSchema),
    userId: Type.Optional(NonEmptyStringSchema),
    cursor: Type.Optional(NonEmptyStringSchema),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 50 })),
  },
  { additionalProperties: false }
);
export type DeadLetterSearchQuery = Static<typeof DeadLetterSearchQuerySchema>;

export const DeadLetterSearchResponseSchema = Type.Object(
  {
    ok: Type.Literal(true),
    data: Type.Object({
      items: Type.Array(RedactedDeliverySchema),
      nextCursor: Type.Union([Type.String(), Type.Null()]),
    }),
  },
  { additionalProperties: false }
);
export type DeadLetterSearchResponse = Static<typeof DeadLetterSearchResponseSchema>;

export const AdminDeliveryIdParamsSchema = Type.Object(
  { id: NonEmptyStringSchema },
  { additionalProperties: false }
);
export type AdminDeliveryIdParams = Static<typeof AdminDeliveryIdParamsSchema>;

export const RequeueDeadLetterBodySchema = Type.Object(
  {
    reason: NonEmptyStringSchema,
    acknowledgeDuplicateRisk: Type.Boolean({ default: false }),
  },
  { additionalProperties: false }
);
export type RequeueDeadLetterBody = Static<typeof RequeueDeadLetterBodySchema>;

export const RequeueDeadLetterResponseSchema = Type.Object(
  { ok: Type.Literal(true), data: Type.Object({ requeued: Type.Boolean() }) },
  { additionalProperties: false }
);
export type RequeueDeadLetterResponse = Static<typeof RequeueDeadLetterResponseSchema>;

export const RevealDeliveryContentBodySchema = Type.Object(
  { reason: NonEmptyStringSchema },
  { additionalProperties: false }
);
export type RevealDeliveryContentBody = Static<typeof RevealDeliveryContentBodySchema>;

export const RevealDeliveryContentResponseSchema = Type.Object(
  { ok: Type.Literal(true), data: RevealedDeliveryContentSchema },
  { additionalProperties: false }
);
export type RevealDeliveryContentResponse = Static<typeof RevealDeliveryContentResponseSchema>;

export const SuppressionListQuerySchema = Type.Object(
  {
    userId: Type.Optional(NonEmptyStringSchema),
    cursor: Type.Optional(NonEmptyStringSchema),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 50 })),
  },
  { additionalProperties: false }
);
export type SuppressionListQuery = Static<typeof SuppressionListQuerySchema>;

export const SuppressionListResponseSchema = Type.Object(
  {
    ok: Type.Literal(true),
    data: Type.Object({
      items: Type.Array(SuppressionViewSchema),
      nextCursor: Type.Union([Type.String(), Type.Null()]),
    }),
  },
  { additionalProperties: false }
);
export type SuppressionListResponse = Static<typeof SuppressionListResponseSchema>;

export const ShadowComparisonParamsSchema = Type.Object(
  { kindId: NonEmptyStringSchema },
  { additionalProperties: false }
);
export type ShadowComparisonParams = Static<typeof ShadowComparisonParamsSchema>;

export const ShadowComparisonQuerySchema = Type.Object(
  { periodKey: Type.Optional(NonEmptyStringSchema) },
  { additionalProperties: false }
);
export type ShadowComparisonQuery = Static<typeof ShadowComparisonQuerySchema>;

export const ShadowComparisonResponseSchema = Type.Object(
  { ok: Type.Literal(true), data: ShadowComparisonSummarySchema },
  { additionalProperties: false }
);
export type ShadowComparisonResponse = Static<typeof ShadowComparisonResponseSchema>;

export const AdminDigestBatchIdParamsSchema = Type.Object(
  { id: NonEmptyStringSchema },
  { additionalProperties: false }
);
export type AdminDigestBatchIdParams = Static<typeof AdminDigestBatchIdParamsSchema>;

export const CancelDigestBatchBodySchema = Type.Object(
  { reason: NonEmptyStringSchema },
  { additionalProperties: false }
);
export type CancelDigestBatchBody = Static<typeof CancelDigestBatchBodySchema>;

export const CancelDigestBatchResponseSchema = Type.Object(
  { ok: Type.Literal(true), data: Type.Object({ cancelled: Type.Boolean() }) },
  { additionalProperties: false }
);
export type CancelDigestBatchResponse = Static<typeof CancelDigestBatchResponseSchema>;
