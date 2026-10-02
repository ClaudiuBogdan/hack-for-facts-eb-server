/**
 * Companies analytics — vocabulary and result shapes.
 *
 * The API speaks ONE vocabulary on both surfaces: the GraphQL enum names
 * (`TURNOVER`, `HELD_PROFILE`, `COUNTY`, …). GraphQL serializes them as-is and
 * MCP returns the same objects, so the two cannot drift. The data contract's
 * snake_case names (`turnover`, `held_profile`) exist only at the boundary:
 * `METRIC_COLUMN` / `STATUS_VALUE` / … below are the whitelist through which a
 * name may reach SQL, and the coverage parser reads the manifest with them.
 *
 * Data contract: scraper `src/sources/private-companies/prod/analytics/contract.ts`
 * (schema `companies-analytics-ch-v1`) and the release migration
 * `20261002T180000__companies_analytics_releases.ts`.
 *
 * Every count, sum and mean is an exact decimal string; nothing is a float.
 */

export const COMPANY_ANALYSIS_SCHEMA_VERSION = 'companies-analytics-ch-v1';

// ─────────────────────────────────────────────────────────────────────────────
// Metrics
// ─────────────────────────────────────────────────────────────────────────────

export const COMPANY_ANALYSIS_METRICS = [
  'TURNOVER',
  'NET_PROFIT',
  'NET_LOSS',
  'EMPLOYEES',
  'TOTAL_REVENUE',
  'TOTAL_EXPENSES',
  'GROSS_PROFIT',
  'GROSS_LOSS',
  'RECEIVABLES',
  'CURRENT_ASSETS',
  'FIXED_ASSETS',
  'CASH_AND_BANK',
  'PREPAID_EXPENSES',
  'DEFERRED_INCOME',
  'SUBSCRIBED_CAPITAL',
  'INVENTORIES',
  'DEBTS',
  'PROVISIONS',
  'TOTAL_EQUITY',
  'PATRIMONY_REGIE',
  'NET_RESULT',
] as const;
export type CompanyAnalysisMetric = (typeof COMPANY_ANALYSIS_METRICS)[number];

/** The ClickHouse value column (and manifest key) of each metric; its status is `<column>_status`. */
export const METRIC_COLUMN: Readonly<Record<CompanyAnalysisMetric, string>> = {
  TURNOVER: 'turnover',
  NET_PROFIT: 'net_profit',
  NET_LOSS: 'net_loss',
  EMPLOYEES: 'employees',
  TOTAL_REVENUE: 'total_revenue',
  TOTAL_EXPENSES: 'total_expenses',
  GROSS_PROFIT: 'gross_profit',
  GROSS_LOSS: 'gross_loss',
  RECEIVABLES: 'receivables',
  CURRENT_ASSETS: 'current_assets',
  FIXED_ASSETS: 'fixed_assets',
  CASH_AND_BANK: 'cash_and_bank',
  PREPAID_EXPENSES: 'prepaid_expenses',
  DEFERRED_INCOME: 'deferred_income',
  SUBSCRIBED_CAPITAL: 'subscribed_capital',
  INVENTORIES: 'inventories',
  DEBTS: 'debts',
  PROVISIONS: 'provisions',
  TOTAL_EQUITY: 'total_equity',
  PATRIMONY_REGIE: 'patrimony_regie',
  NET_RESULT: 'net_result',
};

/** RON = `Decimal(18, 2)` money; HEADCOUNT = reported average employees (`Int64`). */
export type CompanyAnalysisUnit = 'RON' | 'HEADCOUNT';
/**
 * FLOW = an amount over the fiscal year; STOCK = a balance at the statement
 * date; HEADCOUNT = an average headcount. Stocks and headcounts are never
 * summed across years (the API offers no multi-year total at all).
 */
export type CompanyAnalysisMetricKind = 'FLOW' | 'STOCK' | 'HEADCOUNT';

const FLOW_METRICS: ReadonlySet<CompanyAnalysisMetric> = new Set([
  'TURNOVER',
  'NET_PROFIT',
  'NET_LOSS',
  'TOTAL_REVENUE',
  'TOTAL_EXPENSES',
  'GROSS_PROFIT',
  'GROSS_LOSS',
  'NET_RESULT',
]);

