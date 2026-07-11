import { err, ok } from 'neverthrow';

import { type UserDataError } from '@/modules/user-data/core/errors.js';
import {
  type MutationOutcome,
  type MutationRateLimiterPort,
  type MutationResultData,
  type UserDataAdminReadPort,
  type UserDataErasurePort,
  type UserDataMutationPort,
  type UserDataReadPort,
  type UserDataReconciliationPort,
} from '@/modules/user-data/core/ports.js';
import {
  type AdminRecordFilters,
  type CurrentRecord,
  type PlannedMutation,
  type ReceiptClaim,
  type ReconciliationViolation,
  type ResolvedRedactors,
  type UserDataEvent,
} from '@/modules/user-data/core/types.js';

import {
  makeFaultPlan,
  makeKeyedStore,
  type FaultPlan,
  type KeyedStore,
  type SequentialIds,
  type TestClock,
} from '../../support/index.js';

type FakeMethod =
  | 'getForMutation'
  | 'probeReceipt'
  | 'commit'
  | 'deleteExpiredReceipts'
  | 'findByKey'
  | 'findById'
  | 'listByCategory'
  | 'findByTarget'
  | 'syncSince'
  | 'historyByRecord'
  | 'adminListByCategory'
  | 'adminHistoryByCategory'
  | 'eraseOwner'
  | 'findViolations';

export interface FakeReceipt {
  requesterId: string;
  idempotencyKeyHash: string;
  canonicalRequestHash: string;
  result: MutationResultData;
  expiresAt: Date;
}

export interface FakeUserDataStore
  extends
    UserDataMutationPort,
    UserDataReadPort,
    UserDataAdminReadPort,
    UserDataErasurePort,
    UserDataReconciliationPort {
  records: KeyedStore<string, CurrentRecord>;
  events: KeyedStore<string, UserDataEvent>;
  receipts: KeyedStore<string, FakeReceipt>;
  faults: FaultPlan<FakeMethod, UserDataError>;
  ids: SequentialIds;
  reset(): void;
}

const identityKey = (input: { ownerId: string; category: string; logicalKey: string }): string =>
  `${input.ownerId}\u0000${input.category}\u0000${input.logicalKey}`;
const receiptKey = (input: Pick<ReceiptClaim, 'requesterId' | 'idempotencyKeyHash'>): string =>
  `${input.requesterId}\u0000${input.idempotencyKeyHash}`;

const faultResult = <T>(fault: UserDataError | undefined) =>
  fault === undefined ? undefined : err<T, UserDataError>(fault);

const compareDecimal = (left: string, right: string): number =>
  BigInt(left) < BigInt(right) ? -1 : BigInt(left) > BigInt(right) ? 1 : 0;

const redactAnnotations = (
  category: string,
  annotations: CurrentRecord['annotations'],
  redactors: ResolvedRedactors
): CurrentRecord['annotations'] => {
  if (annotations === null) return null;
  const categoryRedactors = redactors.annotationsByCategory[category] ?? {};
  return Object.fromEntries(
    Object.entries(annotations).map(([namespace, annotation]) => [
      namespace,
      categoryRedactors[namespace]?.(annotation) ?? {},
    ])
  );
};

const matchesAdminFilters = (record: CurrentRecord, filters: AdminRecordFilters): boolean => {
  if (filters.status !== undefined && record.status !== filters.status) return false;
  if (
    filters.target !== undefined &&
    (record.target?.targetType !== filters.target.targetType ||
      record.target.targetId !== filters.target.targetId)
  )
    return false;
  if (filters.createdAtFrom !== undefined && record.createdAt < filters.createdAtFrom) return false;
  if (filters.createdAtTo !== undefined && record.createdAt > filters.createdAtTo) return false;
  if (filters.query === undefined) return true;
  for (const [field, raw] of Object.entries(filters.query)) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return false;
    const condition = raw as Record<string, unknown>;
    const actual = record.payload?.[field];
    if (condition['operator'] === 'eq' && actual !== condition['value']) return false;
    if (
      condition['operator'] === 'in' &&
      (!Array.isArray(condition['value']) || !condition['value'].includes(actual))
    )
      return false;
  }
  return true;
};

