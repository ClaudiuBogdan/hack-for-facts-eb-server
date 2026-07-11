import { Type, type Static } from '@sinclair/typebox';

const JsonObjectSchema = Type.Object({}, { additionalProperties: true });
const NullableJsonObjectSchema = Type.Union([JsonObjectSchema, Type.Null()]);

export const RecordTargetSchema = Type.Object(
  {
    targetType: Type.String({ minLength: 1 }),
    targetId: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false }
);

export const RecordViewSchema = Type.Object(
  {
    recordId: Type.String(),
    category: Type.String(),
    logicalKey: Type.String(),
    target: Type.Union([RecordTargetSchema, Type.Null()]),
    schemaVersion: Type.Integer({ minimum: 1 }),
    revision: Type.Integer({ minimum: 1 }),
    status: Type.Union([Type.Literal('active'), Type.Literal('deleted')]),
    payload: NullableJsonObjectSchema,
    annotations: NullableJsonObjectSchema,
    createdAt: Type.String({ format: 'date-time' }),
    updatedAt: Type.String({ format: 'date-time' }),
    deletedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  },
  { additionalProperties: false }
);

export const MutationResponseSchema = Type.Object(
  {
    record: RecordViewSchema,
    eventId: Type.String(),
    eventSeq: Type.String({ pattern: '^\\d+$' }),
    recordedAt: Type.String({ format: 'date-time' }),
    replayed: Type.Boolean(),
  },
  { additionalProperties: false }
);

export const MutationBodySchema = Type.Object(
  {
    schemaVersion: Type.Integer({ minimum: 1 }),
    expectedRevision: Type.Integer({ minimum: 0 }),
    idempotencyKey: Type.String({ minLength: 8, maxLength: 128 }),
    payload: JsonObjectSchema,
    target: Type.Optional(RecordTargetSchema),
    clientOccurredAt: Type.Optional(Type.String({ format: 'date-time' })),
  },
  { additionalProperties: false }
);

/** DELETE uses query parameters so browser and proxy clients need not send a DELETE body. */
export const DeleteMutationQuerySchema = Type.Object(
  {
    expectedRevision: Type.Integer({ minimum: 0 }),
    idempotencyKey: Type.String({ minLength: 8, maxLength: 128 }),
    clientOccurredAt: Type.Optional(Type.String({ format: 'date-time' })),
  },
  { additionalProperties: false }
);

/** logicalKey is one percent-encoded path segment; e.g. legacy:key is sent as legacy%3Akey. */
export const RecordKeyParamsSchema = Type.Object({
  category: Type.String({ minLength: 1 }),
  logicalKey: Type.String({ minLength: 1, maxLength: 512 }),
});
export const CategoryParamsSchema = Type.Object({ category: Type.String({ minLength: 1 }) });
export const AdminHistoryParamsSchema = Type.Object({
  category: Type.String({ minLength: 1 }),
  recordId: Type.String({ minLength: 1 }),
});

export const PageQuerySchema = Type.Object({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500, default: 100 })),
  cursor: Type.Optional(Type.String({ minLength: 1 })),
});
export const HistoryQuerySchema = Type.Object({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500, default: 100 })),
  beforeRevision: Type.Optional(Type.Integer({ minimum: 1 })),
});
export const SyncQuerySchema = Type.Object({
  cursor: Type.Optional(Type.String({ minLength: 1 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500, default: 100 })),
  category: Type.Optional(Type.String({ minLength: 1 })),
});
export const AdminListQuerySchema = Type.Object({
  status: Type.Optional(Type.Union([Type.Literal('active'), Type.Literal('deleted')])),
  targetType: Type.Optional(Type.String({ minLength: 1 })),
  targetId: Type.Optional(Type.String({ minLength: 1 })),
  createdFrom: Type.Optional(Type.String({ format: 'date-time' })),
  createdTo: Type.Optional(Type.String({ format: 'date-time' })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500, default: 100 })),
  cursor: Type.Optional(Type.String({ minLength: 1 })),
  /** JSON object keyed by registered field, with {operator:'eq'|'in',value:...}. */
  filters: Type.Optional(Type.String({ minLength: 2 })),
});

export const PageResponseSchema = Type.Object({
  items: Type.Array(RecordViewSchema),
  nextCursor: Type.Union([Type.String(), Type.Null()]),
});

const ActorContextSchema = Type.Union([
  Type.Object({ type: Type.Literal('owner') }, { additionalProperties: false }),
  Type.Object(
    { type: Type.Literal('system'), source: Type.String() },
    { additionalProperties: false }
  ),
  Type.Object(
    { type: Type.Literal('admin'), actorId: Type.String(), reason: Type.String() },
    { additionalProperties: false }
  ),
]);
const UserDataEventSchema = Type.Object(
  {
    eventSeq: Type.String({ pattern: '^\\d+$' }),
    eventId: Type.String(),
    recordId: Type.String(),
    identity: Type.Object({
      ownerId: Type.String(),
      category: Type.String(),
      logicalKey: Type.String(),
    }),
    target: Type.Union([RecordTargetSchema, Type.Null()]),
    revision: Type.Integer({ minimum: 1 }),
    operation: Type.Union(
      ['create', 'replace', 'annotate', 'delete', 'restore', 'migrate', 'legacy_import'].map(
        (operation) => Type.Literal(operation)
      )
    ),
    scope: Type.Union([Type.Literal('payload'), Type.Literal('annotation')]),
    annotationNamespace: Type.Union([Type.String(), Type.Null()]),
    schemaVersion: Type.Integer({ minimum: 1 }),
    schemaHash: Type.String(),
    payload: NullableJsonObjectSchema,
    annotations: NullableJsonObjectSchema,
    actor: ActorContextSchema,
    provenance: Type.Union([Type.Literal('live'), Type.Literal('legacy')]),
    integrity: Type.Union([Type.Literal('verified'), Type.Literal('unverified')]),
    recordedAt: Type.String({ format: 'date-time' }),
    clientOccurredAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
    privacyRedactedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  },
  { additionalProperties: false }
);
export const EventPageResponseSchema = Type.Object({
  items: Type.Array(UserDataEventSchema),
  nextCursor: Type.Union([Type.String(), Type.Null()]),
});
export const SyncResponseSchema = Type.Object({
  items: Type.Array(RecordViewSchema),
  nextCursor: Type.String(),
  hasMore: Type.Boolean(),
});

export const ErrorResponseSchema = Type.Object(
  {
    error: Type.String(),
    code: Type.Optional(Type.String()),
    message: Type.String(),
    retryable: Type.Boolean(),
    violations: Type.Optional(Type.Array(Type.String())),
    current: Type.Optional(RecordViewSchema),
    limit: Type.Optional(Type.Integer()),
  },
  { additionalProperties: false }
);

export type MutationBody = Static<typeof MutationBodySchema>;
export type DeleteMutationQuery = Static<typeof DeleteMutationQuerySchema>;
export type RecordKeyParams = Static<typeof RecordKeyParamsSchema>;
export type CategoryParams = Static<typeof CategoryParamsSchema>;
export type AdminHistoryParams = Static<typeof AdminHistoryParamsSchema>;
export type PageQuery = Static<typeof PageQuerySchema>;
export type HistoryQuery = Static<typeof HistoryQuerySchema>;
export type SyncQuery = Static<typeof SyncQuerySchema>;
export type AdminListQuery = Static<typeof AdminListQuerySchema>;
