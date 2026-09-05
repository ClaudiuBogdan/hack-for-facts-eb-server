/**
 * Budget module — domain view models (plan §2.2). camelCase; money = `string`
 * (`numeric(18,2)`, never float); ids = `string` (bigint). Budget keys on
 * `entity_cui` (the cross-source link, §2.1) — `org_id` never surfaces here.
 *
 * The clean enums (`ReportType`, `AccountCategory`) are mapped to/from the
 * partition literals at the repo boundary (`constants.ts`).
 */

import type {
  AccountCategory,
  BudgetFrequency,
  BudgetNormalization,
  CommitmentReportType,
  ExecutionReportType,
} from './constants.js';
import type { FilterInput, Money } from '@/modules/shared/index.js';

// ── execution fact row ────────────────────────────────────────────────────────

export interface ExecutionLineItem {
  readonly executionLineItemId: string;
  readonly reportId: string;
  readonly reportingYear: number;
  readonly reportingMonth: number;
  readonly quarter: number | null;
  readonly entityCui: string;
  readonly mainCreditorCui: string | null;
  readonly reportType: ExecutionReportType;
  readonly accountCategory: AccountCategory;
  readonly budgetSectorId: number;
  readonly expenseType: string | null;
  readonly functionalCode: string;
  readonly functionalName: string | null;
  readonly economicCode: string | null;
  readonly economicName: string | null;
  readonly fundingSource: string | null;
  readonly fundingSourceId: number;
  readonly programCode: string | null;
  readonly ytdAmount: Money;
  readonly monthlyAmount: Money;
  readonly quarterlyAmount: Money | null;
  readonly isMonthly: boolean;
  readonly isQuarterly: boolean;
  readonly isYearly: boolean;
  readonly anomaly: string | null;
}

// ── commitment fact row (13 metric families; latest = the un-prefixed column) ─

export interface CommitmentMetric {
  readonly ytd: Money | null;
  readonly monthly: Money | null;
  readonly quarterly: Money | null;
  readonly latest: Money | null;
}

export interface CommitmentLineItem {
  readonly commitmentLineItemId: string;
  readonly reportId: string;
  readonly reportingYear: number;
  readonly reportingMonth: number;
  readonly quarter: number | null;
  readonly entityCui: string;
  readonly mainCreditorCui: string | null;
  readonly reportType: CommitmentReportType;
  readonly budgetSectorId: number;
  readonly functionalCode: string;
  readonly functionalName: string | null;
  readonly economicCode: string | null;
  readonly economicName: string | null;
  readonly fundingSource: string | null;
  readonly fundingSourceId: number;
  // 13 metric families (R3 review fix — surface ALL, matching the live schema).
  readonly crediteAngajament: CommitmentMetric;
  readonly limitaCreditAngajament: CommitmentMetric;
  readonly crediteBugetare: CommitmentMetric;
  readonly crediteAngajamentInitiale: CommitmentMetric;
  readonly crediteBugetareInitiale: CommitmentMetric;
  readonly crediteAngajamentDefinitive: CommitmentMetric;
  readonly crediteBugetareDefinitive: CommitmentMetric;
  readonly crediteAngajamentDisponibile: CommitmentMetric;
  readonly crediteBugetareDisponibile: CommitmentMetric;
  readonly receptiiTotale: CommitmentMetric;
  readonly platiTrezor: CommitmentMetric;
  readonly platiNonTrezor: CommitmentMetric;
  readonly receptiiNeplatite: CommitmentMetric;
  readonly isMonthly: boolean;
  readonly isQuarterly: boolean;
  readonly isYearly: boolean;
  readonly anomaly: string | null;
}

// ── entity/period summaries (from the execution MVs) ──────────────────────────

export interface BudgetPeriod {
  readonly year: number;
  readonly month: number | null;
  readonly quarter: number | null;
}

export interface BudgetEntitySummary {
  readonly entityCui: string;
  readonly mainCreditorCui: string | null;
  readonly reportType: ExecutionReportType;
  readonly period: BudgetPeriod;
  readonly totalIncome: Money;
  readonly totalExpense: Money;
  readonly budgetBalance: Money;
}

