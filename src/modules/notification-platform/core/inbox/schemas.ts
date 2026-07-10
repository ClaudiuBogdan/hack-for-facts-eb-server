import { Type, type Static } from '@sinclair/typebox';

import {
  DateTimeSchema,
  LocaleSchema,
  NonEmptyStringSchema,
  UnknownRecordSchema,
} from '../shared/schemas.js';

export const InboxViewSchema = Type.Union([
  Type.Literal('all'),
  Type.Literal('unread'),
  Type.Literal('archived'),
]);
export type InboxView = Static<typeof InboxViewSchema>;

export const LogicalNotificationSchema = Type.Object(
  {
    id: NonEmptyStringSchema,
    eventId: NonEmptyStringSchema,
    kindId: NonEmptyStringSchema,
    kindVersion: Type.Integer({ minimum: 1 }),
    userId: NonEmptyStringSchema,
    eligibilityReason: NonEmptyStringSchema,
    locale: LocaleSchema,
    recipientFacts: Type.Union([UnknownRecordSchema, Type.Null()]),
    inboxTemplateId: NonEmptyStringSchema,
    inboxTemplateVersion: NonEmptyStringSchema,
    inboxTitle: Type.String(),
    inboxBody: Type.String(),
    inboxActionUrl: Type.Union([Type.String(), Type.Null()]),
    inboxVisible: Type.Boolean(),
    readAt: Type.Union([DateTimeSchema, Type.Null()]),
    archivedAt: Type.Union([DateTimeSchema, Type.Null()]),
    streamKey: Type.Union([Type.String(), Type.Null()]),
    streamSequence: Type.Union([Type.Integer(), Type.Null()]),
    createdAt: DateTimeSchema,
    retentionExpiresAt: DateTimeSchema,
  },
  { additionalProperties: false }
);
export type LogicalNotification = Static<typeof LogicalNotificationSchema>;

export const InboxListQuerySchema = Type.Object(
  {
    view: Type.Optional(InboxViewSchema),
    cursor: Type.Optional(NonEmptyStringSchema),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 50 })),
  },
  { additionalProperties: false }
);
export type InboxListQuery = Static<typeof InboxListQuerySchema>;

export const InboxIdParamsSchema = Type.Object(
  { id: NonEmptyStringSchema },
  { additionalProperties: false }
);
export type InboxIdParams = Static<typeof InboxIdParamsSchema>;

export const InboxListResponseSchema = Type.Object(
  {
    ok: Type.Literal(true),
    data: Type.Object({
      items: Type.Array(LogicalNotificationSchema),
      nextCursor: Type.Union([Type.String(), Type.Null()]),
    }),
  },
  { additionalProperties: false }
);
export type InboxListResponse = Static<typeof InboxListResponseSchema>;

export const UnreadCountResponseSchema = Type.Object(
  { ok: Type.Literal(true), data: Type.Object({ count: Type.Integer({ minimum: 0 }) }) },
  { additionalProperties: false }
);
export type UnreadCountResponse = Static<typeof UnreadCountResponseSchema>;

export const MarkAllReadResponseSchema = Type.Object(
  { ok: Type.Literal(true), data: Type.Object({ updated: Type.Integer({ minimum: 0 }) }) },
  { additionalProperties: false }
);
export type MarkAllReadResponse = Static<typeof MarkAllReadResponseSchema>;
