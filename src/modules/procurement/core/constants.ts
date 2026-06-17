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

export const CONTRACT_STATUSES = ['awarded', 'in_progress', 'closed', 'cancelled', 'unknown'] as const;
export type ContractStatus = (typeof CONTRACT_STATUSES)[number];

export const DA_STATUSES = ['offered', 'awarded', 'finalized', 'cancelled', 'unknown'] as const;
export type DaStatus = (typeof DA_STATUSES)[number];

// ── source-system tokens (verified live) ───────────────────────────────────────

export const DA_SOURCE_SYSTEMS = ['elicitatie_da', 'seap_da', 'seap_dan'] as const;
export type DaSourceSystem = (typeof DA_SOURCE_SYSTEMS)[number];

export const PROCEDURE_SOURCE_SYSTEMS = ['elicitatie', 'seap_notice'] as const;

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