/**
 * Commitment entity×period summary (from the commitment MVs). The ANNUAL +
 * QUARTERLY MVs carry the full 13-metric set; the MONTHLY MV carries a reduced
 * set (only credite_angajament/plati_trezor/plati_non_trezor/receptii_totale +
 * receptii_neplatite_change), so the unavailable metrics are `null` at MONTH grain.
 */
export interface CommitmentEntitySummary {
  readonly entityCui: string;
  readonly mainCreditorCui: string | null;
  readonly reportType: CommitmentReportType;
  readonly period: BudgetPeriod;
  readonly crediteAngajament: Money | null;
  readonly limitaCreditAngajament: Money | null;
  readonly crediteBugetare: Money | null;
  readonly crediteAngajamentInitiale: Money | null;
  readonly crediteBugetareInitiale: Money | null;
  readonly crediteAngajamentDefinitive: Money | null;
  readonly crediteBugetareDefinitive: Money | null;
  readonly crediteAngajamentDisponibile: Money | null;
  readonly crediteBugetareDisponibile: Money | null;
  readonly receptiiTotale: Money | null;
  readonly platiTrezor: Money | null;
  readonly platiNonTrezor: Money | null;
  readonly receptiiNeplatite: Money | null;
}

// ── time series (MV path) ─────────────────────────────────────────────────────

export interface BudgetSeriesPoint {
  readonly period: BudgetPeriod;
  readonly periodLabel: string; // 'YYYY' | 'YYYY-MM' | 'YYYY-Qn'
  readonly amount: Money; // normalized when requested
}

// ── rankings (MV path + factor) ───────────────────────────────────────────────

export type BudgetRankingMetric = 'INCOME' | 'EXPENSE' | 'BALANCE';
export type EntityRankingSort =
  'AMOUNT' | 'PER_CAPITA' | 'ENTITY_NAME' | 'ENTITY_TYPE' | 'POPULATION' | 'COUNTY';

export interface RankedEntity {
  readonly entityCui: string;
  readonly entityName: string | null;
  readonly reportType: ExecutionReportType;
  readonly year: number;
  readonly amount: Money; // metric value (normalized if requested)
  readonly perCapita: Money | null;
  readonly population: number | null;
  readonly countyCode: string | null;
  readonly countyName: string | null;
  readonly entityType: string | null;
  readonly territoryId: number | null;
}

export interface RankedEntityPage {
  readonly items: readonly RankedEntity[];
  readonly total: number;
}

export type CommitmentRankingMetric =
  'plati_trezor' | 'plati_non_trezor' | 'credite_angajament' | 'receptii_totale';

export interface RankedCommitmentEntity {
  readonly entityCui: string;
  readonly entityName: string | null;
  readonly reportType: CommitmentReportType;
  readonly year: number;
  readonly amount: Money;
}

// ── classification aggregate (fact path; one pruned leaf) ─────────────────────

export interface AggregatedBudgetRow {
  readonly functionalCode: string;
  readonly functionalName: string | null;
  readonly economicCode: string | null; // economic_code IS NULL is a real bucket
  readonly economicName: string | null;
  readonly amount: Money;
  readonly lineCount: number;
}

// ── county heatmap (MV → county rollup) ───────────────────────────────────────

export interface CountyHeatmapPoint {
  readonly countyCode: string;
  readonly countyName: string | null;
  readonly countyEntityCui: string | null;
  readonly year: number;
  readonly amount: Money;
  readonly perCapita: Money | null;
  readonly population: number | null;
  readonly entityCount: number;
}

export interface UatHeatmapPoint {
  readonly territoryId: number;
  readonly entityCui: string;
  readonly uatName: string;
  readonly sirutaCode: string | null;
  readonly countyCode: string | null;
  readonly countyName: string | null;
  readonly region: string | null;
  readonly year: number;
  readonly amount: Money;
  readonly perCapita: Money | null;
  readonly population: number | null;
}

