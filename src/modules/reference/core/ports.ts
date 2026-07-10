/**
 * Reference module — repository ports (plan §3).
 *
 * Two MODULE-OWNED data repos (`PublicEntityRepo`, `ClassificationRepo`) — the only
 * readers of `core.public_entities` / `core.classification_codes` — plus a thin
 * `TerritoryQueryRepo` that adds ONLY the queries the kernel `TerritoryRepo` lacks
 * (filtered cursor browse, surrogate-id lookup, and the rich county/region
 * rollups). The kernel `IdentityRepo`/`TerritoryRepo` are injected and reused for
 * everything they already provide (§0 non-duplication rule). All methods return
 * `Result<T, ApiError>` (neverthrow).
 *
 * Pagination: GraphQL + MCP only (no REST), so lists use the kernel cursor envelope
 * (`CursorPage<T>`) projected to Relay connections — one cursor contract, keyset on
 * a UNIQUE compound sort tuple (the repo appends the PK as a tiebreak: `(sort, cui)`
 * for public_entities, `(sort, id)` for territories; classification's `(system,
 * code)` is already unique). The 15k/3.2k registries are small, so a driving
 * predicate is NOT forced (unfiltered browse is an index-ordered scan); virtual
 * filters still validate. List methods also return the filtered `totalCount`
 * (cheap COUNT over the small registry) so MCP/UI facets have a denominator.
 */

import type {
  ReferenceAggregateDim,
  ReferenceClassificationCode,
  ReferenceCountBucket,
  ReferenceCounty,
  ReferencePublicEntity,
  ReferencePublicEntityCard,
  ReferenceRegion,
  ReferenceResolveHit,
  Territory,
} from './types.js';
import type { ApiError, CursorPage, FilterInput } from '@/modules/shared/index.js';
import type { Result } from 'neverthrow';

/**
 * A first/after cursor page request (the kernel cursor envelope binds the fhash).
 * `sort` selects one of the collection's allowed sort fields (the repo validates +
 * defaults it, and always appends a unique tiebreak). Defined locally to mirror
 * pnrr; a kernel-ergonomics ask to the GM is to lift this one shape into
 * `shared/core/pagination.ts` so modules stop duplicating it (NIT).
 */
export interface CursorPageRequest {
  readonly first: number;
  readonly after?: string;
  readonly sort?: string;
}

/** A cursor page that also carries the filtered total (small registries — cheap COUNT). */
export interface CountedCursorPage<T> extends CursorPage<T> {
  readonly totalCount: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// PublicEntityRepo — the ONLY reader of core.public_entities
// ─────────────────────────────────────────────────────────────────────────────

export interface PublicEntityRepo {
  /** detail — PK lookup; territory is resolved through the kernel repo in the usecase. */
  findByCui(
    cui: string,
    includeTrace: boolean
  ): Promise<Result<ReferencePublicEntity | null, ApiError>>;

  /** list+filter — cursor on the active compound sort (name asc default), with the filtered total. */
  list(
    f: FilterInput,
    page: CursorPageRequest
  ): Promise<Result<CountedCursorPage<ReferencePublicEntityCard>, ApiError>>;

  /** name autocomplete — GIN pg_trgm with similarity ordering, bounded. */
  searchByName(
    q: string,
    limit: number
  ): Promise<Result<readonly ReferencePublicEntityCard[], ApiError>>;

  /** children of a creditor (parent1_cui/parent2_cui) — the org tree (bounded). */
  findChildren(parentCui: string): Promise<Result<readonly ReferencePublicEntityCard[], ApiError>>;

  /** registry stats — counts by entity_type / category / is_uat / county. */
  aggregate(
    by: ReferenceAggregateDim,
    f: FilterInput
  ): Promise<Result<readonly ReferenceCountBucket[], ApiError>>;

  /** resolve institution name → {kind:'public_entity', value:cui, label:name, hint:county}. */
  resolve(q: string, limit: number): Promise<Result<readonly ReferenceResolveHit[], ApiError>>;

  /**
   * INTERNAL batching primitive (NOT a resolver path): cui[] → registry card map
   * for the cross-source contributor / `Entity.reference` DataLoader. One
   * `WHERE cui = ANY($1)`; returns CARDS (no field_trace). The `Entity.reference`
   * resolver still goes through `contributor.profileSlice` (§14.7) — this only
   * batches the underlying read.
   */
  cardsForCuis(
    cuis: readonly string[]
  ): Promise<Result<ReadonlyMap<string, ReferencePublicEntityCard>, ApiError>>;
}

// ─────────────────────────────────────────────────────────────────────────────
// ClassificationRepo — the ONLY reader of core.classification_codes
// ─────────────────────────────────────────────────────────────────────────────

export interface ClassificationRepo {
  /** detail — PK (system, code). */
  findOne(
    system: string,
    code: string
  ): Promise<Result<ReferenceClassificationCode | null, ApiError>>;

  /** list+filter — cursor on (code, system) unique tuple. */
  list(
    f: FilterInput,
    page: CursorPageRequest
  ): Promise<Result<CursorPage<ReferenceClassificationCode>, ApiError>>;

  /** resolve label|code fragment → {kind:'classification', value:code, label, hint:system}. */
  resolve(
    system: string | null,
    q: string,
    limit: number
  ): Promise<Result<readonly ReferenceResolveHit[], ApiError>>;

  /** the CAEN systems with their code counts (R11). */
  listSystems(): Promise<
    Result<readonly { readonly system: string; readonly count: number }[], ApiError>
  >;
}

// ─────────────────────────────────────────────────────────────────────────────
// TerritoryQueryRepo — module-owned cursor/aggregate reader over core.territories
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The kernel `TerritoryRepo` covers point lookups (byTerritorialSiruta, byCounty,
 * searchUat, listCounties→CountyRef, listRegions→string[]) but NOT a filtered+
 * cursor-paginated browse, a surrogate-id lookup, or the RICH county/region
 * rollups the reference plan needs (uatCount/population per county; counts per
 * region — §2.2). This module-owned repo adds ONLY those over the same
 * `core.territories` table; the kernel repo is reused for everything it already
 * provides (§0 non-duplication rule). The rollup methods are named `*Rollups` to
 * avoid confusion with the kernel's thinner `listCounties`/`listRegions`.
 */
export interface TerritoryQueryRepo {
  /** Surrogate-id lookup (the legacy uat_id contract) — the kernel repo has no byId. */
  byId(id: number): Promise<Result<Territory | null, ApiError>>;
  list(
    f: FilterInput,
    page: CursorPageRequest
  ): Promise<Result<CountedCursorPage<Territory>, ApiError>>;
  listCountyRollups(): Promise<Result<readonly ReferenceCounty[], ApiError>>;
  listRegionRollups(): Promise<Result<readonly ReferenceRegion[], ApiError>>;
}
