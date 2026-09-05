/**
 * Legacy `executionAnalytics` root on the kernel (docs/server-redesign/13 §4 row 1).
 *
 * These are the LEGACY wire shapes (snake_case, `AnalyticsFilterInput` /
 * `AnalyticsSeries`) frozen by the compatibility manifest (program §2 item 2).
 * The GraphQL input arrives with `null` for explicitly-null optional fields and
 * `undefined` for absent ones; every optional here accepts both and the usecase
 * canonicalizes them (`[]` and `null` both mean "no filter" — never `false`).
 *
 * `report_type` is the ROMANIAN PARTITION LITERAL: the legacy `ReportType` enum
 * value resolver maps `DETAILED` → 'Executie bugetara detaliata' before the
 * resolver sees it, and that map moves with the slice.
 */

import type { Decimal } from 'decimal.js';

export type Maybe<T> = T | null | undefined;

export type LegacyFrequency = 'MONTH' | 'QUARTER' | 'YEAR';
export type LegacyAccountCategory = 'vn' | 'ch';
export type LegacyExpenseType = 'dezvoltare' | 'functionare';
export type LegacyCurrency = 'RON' | 'EUR' | 'USD';

/** The wire enum (includes the two composite legacy values). */
export type LegacyNormalizationInput =
  'total' | 'total_euro' | 'per_capita' | 'per_capita_euro' | 'percent_gdp';

/** The strict mode after the composites are resolved. */
export type LegacyNormalizationMode = 'total' | 'per_capita' | 'percent_gdp';

export interface LegacyPeriodInterval {
  readonly start: string;
  readonly end: string;
}

export interface LegacyPeriodSelection {
  readonly interval?: Maybe<LegacyPeriodInterval>;
  readonly dates?: Maybe<readonly string[]>;
}

export interface LegacyReportPeriod {
  readonly type: LegacyFrequency;
  readonly selection: LegacyPeriodSelection;
}

export interface LegacyAnalyticsExclude {
  readonly report_ids?: Maybe<readonly string[]>;
  readonly entity_cuis?: Maybe<readonly string[]>;
  readonly main_creditor_cui?: Maybe<string>;
  readonly functional_codes?: Maybe<readonly string[]>;
  readonly functional_prefixes?: Maybe<readonly string[]>;
  readonly economic_codes?: Maybe<readonly string[]>;
  readonly economic_prefixes?: Maybe<readonly string[]>;
  readonly funding_source_ids?: Maybe<readonly string[]>;
  readonly budget_sector_ids?: Maybe<readonly string[]>;
  readonly expense_types?: Maybe<readonly LegacyExpenseType[]>;
  readonly program_codes?: Maybe<readonly string[]>;
  readonly county_codes?: Maybe<readonly string[]>;
  readonly regions?: Maybe<readonly string[]>;
  readonly uat_ids?: Maybe<readonly string[]>;
  readonly entity_types?: Maybe<readonly string[]>;
  readonly tags?: Maybe<readonly string[]>;
}

export interface LegacyAnalyticsFilter {
  readonly account_category: LegacyAccountCategory;
  readonly report_period: LegacyReportPeriod;
  readonly report_type?: Maybe<string>;
  readonly main_creditor_cui?: Maybe<string>;
  readonly report_ids?: Maybe<readonly string[]>;
  readonly entity_cuis?: Maybe<readonly string[]>;
  readonly functional_codes?: Maybe<readonly string[]>;
  readonly functional_prefixes?: Maybe<readonly string[]>;
  readonly economic_codes?: Maybe<readonly string[]>;
  readonly economic_prefixes?: Maybe<readonly string[]>;
  readonly funding_source_ids?: Maybe<readonly string[]>;
  readonly budget_sector_ids?: Maybe<readonly string[]>;
  readonly expense_types?: Maybe<readonly LegacyExpenseType[]>;
  readonly program_codes?: Maybe<readonly string[]>;
  readonly county_codes?: Maybe<readonly string[]>;
  readonly regions?: Maybe<readonly string[]>;
  readonly uat_ids?: Maybe<readonly string[]>;
  readonly entity_types?: Maybe<readonly string[]>;
  readonly is_uat?: Maybe<boolean>;
  readonly is_territorial_executive?: Maybe<boolean>;
  readonly search?: Maybe<string>;
  readonly tags?: Maybe<readonly string[]>;
  readonly min_population?: Maybe<number>;
  readonly max_population?: Maybe<number>;
  readonly aggregate_min_amount?: Maybe<number>;
  readonly aggregate_max_amount?: Maybe<number>;
  readonly normalization?: Maybe<LegacyNormalizationInput>;
  readonly inflation_adjusted?: Maybe<boolean>;
  readonly currency?: Maybe<LegacyCurrency>;
  readonly show_period_growth?: Maybe<boolean>;
  readonly item_min_amount?: Maybe<number>;
  readonly item_max_amount?: Maybe<number>;
  readonly exclude?: Maybe<LegacyAnalyticsExclude>;
}

export interface LegacyAnalyticsInput {
  readonly seriesId?: Maybe<string>;
  readonly filter: LegacyAnalyticsFilter;
}

// ── the canonical (cleaned) query the repo receives ───────────────────────────

/** A sub-year period: month 1–12 or quarter 1–4 paired with its year. */
export interface SubPeriod {
  readonly year: number;
  readonly sub: number;
}

