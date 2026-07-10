/**
 * Procurement module — scope-aggregate routing + grain/gate resolution (pure).
 *
 * ONE `scope` object serves the landing page (empty), the CPV category page
 * (`{ cpvDivision }`) and the supplier slice (`{ supplierCui }`). Two decisions live
 * here, both testable without a DB:
 *
 *  1. WHICH ROLLUP. `org_edge_monthly_rollups` has (authority, supplier, month) but
 *     NO CPV dimension. The CPV MVs have it. So: any CPV-dimension answer — and any
 *     scope that names a `cpvDivision` — routes to
 *     `supplier_cpv_division_monthly_rollups` (the only CPV MV carrying BOTH cuis,
 *     which `buyersCount`/`suppliersCount`/`topSuppliers` all need); everything else
 *     routes to `org_edge`. Never mix the two inside one answer: they partition the
 *     same facts differently (the supplier MV drops null-supplier rows), so their
 *     totals legitimately disagree.
 *
 *  2. WHICH GRAINS, AND WHOSE MONEY. `grain: null` means "both grains". Counts may
 *     be summed across grains; MONEY MAY NOT (§14.6) — and `procurement_contract`
 *     is gate-blocked for spend anyway. So money sums only over the grains whose
 *     `spend_rankings_allowed` is true, and when that set is empty the amount is
 *     `null` — never `0`, never a partial total dressed up as the whole.
 */

import { err, ok, type Result } from 'neverthrow';

import { invalidInput, type ApiError  } from '@/modules/shared/index.js';

import { PROCUREMENT_GRAINS } from './constants.js';

import type { GrainQuality, ProcurementGrain, ScopeFilter } from './types.js';

/** Which materialized view answers a scope. */
export type ScopeSource = 'org_edge' | 'supplier_cpv';

/** CPV-dimension answers always need a CPV MV, whatever the scope says. */
export const routeScope = (scope: ScopeFilter, needsCpvDimension: boolean): ScopeSource =>
  needsCpvDimension || scope.cpvDivision !== undefined ? 'supplier_cpv' : 'org_edge';

/** Parse the `grain` argument. `null`/absent = both grains. */
export const resolveGrains = (grain: string | null | undefined): Result<readonly ProcurementGrain[], ApiError> => {
  if (grain === undefined || grain === null || grain === '') return ok(PROCUREMENT_GRAINS);
  if ((PROCUREMENT_GRAINS as readonly string[]).includes(grain)) {
    return ok([grain as ProcurementGrain]);
  }
  return err(
    invalidInput(`grain must be one of ${PROCUREMENT_GRAINS.join(', ')}, or null for both`, 'grain')
  );
};

/** The subset of `grains` whose spend the live gate approves for summing. */
export const spendApprovedGrains = (
  grains: readonly ProcurementGrain[],
  gates: readonly GrainQuality[]
): readonly ProcurementGrain[] =>
  grains.filter((g) => gates.find((row) => row.grain === g)?.spendRankingsAllowed === true);

/**
 * Rank by value only when EVERY in-scope grain is spend-approved. Otherwise a
 * value ranking would sort the suppressed grain's rows (whose amount is null) to
 * the bottom regardless of size — so we rank by `flow_count`, which every grain has.
 */
export const rankByValue = (
  grains: readonly ProcurementGrain[],
  spendGrains: readonly ProcurementGrain[]
): boolean => grains.length > 0 && grains.length === spendGrains.length;

/**
 * `cpvCode` scoping is rejected in v1: every rollup is keyed on the 2-digit
 * `cpv_division_code`, so an 8-digit answer would have to scan the fact tables.
 * The 8-digit code still works as a SEARCH filter — just not as an aggregate scope.
 */
export const assertScopeSupported = (scope: ScopeFilter): Result<void, ApiError> => {
  if (scope.cpvCode !== undefined) {
    return err(
      invalidInput(
        'scope.cpvCode is not supported in v1: the monthly rollups are keyed on the 2-digit CPV division. Use scope.cpvDivision.',
        'cpvCode'
      )
    );
  }
  return ok(undefined);
};

/**
 * `YYYY-MM` → the `month_start` date literal the MVs store. The MVs bucket on the
 * FIRST of the month, so BOTH `monthFrom` and `monthTo` map through this and the
 * `monthTo` comparison stays inclusive (`month_start <= '2026-06-01'`).
 */
export const monthStart = (month: string): string => `${month}-01`;

/**
 * A stable, order-independent cache key. Entity-scoped requests are NOT cached
 * (unbounded key space + they are already index-fast), so `cacheable` gates it.
 */
export const scopeCacheKey = (
  query: string,
  scope: ScopeFilter,
  grains: readonly ProcurementGrain[],
  topN: number,
  gateRefreshedAt: string | null
): string =>
  JSON.stringify([
    query,
    scope.cpvDivision ?? null,
    scope.monthFrom ?? null,
    scope.monthTo ?? null,
    [...grains].sort(),
    topN,
    gateRefreshedAt,
  ]);

/**
 * Cacheable ⟺ the scope names no entity. That bounds the key space to
 * (empty + 45 divisions) × grain-set × month-window, which is small enough to hold
 * in process; an authority/supplier scope is unbounded and stays live.
 */
export const isCacheableScope = (scope: ScopeFilter): boolean =>
  scope.authorityCui === undefined && scope.supplierCui === undefined;
