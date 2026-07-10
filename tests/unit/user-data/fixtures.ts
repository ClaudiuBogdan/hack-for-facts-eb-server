import { Type, type TSchema } from '@sinclair/typebox';

import { hashSchema } from '@/common/canonical-json/index.js';
import {
  type CategoryDefinition,
  type ResolvedCategory,
} from '@/modules/user-data/core/registry/types.js';
import {
  type CurrentRecord,
  type ReceiptClaim,
  type RecordIdentity,
} from '@/modules/user-data/core/types.js';

import { expectOk } from '../../support/result.js';

export const identity: RecordIdentity = {
  ownerId: 'owner-1',
  category: 'test.category',
  logicalKey: 'record:key',
};

export const receipt: ReceiptClaim = {
  requesterId: 'owner-1',
  idempotencyKeyHash: 'key-hash',
  canonicalRequestHash: 'request-hash',
};

export const makeDefinition = (
  input: {
    schema?: TSchema;
    writeEnabled?: boolean;
    pattern?: RegExp;
    maxLength?: number;
    maxPayloadBytes?: number;
    annotationSchema?: TSchema;
    annotationMaxBytes?: number;
    allowedActorTypes?: readonly ('system' | 'admin')[];
  } = {}
): CategoryDefinition => {
  const schema = input.schema ?? Type.Object({ value: Type.String({ maxLength: 16_384 }) });
  const annotationSchema =
    input.annotationSchema ?? Type.Object({ status: Type.String({ maxLength: 32 }) });
  return {
    category: identity.category,
    schemaVersions: [
      {
        version: 1,
        schema,
        schemaHash: expectOk(hashSchema(schema)),
        readable: true,
        writeEnabled: input.writeEnabled ?? true,
      },
    ],
    maxPayloadBytes: input.maxPayloadBytes ?? 65_536,
    logicalKey: { pattern: input.pattern ?? /^record:\S+$/, maxLength: input.maxLength ?? 128 },
    target: { required: false, allowedTypes: ['entity'] },
    redactor: () => ({}),
    queryFields: [],
    annotationNamespaces: [
      {
        namespace: 'review',
        schema: annotationSchema,
        schemaHash: expectOk(hashSchema(annotationSchema)),
        maxBytes: input.annotationMaxBytes ?? 1024,
        allowedActorTypes: input.allowedActorTypes ?? ['system', 'admin'],
        redactor: () => ({}),
      },
    ],
    maxRecordsPerOwner: 10,
    writeRateLimitPerMinute: 20,
    adminPermission: 'test:admin',
  };
};

export const resolveDefinition = (definition = makeDefinition()): ResolvedCategory => ({
  definition,
  schemaVersion: definition.schemaVersions[0]!,
});

export const makeCurrent = (overrides: Partial<CurrentRecord> = {}): CurrentRecord => ({
  recordId: 'record-id',
  identity,
  target: { targetType: 'entity', targetId: '123' },
  schemaVersion: 1,
  schemaHash: resolveDefinition().schemaVersion.schemaHash,
  revision: 3,
  status: 'active',
  payload: { value: 'old' },
  annotations: { review: { status: 'pending', keep: true } },
  lastEventSeq: '7',
  lastEventId: 'event-old',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-02T00:00:00.000Z'),
  deletedAt: null,
  privacyRedactedAt: null,
  ...overrides,
});