/**
 * The period predicate plan. `years` is ALWAYS bounded (the §0.3 L1 prune) and
 * already expresses the year-only predicates (interval → `between`, dates →
 * `in`). `tupleRange`/`tupleList` carry the finer MONTH/QUARTER predicates when
 * the selection provides them. Legacy applied interval AND dates when both
 * were sent (the `@oneOf` directive was unenforced on the legacy endpoint);
 * both are carried here too — `yearList` is the YEAR-frequency dates predicate
 * when an interval already provided `years`.
 */
export interface PeriodPlan {
  readonly years:
    { readonly from: number; readonly to: number } | { readonly in: readonly number[] };
  readonly tupleRange?: { readonly start: SubPeriod; readonly end: SubPeriod };
  readonly tupleList?: readonly SubPeriod[];
  readonly yearList?: readonly number[];
}

export interface CleanExclude {
  readonly reportIds?: readonly string[];
  readonly entityCuis?: readonly string[];
  readonly mainCreditorCui?: string;
  readonly functionalCodes?: readonly string[];
  readonly functionalPrefixes?: readonly string[];
  readonly economicCodes?: readonly string[];
  readonly economicPrefixes?: readonly string[];
  /** PUBLIC (phoenix-ordinal) ids — the repo translates through the compat view. */
  readonly fundingSourceIds?: readonly number[];
  readonly budgetSectorIds?: readonly number[];
  readonly expenseTypes?: readonly LegacyExpenseType[];
  readonly programCodes?: readonly string[];
  readonly countyCodes?: readonly string[];
  readonly regions?: readonly string[];
  readonly uatIds?: readonly number[];
  readonly entityTypes?: readonly string[];
  readonly tags?: readonly string[];
}

/**
 * The validated aggregate query: nulls/`[]` removed (absent = no predicate),
 * ids parsed, amounts carried as decimal STRINGS (never floats into SQL), the
 * pruning triple resolved. `reportType === null` = ALL SUPPORTED execution
 * report types (the kept legacy semantic; the repo emits a parameterized `IN`
 * over the three L2 literals — multi-leaf, never the `_default` leaves).
 */
export interface LegacyAggregateQuery {
  readonly frequency: LegacyFrequency;
  readonly accountCategory: LegacyAccountCategory;
  readonly reportType: string | null;
  readonly period: PeriodPlan;
  readonly mainCreditorCui?: string;
  readonly reportIds?: readonly string[];
  readonly entityCuis?: readonly string[];
  readonly functionalCodes?: readonly string[];
  readonly functionalPrefixes?: readonly string[];
  readonly economicCodes?: readonly string[];
  readonly economicPrefixes?: readonly string[];
  /** PUBLIC (phoenix-ordinal) ids — the repo translates through the compat view. */
  readonly fundingSourceIds?: readonly number[];
  readonly budgetSectorIds?: readonly number[];
  readonly expenseTypes?: readonly LegacyExpenseType[];
  readonly programCodes?: readonly string[];
  readonly countyCodes?: readonly string[];
  readonly regions?: readonly string[];
  readonly uatIds?: readonly number[];
  readonly entityTypes?: readonly string[];
  readonly isUat?: boolean;
  readonly isTerritorialExecutive?: boolean;
  readonly search?: string;
  /** Validated faceted tags grouped by facet: OR within a group, AND across groups. */
  readonly tagFacets?: readonly (readonly string[])[];
  readonly minPopulation?: number;
  readonly maxPopulation?: number;
  readonly itemMinAmount?: string;
  readonly itemMaxAmount?: string;
  readonly aggregateMinAmount?: string;
  readonly aggregateMaxAmount?: string;
  readonly exclude?: CleanExclude;
}

// ── normalization plan + population scope ─────────────────────────────────────

export interface NormalizationPlan {
  readonly mode: LegacyNormalizationMode;
  readonly currency: LegacyCurrency;
  readonly inflationAdjusted: boolean;
  readonly showPeriodGrowth: boolean;
}

/**
 * The legacy `getDenominatorPopulation` priority (normalization/core/population.ts
 * + shell/repo/population-repo.ts `computeFilteredPopulation`): entity_cuis →
 * uat_ids → county_codes → entity_types → is_uat === true → country. Regions,
 * tags, search and population bounds do NOT narrow the denominator (legacy).
 * Executive-field requests instead use the full shared entity/geography
 * predicates and an ancestor-maximal union; explicit geography retains priority.
 */
export type PopulationScope =
  | { readonly kind: 'country' }
  | { readonly kind: 'entityUnion'; readonly selection: LegacyAggregateQuery }
  | { readonly kind: 'entities'; readonly cuis: readonly string[] }
  | { readonly kind: 'territories'; readonly ids: readonly number[] }
  | { readonly kind: 'counties'; readonly codes: readonly string[] }
  | { readonly kind: 'entityTypes'; readonly types: readonly string[]; readonly isUat?: boolean }
  | { readonly kind: 'allUats' };

// ── outputs ───────────────────────────────────────────────────────────────────

export type LegacyAxisDataType = 'STRING' | 'INTEGER' | 'FLOAT' | 'DATE';

export interface LegacyAxis {
  readonly name: string;
  readonly type: LegacyAxisDataType;
  readonly unit: string;
}

/** One output point; `y` stays a Decimal until the GraphQL boundary (`Float!`). */
export interface LegacySeriesPoint {
  readonly x: string;
  readonly y: Decimal;
}

export interface LegacyAnalyticsSeries {
  readonly seriesId: string;
  readonly xAxis: LegacyAxis;
  readonly yAxis: LegacyAxis;
  readonly data: readonly LegacySeriesPoint[];
}

/** A yearly reference series (CPI YoY index, FX rate, GDP, population). */
export type YearlySeries = ReadonlyMap<number, Decimal>;