export const metricUnit = (metric: CompanyAnalysisMetric): CompanyAnalysisUnit =>
  metric === 'EMPLOYEES' ? 'HEADCOUNT' : 'RON';

export const metricKind = (metric: CompanyAnalysisMetric): CompanyAnalysisMetricKind => {
  if (metric === 'EMPLOYEES') return 'HEADCOUNT';
  return FLOW_METRICS.has(metric) ? 'FLOW' : 'STOCK';
};

export const isCompanyAnalysisMetric = (value: unknown): value is CompanyAnalysisMetric =>
  typeof value === 'string' && (COMPANY_ANALYSIS_METRICS as readonly string[]).includes(value);

// ─────────────────────────────────────────────────────────────────────────────
// Per-metric statuses (every company-year carries one per metric)
// ─────────────────────────────────────────────────────────────────────────────

export const COMPANY_ANALYSIS_STATUSES = [
  'REPORTED',
  'MISSING',
  'NOT_ADMITTED',
  'HELD_PROFILE',
  'HELD_OBSERVATION',
  'HELD_QUALITY',
  'HELD_COMPONENT',
] as const;
export type CompanyAnalysisStatus = (typeof COMPANY_ANALYSIS_STATUSES)[number];

export const STATUS_VALUE: Readonly<Record<CompanyAnalysisStatus, string>> = {
  REPORTED: 'reported',
  MISSING: 'missing',
  NOT_ADMITTED: 'not_admitted',
  HELD_PROFILE: 'held_profile',
  HELD_OBSERVATION: 'held_observation',
  HELD_QUALITY: 'held_quality',
  HELD_COMPONENT: 'held_component',
};

/** Status counts of one metric over a set of statements. Their sum is the statement count. */
export interface CompanyAnalysisCoverage {
  readonly reported: string;
  readonly missing: string;
  readonly notAdmitted: string;
  readonly heldProfile: string;
  readonly heldObservation: string;
  readonly heldQuality: string;
  readonly heldComponent: string;
}

export const COVERAGE_FIELD: Readonly<
  Record<CompanyAnalysisStatus, keyof CompanyAnalysisCoverage>
> = {
  REPORTED: 'reported',
  MISSING: 'missing',
  NOT_ADMITTED: 'notAdmitted',
  HELD_PROFILE: 'heldProfile',
  HELD_OBSERVATION: 'heldObservation',
  HELD_QUALITY: 'heldQuality',
  HELD_COMPONENT: 'heldComponent',
};

// ─────────────────────────────────────────────────────────────────────────────
// Dimension values
// ─────────────────────────────────────────────────────────────────────────────

/** EU headcount bands over the year's REPORTED employees (`eu-headcount-2003-361-v1`). */
export const COMPANY_ANALYSIS_SIZE_BANDS = [
  'UNAVAILABLE',
  'NEGATIVE',
  'ZERO',
  'FROM_1_TO_9',
  'FROM_10_TO_49',
  'FROM_50_TO_249',
  'FROM_250',
] as const;
export type CompanyAnalysisSizeBand = (typeof COMPANY_ANALYSIS_SIZE_BANDS)[number];

export const SIZE_BAND_VALUE: Readonly<Record<CompanyAnalysisSizeBand, string>> = {
  UNAVAILABLE: 'unavailable',
  NEGATIVE: 'negative',
  ZERO: '0',
  FROM_1_TO_9: '1-9',
  FROM_10_TO_49: '10-49',
  FROM_50_TO_249: '50-249',
  FROM_250: '250+',
};

export const COMPANY_ANALYSIS_CAEN_BASES = [
  'REVISION_KNOWN',
  'REVISION_UNKNOWN',
  'MISSING',
] as const;
export type CompanyAnalysisCaenBasis = (typeof COMPANY_ANALYSIS_CAEN_BASES)[number];

