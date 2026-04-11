/**
 * Learning Progress Module - Snapshot and Delta Helpers
 */

import {
  SNAPSHOT_VERSION,
  type InteractiveAuditEvent,
  type LearningInteractiveUpdatedEvent,
  type LearningProgressRecordRow,
  type LearningProgressSnapshot,
  type StoredInteractiveAuditEvent,
} from './types.js';

function compareSequence(left: string, right: string): number {
  const leftValue = BigInt(left);
  const rightValue = BigInt(right);

  if (leftValue < rightValue) return -1;
  if (leftValue > rightValue) return 1;
  return 0;
}

function compareStoredRows(
  leftRow: LearningProgressRecordRow,
  rightRow: LearningProgressRecordRow
): number {
  const sequenceCompare = compareSequence(leftRow.updatedSeq, rightRow.updatedSeq);
  if (sequenceCompare !== 0) {
    return sequenceCompare;
  }

  return leftRow.recordKey.localeCompare(rightRow.recordKey);
}

function stripStoredAuditMetadata(storedEvent: StoredInteractiveAuditEvent): InteractiveAuditEvent {
  const { seq, sourceClientEventId, sourceClientId, ...event } = storedEvent;
  void seq;
  void sourceClientEventId;
  void sourceClientId;

  if (event.type === 'evaluated') {
    const { actorUserId, actorPermission, actorSource, ...sanitizedEvent } = event;
    void actorUserId;
    void actorPermission;
    void actorSource;

    return {
      ...sanitizedEvent,
      actor: 'system',
    };
  }

  return event;
}

function stripPublicReviewMetadata(
  record: LearningProgressRecordRow['record']
): LearningProgressRecordRow['record'] {
  if (record.review === undefined || record.review === null) {
    return record;
  }

  const { reviewedByUserId, reviewSource, ...review } = record.review;
  void reviewedByUserId;
  void reviewSource;

  return {
    ...record,
    review,
  };
}

export function createEmptySnapshot(): LearningProgressSnapshot {
  return {
    version: SNAPSHOT_VERSION,
    recordsByKey: {},
    lastUpdated: null,
  };
}

export function buildSnapshotFromRecords(
  records: readonly LearningProgressRecordRow[]
): LearningProgressSnapshot {
  if (records.length === 0) {
    return createEmptySnapshot();
  }

  const sortedRecords = [...records].sort(compareStoredRows);
  const recordsByKey = Object.fromEntries(
    sortedRecords.map((row) => [row.recordKey, stripPublicReviewMetadata(row.record)] as const)
  );
  const lastUpdated = sortedRecords.reduce<string | null>((latest, row) => {
    if (latest === null || row.updatedAt > latest) {
      return row.updatedAt;
    }
    return latest;
  }, null);

  return {
    version: SNAPSHOT_VERSION,
    recordsByKey,
    lastUpdated,
  };
}

export function buildDeltaEventsFromRecords(
  records: readonly LearningProgressRecordRow[],
  since: string
): LearningInteractiveUpdatedEvent[] {
  return [...records]
    .filter((row) => compareSequence(row.updatedSeq, since) > 0)
    .sort(compareStoredRows)
    .map((row) => {
      const auditEvents = row.auditEvents
        .filter((auditEvent) => compareSequence(auditEvent.seq, since) > 0)
        .map(stripStoredAuditMetadata);

      return {
        eventId: `server:${row.updatedSeq}:${row.recordKey}`,
        occurredAt: row.updatedAt,
        clientId: 'server',
        type: 'interactive.updated',
        payload: {
          record: stripPublicReviewMetadata(row.record),
          ...(auditEvents.length > 0 ? { auditEvents } : {}),
        },
      };
    });
}

export function getLatestCursor(records: readonly LearningProgressRecordRow[]): string {
  return records.reduce((latest, row) => {
    return compareSequence(row.updatedSeq, latest) > 0 ? row.updatedSeq : latest;
  }, '0');
}