// ── reports ───────────────────────────────────────────────────────────────────

export interface BudgetReport {
  readonly reportId: string;
  readonly entityCui: string;
  readonly entityName: string | null;
  // The reports registry mixes execution + commitment report literals; kept as
  // the raw partition literal here (a closed union would drop unmapped types).
  readonly reportType: string;
  readonly mainCreditorCui: string | null;
  readonly reportDate: string | null;
  readonly reportingYear: number;
  readonly reportingPeriod: string;
  readonly budgetSectorId: number | null;
  readonly fileSource: string | null;
  readonly downloadLinks: readonly string[];
}

// ── dimensions ────────────────────────────────────────────────────────────────

export interface BudgetClassification {
  readonly code: string;
  readonly name: string | null;
}

export interface BudgetSector {
  readonly sectorId: number;
  readonly sectorDescription: string | null;
}

export interface BudgetFundingSource {
  readonly sourceId: number;
  readonly sourceCode: string | null;
  readonly sourceDescription: string | null;
}

// ── budget-official (capability-gated) ────────────────────────────────────────

export interface ApprovedBudgetFact {
  readonly factId: string;
  readonly budgetYear: number;
  readonly measureYear: number | null;
  readonly budgetComponent: string | null;
  readonly functionalCode: string | null;
  readonly economicCode: string | null;
  readonly programCode: string | null;
  readonly label: string | null;
  readonly measureKind: string | null;
  readonly amountValue: Money | null;
  readonly unit: string | null;
}

export interface BudgetVsExecutionRow {
  readonly componentKey: string | null;
  readonly section: string | null;
  readonly lineItemKey: string | null;
  readonly lineItemLabel: string | null;
  readonly periodYear: number | null;
  readonly budgetYear: number | null;
  readonly executionAmountRon: Money | null;
  readonly approvedAmountRon: Money | null;
  readonly deltaAmount: Money | null;
  readonly comparisonBasis: string | null;
}

/**
 * A capability-gated OFFSET page (R6 review fix — these are bounded/indexed
 * lists, so offset + cheap COUNT, NOT a cursor). Empty data from a missing
 * upstream load surfaces a caveat, never a 404.
 */
export interface GatedOffsetPage<T> {
  readonly items: readonly T[];
  readonly total: number | null;
  readonly estimated: boolean;
  readonly caveats: readonly string[];
}

// ── contributor / entity-360 (plan §4.1) ──────────────────────────────────────

export interface BudgetTopCategory {
  readonly functionalCode: string;
  readonly functionalName: string | null;
  readonly amount: Money;
}

export interface BudgetProfileSlice {
  readonly cui: string;
  readonly latestYear: number;
  readonly latestCompleteYear: number;
  readonly reportType: ExecutionReportType;
  readonly totalIncome: Money | null;
  readonly totalExpense: Money | null;
  readonly budgetBalance: Money | null;
  readonly topExpenseCategories: readonly BudgetTopCategory[];
  readonly refreshedAt: string | null;
}

// ── as-of / freshness (plan §10) ──────────────────────────────────────────────

export interface BudgetAsOf {
  readonly latestLoadedYear: number;
  readonly latestCompleteYear: number;
  readonly refreshedAt: string | null;
}

// ── discovery / resolve (plan §7.4/§7.5) ──────────────────────────────────────

export const BUDGET_RESOLVE_DIMS = ['entity', 'territory', 'functional', 'economic'] as const;
export type BudgetResolveDim = (typeof BUDGET_RESOLVE_DIMS)[number];

/** A name→value resolve hit (the §7.5 Entity Resolution Gate output). */
export interface ResolveMatch {
  readonly dim: BudgetResolveDim;
  readonly value: string; // the filter value to feed back (CUI / SIRUTA / code)
  readonly label: string;
  readonly hint: string | null; // county / type disambiguator
  readonly score: number | null;
  readonly ambiguous: boolean;
}

// ── query option bags (the repo inputs the usecases build) ────────────────────

