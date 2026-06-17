/**
 * Monitorul-Oficial (`mo/` area, plan 06) — the `MonitorulRepo` port (§3). **06
 * OWNS this.** It touches ONLY `legal.mo_*` + `legal.act_status_events` (read,
 * scoped to `event_source='monitorul-oficial'`) + `legal.acts` (read, via the
 * 05-owned `LegalRepoBase` injected at construction). No writes (foundation F5).
 *
 * Every method returns `Result<T, ApiError>` (neverthrow). Batch methods returning
 * `Map<actId, …>` back the `LegalAct.gazette*` DataLoaders (avoid N+1).
 */

import type {
  MoActPublication,
  MoIssue,
  MoIssuerSummary,
  MoIssuerYearCount,
  MoLifecycleEdge,
  MoPartCount,
  MoPartCode,
  MoResolveHit,
  MoStatusEvent,
} from './types.js';
import type { ApiError, CursorPage, FilterInput } from '@/modules/shared/index.js';
import type { Result } from 'neverthrow';

/** A `first`/`after` cursor page request (the kernel envelope binds the fhash). */
export interface MoCursorPageRequest {
  readonly first: number;
  readonly after?: string;
}

/** A bounded offset page request (small year-bounded issue lists). */
export interface MoOffsetPageRequest {
  readonly page: number;
  readonly pageSize: number;
}

/** A bounded offset page result. */
export interface MoOffsetPage<T> {
  readonly items: readonly T[];
  readonly total: number;
}

/** The aggregate grouping dimension (MO-1). */
export type MoAggGroupBy = 'issuer' | 'act_type' | 'year';

/** The aggregate input (MO-1). `year` is required (bounds the scan). */
export interface MoPublicationAggInput {
  readonly year: number;
  readonly issuerSlug?: string;
  readonly actType?: readonly string[];
  readonly groupBy: MoAggGroupBy;
}

export interface MonitorulRepo {
  // ── issue browsing ──────────────────────────────────────────────────────────
  getIssueById(moIssueId: string): Promise<Result<MoIssue | null, ApiError>>;
  /**
   * Resolve a portal mo_part/mo_number/mo_date triple to an issue (consumer side
   * of the act↔gazette correlation). `partCode` is passed by the caller (portal
   * `mo_part`(int) → `part_code`(text)); PIM has no int form and is unresolvable.
   * Match: `mo_issues_identity_uq (part_code, lower(issue_label), issue_year)`.
   */
  findIssueByCoordinates(
    partCode: MoPartCode,
    moNumberText: string,
    issueYear: number
  ): Promise<Result<MoIssue | null, ApiError>>;
  /** Year-bounded issue list (offset; the table is 42K rows, the scan is cheap). */
  listIssues(
    filter: FilterInput,
    page: MoOffsetPageRequest,
    sort: string
  ): Promise<Result<MoOffsetPage<MoIssue>, ApiError>>;
  /** Table-of-contents: the publications in one issue (index `_issue_idx`). */
  getIssueContents(
    moIssueId: string,
    page: MoCursorPageRequest
  ): Promise<Result<CursorPage<MoActPublication>, ApiError>>;

  // ── act-publication lookup ────────────────────────────────────────────────────
  getPublicationByKey(moActKey: string): Promise<Result<MoActPublication | null, ApiError>>;
  /** Cursor list on `(act_year desc, mo_act_key)`; ≥1 bounding predicate enforced. */
  listPublications(
    filter: FilterInput,
    page: MoCursorPageRequest,
    sort: string
  ): Promise<Result<CursorPage<MoActPublication>, ApiError>>;
  /** MO-4: every place an act was published (partial index `_act_idx`). */
  getPublicationsForAct(actId: string): Promise<Result<readonly MoActPublication[], ApiError>>;
  /** Batch of MO-4 for the `LegalAct.gazettePublications` DataLoader. */
  getPublicationsForActs(
    actIds: readonly string[]
  ): Promise<Result<ReadonlyMap<string, readonly MoActPublication[]>, ApiError>>;
  /** MO-1 aggregate: grouped publication counts, bounded by year. */
  /**
   * MO-1: grouped publication counts (top-100 by count) AND the TRUE total over
   * the same filters (the denominator — NOT the sum of the capped groups, Codex #1).
   */
  countPublicationsByIssuerYear(
    input: MoPublicationAggInput
  ): Promise<Result<{ rows: readonly MoIssuerYearCount[]; total: number }, ApiError>>;

  // ── lifecycle / status timelines ──────────────────────────────────────────────
  /** Out-edges of a publication (`_natural_uq` prefix). */
  getEdgesForSource(moActKey: string): Promise<Result<readonly MoLifecycleEdge[], ApiError>>;
  /** LG-2/MO-3 in-edges targeting an act (partial index `_target_act_idx`). */
  getEdgesForTargetAct(actId: string): Promise<Result<readonly MoLifecycleEdge[], ApiError>>;
  /** Batch of in-edges for the `LegalAct.gazetteInEdges` DataLoader. */
  getEdgesForTargetActs(
    actIds: readonly string[]
  ): Promise<Result<ReadonlyMap<string, readonly MoLifecycleEdge[]>, ApiError>>;
  /** Cursor list on `(edge_id)`; bounded by relation and/or target_act_id. */
  listEdges(
    filter: FilterInput,
    page: MoCursorPageRequest
  ): Promise<Result<CursorPage<MoLifecycleEdge>, ApiError>>;
  /** MO status events for an act (act_status_events, event_source='monitorul-oficial'). */
  getStatusEventsForAct(actId: string): Promise<Result<readonly MoStatusEvent[], ApiError>>;
  /** Batch of MO status events for the `LegalAct.gazetteStatusEvents` DataLoader. */
  getStatusEventsForActs(
    actIds: readonly string[]
  ): Promise<Result<ReadonlyMap<string, readonly MoStatusEvent[]>, ApiError>>;

  // ── coverage / discovery / contributor support ────────────────────────────────
  /** The min/max issue_year (cached; one bounded scan per TTL) — coverage block. */
  getIssueYearRange(): Promise<Result<{ min: number | null; max: number | null }, ApiError>>;
  /** Issuer-keyed summary for the contributor / Entity.monitorul (best-effort). */
  getIssuerSummary(issuerSlug: string): Promise<Result<MoIssuerSummary | null, ApiError>>;
  /** Per-part-code publication counts for an issuer (entity-summary breakdown). */
  countPublicationsByPartForIssuer(
    issuerSlug: string
  ): Promise<Result<readonly MoPartCount[], ApiError>>;
  /** Discovery: resolve a Romanian issuer name → issuer_slug + count (§7.4). */
  resolveIssuer(q: string, limit: number): Promise<Result<readonly MoResolveHit[], ApiError>>;
  /** Discovery: resolve an act-type label → normalized act_type value + count. */
  resolveActType(q: string, limit: number): Promise<Result<readonly MoResolveHit[], ApiError>>;
}
