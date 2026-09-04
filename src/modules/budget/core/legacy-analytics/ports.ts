/**
 * Ports for the legacy `executionAnalytics` usecase. Three seams:
 *
 *  - `LegacyExecutionAggregateRepo` — the nominal-RON per-period SUM over
 *    `budget.execution_line_items` (the fact path; §0.3 pruning; 10,000-row cap
 *    reported, never silent).
 *  - `FactorSource` — the yearly reference series (CPI price LEVEL, FX, GDP,
 *    country population) in the program-D2 `factor_kind` vocabulary AND
 *    representation. The kernel uses a manifest-checked versioned database
 *    snapshot; the datasets YAML adapter remains the equivalence-test oracle.
 *  - `PopulationSource` — the filter-wide per-capita denominator over the kernel
 *    `core.*` hubs (legacy `PopulationRepository` semantics, plan 13 §4).
 */

import type { LegacyAggregateQuery, PopulationScope, YearlySeries } from './types.js';
import type { ApiError } from '@/modules/shared/index.js';
import type { Decimal } from 'decimal.js';
import type { Result } from 'neverthrow';

export interface LegacyAggregateRow {
  readonly year: number;
  /** month 1–12, quarter 1–4, or the year again for YEAR frequency. */
  readonly periodValue: number;
  /** numeric → decimal string (precision-safe; never a float). */
  readonly amount: string;
}

export interface LegacyAggregateResult {
  readonly rows: readonly LegacyAggregateRow[];
  /** True when the query hit `LEGACY_ANALYTICS_MAX_POINTS` (rows were dropped). */
  readonly capped: boolean;
}

export interface LegacyExecutionAggregateRepo {
  legacyExecutionAggregate(
    q: LegacyAggregateQuery
  ): Promise<Result<LegacyAggregateResult, ApiError>>;
}

/**
 * Program D2 `factor_kind` vocabulary (the `core.normalization_factors`
 * discriminator), with the D2 REPRESENTATION per kind — an adapter must return
 * exactly this, whatever its upstream stores:
 *
 *  - `cpi_index` — the chain-linked price LEVEL, `level(y) = 100 × Π yoy(t)/100`
 *    anchored on the year before the first observed index (INSSE: 1970 = 100;
 *    2024 ≈ 969828.98), NOT the year-over-year index. Consumers take ratios
 *    `level(base) / level(period)`; the anchor cancels.
 *  - `ron_per_eur` / `ron_per_usd` — BNR annual average, RON per unit.
 *  - `gdp_ron` — nominal GDP at current prices, RON.
 *  - `population_ro` — national resident population, persons.
 */
export type FactorKind = 'cpi_index' | 'ron_per_eur' | 'ron_per_usd' | 'gdp_ron' | 'population_ro';

export interface FactorSource {
  /**
   * The yearly series for a factor kind, keyed by year, in the D2
   * representation above. `null` when the dataset is not available — the
   * YAML oracle only: the `legacy` normalization policy leaves values
   * unadjusted and logs absence. The versioned database adapter requires the
   * configured set, manifest and yearly kind; missing data returns an error.
   */
  yearly(kind: FactorKind): Promise<Result<YearlySeries | null, ApiError>>;
}

export interface PopulationSource {
  /**
   * The population for an entity-narrowed scope (never `country` — the usecase
   * serves that from `FactorSource.population_ro`). `null` when the scope
   * resolves to no territory (legacy then divided by nothing → unadjusted).
   */
  scopedPopulation(scope: PopulationScope): Promise<Result<Decimal | null, ApiError>>;
}

/** The legacy point cap (`MAX_DATA_POINTS`), kept and LOGGED (manifest §2). */
export const LEGACY_ANALYTICS_MAX_POINTS = 10_000;
