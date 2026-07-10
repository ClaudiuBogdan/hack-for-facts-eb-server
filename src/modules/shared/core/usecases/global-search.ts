/**
 * Shared Kernel — Global search usecase (foundation §4.5, §15.7; search plan §1).
 *
 * Hybrid over the entity-grade `entities` Meili index:
 *  - Meili is primary: `searchEntities(q, index, { filter, facets, limit, offset })`
 *    with a visibility-pinned, allowlisted ARRAY filter (`buildEntitiesFilter`).
 *  - A Meili failure OR a missing/corrupt index (the client surfaces both as
 *    `err`) DEGRADES to a bounded, visibility-scoped pg search over
 *    `search.documents` — never a hard fail.
 *  - The deprecated `organizations` array stays empty. Its former Postgres
 *    name lookup was an unindexed scan over millions of rows; entity discovery
 *    belongs to the indexed `hits` path.
 *  - Empty/whitespace `q` short-circuits to an empty result (no engine query) so
 *    Meili's "return everything" default never leaks.
 *
 * Exactly one cheap, non-throwing structured log line is emitted per search.
 */

import { err, ok, type Result } from 'neverthrow';

import { invalidInput, type ApiError } from '../errors.js';
import {
  buildEntitiesFilter,
  normalizeCounty,
  validEntityDocTypes,
} from '../filters/meili-array.js';
import {
  SEARCH_ENTITY_DOC_TYPES,
  type OrgNameMatch,
  type SearchFacet,
  type SearchHit,
} from '../types.js';

import type { MeiliClient, SearchRepo } from '../ports.js';

/**
 * The minimal structured-logger contract the usecase accepts (a pino `Logger`,
 * Fastify's `app.log`, and the kernel `Logger` all satisfy it). Declared locally
 * so the pure core does not import the kernel shell/root (no circular dep).
 */
export interface GlobalSearchLogger {
  info(obj: unknown, msg?: string): void;
}

export interface GlobalSearchDeps {
  readonly meiliClient: MeiliClient;
  readonly searchRepo: SearchRepo;
  /** Meili indexes to query (resolved from per-domain config at wiring time). */
  readonly meiliIndexes: readonly string[];
  /** Optional structured logger — one line per search; never throws. */
  readonly logger?: GlobalSearchLogger;
}

export interface GlobalSearchInput {
  readonly q: string;
  readonly docTypes?: readonly string[];
  /** Canonical county name (Meili equality is case-sensitive — see the filter builder). */
  readonly county?: string;
  readonly year?: number;
  readonly limit?: number;
  readonly offset?: number;
}

export interface GlobalSearchResult {
  readonly query: string;
  readonly hits: readonly SearchHit[];
  readonly organizations: readonly OrgNameMatch[];
  readonly engine: 'meili' | 'postgres';
  /** Facet distribution (e.g. `doc_type` → counts) backing the type-filter chips. */
  readonly facets: readonly SearchFacet[];
  /** Meili's approximate total (capped by `maxTotalHits`, default 1000); 0 on the pg path. */
  readonly estimatedTotalHits: number;
}

const LIMIT_DEFAULT = 20;
const LIMIT_MAX = 50;
/** Meili stops scanning at `maxTotalHits` (default 1000); deeper offsets are pointless. */
const OFFSET_MAX = 1000;

/** Flatten Meili's `{ field: { value: count } }` distribution to typed buckets. */
const toFacets = (
  distribution: Readonly<Record<string, Record<string, number>>>
): readonly SearchFacet[] =>
  Object.entries(distribution).flatMap(([field, buckets]) =>
    Object.entries(buckets).map(([value, count]): SearchFacet => ({ field, value, count }))
  );

