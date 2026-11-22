/**
 * Direct acquisitions, release 1 — the repository port.
 *
 * Every request runs inside ONE `snapshot`: a read-only, repeatable-read
 * transaction, so the release's `dataAsOf`, lists, detail and totals of a
 * response come from the same database state. A reader must not be used
 * after its snapshot callback returns. If release revisions are introduced
 * later, the revision filter belongs in the snapshot, not in each read.
 */

import type {
  DaItemRecord,
  DaListSort,
  DaOutcome,
  DaPurchaseRecord,
  DaTotalsDimension,
  DaTotalsGroupRecord,
  DaTotalsRecord,
} from './da-release.js';
import type { ApiError } from '@/modules/shared/index.js';
import type { Result } from 'neverthrow';

/** A validated filter; every field narrows the scope (AND). */
export interface DaPurchaseFilter {
  /** Matches buyers whose fiscal code is valid. */
  readonly buyerFiscalCode?: string;
  /** Matches only suppliers D6 names (a company), so a withheld supplier cannot be listed by code. */
  readonly supplierFiscalCode?: string;
  /** First two digits of the category (CPV) code. */
  readonly cpvDivision?: string;
  /** Inclusive `finalization_day` bounds, YYYY-MM-DD. */
  readonly finalizationFrom?: string;
  readonly finalizationTo?: string;
  readonly outcomes?: readonly DaOutcome[];
  readonly counted?: boolean;
  /** The portal's code (unique), e.g. DA37709621: resolves legacy links. */
  readonly code?: string;
  readonly nativeId?: string;
}

export interface DaPurchaseListQuery {
  readonly filter: DaPurchaseFilter;
  readonly sort: DaListSort;
  readonly page: number;
  readonly pageSize: number;
}

export interface DaPurchaseListRecords {
  readonly rows: readonly DaPurchaseRecord[];
  /** Exact up to `cap`; `capped` when more rows match. */
  readonly total: number;
  readonly capped: boolean;
}

export interface DaTotalsQuery {
  readonly filter: DaPurchaseFilter;
  readonly groupBy: DaTotalsDimension | null;
  readonly page: number;
  readonly pageSize: number;
}

export interface DaTotalsRecords {
  readonly overall: DaTotalsRecord;
  readonly groups: readonly DaTotalsGroupRecord[];
  readonly groupCount: number;
}

export interface DaReleaseReader {
  /** The one `da_release` row's `data_as_of` (ISO timestamptz); null when the table is empty. */
  dataAsOf(): Promise<Result<string | null, ApiError>>;
  /** Whether `supplier_disclosure` is readable; without it every supplier is withheld (D6 fails closed). */
  supplierPrivacyTable(): boolean;
  listPurchases(query: DaPurchaseListQuery): Promise<Result<DaPurchaseListRecords, ApiError>>;
  purchaseById(purchaseId: string): Promise<Result<DaPurchaseRecord | null, ApiError>>;
  itemsOf(purchaseId: string): Promise<Result<readonly DaItemRecord[], ApiError>>;
  totals(query: DaTotalsQuery): Promise<Result<DaTotalsRecords, ApiError>>;
}

export interface DaReleaseRepo {
  /** False when PROCUREMENT_DA_V3_ENABLED is off: every snapshot refuses without a query. */
  readonly enabled: boolean;
  /**
   * One read-only snapshot. With `settle`, a read that succeeded is answered only
   * if, after it, the release is still the one it read and, when supplier_privacy
   * was readable in it, still readable; otherwise a retryable unavailable error
   * (the release was republished, repeat the request).
   */
  snapshot<T>(
    read: (reader: DaReleaseReader) => Promise<Result<T, ApiError>>,
    options?: { readonly settle?: boolean }
  ): Promise<Result<T, ApiError>>;
}
