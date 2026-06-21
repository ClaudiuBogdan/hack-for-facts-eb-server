/**
 * Shared Kernel — Global search usecase (foundation §4.5, §15.7; search plan §1).
 *
 * Hybrid over the entity-grade `entities` Meili index:
 *  - Meili is primary: `searchEntities(q, index, { filter, facets, limit, offset })`
 *    with a visibility-pinned, allowlisted ARRAY filter (`buildEntitiesFilter`).
 *  - A Meili failure OR a missing/corrupt index (the client surfaces both as
 *    `err`) DEGRADES to a bounded, visibility-scoped pg search over
 *    `search.documents` — never a hard fail.
 *  - The CUI-keyed org name match runs concurrently as the (deprecated)
 *    `organizations` array.
 *  - Empty/whitespace `q` short-circuits to an empty result (no engine query) so
 *    Meili's "return everything" default never leaks.
 *
 * Exactly one cheap, non-throwing structured log line is emitted per search.
 */

import { ok, type Result } from 'neverthrow';

import { type ApiError } from '../errors.js';
import { buildEntitiesFilter } from '../filters/meili-array.js';

import type { IdentityRepo, MeiliClient, SearchRepo } from '../ports.js';
import type { OrgNameMatch, SearchFacet, SearchHit } from '../types.js';

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
  readonly identityRepo: IdentityRepo;
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
  const { meiliClient, identityRepo, searchRepo, meiliIndexes, logger } = deps;
  const startedAt = Date.now();
  const limit = Math.min(input.limit ?? 20, 50);
  const offset = input.offset !== undefined && input.offset > 0 ? input.offset : undefined;

  const logSearch = (engine: 'meili' | 'postgres', hitCount: number, facetCount: number, meiliOk: boolean): void => {
    try {
      logger?.info(
        {
          component: 'kernel.globalSearch',
          q: input.q,
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

  // Org name match is cheap + always useful (Meili-primary internally, §15.7).
  const orgMatchPromise = identityRepo.searchByName(input.q, 10);

  const filterArgs = {
    ...(input.docTypes !== undefined && { docTypes: input.docTypes }),
    ...(input.county !== undefined && { county: input.county }),
    ...(input.year !== undefined && { year: input.year }),
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
    const orgs = await orgMatchPromise;
    logSearch('meili', hits.length, facets.length, true);
    return ok({
      query: input.q,
      hits,
      organizations: orgs.isOk() ? orgs.value : [],
      engine: 'meili',
      facets,
      estimatedTotalHits,
    });
  }

  // Meili down OR index missing/corrupt — bounded, visibility-scoped pg fallback
  // (degrade, do not error). No facets on this path.
  const [fallbackRes, orgs] = await Promise.all([
    searchRepo.searchEntities(input.q, {
      ...filterArgs,
      limit,
      ...(offset !== undefined && { offset }),
    }),
    orgMatchPromise,
  ]);

  const hits = fallbackRes.isOk() ? fallbackRes.value : [];
  logSearch('postgres', hits.length, 0, false);
  return ok({
    query: input.q,
    hits,
    organizations: orgs.isOk() ? orgs.value : [],
    engine: 'postgres',
    facets: [],
    estimatedTotalHits: hits.length,
  });
};