export const makeFakeUserDataStore = (options: {
  clock: TestClock;
  ids: SequentialIds;
}): FakeUserDataStore => {
  const records = makeKeyedStore<string, CurrentRecord>({
    keyOf: (record) => identityKey(record.identity),
  });
  const events = makeKeyedStore<string, UserDataEvent>({ keyOf: (event) => event.eventId });
  const receipts = makeKeyedStore<string, FakeReceipt>({ keyOf: receiptKey });
  const faults = makeFaultPlan<FakeMethod, UserDataError>();
  let eventSequence = 0n;

  const currentByIdentity = (plan: PlannedMutation): CurrentRecord | undefined =>
    records.get(identityKey(plan.identity));
  const activeReceipt = (claim: ReceiptClaim): FakeReceipt | undefined => {
    const found = receipts.get(receiptKey(claim));
    return found !== undefined && found.expiresAt.getTime() > options.clock.now().getTime()
      ? found
      : undefined;
  };
  const fail = <T>(method: FakeMethod) => faultResult<T>(faults.intercept(method));

  const store: FakeUserDataStore = {
    records,
    events,
    receipts,
    faults,
    ids: options.ids,
    getForMutation: async (identity) => {
      const failure = fail<CurrentRecord | null>('getForMutation');
      if (failure !== undefined) return failure;
      return ok(records.get(identityKey(identity)) ?? null);
    },
    probeReceipt: async (claim) => {
      const failure = fail<'absent' | 'match' | 'mismatch'>('probeReceipt');
      if (failure !== undefined) return failure;
      const found = activeReceipt(claim);
      if (found === undefined) return ok('absent');
      return ok(found.canonicalRequestHash === claim.canonicalRequestHash ? 'match' : 'mismatch');
    },
    commit: async (plan) => {
      const failure = fail<MutationOutcome>('commit');
      if (failure !== undefined) return failure;

      const accepted = activeReceipt(plan.receipt);
      if (accepted !== undefined) {
        return accepted.canonicalRequestHash === plan.receipt.canonicalRequestHash
          ? ok({ kind: 'replayed', result: accepted.result })
          : ok({ kind: 'idempotencyConflict' });
      }

      const current = currentByIdentity(plan);
      if (
        (plan.expectedRevision === 0 && current !== undefined) ||
        (plan.expectedRevision !== 0 && current?.revision !== plan.expectedRevision)
      ) {
        if (current === undefined)
          return err({ type: 'DatabaseError', message: 'CAS row disappeared', retryable: true });
        return ok({ kind: 'revisionConflict', current });
      }

      if (plan.operation === 'create' && plan.quota !== null) {
        const liveCount = records.filter(
          (record) =>
            record.identity.ownerId === plan.identity.ownerId &&
            record.identity.category === plan.identity.category &&
            record.status === 'active'
        ).length;
        if (liveCount >= plan.quota.maxRecordsInCategory)
          return ok({ kind: 'quotaExceeded', limit: plan.quota.maxRecordsInCategory });
      }

      eventSequence += 1n;
      const eventSeq = eventSequence.toString();
      const recordedAt = options.clock.now();
      const record: CurrentRecord = {
        recordId: plan.recordId,
        identity: plan.identity,
        target: plan.target,
        schemaVersion: plan.afterImage.schemaVersion,
        schemaHash: plan.afterImage.schemaHash,
        revision: plan.nextRevision,
        status: plan.afterImage.status,
        payload: plan.afterImage.payload,
        annotations: plan.afterImage.annotations,
        lastEventSeq: eventSeq,
        lastEventId: plan.eventId,
        createdAt: current?.createdAt ?? recordedAt,
        updatedAt: recordedAt,
        deletedAt: plan.afterImage.status === 'deleted' ? recordedAt : null,
        privacyRedactedAt: current?.privacyRedactedAt ?? null,
      };
      const event: UserDataEvent = {
        eventSeq,
        eventId: plan.eventId,
        recordId: plan.recordId,
        identity: plan.identity,
        target: plan.target,
        revision: plan.nextRevision,
        operation: plan.operation,
        scope: plan.scope,
        annotationNamespace: plan.annotationNamespace,
        schemaVersion: plan.afterImage.schemaVersion,
        schemaHash: plan.afterImage.schemaHash,
        payload: plan.afterImage.payload,
        annotations: plan.afterImage.annotations,
        actor: plan.actor,
        provenance: 'live',
        integrity: 'verified',
        recordedAt,
        clientOccurredAt: plan.clientOccurredAt,
        privacyRedactedAt: null,
      };
      const result: MutationResultData = { record, eventId: plan.eventId, eventSeq, recordedAt };
      records.put(record);
      events.put(event);
      receipts.put({
        ...plan.receipt,
        result,
        expiresAt: new Date(recordedAt.getTime() + 30 * 24 * 60 * 60 * 1000),
      });
      return ok({ kind: 'committed', result });
    },
    deleteExpiredReceipts: async (now) => {
      const failure = fail<number>('deleteExpiredReceipts');
      if (failure !== undefined) return failure;
      let deleted = 0;
      for (const receipt of receipts.list()) {
        if (receipt.expiresAt.getTime() <= now.getTime() && receipts.delete(receiptKey(receipt)))
          deleted += 1;
      }
      return ok(deleted);
    },
    findByKey: async (ownerId, category, logicalKey) => {
      const failure = fail<CurrentRecord | null>('findByKey');
      return failure ?? ok(records.get(identityKey({ ownerId, category, logicalKey })) ?? null);
    },
    findById: async (ownerId, recordId) => {
      const failure = fail<CurrentRecord | null>('findById');
      if (failure !== undefined) return failure;
      return ok(
        records.find(
          (record) => record.identity.ownerId === ownerId && record.recordId === recordId
        ) ?? null
      );
    },
    listByCategory: async (ownerId, category, page) => {
      const failure = fail<{ items: CurrentRecord[]; nextCursor: string | null }>('listByCategory');
      if (failure !== undefined) return failure;
      const rows = records
        .filter(
          (record) => record.identity.ownerId === ownerId && record.identity.category === category
        )
        .sort((left, right) => left.identity.logicalKey.localeCompare(right.identity.logicalKey))
        .filter((record) => page.cursor === null || record.identity.logicalKey > page.cursor);
      const items = rows.slice(0, page.limit);
      return ok({
        items,
        nextCursor: rows.length > page.limit ? (items.at(-1)?.identity.logicalKey ?? null) : null,
      });
    },
    findByTarget: async (ownerId, category, target) => {
      const failure = fail<CurrentRecord[]>('findByTarget');
      if (failure !== undefined) return failure;
      return ok(
        records.filter(
          (record) =>
            record.identity.ownerId === ownerId &&
            record.identity.category === category &&
            record.target?.targetType === target.targetType &&
            record.target.targetId === target.targetId
        )
      );
    },
    syncSince: async (ownerId, cursor, limit) => {
      const failure = fail<{ items: CurrentRecord[]; ownerHighWater: string }>('syncSince');
      if (failure !== undefined) return failure;
      const ownerRows = records.filter(
        (record) =>
          record.identity.ownerId === ownerId &&
          (cursor.category === null || record.identity.category === cursor.category)
      );
      const ownerHighWater = ownerRows.reduce(
        (highest, record) =>
          compareDecimal(record.lastEventSeq, highest) > 0 ? record.lastEventSeq : highest,
        '0'
      );
      const items = ownerRows
        .filter((record) => compareDecimal(record.lastEventSeq, cursor.lastSeq) > 0)
        .filter(
          (record) =>
            cursor.cycleHighWater === null ||
            compareDecimal(record.lastEventSeq, cursor.cycleHighWater) <= 0
        )
        .sort((left, right) => compareDecimal(left.lastEventSeq, right.lastEventSeq))
        .slice(0, limit);
      return ok({ items, ownerHighWater });
    },
    historyByRecord: async (ownerId, recordId, page) => {
      const failure = fail<{ items: UserDataEvent[]; nextCursor: string | null }>(
        'historyByRecord'
      );
      if (failure !== undefined) return failure;
      const rows = events
        .filter((event) => event.identity.ownerId === ownerId && event.recordId === recordId)
        .filter((event) => page.beforeRevision === null || event.revision < page.beforeRevision)
        .sort((left, right) => right.revision - left.revision);
      const items = rows.slice(0, page.limit);
      return ok({
        items,
        nextCursor: rows.length > page.limit ? String(items.at(-1)?.revision ?? '') : null,
      });
    },
    adminListByCategory: async (category, filters, page) => {
      const failure = fail<{ items: CurrentRecord[]; nextCursor: string | null }>(
        'adminListByCategory'
      );
      if (failure !== undefined) return failure;
      const rows = records
        .filter(
          (record) => record.identity.category === category && matchesAdminFilters(record, filters)
        )
        .sort((left, right) => left.recordId.localeCompare(right.recordId))
        .filter((record) => page.cursor === null || record.recordId > page.cursor);
      const items = rows.slice(0, page.limit);
      return ok({
        items,
        nextCursor: rows.length > page.limit ? (items.at(-1)?.recordId ?? null) : null,
      });
    },
    adminHistoryByCategory: async (category, recordId, page) => {
      const failure = fail<{ items: UserDataEvent[]; nextCursor: string | null }>(
        'adminHistoryByCategory'
      );
      if (failure !== undefined) return failure;
      const rows = events
        .filter((event) => event.identity.category === category && event.recordId === recordId)
        .filter((event) => page.beforeRevision === null || event.revision < page.beforeRevision)
        .sort((left, right) => right.revision - left.revision);
      const items = rows.slice(0, page.limit);
      return ok({
        items,
        nextCursor: rows.length > page.limit ? String(items.at(-1)?.revision ?? '') : null,
      });
    },
    eraseOwner: async (input) => {
      const failure = fail<{ records: number; events: number; receipts: number }>('eraseOwner');
      if (failure !== undefined) return failure;
      let recordCount = 0;
      let eventCount = 0;
      let receiptCount = 0;
      for (const record of records.filter(
        (candidate) => candidate.identity.ownerId === input.ownerId
      )) {
        const payloadRedactor = input.redactors.payloadByCategory[record.identity.category];
        records.put({
          ...record,
          identity: { ...record.identity, ownerId: input.anonymizedOwnerId },
          payload:
            record.payload === null ? null : (payloadRedactor?.(record.payload) ?? record.payload),
          annotations: redactAnnotations(
            record.identity.category,
            record.annotations,
            input.redactors
          ),
          privacyRedactedAt: input.now,
        });
        records.delete(identityKey(record.identity));
        recordCount += 1;
      }
      for (const event of events.filter(
        (candidate) => candidate.identity.ownerId === input.ownerId
      )) {
        const payloadRedactor = input.redactors.payloadByCategory[event.identity.category];
        events.put({
          ...event,
          identity: { ...event.identity, ownerId: input.anonymizedOwnerId },
          payload:
            event.payload === null ? null : (payloadRedactor?.(event.payload) ?? event.payload),
          annotations: redactAnnotations(
            event.identity.category,
            event.annotations,
            input.redactors
          ),
          clientOccurredAt: null,
          privacyRedactedAt: input.now,
        });
        eventCount += 1;
      }
      // Receipts are deleted by requester: the receipts table has no record-owner
      // column, and the events' owner is redacted in the same transaction, so
      // requester scope is the only semantics the real adapter can honor.
      for (const receipt of receipts.filter(
        (candidate) => candidate.requesterId === input.ownerId
      )) {
        if (receipts.delete(receiptKey(receipt))) receiptCount += 1;
      }
      return ok({ records: recordCount, events: eventCount, receipts: receiptCount });
    },
    findViolations: async ({ limit }) => {
      const failure = fail<{
        checkedRecords: number;
        violations: readonly ReconciliationViolation[];
      }>('findViolations');
      if (failure !== undefined) return failure;
      const candidates = records
        .list()
        .sort((left, right) => compareDecimal(right.lastEventSeq, left.lastEventSeq))
        .slice(0, limit);
      const violations: ReconciliationViolation[] = [];
      for (const record of candidates) {
        const recordEvents = events
          .filter((event) => event.recordId === record.recordId)
          .sort((left, right) => right.revision - left.revision);
        const latest = recordEvents[0];
        const maxRevision = latest?.revision;
        if (maxRevision !== undefined && record.revision !== maxRevision) {
          violations.push({
            recordId: record.recordId,
            kind: 'revisionMismatch',
            detail: `recordId=${record.recordId} currentRevision=${String(record.revision)} maxEventRevision=${String(maxRevision)}`,
          });
        }
        if (
          latest !== undefined &&
          (record.status !== (latest.operation === 'delete' ? 'deleted' : 'active') ||
            record.schemaVersion !== latest.schemaVersion ||
            JSON.stringify(record.payload) !== JSON.stringify(latest.payload) ||
            JSON.stringify(record.annotations) !== JSON.stringify(latest.annotations))
        ) {
          violations.push({
            recordId: record.recordId,
            kind: 'afterImageMismatch',
            detail: `recordId=${record.recordId} currentRevision=${String(record.revision)} latestEventRevision=${String(latest.revision)}`,
          });
        }
        if (
          !recordEvents.some(
            (event) =>
              event.eventSeq === record.lastEventSeq && event.eventId === record.lastEventId
          )
        ) {
          violations.push({
            recordId: record.recordId,
            kind: 'missingEvent',
            detail: `recordId=${record.recordId} revision=${String(record.revision)}`,
          });
        }
      }
      const cleanupAllowance = options.clock.now().getTime() - 7 * 24 * 60 * 60 * 1000;
      const expiredReceipts = receipts.filter(
        (receipt) => receipt.expiresAt.getTime() < cleanupAllowance
      ).length;
      if (expiredReceipts > 0) {
        violations.push({
          recordId: 'receipts',
          kind: 'expiredReceipts',
          detail: `expiredReceiptCount=${String(expiredReceipts)}`,
        });
      }
      return ok({ checkedRecords: candidates.length, violations });
    },
    reset: () => {
      records.clear();
      events.clear();
      receipts.clear();
      faults.clear();
      eventSequence = 0n;
    },
  };
  return store;
};

export interface FakeMutationRateLimiter extends MutationRateLimiterPort {
  calls: number;
  deny(retryAfterSeconds?: number): void;
  allow(): void;
}

export const makeFakeMutationRateLimiter = (): FakeMutationRateLimiter => {
  let deniedRetry: number | null = null;
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    consume: async () => {
      calls += 1;
      return deniedRetry === null
        ? ok({ allowed: true as const })
        : ok({ allowed: false as const, retryAfterSeconds: deniedRetry });
    },
    deny: (retryAfterSeconds = 60) => {
      deniedRetry = retryAfterSeconds;
    },
    allow: () => {
      deniedRetry = null;
    },
  };
};
