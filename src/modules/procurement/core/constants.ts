/**
 * Procurement module — constants (plan §0, §2, §3a). Closed enums (verified live
 * 2026-06-17), the grain set, source-system tokens, and the kernel-registered
 * flow/doc types. NO partition-literal maps (procurement enums are stored as the
 * clean tokens themselves — unlike budget, whose columns store Romanian labels).
 */

export const PROCUREMENT_SOURCE = 'procurement' as const;

/**
 * `source_grain` = the kernel `flow_type` (NOT a SEAP/elicitatie distinction).
 * The grain gate (`aggregate_quality_by_grain`) is keyed by this; every aggregate
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
