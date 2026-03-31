/**
 * Notification Delivery Module - TypeBox Schemas
 *
 * Runtime validation schemas for BullMQ job payloads.
 */

import { Type } from '@sinclair/typebox';

// ─────────────────────────────────────────────────────────────────────────────
// Job Payload Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const CollectJobPayloadSchema = Type.Object({
  runId: Type.String({ minLength: 1 }),
  notificationType: Type.String({ minLength: 1 }),
  periodKey: Type.String({ minLength: 1 }),
  notificationIds: Type.Array(Type.String({ minLength: 1 })),
});

export const ComposeSubscriptionJobPayloadSchema = Type.Object({
  runId: Type.String({ minLength: 1 }),
  kind: Type.Literal('subscription'),
  notificationId: Type.String({ minLength: 1 }),
  periodKey: Type.String({ minLength: 1 }),
});

export const ComposeOutboxJobPayloadSchema = Type.Object({
  runId: Type.String({ minLength: 1 }),
  kind: Type.Literal('outbox'),
  outboxId: Type.String({ minLength: 1 }),
});

export const ComposeJobPayloadSchema = Type.Union([
  ComposeSubscriptionJobPayloadSchema,
  ComposeOutboxJobPayloadSchema,
]);

export const SendJobPayloadSchema = Type.Object({
  outboxId: Type.String({ minLength: 1 }),
});

export const RecoveryJobPayloadSchema = Type.Object({
  thresholdMinutes: Type.Number({ minimum: 1 }),
});
