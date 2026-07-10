import {
  type ActorContext,
  type PlannedMutation,
  type ReceiptClaim,
  type RecordIdentity,
} from '@/modules/user-data/core/types.js';

export const makeRecordIdentity = (overrides: Partial<RecordIdentity> = {}): RecordIdentity => ({
  ownerId: 'owner-1',
  category: 'test.category',
  logicalKey: 'record:1',
  ...overrides,
});

export const makeReceiptClaim = (overrides: Partial<ReceiptClaim> = {}): ReceiptClaim => ({
  requesterId: 'owner-1',
  idempotencyKeyHash: 'idempotency-key-1',
  canonicalRequestHash: 'canonical-request-1',
  ...overrides,
});

export const makePlannedMutation = (
  overrides: Partial<PlannedMutation> & Pick<PlannedMutation, 'operation'> = {
    operation: 'create',
  }
): PlannedMutation => {
  const operation = overrides.operation;
  const expectedRevision = overrides.expectedRevision ?? (operation === 'create' ? 0 : 1);
  const actor: ActorContext = overrides.actor ?? { type: 'owner' };
  return {
    operation,
    scope: overrides.scope ?? (operation === 'annotate' ? 'annotation' : 'payload'),
    annotationNamespace:
      overrides.annotationNamespace ?? (operation === 'annotate' ? 'review' : null),
    identity: overrides.identity ?? makeRecordIdentity(),
    recordId: overrides.recordId ?? 'record-id-1',
    eventId: overrides.eventId ?? `event-${String(expectedRevision + 1)}`,
    target: overrides.target ?? null,
    expectedRevision,
    nextRevision: overrides.nextRevision ?? expectedRevision + 1,
    afterImage: overrides.afterImage ?? {
      status: operation === 'delete' ? 'deleted' : 'active',
      payload:
        operation === 'delete' ? null : { value: `revision-${String(expectedRevision + 1)}` },
      annotations: null,
      schemaVersion: 1,
      schemaHash: 'schema-hash-1',
    },
    actor,
    clientOccurredAt: overrides.clientOccurredAt ?? null,
    receipt: overrides.receipt ?? makeReceiptClaim(),
    quota:
      overrides.quota === undefined
        ? operation === 'create'
          ? { maxRecordsInCategory: 10 }
          : null
        : overrides.quota,
  };
};