export const CAEN_BASIS_VALUE: Readonly<Record<CompanyAnalysisCaenBasis, string>> = {
  REVISION_KNOWN: 'revision_known',
  REVISION_UNKNOWN: 'revision_unknown',
  MISSING: 'missing',
};

/** An ANAF fiscal observation. UNKNOWN is a NULL observation — never read as NO. */
export const COMPANY_ANALYSIS_FLAG_VALUES = ['YES', 'NO', 'UNKNOWN'] as const;
export type CompanyAnalysisFlagValue = (typeof COMPANY_ANALYSIS_FLAG_VALUES)[number];

export const COMPANY_ANALYSIS_FILING = ['FILED', 'NOT_FILED'] as const;
export type CompanyAnalysisFiling = (typeof COMPANY_ANALYSIS_FILING)[number];

// ─────────────────────────────────────────────────────────────────────────────
// Shapes: breakdown dimensions, rankings, series modes, record sorts
// ─────────────────────────────────────────────────────────────────────────────

export const COMPANY_ANALYSIS_DIMENSIONS = [
  'COUNTY',
  'UAT',
  'MAIN_CAEN',
  'LEGAL_FORM',
  'OBSERVED_STATUS',
  'VAT_PAYER',
  'FISCALLY_INACTIVE',
  'EMPLOYEE_SIZE',
] as const;
export type CompanyAnalysisDimension = (typeof COMPANY_ANALYSIS_DIMENSIONS)[number];

export const COMPANY_ANALYSIS_RANKINGS = [
  'METRIC_SUM',
  'COMPANIES',
  'FILERS',
  'CONTRIBUTORS',
] as const;
export type CompanyAnalysisRankBy = (typeof COMPANY_ANALYSIS_RANKINGS)[number];

/**
 * EACH_YEAR re-applies every selected-year filter (filing, financial ranges,
 * size bands) to each year; REFERENCE_YEAR fixes the cohort of companies that
 * filed in the scope's fiscal year and satisfied every filter there.
 */
export const COMPANY_ANALYSIS_COHORT_MODES = ['EACH_YEAR', 'REFERENCE_YEAR'] as const;
export type CompanyAnalysisCohortMode = (typeof COMPANY_ANALYSIS_COHORT_MODES)[number];

export const COMPANY_ANALYSIS_RECORD_SORTS = ['METRIC', 'CUI'] as const;
export type CompanyAnalysisRecordSort = (typeof COMPANY_ANALYSIS_RECORD_SORTS)[number];

export const COMPANY_ANALYSIS_DIRECTIONS = ['DESC', 'ASC'] as const;
export type CompanyAnalysisDirection = (typeof COMPANY_ANALYSIS_DIRECTIONS)[number];

/** Why a series year carries no figure, judged on the scope's own statements that year. */
export type CompanyAnalysisGapReason = 'NO_STATEMENTS' | 'NOT_ADMITTED' | 'NO_REPORTED_VALUES';

// ─────────────────────────────────────────────────────────────────────────────
// Limits (enforced in core, before any engine call)
// ─────────────────────────────────────────────────────────────────────────────

export const COMPANY_ANALYSIS_LIMITS = {
  maxSelectedCuis: 500,
  maxCounties: 60,
  maxUats: 500,
  maxLegalForms: 30,
  maxObservedStatuses: 60,
  maxCaenCodes: 200,
  maxFinancialRanges: 6,
  maxMetrics: COMPANY_ANALYSIS_METRICS.length,
  /** Values carried per record row (bounds the joined statement side). */
  maxRecordMetrics: 8,
  defaultTopN: 10,
  maxTopN: 100,
  defaultPageSize: 25,
  maxPageSize: 100,
} as const;

export const DEFAULT_METRIC: CompanyAnalysisMetric = 'TURNOVER';
export const PREFERRED_DEFAULT_YEAR = 2024;

// ─────────────────────────────────────────────────────────────────────────────
// Validated scope (the question every shape answers)
// ─────────────────────────────────────────────────────────────────────────────

export interface CompanyAnalysisKeyFilter {
  /** Sorted, de-duplicated stable keys. */
  readonly values: readonly string[];
  /** Also match the unknown (NULL) group. */
  readonly includeUnknown: boolean;
}

