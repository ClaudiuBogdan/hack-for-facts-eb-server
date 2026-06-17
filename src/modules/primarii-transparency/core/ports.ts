/**
 * Primarii-transparency module — repo port (plan §3). All methods return
 * `Result<T, ApiError>` (neverthrow, §5.1). The repo touches ONLY
 * `primarii_transparency.*`. Geography against `core.public_entities` +
 * `core.territories` is NOT a private join here — it is delegated to the kernel
 * `IdentityRepo.territoryForCui` resolver (so the identity/territory hubs stay
 * authoritative). Until/unless that resolver is available, the territory-dependent
 * repo paths are capability-gated (§7.1/§13.0).
 */

import type {
  PrimariiCategoryCoverage,
  PrimariiCategoryStatus,
  PrimariiDocument,
  PrimariiEntityProfile,
  PrimariiEntityStatus,
  PrimariiLoadIssue,
  PrimariiOrganigramaClaim,
  PrimariiRegistryLink,
  PrimariiSalaryClaim,
  PrimariiSnapshot,
  PrimariiStaffingClaim,
  PrimariiStatGroupBy,
  PrimariiStatusBucket,
} from './types.js';
import type {
  ApiError,
  CursorPage,
  CursorPageRequest,
  Cui,
  FilterInput,
  ResolveHit,
} from '@/modules/shared/index.js';
import type { Result } from 'neverthrow';

/**
 * A cursor page that also carries the filtered total (the registries are small —
 * ≤3,187 entities / 7,233 documents — so an exact COUNT is cheap; §14.4 guard
 * satisfied). The GraphQL connection projection exposes it as `totalCount`.
 */
export interface CountedCursorPage<T> extends CursorPage<T> {
  readonly totalCount: number;
}

export interface PrimariiRepository {
  // ── current registry (primary surface) ──────────────────────────────────────
  listEntities(
    f: FilterInput,
    page: CursorPageRequest
  ): Promise<Result<CountedCursorPage<PrimariiEntityStatus>, ApiError>>;

  getEntity(cui: Cui): Promise<Result<PrimariiEntityStatus | null, ApiError>>;

  /** Current status + 3 category statuses + staffing + organigrama + per-category doc counts. */
  getEntityProfile(cui: Cui): Promise<Result<PrimariiEntityProfile | null, ApiError>>;

  // ── category / claim detail (per-CUI) ────────────────────────────────────────
  /** Scoped to the CURRENT snapshot (avoids stale-snapshot category rows). */
  getCategoryStatuses(cui: Cui): Promise<Result<readonly PrimariiCategoryStatus[], ApiError>>;
  getStaffing(cui: Cui): Promise<Result<PrimariiStaffingClaim | null, ApiError>>;
  getOrganigrama(cui: Cui): Promise<Result<PrimariiOrganigramaClaim | null, ApiError>>;
  listSalaryClaims(
    cui: Cui,
    page: CursorPageRequest
  ): Promise<Result<CountedCursorPage<PrimariiSalaryClaim>, ApiError>>;

  // ── document inventory (cross-entity list MUST be bounded by cui or category) ──
  listDocuments(
    f: FilterInput,
    page: CursorPageRequest
  ): Promise<Result<CountedCursorPage<PrimariiDocument>, ApiError>>;

  // ── history ───────────────────────────────────────────────────────────────
  listSnapshots(
    cui: Cui,
    page: CursorPageRequest
  ): Promise<Result<CountedCursorPage<PrimariiSnapshot>, ApiError>>;

  // ── aggregates (analytics) ──────────────────────────────────────────────────
  /** `region` grouping requires the kernel cui→territory resolver (§13 gap) — gated. */
  aggregateStatus(
    groupBy: PrimariiStatGroupBy,
    f: FilterInput
  ): Promise<Result<readonly PrimariiStatusBucket[], ApiError>>;

  aggregateCategoryCoverage(
    f: FilterInput
  ): Promise<Result<readonly PrimariiCategoryCoverage[], ApiError>>;

  // ── ops / QA (bounded capped list — small table, no cursor) ───────────────────
  listLoadIssues(
    f: { cui?: string; severity?: string; issueCode?: string },
    limit: number
  ): Promise<Result<readonly PrimariiLoadIssue[], ApiError>>;

  // ── discovery (name → value) ─────────────────────────────────────────────────
  /**
   * entity name → CUI (pg ILIKE; Meili-backed when available), county-name, status
   * label. NOTE: the `siruta` resolve dim is NOT handled here — it delegates to the
   * kernel territory resolver at the usecase layer (this repo never joins core.*).
   */
  resolve(
    dim: 'entity' | 'county' | 'status',
    q: string,
    limit: number
  ): Promise<Result<readonly ResolveHit[], ApiError>>;

  // ── deferred (DDL-only today; INTERNAL forward-compat hook, NOT a v1 GraphQL/MCP
  //    surface — returns [] until the loader populates entity_registry_links, then
  //    the contributor/profile can adopt it without an API break) ────────────────
  getRegistryLinks(cui: Cui): Promise<Result<readonly PrimariiRegistryLink[], ApiError>>;

  // ── contributor support (§4) ──────────────────────────────────────────────────
  presenceFor(
    cui: Cui
  ): Promise<Result<{ present: boolean; status?: string; dataQuality?: string } | null, ApiError>>;
}

export type { CursorPageRequest } from '@/modules/shared/index.js';
