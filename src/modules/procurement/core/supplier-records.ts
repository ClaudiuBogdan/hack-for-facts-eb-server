/**
 * Procurement module — the supplier-records union (`ProcurementContract |
 * ProcurementDirectAcquisition`), keyset-paged.
 *
 * The two grains live in two tables, so there is no single index to walk. We issue
 * one keyset query per table, merge-sort in TS, and slice to `first`. The cursor
 * therefore encodes `(date, grain, id)` — the GRAIN TAG IS REQUIRED because
 * `contract_id` and `da_id` are only unique WITHIN their table, so `(date, id)`
 * alone would collide across grains and silently drop or repeat a row.
 *
 * Merge order — the total order both tables and the merge agree on:
 *     (date DESC NULLS LAST, grainRank ASC, id DESC)
 */

import { err, ok, type Result } from 'neverthrow';

import { invalidInput, type ApiError } from '@/modules/shared/index.js';

import type { ProcurementGrain, SupplierRecord } from './types.js';

/** Ties on `date` break by grain first; contracts before direct acquisitions. */
export const grainRank = (grain: ProcurementGrain): number =>
  grain === 'procurement_contract' ? 0 : 1;

/** Null dates sort AFTER every dated row (`NULLS LAST`). */
const dateRank = (date: string | null): number => (date === null ? 1 : 0);

export interface RecordCursor {
  readonly date: string | null;
  readonly grain: ProcurementGrain;
  readonly id: string;
}

const CURSOR_SEPARATOR = '|';
const GRAIN_TOKENS: Readonly<Record<string, ProcurementGrain>> = {
  c: 'procurement_contract',
  d: 'direct_acquisition',
};
const GRAIN_CODE: Readonly<Record<ProcurementGrain, string>> = {
  procurement_contract: 'c',
  direct_acquisition: 'd',
};

/** Opaque, but stable: `base64url("<date|''>|<c|d>|<id>")`. */
export const encodeRecordCursor = (cursor: RecordCursor): string =>
  Buffer.from(
    [cursor.date ?? '', GRAIN_CODE[cursor.grain], cursor.id].join(CURSOR_SEPARATOR),
    'utf8'
  ).toString('base64url');

export const decodeRecordCursor = (raw: string): Result<RecordCursor, ApiError> => {
  let decoded: string;
  try {
    decoded = Buffer.from(raw, 'base64url').toString('utf8');
  } catch {
    return err(invalidInput('after is not a valid cursor', 'after'));
  }
  const parts = decoded.split(CURSOR_SEPARATOR);
  if (parts.length !== 3) return err(invalidInput('after is not a valid cursor', 'after'));
  const [date, code, id] = parts as [string, string, string];
  const grain = GRAIN_TOKENS[code];
  if (grain === undefined) return err(invalidInput('after carries an unknown grain', 'after'));
  if (!/^\d+$/u.test(id)) return err(invalidInput('after carries an invalid id', 'after'));
  if (date !== '' && !/^\d{4}-\d{2}-\d{2}$/u.test(date)) {
    return err(invalidInput('after carries an invalid date', 'after'));
  }
  return ok({ date: date === '' ? null : date, grain, id });
};

export const cursorOf = (record: SupplierRecord): RecordCursor =>
  record.grain === 'procurement_contract'
    ? { date: record.contract.contractDate, grain: record.grain, id: record.contract.contractId }
    : {
        date: record.directAcquisition.finalizationDate,
        grain: record.grain,
        id: record.directAcquisition.daId,
      };

/**
 * The merge comparator: negative when `a` precedes `b`. `id` is a bigint string, so
 * it is compared by length-then-lexicographically, never as a lossy JS number.
 */
export const compareRecords = (a: RecordCursor, b: RecordCursor): number => {
  const rank = dateRank(a.date) - dateRank(b.date);
  if (rank !== 0) return rank;
  if (a.date !== null && b.date !== null && a.date !== b.date) return a.date < b.date ? 1 : -1;
  const grains = grainRank(a.grain) - grainRank(b.grain);
  if (grains !== 0) return grains;
  return compareBigintDesc(a.id, b.id);
};

/** `id DESC` over bigint STRINGS (`'100' > '99'` numerically, not lexicographically). */
export const compareBigintDesc = (a: string, b: string): number => {
  if (a.length !== b.length) return a.length < b.length ? 1 : -1;
  if (a === b) return 0;
  return a < b ? 1 : -1;
};

/**
 * Merge the two per-table pages, drop everything at-or-before the cursor (the SQL
 * predicates already did, but the merge must be total), and slice to `first`.
 * `hasNextPage` is true when either table still had rows beyond the slice.
 */
export const mergeSupplierRecords = (
  contracts: readonly SupplierRecord[],
  directAcquisitions: readonly SupplierRecord[],
  first: number
): { readonly page: readonly SupplierRecord[]; readonly hasNextPage: boolean } => {
  const merged = [...contracts, ...directAcquisitions].sort((a, b) =>
    compareRecords(cursorOf(a), cursorOf(b))
  );
  return { page: merged.slice(0, first), hasNextPage: merged.length > first };
};