export interface CompanyAnalysisCaenSelector {
  readonly code: string;
  /** null = ANAF published no revision: matches `revision_unknown` rows only, never guessed. */
  readonly revision: string | null;
}

export interface CompanyAnalysisRange {
  readonly metric: CompanyAnalysisMetric;
  /** Exact decimal (RON, 2 places) or integer (headcount) string, inclusive. */
  readonly min: string | null;
  readonly max: string | null;
}

/**
 * The validated scope. OR within a field, AND across fields. `fiscalYear` is
 * always set (the release default fills it). Company dimensions describe the
 * release snapshot; filing, ranges and size bands are selected-year facts.
 */
export interface CompanyAnalysisScope {
  readonly fiscalYear: number;
  readonly cuis?: readonly string[];
  readonly county?: CompanyAnalysisKeyFilter;
  readonly uat?: CompanyAnalysisKeyFilter;
  readonly legalForms?: readonly string[];
  readonly observedStatus?: CompanyAnalysisKeyFilter;
  readonly vatPayer?: readonly CompanyAnalysisFlagValue[];
  readonly fiscallyInactive?: readonly CompanyAnalysisFlagValue[];
  readonly mainCaen?: readonly CompanyAnalysisCaenSelector[];
  readonly mainCaenBasis?: readonly CompanyAnalysisCaenBasis[];
  readonly filing?: CompanyAnalysisFiling;
  readonly financialRanges?: readonly CompanyAnalysisRange[];
  readonly employeeSizeBands?: readonly CompanyAnalysisSizeBand[];
}

/** True when the scope constrains the selected year's statement (population ⊆ filers). */
export const requiresStatement = (scope: CompanyAnalysisScope): boolean =>
  scope.filing === 'FILED' ||
  (scope.financialRanges?.length ?? 0) > 0 ||
  (scope.employeeSizeBands?.length ?? 0) > 0;

// ─────────────────────────────────────────────────────────────────────────────
// Release
// ─────────────────────────────────────────────────────────────────────────────

/** Echoed on every answer. `releaseId` is a positive safe integer as a string. */
export interface CompanyAnalysisReleaseRef {
  readonly releaseId: string;
  readonly publishedAt: string | null;
  /** True when this is the currently active publication. */
  readonly active: boolean;
}

export interface CompanyAnalysisYearMetric {
  readonly metric: CompanyAnalysisMetric;
  /** Offered: admitted for the year and at least one reported value. */
  readonly offered: boolean;
  readonly coverage: CompanyAnalysisCoverage;
}

export interface CompanyAnalysisSizeBandCount {
  readonly band: CompanyAnalysisSizeBand;
  readonly statements: string;
}

export interface CompanyAnalysisYearCapability {
  readonly fiscalYear: number;
  /** Selected statements (company-years) in the release for this year. */
  readonly statements: string;
  readonly metrics: readonly CompanyAnalysisYearMetric[];
  readonly sizeBands: readonly CompanyAnalysisSizeBandCount[];
}

export interface CompanyAnalysisMetricCapability {
  readonly metric: CompanyAnalysisMetric;
  readonly unit: CompanyAnalysisUnit;
  readonly kind: CompanyAnalysisMetricKind;
  readonly offeredYears: readonly number[];
}

export interface CompanyAnalysisDimensionCapability {
  readonly dimension: CompanyAnalysisDimension;
  /** True for EMPLOYEE_SIZE: a selected-year statement attribute, not a company key. */
  readonly yearScoped: boolean;
  readonly labelSource: string;
}

export interface CompanyAnalysisFrontierEntry {
  readonly kind: string;
  readonly id: string | null;
  readonly published: string | null;
  readonly retrieved: string | null;
  readonly rows: string | null;
}

export interface CompanyAnalysisDefaults {
  readonly fiscalYear: number;
  readonly metric: CompanyAnalysisMetric;
  readonly cohortMode: CompanyAnalysisCohortMode;
  readonly rankBy: CompanyAnalysisRankBy;
  readonly topN: number;
  readonly recordSort: CompanyAnalysisRecordSort;
  readonly direction: CompanyAnalysisDirection;
  readonly pageSize: number;
}