export const makeGlobalSearch = async (
  deps: GlobalSearchDeps,
  input: GlobalSearchInput
): Promise<Result<GlobalSearchResult, ApiError>> => {
  const { meiliClient, searchRepo, meiliIndexes, logger } = deps;
  const startedAt = Date.now();
  // Bound the page window: clamp limit to [1,50] and offset to [0,1000] so a
  // hostile/garbage paginator can never push Meili past its scan cap or send a
  // negative limit (which Meili rejects and pg silently clamps to 1).
  const limit = Math.min(Math.max(input.limit ?? LIMIT_DEFAULT, 1), LIMIT_MAX);
  const offsetClamped = Math.min(Math.max(input.offset ?? 0, 0), OFFSET_MAX);
  const offset = offsetClamped > 0 ? offsetClamped : undefined;

  const logSearch = (
    engine: 'meili' | 'postgres',
    hitCount: number,
    facetCount: number,
    meiliOk: boolean
  ): void => {
    try {
      logger?.info(
        {
          component: 'kernel.globalSearch',
          queryLength: input.q.length,
          engine,
          hitCount,
          facetCount,
          latencyMs: Date.now() - startedAt,
          meiliOk,
        },
        'global search'
      );
    } catch {
      // Logging must never break the request path.
    }
  };

  // Empty/whitespace q → never query either engine (don't leak Meili's
  // "return everything" default). Report as the meili engine (nothing degraded).
  if (input.q.trim() === '') {
    logSearch('meili', 0, 0, true);
    return ok({
      query: input.q,
      hits: [],
      organizations: [],
      engine: 'meili',
      facets: [],
      estimatedTotalHits: 0,
    });
  }

  // Validate filter inputs ONCE and feed the SAME set to both engines, so the
  // Meili and pg paths can never diverge. A requested-but-all-invalid docTypes
  // set matches nothing on either engine → short-circuit to empty (mirrors the
  // empty-q guard; no engine or org query).
  const requested = validEntityDocTypes(input.docTypes);
  if (input.docTypes !== undefined && requested.length === 0) {
    logSearch('meili', 0, 0, true);
    return ok({
      query: input.q,
      hits: [],
      organizations: [],
      engine: 'meili',
      facets: [],
      estimatedTotalHits: 0,
    });
  }
  // No docTypes requested → pin the FULL entity-grade allowlist (not just the
  // visibility clause) so Meili matches the pg fallback exactly AND a mispointed
  // or polluted index can never surface public non-entity docs.
  const docTypes = input.docTypes === undefined ? [...SEARCH_ENTITY_DOC_TYPES] : requested;
  const county = normalizeCounty(input.county);
  if (input.county !== undefined && county === undefined) {
    logSearch('meili', 0, 0, true);
    return err(invalidInput('county must be a canonical county name', 'county'));
  }
  const year = input.year !== undefined && Number.isInteger(input.year) ? input.year : undefined;

  const filterArgs = {
    ...(docTypes.length > 0 && { docTypes }),
    ...(county !== undefined && { county }),
    ...(year !== undefined && { year }),
  };

  const index = meiliIndexes[0] ?? 'entities';
  // No Meili index configured → go straight to the bounded pg fallback.
  const meiliRes =
    meiliIndexes.length > 0
      ? await meiliClient.searchEntities(input.q, index, {
          filter: buildEntitiesFilter(filterArgs),
          facets: ['doc_type'],
          limit,
          ...(offset !== undefined && { offset }),
        })
      : undefined;

  if (meiliRes?.isOk() === true) {
    const { hits, facetDistribution, estimatedTotalHits } = meiliRes.value;
    const facets = toFacets(facetDistribution);
    logSearch('meili', hits.length, facets.length, true);
    return ok({
      query: input.q,
      hits,
      organizations: [],
      engine: 'meili',
      facets,
      estimatedTotalHits,
    });
  }

  // Meili down OR index missing/corrupt — bounded, visibility-scoped pg fallback
  // (degrade, do not error). No facets on this path.
  const fallbackRes = await searchRepo.searchEntities(input.q, {
    ...filterArgs,
    limit,
    ...(offset !== undefined && { offset }),
  });

  // A pg fallback ERROR is a real failure (DB/schema), not a degrade — surface it
  // rather than masking a regression as a valid empty result. (Meili being down
  // is the expected degrade and already handled above.)
  if (fallbackRes.isErr()) {
    logSearch('postgres', 0, 0, false);
    return err(fallbackRes.error);
  }

  const hits = fallbackRes.value;
  logSearch('postgres', hits.length, 0, false);
  return ok({
    query: input.q,
    hits,
    organizations: [],
    engine: 'postgres',
    facets: [],
    estimatedTotalHits: hits.length,
  });
};
