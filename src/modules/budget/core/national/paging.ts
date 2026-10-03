/**
 * National budget — the two paged lanes: law records and execution
 * observation occurrences. Each defines its sort spec, key encoding/decoding
 * and the binding that decides live (snapshot) vs pinned (immutable IDs).
 */

import { err, ok, type Result } from 'neverthrow';

import { invalidInput, type ApiError } from '@/modules/shared/index.js';

import { MALFORMED_CURSOR } from './errors.js';
import { isCanonicalUuid } from './input-rules.js';
import { isMonthEnd } from './periods.js';
import { pinToken } from './snapshot.js';
import { EXECUTION_INPUT_SOURCE_IDS, isOneOf, type ExecutionInputSourceId } from './vocabulary.js';

import type { ApprovedRecordsQuery } from './approved-inputs.js';
import type { CursorBinding, CursorSpec } from './cursor.js';
import type { ExecutionObservationsQuery } from './execution-inputs.js';
import type { ApprovedRecord, ObservationOccurrence } from './models.js';

// ── law records ──────────────────────────────────────────────────────────────

export const RECORDS_ROOT = 'budgetApprovedRecords';
export const RECORDS_CURSOR: CursorSpec = {
  sort: 'interpretation_id,record_index',
  dir: 'asc',
  keyCount: 2,
};

export interface RecordAfter {
  readonly interpretationId: string;
  readonly recordIndex: number;
}

export const recordCursorKeys = (record: ApprovedRecord): readonly (string | number)[] => [
  record.interpretationId,
  record.recordIndex,
];

const NON_NEGATIVE_INT = /^(0|[1-9]\d{0,9})$/u;

/** Largest PostgreSQL `integer` (`record_index` column type). */
export const MAX_PG_INTEGER = 2_147_483_647;

/**
 * Decoded record keys. Interpretation IDs are opaque existing IDs; the record
 * index must fit the `integer` column, so a forged key fails here, not in SQL.
 */
export const parseRecordAfter = (keys: readonly string[]): Result<RecordAfter, ApiError> => {
  const [interpretationId, index] = keys;
  if (
    keys.length !== 2 ||
    interpretationId === undefined ||
    interpretationId.length === 0 ||
    index === undefined ||
    !NON_NEGATIVE_INT.test(index)
  ) {
    return err(invalidInput(MALFORMED_CURSOR, 'after'));
  }
  const recordIndex = Number.parseInt(index, 10);
  return recordIndex > MAX_PG_INTEGER
    ? err(invalidInput(MALFORMED_CURSOR, 'after'))
    : ok({ interpretationId, recordIndex });
};

/** Edition/form reads follow the live law lane; an interpretation ID is immutable. */
export const recordsBinding = (
  query: ApprovedRecordsQuery,
  approvedSnapshot: string
): Result<CursorBinding, ApiError> =>
  query.source.kind === 'EDITION'
    ? ok({ mode: 'LIVE', lane: 'APPROVED', snapshot: approvedSnapshot })
    : pinToken('APPROVED', [query.source.interpretationId]).map((pin) => ({
        mode: 'PINNED' as const,
        lane: 'APPROVED' as const,
        pin,
      }));

// ── execution observation occurrences ────────────────────────────────────────

export const OBSERVATIONS_ROOT = 'budgetExecutionObservations';
export const OBSERVATIONS_CURSOR: CursorSpec = {
  sort: 'period_end,selection_id,input_id,observation_key',
  dir: 'asc',
  keyCount: 4,
};

export interface ObservationAfter {
  /** Month-end `date` of the selection. */
  readonly periodEnd: string;
  /** Canonical lowercase `uuid`. */
  readonly selectionId: string;
  readonly inputSourceId: ExecutionInputSourceId;
  readonly observationKey: string;
}

export const observationCursorKeys = (
  occurrence: ObservationOccurrence
): readonly (string | number)[] => [
  occurrence.periodEnd,
  occurrence.selectionId,
  occurrence.inputSourceId,
  occurrence.node.observationKey,
];

/**
 * Decoded occurrence keys, checked against the actual column domains before
 * any SQL cast: a real month-end date, a canonical lowercase UUID (as the
 * adapter emits it), and an exact stored input ID.
 */
export const parseObservationAfter = (
  keys: readonly string[]
): Result<ObservationAfter, ApiError> => {
  const [periodEnd, selectionId, inputSourceId, observationKey] = keys;
  if (
    keys.length !== 4 ||
    periodEnd === undefined ||
    !isMonthEnd(periodEnd) ||
    selectionId === undefined ||
    !isCanonicalUuid(selectionId) ||
    !isOneOf(EXECUTION_INPUT_SOURCE_IDS, inputSourceId) ||
    observationKey === undefined ||
    observationKey.length === 0
  ) {
    return err(invalidInput(MALFORMED_CURSOR, 'after'));
  }
  return ok({ periodEnd, selectionId, inputSourceId, observationKey });
};

/** Month reads follow the live execution lane; explicit selection IDs are immutable. */
export const observationsBinding = (
  query: ExecutionObservationsQuery,
  executionSnapshot: string
): Result<CursorBinding, ApiError> =>
  query.source.kind === 'MONTHS'
    ? ok({ mode: 'LIVE', lane: 'EXECUTION', snapshot: executionSnapshot })
    : pinToken('EXECUTION', query.source.selectionIds).map((pin) => ({
        mode: 'PINNED' as const,
        lane: 'EXECUTION' as const,
        pin,
      }));

const utf8 = new TextEncoder();

/** Byte-wise comparison, as PostgreSQL `COLLATE "C"` orders UTF-8 text. */
export const compareCollateC = (a: string, b: string): number => {
  const left = utf8.encode(a);
  const right = utf8.encode(b);
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index++) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return left.length - right.length;
};

/**
 * The occurrence order `(periodEnd, selectionId, inputSourceId, observationKey
 * COLLATE "C")`. Reference ordering for in-memory fakes and tests; the adapter
 * orders in SQL. The first three keys are ASCII by domain (date, canonical
 * UUID, `bgc`/`sinteza`), so byte order equals the database order there too.
 */
export const compareObservationAfter = (a: ObservationAfter, b: ObservationAfter): number => {
  const pairs: readonly (readonly [string, string])[] = [
    [a.periodEnd, b.periodEnd],
    [a.selectionId, b.selectionId],
    [a.inputSourceId, b.inputSourceId],
    [a.observationKey, b.observationKey],
  ];
  for (const [left, right] of pairs) {
    const order = compareCollateC(left, right);
    if (order !== 0) return order;
  }
  return 0;
};
