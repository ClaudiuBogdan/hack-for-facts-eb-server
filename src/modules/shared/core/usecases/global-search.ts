/**
 * Shared Kernel — Global search usecase (foundation §4.5, §15.7).
 *
 * Hybrid: Meili (instant entity-name autocomplete) is primary; on Meili failure
 * we fall back to a bounded pg ILIKE over search.documents + an org name match.
 * Org name search folds diacritics in TS (no unaccent, no trigram-index
 * assumption — §15.7). Degrades, never hard-fails on aux down.
 */

import { ok, type Result } from 'neverthrow';

import { type ApiError } from '../errors.js';

import type { IdentityRepo, MeiliClient, SearchRepo } from '../ports.js';
import type { OrgNameMatch, SearchFacet, SearchHit } from '../types.js';

export interface GlobalSearchDeps {
  readonly meiliClient: MeiliClient;
  readonly identityRepo: IdentityRepo;
  readonly searchRepo: SearchRepo;
  /** Meili indexes to query (resolved from per-domain config at wiring time). */
  readonly meiliIndexes: readonly string[];
}

export interface GlobalSearchInput {
  readonly q: string;
  readonly docTypes?: readonly string[];
  readonly limit?: number;
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

export const makeGlobalSearch = async (
  deps: GlobalSearchDeps,
  input: GlobalSearchInput
): Promise<Result<GlobalSearchResult, ApiError>> => {
  const { meiliClient, identityRepo, searchRepo, meiliIndexes } = deps;
  const limit = Math.min(input.limit ?? 20, 50);

  // Org name match is cheap + always useful (Meili-primary internally, §15.7).
  const orgMatchPromise = identityRepo.searchByName(input.q, 10);

  // No Meili indexes configured → go straight to the bounded pg fallback.
  const meiliRes =
    meiliIndexes.length > 0
      ? await meiliClient.multiSearch(input.q, meiliIndexes, limit)
      : undefined;

  if (meiliRes?.isOk() === true) {
    const hits = meiliRes.value.flatMap((r) => r.hits).slice(0, limit);
    const orgs = await orgMatchPromise;
    return ok({
      query: input.q,
      hits,
      organizations: orgs.isOk() ? orgs.value : [],
      engine: 'meili',
      // Facets + estimatedTotalHits are populated by the dedicated entities path
      // (T3); the legacy multiSearch path does not request facets.
      facets: [],
      estimatedTotalHits: hits.length,
    });
  }

  // Meili down — bounded pg fallback (degrade, do not error).
  const [fallbackRes, orgs] = await Promise.all([
    searchRepo.fallbackTextSearch(input.q, input.docTypes ?? [], limit),
    orgMatchPromise,
  ]);

  const hits = fallbackRes.isOk() ? fallbackRes.value : [];
  return ok({
    query: input.q,
    hits,
    organizations: orgs.isOk() ? orgs.value : [],
    engine: 'postgres',
    facets: [],
    estimatedTotalHits: hits.length,
  });
};