export interface CursorPageReq {
  readonly first: number;
  readonly after?: string;
}

/** The validated fact-list query: a kernel FilterInput + a page request. */
export interface BudgetFactQuery {
  readonly filter: FilterInput;
  readonly sort: 'LINE_ORDER' | 'AMOUNT_DESC' | 'AMOUNT_ASC';
  readonly page: CursorPageReq;
}

export interface BudgetCommitmentFactQuery {
  readonly filter: FilterInput;
  readonly metric: CommitmentRankingMetric;
  readonly sort: 'LINE_ORDER' | 'AMOUNT_DESC' | 'AMOUNT_ASC';
  readonly page: CursorPageReq;
}

/** Classification aggregate query (fact path; one pruned leaf, GROUP BY classification). */
export interface ClassificationAggregateQuery {
  readonly filter: FilterInput;
  readonly normalization: BudgetNormalization;
  readonly minAmount?: string;
  readonly maxAmount?: string;
  readonly limit: number;
  readonly complete?: boolean;
}

export interface SummaryQuery {
  readonly year?: number;
  readonly yearFrom?: number;
  readonly yearTo?: number;
  readonly frequency: BudgetFrequency;
  readonly reportType?: ExecutionReportType;
}

export interface CommitmentSummaryQuery {
  readonly year?: number;
  readonly yearFrom?: number;
  readonly yearTo?: number;
  readonly frequency: BudgetFrequency;
  readonly reportType?: CommitmentReportType;
}

/** Execution time series (MV path). `metric` selects the MV column (§0.4). */
export interface TimeseriesQuery {
  readonly entityCui: string;
  readonly reportType: ExecutionReportType;
  readonly metric: BudgetRankingMetric;
  readonly frequency: BudgetFrequency;
  readonly yearFrom?: number;
  readonly yearTo?: number;
  readonly normalization: BudgetNormalization;
}

export interface AggregateTimeseriesQuery {
  readonly reportType: ExecutionReportType;
  readonly metric: BudgetRankingMetric;
  readonly frequency: BudgetFrequency;
  readonly yearFrom: number;
  readonly yearTo: number;
  readonly normalization: BudgetNormalization;
  readonly isUat?: boolean;
  readonly isTerritorialExecutive?: boolean;
}

/** Commitment time series (MV path); `metric` is a commitment metric column. */
export interface CommitmentTimeseriesQuery {
  readonly entityCui: string;
  readonly reportType: CommitmentReportType;
  readonly metric: CommitmentRankingMetric;
  readonly frequency: BudgetFrequency;
  readonly yearFrom?: number;
  readonly yearTo?: number;
}

/** Bounded top-N ranking (MV path). NO cursor — rankings are top-N by definition. */
export interface EntityRankingQuery {
  readonly year: number;
  readonly reportType: ExecutionReportType;
  readonly frequency: BudgetFrequency;
  readonly month?: number;
  readonly quarter?: number;
  readonly metric: BudgetRankingMetric;
  readonly normalization: BudgetNormalization;
  readonly entityCuis?: readonly string[];
  readonly mainCreditorCui?: string;
  readonly excludeEntityCuis?: readonly string[];
  readonly countyCodes?: readonly string[];
  readonly regions?: readonly string[];
  readonly isUat?: boolean;
  readonly isTerritorialExecutive?: boolean;
  readonly minPopulation?: number;
  readonly maxPopulation?: number;
  readonly ascending?: boolean;
  readonly sort?: EntityRankingSort;
  readonly limit: number;
}

export interface EntityRankingPageQuery extends EntityRankingQuery {
  readonly offset: number;
}

export interface CommitmentRankingQuery {
  readonly year: number;
  readonly reportType: CommitmentReportType;
  readonly metric: CommitmentRankingMetric;
  readonly limit: number;
}

export interface HeatmapQuery {
  readonly year: number;
  readonly reportType: ExecutionReportType;
  readonly metric: BudgetRankingMetric;
  readonly normalization: BudgetNormalization;
}
