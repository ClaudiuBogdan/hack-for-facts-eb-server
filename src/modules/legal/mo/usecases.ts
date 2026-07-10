/**
 * Monitorul-Oficial (`mo/` area, plan 06) — usecases (§4). Framework-free; each
 * calls one repo method, shapes the view model, and attaches the `coverage` block
 * where the catalog requires it (Core Rule). REST is not built (GraphQL + MCP
 * only), so these are the SHARED business layer both surfaces call — the basis of
 * tri-surface equivalence (§14.7).
 *
 * `coverage` is computed cheaply: the year range comes from a cached repo scan
 * (one bounded query per TTL window, not per request); the gaps list is fixed;
 * `resolutionRates` are publication-only (Codex #5 — edges/issues omit it).
 */

import { err, ok, type Result } from 'neverthrow';

import {
  invalidInput,
  type ApiError,
  type CursorPage,
  type FilterInput,
} from '@/modules/shared/index.js';

import {
  MO_COVERAGE_GAPS,
  type MoActLifecycle,
  type MoCoverage,
  type MoPublicationEvents,
  type MoActPublication,
  type MoIssue,
  type MoIssuerYearCount,
  type MoLifecycleEdge,
  type MoResolutionRates,
  type MoStatusEvent,
} from './types.js';

import type { MonitorulRepo, MoPublicationAggInput } from './ports.js';

/** A cached year-range provider — one bounded scan per TTL (foundation §10/§14.11). */
export interface MoCoverageDeps {
  /** Returns the {min,max} issue_year, memoized at a TTL by the caller. */
  yearRange(): Promise<Result<{ min: number | null; max: number | null }, ApiError>>;
}

/** Build a coverage block; `rates` only for publication/edge collections. */
const coverageOf = (
  range: { min: number | null; max: number | null },
  rates: MoResolutionRates | null
): MoCoverage => ({
  yearMin: range.min,
  yearMax: range.max,
  gaps: MO_COVERAGE_GAPS,
  resolutionRates: rates,
});

/** Publication resolution-rate tally over a result set (deterministic, in-hand). */
const tallyResolution = (pubs: readonly MoActPublication[]): MoResolutionRates => {
  let unique = 0;
  let ambiguous = 0;
  let unmatched = 0;
  for (const p of pubs) {
    if (p.resolution === 'unique') unique++;
    else if (p.resolution === 'ambiguous') ambiguous++;
    else unmatched++;
  }
  return { unique, ambiguous, unmatched };
};

// ─────────────────────────────────────────────────────────────────────────────
// Issue browsing
// ─────────────────────────────────────────────────────────────────────────────

export interface MoBrowseIssuesResult {
  readonly items: readonly MoIssue[];
  readonly total: number;
  readonly coverage: MoCoverage;
}

/** Browse gazette issues for a year (offset; the year bounds the scan, §5). */
export const browseIssues = async (
  repo: MonitorulRepo,
  cov: MoCoverageDeps,
  filter: FilterInput,
  page: { page: number; pageSize: number },
  sort: string
): Promise<Result<MoBrowseIssuesResult, ApiError>> => {
  // `year` is mandatory for the browse usecase (bounds the 42K-row scan). A missing
  // year is an InvalidInput on BOTH surfaces (Codex #7 — was a silent empty success).
  if (!hasFieldEq(filter, 'year')) {
    return err(invalidInput('mo issue browse requires a year filter', 'year'));
  }
  const res = await repo.listIssues(filter, page, sort);
  if (res.isErr()) return err(res.error);
  const range = await cov.yearRange();
  const cvg = coverageOf(range.isOk() ? range.value : { min: null, max: null }, null);
  return ok({ items: res.value.items, total: res.value.total, coverage: cvg });
};

/** A single issue (NotFound surfaced as null by the caller). */
export const getIssue = (
  repo: MonitorulRepo,
  moIssueId: string
): Promise<Result<MoIssue | null, ApiError>> => repo.getIssueById(moIssueId);