/** A parsed, schema-supported, published release with its capabilities. */
export interface CompanyAnalysisRelease {
  readonly ref: CompanyAnalysisReleaseRef;
  /** The validated numeric id (names `company_r<id>` / `company_year_r<id>`). */
  readonly releaseNumber: number;
  /** Privacy epoch captured with the facts. Internal guard input, never served. */
  readonly privacyEpoch: string;
  readonly publicationId: string | null;
  readonly schemaVersion: string;
  readonly populationPolicyVersion: string;
  readonly admissionPolicyVersion: string | null;
  readonly admissionPolicySha256: string | null;
  readonly inputSnapshotAt: string | null;
  readonly companies: string;
  readonly companyYears: string;
  readonly fiscalYears: readonly number[];
  readonly years: readonly CompanyAnalysisYearCapability[];
  readonly metrics: readonly CompanyAnalysisMetricCapability[];
  readonly dimensions: readonly CompanyAnalysisDimensionCapability[];
  readonly defaults: CompanyAnalysisDefaults;
  readonly asOf: readonly CompanyAnalysisFrontierEntry[];
  /** Broad analytical name filtering is not offered in this release (selected CUIs are). */
  readonly nameFilter: false;
  readonly limits: typeof COMPANY_ANALYSIS_LIMITS;
  readonly caveats: readonly string[];
}

/** The capabilities answer (`companyAnalysisRelease`): the release minus internals. */
export type CompanyAnalysisReleaseInfo = Omit<
  CompanyAnalysisRelease,
  'ref' | 'releaseNumber' | 'privacyEpoch'
> & {
  readonly release: CompanyAnalysisReleaseRef;
};

// ─────────────────────────────────────────────────────────────────────────────
// Answers
// ─────────────────────────────────────────────────────────────────────────────

export interface CompanyAnalysisMetricAggregate {
  readonly metric: CompanyAnalysisMetric;
  readonly unit: CompanyAnalysisUnit;
  readonly kind: CompanyAnalysisMetricKind;
  /** Sum of REPORTED values; null when nothing was reported (an explicit 0 stays "0.00"). */
  readonly sum: string | null;
  /** Statements with a REPORTED value — the only denominator a mean uses. */
  readonly contributors: string;
  /** sum / contributors, 2 decimals, half away from zero; null without contributors. */
  readonly mean: string | null;
  readonly coverage: CompanyAnalysisCoverage;
}

interface CompanyAnalysisAnswerBase {
  readonly release: CompanyAnalysisReleaseRef;
  /** The normalized scope, in input shape (feed it back unchanged to page/drill). */
  readonly scope: Readonly<Record<string, unknown>>;
  readonly scopeHash: string;
  readonly fiscalYear: number;
  readonly caveats: readonly string[];
}

export interface CompanyAnalysisStats extends CompanyAnalysisAnswerBase {
  /** Companies in the scope (the `company_r` population, filers and non-filers). */
  readonly companies: string;
  /** Companies with a selected statement for the fiscal year (`company_year_r` rows). */
  readonly filers: string;
  readonly nonFilers: string;
  readonly metrics: readonly CompanyAnalysisMetricAggregate[];
}

export type CompanyAnalysisBucketKind = 'GROUP' | 'OTHER' | 'UNKNOWN' | 'TOTAL';

export interface CompanyAnalysisCaenValue {
  readonly code: string;
  readonly revision: string | null;
  readonly basis: CompanyAnalysisCaenBasis;
  readonly label: string | null;
}

export interface CompanyAnalysisBucket {
  readonly kind: CompanyAnalysisBucketKind;
  /** Stable key (GROUP only); feed it back as a scope filter value. */
  readonly key: string | null;
  readonly label: string | null;
  /** MAIN_CAEN groups only. */
  readonly caen: CompanyAnalysisCaenValue | null;
  /** OTHER: how many groups were folded; GROUP/UNKNOWN: 1; TOTAL: all groups + unknown. */
  readonly groups: number;
  readonly companies: string;
  readonly filers: string;
  /** null only when the fiscal year offers no metric at all. */
  readonly metric: CompanyAnalysisMetricAggregate | null;
}

