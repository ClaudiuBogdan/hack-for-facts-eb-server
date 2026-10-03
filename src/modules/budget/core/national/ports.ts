/**
 * National budget — typed read ports (implemented by the shell; no SQL here).
 *
 * Every root computes all requested fields eagerly inside ONE read-only
 * repeatable-read transaction (`NationalReadPort.read`); no field resolver
 * opens another read. Adapter errors: spent budget → `Timeout`; a missing relation
 * or an unknown stored literal → `ServiceUnavailable`. Readers return typed
 * source rows (exact `Decimal` amounts, mapped enums); core builds every public
 * shape, so internal storage/gate/parse fields never reach a reader result.
 */

import type { ApprovedRecordsQuery } from './approved-inputs.js';
import type { DescriptorGroup } from './approved-plan.js';
import type { ExecutionObservationsQuery } from './execution-inputs.js';
import type {
  ApprovedCatalogEdition,
  ApprovedStoredRecord,
  ApprovedUnrecognizedGroup,
  ExecutionChain,
  ExecutionItem,
  ExecutionLeafRow,
  NationalSeriesViewRow,
  ObservationOccurrence,
} from './models.js';
import type { ObservationAfter, RecordAfter } from './paging.js';
import type { ApprovedInventoryKey } from './snapshot.js';
import type { PeriodType, SeriesBasis } from './vocabulary.js';
import type { ApiError } from '@/modules/shared/index.js';
import type { Result } from 'neverthrow';

type Read<T> = Promise<Result<T, ApiError>>;

/**
 * One read budget per root (design §7), covering connection acquisition and
 * the whole transaction; the adapter maps an exhausted budget to `Timeout`.
 */
export const DEFAULT_READ_DEADLINE_MS = 5_000;
export const NATIONAL_SERIES_READ_DEADLINE_MS = 15_000;

// ── law lane ─────────────────────────────────────────────────────────────────

export interface ApprovedInventory {
  /** Rows of the lane token, read in the same transaction. */
  readonly snapshotRows: readonly ApprovedInventoryKey[];
  /** Recognised editions (reviewed fund/form vocabulary), canonical order. */
  readonly editions: readonly ApprovedCatalogEdition[];
  /** Loaded fund/form groups outside the reviewed vocabulary: counted only. */
  readonly unrecognized: readonly ApprovedUnrecognizedGroup[];
}

export interface ApprovedRecordsPageRequest {
  readonly query: ApprovedRecordsQuery;
  /** The interpretations the resolved source reads (one edition form). */
  readonly interpretationIds: readonly string[];
  readonly after: RecordAfter | null;
  /** `first + 1`, to detect a next page. */
  readonly limit: number;
}

export interface NationalApprovedReader {
  inventory(): Read<ApprovedInventory>;
  /**
   * Candidate records of every group in ONE bounded statement, each with ALL
   * stored slots (never filtered to a target year first), keyed by
   * `descriptorGroupKey`. Groups without candidates are absent.
   */
  descriptorCandidates(
    groups: readonly DescriptorGroup[]
  ): Read<ReadonlyMap<string, readonly ApprovedStoredRecord[]>>;
  /** Source order `(interpretationId COLLATE "C", recordIndex)` after the keys. */
  records(request: ApprovedRecordsPageRequest): Read<readonly ApprovedStoredRecord[]>;
}

// ── execution lane ───────────────────────────────────────────────────────────

/** A resolved selection occurrence source (current leaf or explicit ID). */
export interface ResolvedSelection {
  readonly selectionId: string;
  readonly periodEnd: string;
  readonly releaseId: string;
}

export interface ObservationPageRequest {
  readonly query: ExecutionObservationsQuery;
  /** Selections the source resolved to (current leaves or explicit IDs). */
  readonly selections: readonly ResolvedSelection[];
  /**
   * Exactly one resolved selection: read non-FACT classified cells and attach
   * the sealed locator/label evidence to facts.
   */
  readonly singleSelection: boolean;
  readonly after: ObservationAfter | null;
  /** `first + 1`, to detect a next page. */
  readonly limit: number;
}

export interface SeriesRowsRequest {
  /** Known catalog item IDs; one batched read. */
  readonly itemIds: readonly string[];
  readonly basis: SeriesBasis;
  readonly type: PeriodType;
  /** Only labels inside coverage; outside ones are classified without a read. */
  readonly labels: readonly string[];
}

export interface NationalSeriesRows {
  readonly rows: readonly NationalSeriesViewRow[];
  /** The view's derivation version (pinned to the reviewed v1 definition). */
  readonly derivationVersion: string;
  /** The view's component (pinned: the national consolidated budget). */
  readonly component: string;
}

export interface NationalExecutionReader {
  currentLeaves(): Read<readonly ExecutionLeafRow[]>;
  catalogItems(): Read<readonly ExecutionItem[]>;
  /** Chains of the given month ends (months without a selection are absent). */
  releaseChains(
    periodEnds: readonly string[],
    revisionsPerMonth: number
  ): Read<readonly ExecutionChain[]>;
  /** Known selections among explicit canonical IDs (unknown ones are absent). */
  selections(selectionIds: readonly string[]): Read<readonly ResolvedSelection[]>;
  observations(request: ObservationPageRequest): Read<readonly ObservationOccurrence[]>;
  seriesRows(request: SeriesRowsRequest): Read<NationalSeriesRows>;
}

// ── transaction boundary ─────────────────────────────────────────────────────

export interface NationalReadTx {
  readonly approved: NationalApprovedReader;
  readonly execution: NationalExecutionReader;
}

export interface NationalReadOptions {
  readonly deadlineMs: number;
  /** Short operation name for errors and statement tagging. */
  readonly operation: string;
}

export interface NationalReadPort {
  /** Run `work` in one read-only repeatable-read transaction within `deadlineMs`. */
  read<T>(
    work: (tx: NationalReadTx) => Promise<Result<T, ApiError>>,
    options: NationalReadOptions
  ): Read<T>;
}

/** When a read started: wall time for freshness, start order for recency. */
export interface NationalCacheStamp {
  readonly at: number;
  readonly order: number;
}

/**
 * Bounded-stale response cache (kernel `createCache` in the shell). Keys always
 * contain the lane snapshot(s). Freshness is measured from the read-START stamp
 * (`begin`, taken before the transaction is even requested), so a probe never
 * outlives 30 s after its snapshot could have been observed; an older read
 * never replaces a newer probe. Never a source replay store. `set` may decline
 * a response (too large, or no longer fresh); the result is unaffected.
 */
export interface NationalResponseCache {
  begin(): NationalCacheStamp;
  probe(lane: 'APPROVED' | 'EXECUTION'): string | undefined;
  remember(lane: 'APPROVED' | 'EXECUTION', snapshot: string, stamp: NationalCacheStamp): void;
  get(key: string): unknown;
  set(key: string, value: unknown, stamp: NationalCacheStamp): void;
}
