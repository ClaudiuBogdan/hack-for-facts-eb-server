/**
 * Procurement module — constants (plan §0, §2, §3a). Closed enums (verified live
 * 2026-06-17), the grain set, source-system tokens, and the kernel-registered
 * flow/doc types. NO partition-literal maps (procurement enums are stored as the
 * clean tokens themselves — unlike budget, whose columns store Romanian labels).
 */

export const PROCUREMENT_SOURCE = 'procurement' as const;

/**
 * `source_grain` = the kernel `flow_type` (NOT a SEAP/elicitatie distinction).
 * The generation quality verdicts are keyed by this; every analysis
 * answer is scoped to ONE grain and the two are never summed (§14.6).
 */
export const PROCUREMENT_GRAINS = ['direct_acquisition', 'procurement_contract'] as const;
export type ProcurementGrain = (typeof PROCUREMENT_GRAINS)[number];

/** Flow types this module registers into the kernel `FLOW_TYPES` enum (§4.4). */
export const PROCUREMENT_FLOW_TYPES = ['procurement_contract', 'direct_acquisition'] as const;

/** Doc types this module owns in `search.documents` (§9). */
export const PROCUREMENT_DOC_TYPES = [
  'procurement_procedure',
  'procurement_contract',
  'procurement_direct_acquisition',
] as const;

// ── status enums (verified live: every observed value is covered) ──────────────

export const PROCEDURE_STATUSES = [
  'published',
  'in_evaluation',
  'awarded',
  'cancelled',
  'suspended',
  'unknown',
] as const;
export type ProcedureStatus = (typeof PROCEDURE_STATUSES)[number];

export const CONTRACT_STATUSES = [
  'awarded',
  'in_progress',
  'closed',
  'cancelled',
  'unknown',
] as const;
export type ContractStatus = (typeof CONTRACT_STATUSES)[number];

export const DA_STATUSES = ['offered', 'awarded', 'finalized', 'cancelled', 'unknown'] as const;
export type DaStatus = (typeof DA_STATUSES)[number];

// ── source-system tokens (verified live) ───────────────────────────────────────

export const DA_SOURCE_SYSTEMS = ['elicitatie_da', 'seap_da', 'seap_dan'] as const;
export type DaSourceSystem = (typeof DA_SOURCE_SYSTEMS)[number];

// ── value-model resolution states (scrapper VALUE_RULES_VERSION 4) ────────────
// The closed per-row outcome set of the data layer's resolution engine.
// ACCEPTED states are the ONLY ones whose money enters served aggregates;
// `cross_source_exact` / `official_document_recovered` are reserved (not yet
// minted by the v4 engine) but part of the frozen contract.
export const ACCEPTED_VALUE_STATES = [
  'official_exact',
  'official_ron_equivalent',
  'cross_source_exact',
  'official_document_recovered',
] as const;
export const VALUE_STATES = [
  ...ACCEPTED_VALUE_STATES,
  'source_missing',
  'invalid_source_value',
  'foreign_currency_only',
  'ambiguous_grain',
  'conflicting_sources',
  'not_applicable',
] as const;
export type ValueState = (typeof VALUE_STATES)[number];
export const ACCEPTED_VALUE_STATE_SET: ReadonlySet<string> = new Set(ACCEPTED_VALUE_STATES);

export const VALUE_COMPARABLE_BASES = ['official', 'derived_bnr'] as const;

/**
 * Contract record kinds (serving convention 2026-07-23, scrapper
 * docs/procurement/PROCUREMENT_TYPES_AND_VALUES_EXPLAINED.md §5–§6): a
 * contract row is either a purchase record or a framework umbrella. Stamped
 * by value-rules v5 from the framework observation marker — orthogonal to
 * value_state (ambiguous_grain is NOT a framework marker). A NULL column
 * (pre-v5 data) reads as 'contract_award'.
 */
export const RECORD_KINDS = ['contract_award', 'framework_agreement'] as const;
export type RecordKind = (typeof RECORD_KINDS)[number];
export type ValueComparableBasis = (typeof VALUE_COMPARABLE_BASES)[number];

export const PROCEDURE_SOURCE_SYSTEMS = ['elicitatie', 'seap_notice'] as const;
export const CONTRACT_SOURCE_SYSTEMS = ['elicitatie_ca_award', 'seap_contracts'] as const;

// ── offset search (the client contract, graphql-api-spec.md §Pagination) ───────

/** `page * pageSize` may not exceed this — a deep OFFSET is a scan, not a seek. */
export const SEARCH_WINDOW_MAX = 10_000;
/**
 * The exact-count cap. We count `select 1 … limit CAP+1` in a subquery: ≤ CAP →
 * an exact `total`; CAP+1 → `total: null` + `totalEstimated: true` ("10000+").
 */
export const SEARCH_COUNT_CAP = 10_000;
export const PAGE_SIZE_MAX = 100;
export const PAGE_SIZE_DEFAULT = 20;

/** Free-text `q` bounds. Below the minimum an ILIKE `%x%` degenerates to a scan. */
export const Q_MIN_LENGTH = 3;
export const Q_MAX_LENGTH = 100;

