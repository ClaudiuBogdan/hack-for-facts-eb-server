/**
 * Contract awards (PROC-KB0Z step 1): the repository port.
 *
 * Every request runs inside ONE `snapshot` (read-only, repeatable read), so the
 * counts, keys, rows, winners and names of a response come from one database
 * state. Every list is read in two steps (procurement-prod's reader rule 1): the
 * keys, filtered and sorted on the view's plain columns only, then the rows by
 * `(source_name, match_id = any(...))`. No computed column (winner_count,
 * lot_count, flags, buyer_person, buyer_name_masked, change_*) is ever a filter,
 * a sort key or part of a count.
 */

import type {
  CaAppearance,
  CaKey,
  CaListSort,
  CaLotRow,
  CaRecordRow,
  CaWinnerRow,
} from './ca-records.js';
import type { SupplierNaming } from './supplier-naming.js';
import type { ApiError } from '@/modules/shared/index.js';
import type { Result } from 'neverthrow';

/** Inclusive award-day bounds; `from` is never before the floor. */
export interface CaWindow {
  readonly from: string;
  readonly to: string | null;
}

export interface CaCounts {
  /** Records with an award day inside the window. */
  readonly recordCount: number;
  /** Of those, with an amount in lei. */
  readonly valuedCount: number;
  /** Of those, under identity review (shown, never additive). */
  readonly identityReviewCount: number;
  /** The buyer's (or winner's) records with no award day (in no dated list or count). */
  readonly undatedCount: number;
}

export interface CaBuyerProbe {
  readonly person: boolean | null;
  readonly maskedName: string | null;
}

/**
 * A winner code's place in the gate: whether D6 discloses it (`supplier_disclosure`) and its naming
 * from `supplier_names_public`. Both are needed before any record of the code is read; either view
 * not readable reads as not disclosed (fails closed).
 */
export interface CaWinnerGate {
  readonly disclosed: boolean;
  /** Null when the names view is not readable. */
  readonly naming: SupplierNaming | null;
}

/** Every key a winner code wins, and whether every one of its winner rows is in the D6 gate. */
export interface CaWinnerKeys {
  readonly keys: readonly CaKey[];
  readonly allDisclosed: boolean;
}

/** The keys a list is drawn from: one source and its match ids. */
export interface CaKeySet {
  readonly sourceName: string;
  readonly matchIds: readonly string[];
}

export interface CaRecordsReader {
  /** `da_release.data_as_of` (ISO timestamptz); null when the table is empty. */
  dataAsOf(): Promise<Result<string | null, ApiError>>;
  /** Whether `supplier_names_public` was readable in this snapshot (no winner code shown without it). */
  namesReadable(): boolean;
  buyerCounts(buyerCode: string, window: CaWindow): Promise<Result<CaCounts, ApiError>>;
  buyerKeys(query: {
    readonly buyerCode: string;
    readonly window: CaWindow;
    readonly sort: CaListSort;
    readonly offset: number;
    readonly limit: number;
  }): Promise<Result<readonly CaKey[], ApiError>>;
  /** A record's award day (a plain column only); null when the key has no record. */
  awardDayOf(key: CaKey): Promise<Result<{ readonly awardDay: string | null } | null, ApiError>>;
  /** The rows of these keys, in the keys' order (a key with no row is left out). */
  recordsByKeys(keys: readonly CaKey[]): Promise<Result<readonly CaRecordRow[], ApiError>>;
  /** The winners of these keys, each code with its naming from `supplier_names_public`. */
  winnersByKeys(keys: readonly CaKey[]): Promise<Result<readonly CaWinnerRow[], ApiError>>;
  lotsOf(key: CaKey): Promise<Result<readonly CaLotRow[], ApiError>>;
  /** Today's key of an appearance (`ca_record_keys_public`), for an id issued by an earlier build. */
  currentKeyOf(appearance: CaAppearance): Promise<Result<CaKey | null, ApiError>>;
  /** The buyer's person flag and masked name, read from one of its records; null with none. */
  buyerProbe(buyerCode: string): Promise<Result<CaBuyerProbe | null, ApiError>>;
  /** The winner code's gate (two by-code reads); call before reading any of its records. */
  winnerGate(code: string): Promise<Result<CaWinnerGate, ApiError>>;
  /**
   * Every key the code wins (`ca_record_winners_public`, one scan: never per row), at most
   * `limit` of them (the caller refuses a code that reaches it).
   */
  winnerKeys(code: string, limit: number): Promise<Result<CaWinnerKeys, ApiError>>;
  /** The counts of a key set in the window (plain columns only). */
  keySetCounts(keys: CaKeySet, window: CaWindow): Promise<Result<CaCounts, ApiError>>;
  /** A page of a key set's dated keys in the window, sorted on plain columns only. */
  keySetPage(query: {
    readonly keys: CaKeySet;
    readonly window: CaWindow;
    readonly sort: CaListSort;
    readonly offset: number;
    readonly limit: number;
  }): Promise<Result<readonly CaKey[], ApiError>>;
  /** Registry names by code where the buyer name is public (`party_public_names`). Never call for a person. */
  buyerRegistryNames(
    codes: readonly string[]
  ): Promise<Result<ReadonlyMap<string, string>, ApiError>>;
}

export interface CaRecordsRepo {
  /** False when PROCUREMENT_CA_RECORDS_ENABLED is off: every snapshot refuses without a query. */
  readonly enabled: boolean;
  /**
   * One read-only snapshot, refused as unavailable when any of the four views is not readable.
   * A read that succeeded is answered only if, after it, the release is the one it read and the
   * names and disclosure views are no less readable (otherwise a retryable unavailable error).
   */
  snapshot<T>(
    read: (reader: CaRecordsReader) => Promise<Result<T, ApiError>>
  ): Promise<Result<T, ApiError>>;
}