/** The issue's table-of-contents (publications in the issue, cursor-paged). */
export const getIssueContents = (
  repo: MonitorulRepo,
  moIssueId: string,
  page: { first: number; after?: string }
): Promise<Result<CursorPage<MoActPublication>, ApiError>> =>
  repo.getIssueContents(moIssueId, page);

// ─────────────────────────────────────────────────────────────────────────────
// Publication lookup
// ─────────────────────────────────────────────────────────────────────────────

export const lookupPublication = (
  repo: MonitorulRepo,
  moActKey: string
): Promise<Result<MoActPublication | null, ApiError>> => repo.getPublicationByKey(moActKey);

export const listPublications = (
  repo: MonitorulRepo,
  filter: FilterInput,
  page: { first: number; after?: string },
  sort: string
): Promise<Result<CursorPage<MoActPublication>, ApiError>> =>
  repo.listPublications(filter, page, sort);

/** MO-4: where/when an act was published in MO, + coverage. */
export const wherePublished = async (
  repo: MonitorulRepo,
  cov: MoCoverageDeps,
  actId: string
): Promise<Result<MoPublicationEvents, ApiError>> => {
  const res = await repo.getPublicationsForAct(actId);
  if (res.isErr()) return err(res.error);
  const range = await cov.yearRange();
  const cvg = coverageOf(
    range.isOk() ? range.value : { min: null, max: null },
    tallyResolution(res.value)
  );
  return ok({ publications: res.value, coverage: cvg });
};

/** MO-1: grouped publication counts for a year (+ denominator). */
export interface MoIssuerBreakdownResult {
  readonly items: readonly MoIssuerYearCount[];
  readonly denominator: number;
  readonly coverage: MoCoverage;
}

export const issuerYearBreakdown = async (
  repo: MonitorulRepo,
  cov: MoCoverageDeps,
  input: MoPublicationAggInput
): Promise<Result<MoIssuerBreakdownResult, ApiError>> => {
  const res = await repo.countPublicationsByIssuerYear(input);
  if (res.isErr()) return err(res.error);
  // The denominator is the TRUE total over the filters (not the capped-group sum).
  const range = await cov.yearRange();
  const cvg = coverageOf(range.isOk() ? range.value : { min: null, max: null }, null);
  return ok({ items: res.value.rows, denominator: res.value.total, coverage: cvg });
};

// ─────────────────────────────────────────────────────────────────────────────
// Lifecycle / status
// ─────────────────────────────────────────────────────────────────────────────

/** MO-3/LG-2 MO slice: in-edges + MO status events for an act, + coverage. */
export const actLifecycle = async (
  repo: MonitorulRepo,
  cov: MoCoverageDeps,
  actId: string
): Promise<Result<MoActLifecycle, ApiError>> => {
  const [statusRes, edgeRes] = await Promise.all([
    repo.getStatusEventsForAct(actId),
    repo.getEdgesForTargetAct(actId),
  ]);
  if (statusRes.isErr()) return err(statusRes.error);
  if (edgeRes.isErr()) return err(edgeRes.error);
  const range = await cov.yearRange();
  const cvg = coverageOf(range.isOk() ? range.value : { min: null, max: null }, null);
  return ok({ statusEvents: statusRes.value, inEdges: edgeRes.value, coverage: cvg });
};

export const listEdges = (
  repo: MonitorulRepo,
  filter: FilterInput,
  page: { first: number; after?: string }
): Promise<Result<CursorPage<MoLifecycleEdge>, ApiError>> => repo.listEdges(filter, page);

// ─────────────────────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────────────────────

const hasFieldEq = (filter: FilterInput, field: string): boolean => {
  const v = filter[field] as Record<string, unknown> | undefined;
  return v !== undefined && typeof v === 'object' && v['eq'] !== undefined;
};

export type { MoStatusEvent };