/** The four sorts the client offers. Mapped to a per-grain column in the repo. */
export const SEARCH_SORTS = ['date_desc', 'date_asc', 'value_desc', 'value_asc'] as const;
export type SearchSort = (typeof SEARCH_SORTS)[number];
export const DEFAULT_SEARCH_SORT: SearchSort = 'date_desc';

/**
 * Direct acquisitions are 26M rows and `finalization_date` is NULL on 9.57M of
 * them, so `ORDER BY finalization_date DESC NULLS LAST` cannot be served by the
 * plain `das_finalization_date_idx` — the planner sorts whatever the WHERE clause
 * yields. Measured live 2026-07-09 against the 15s statement timeout:
 *   authority_cui eq         →   0.8s   ✓
 *   supplier_cui eq          →   6.4s   ✓ (a 312k-flow supplier; the worst case)
 *   bounded 366d window      →   6.5s   ✓
 *   cpv division range       →  16.6s   ✗ TIMES OUT (2.8M rows to sort)
 *   unique_code eq           →   8.0s   ✗ no index on unique_code — seq scan
 * So the OFFSET surface admits only the three qualifying dimensions below. CPV and
 * `q` still REFINE a qualifying filter; they just cannot drive one on their own.
 * (The legacy cursor surface keeps its own, looser `DA_SELECTIVE_FIELDS` rule.)
 */
export const DA_OFFSET_SELECTIVE_FIELDS = ['authorityCui', 'supplierCui'] as const;

// ── discovery dimensions (§7.6) ────────────────────────────────────────────────

export const PROCUREMENT_RESOLVE_DIMS = [
  'authority',
  'supplier',
  'cpvDivision',
  'cpv',
  'region',
  'county',
] as const;
export type ProcurementResolveDim = (typeof PROCUREMENT_RESOLVE_DIMS)[number];

// ── as-of / grain note surfaced to agents (§14.6) ──────────────────────────────

export const PROCUREMENT_GRAIN_NOTE =
  'Contract and direct-acquisition answers are reported on separate grains and never summed into one number.';

/**
 * The DA bare-date list window cap (days). A bare-date-only DA list is allowed but
 * its window must be ≤ this so the planner range-scans the finalization_date index
 * rather than walking the whole 20M-row table (§3a(1)). Env-tunable.
 */
export const DA_LIST_MAX_WINDOW_DAYS_DEFAULT = 366;

/** The MV minimum month — endpoints "across all time" still bound by this so the
 * dims index range-scans rather than seq-scanning the MV (§3a(2)). */
export const ROLLUP_MIN_MONTH = '2011-07-01' as const;

/** The grain that defaults when an aggregate request omits one (higher coverage). */
export const DEFAULT_GRAIN: ProcurementGrain = 'direct_acquisition';

// ── analysis package (design §3–§5; scraper-built rollups) ─────────────────────

/**
 * The analysis grains, in the DB vocabulary of `procurement.analysis_rollup_*`
 * (`grain` column). This is the ONE canonical TS vocabulary for the analysis
 * surface; the legacy `PROCUREMENT_GRAINS` ('procurement_contract' …) stays for
 * the flow-MV surfaces and the two never mix.
 */
export const ANALYSIS_GRAINS = ['procedure', 'contract', 'direct_acquisition'] as const;
export type AnalysisGrain = (typeof ANALYSIS_GRAINS)[number];

/** Measures the semantic policy table (core/policy.ts) declares entries for. */
export const MEASURE_IDS = [
  'recordCount',
  'withValueCount',
  'valueAwardedSum',
  'valueEstimatedSum',
  'avgValueAwarded',
  'distinctSuppliers',
  'distinctAuthorities',
] as const;
export type MeasureId = (typeof MEASURE_IDS)[number];

/** Breakdown dimensions ClickHouse facts can GROUP BY (design §6.2). */
export const BREAKDOWN_DIMENSIONS = [
  'authority',
  'supplier',
  'cpvDivision',
  'cpvGroup',
  'cpvClass',
  'cpvCategory',
  'cpvCode',
  'status',
  'procedureType',
  'recordKind',
  'buyerRegion',
  'buyerCounty',
  'buyerSiruta',
  'supplierRegion',
  'supplierCounty',
  'supplierSiruta',
] as const;
export type BreakdownDimension = (typeof BREAKDOWN_DIMENSIONS)[number];

/**
 * SIRUTA breakdown topN ceiling: full-country UAT painting needs every UAT
 * bucket (3,186 UATs / 2021 SIRUTA); every other dimension keeps the regular
 * topN cap (analysis-usecases.ts TOPN_MAX).
 */
export const TOPN_SIRUTA_MAX = 3300;

/** Series buckets. Storage is monthly; quarter/year are derived (additive laws only). */
export const SERIES_BUCKETS = ['month', 'quarter', 'year'] as const;
export type SeriesBucket = (typeof SERIES_BUCKETS)[number];

/**
 * Count/time answers degrade with disclosure down to this coverage floor and
 * abstain below it (design §5.4; provisional per §9.6). The scraper computes the
 * gate classes against it; `core/gate-v2.ts` interprets them.
 */
export const COUNT_TIME_DEGRADE_FLOOR = 0.5;