export interface CompanyAnalysisBreakdown extends CompanyAnalysisAnswerBase {
  readonly dimension: CompanyAnalysisDimension;
  readonly metric: CompanyAnalysisMetric | null;
  /** Known groups before the top-N cut. */
  readonly groupCount: number;
  readonly rankBy: CompanyAnalysisRankBy;
  /** The ranking actually applied (METRIC_SUM falls back to COMPANIES when no group has a contributor). */
  readonly rankedBy: CompanyAnalysisRankBy;
  readonly topN: number;
  readonly groups: readonly CompanyAnalysisBucket[];
  readonly other: CompanyAnalysisBucket;
  readonly unknown: CompanyAnalysisBucket;
  /** groups + other + unknown, equal to companyAnalysisStats for the same scope. */
  readonly totals: CompanyAnalysisBucket;
}

export interface CompanyAnalysisSeriesPoint {
  readonly fiscalYear: number;
  /** True iff the scope's statements that year carry a REPORTED value (sum non-null). */
  readonly available: boolean;
  readonly gapReason: CompanyAnalysisGapReason | null;
  /** EACH_YEAR: the year's population; REFERENCE_YEAR: the fixed cohort size. */
  readonly companies: string;
  readonly filers: string;
  readonly metric: CompanyAnalysisMetricAggregate;
}

export interface CompanyAnalysisSeries extends CompanyAnalysisAnswerBase {
  readonly metric: CompanyAnalysisMetric;
  readonly unit: CompanyAnalysisUnit;
  readonly kind: CompanyAnalysisMetricKind;
  readonly cohortMode: CompanyAnalysisCohortMode;
  /** REFERENCE_YEAR only: the year the cohort was selected in (= fiscalYear). */
  readonly referenceYear: number | null;
  /** REFERENCE_YEAR only: the fixed cohort size. */
  readonly cohortCompanies: string | null;
  readonly fromYear: number;
  readonly toYear: number;
  readonly points: readonly CompanyAnalysisSeriesPoint[];
}

export interface CompanyAnalysisLabelled {
  readonly code: string;
  readonly label: string | null;
}

export interface CompanyAnalysisRecordValue {
  readonly metric: CompanyAnalysisMetric;
  /** Reported value only; null for every other status and for non-filers. */
  readonly value: string | null;
  /** null when the company has no statement for the fiscal year. */
  readonly status: CompanyAnalysisStatus | null;
}

export interface CompanyAnalysisRecord {
  readonly cui: string;
  /** Current public name from PostgreSQL (not release-pinned); null when not publicly named. */
  readonly currentName: string | null;
  readonly legalForm: string;
  readonly county: CompanyAnalysisLabelled | null;
  readonly uat: CompanyAnalysisLabelled | null;
  readonly observedStatus: CompanyAnalysisLabelled | null;
  readonly vatPayer: CompanyAnalysisFlagValue;
  readonly fiscallyInactive: CompanyAnalysisFlagValue;
  readonly mainCaen: CompanyAnalysisCaenValue | null;
  readonly registrationYear: number | null;
  readonly filed: boolean;
  readonly employeeSizeBand: CompanyAnalysisSizeBand | null;
  readonly values: readonly CompanyAnalysisRecordValue[];
}

export interface CompanyAnalysisRecordsPage extends CompanyAnalysisAnswerBase {
  readonly sort: CompanyAnalysisRecordSort;
  readonly sortMetric: CompanyAnalysisMetric | null;
  readonly direction: CompanyAnalysisDirection;
  /** Exact population count of the scope (equal to stats.companies). */
  readonly totalCount: string;
  readonly edges: readonly { readonly cursor: string; readonly node: CompanyAnalysisRecord }[];
  readonly pageInfo: { readonly hasNextPage: boolean; readonly endCursor: string | null };
}
