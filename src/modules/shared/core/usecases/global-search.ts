/**
 * Shared Kernel — Global search usecase (foundation §4.5, §15.7; search plan §1).
 *
 * Hybrid over the entity-grade `entities` Meili index:
 *  - Meili is primary: `searchEntities(q, index, { filter, facets, limit, offset })`
 *    with a visibility-pinned, allowlisted ARRAY filter (`buildEntitiesFilter`).
 *  - A Meili failure OR a missing/corrupt index (the client surfaces both as
 *    `err`) DEGRADES honestly, and says so via `degraded: true` — never a hard
 *    fail, and never a pretence of full-text search (D5).
 *
 *  - The deprecated `organizations` array stays empty. Its former Postgres
 *    name lookup was an unindexed scan over millions of rows; entity discovery
 *    belongs to the indexed `hits` path.
 *  - Empty/whitespace `q` short-circuits to an empty result (no engine query) so
 *    Meili's "return everything" default never leaks.
 *
 * THE DEGRADE PATH, AND WHY IT SHRANK (SEARCH_LAYER_REVIEW_2026-08-25.md D5).
 * The fallback used to be `title/body/doc_id ILIKE '%q%'` over the 13.8M-row
 * `search.documents` projection with no trigram index. That is not a degrade —
 * it is a sequential scan that exhausts the statement timeout and turns a search
 * outage into a database incident, while LOOKING like a working fallback because
 * the code path exists.
 *
 * What replaces it returns NO hits and sets `degraded: true`, so the caller can
 * say "search is unavailable" instead of rendering an empty result as "no
 * matches" — completely different answers that the old shape could not tell
 * apart. The long comment at the degrade branch records why an exact-CUI lookup
 * was tried there twice and removed twice; a pg_trgm partial index is the
 * alternative if product wants text search during outages, and must be MEASURED
 * first (index size over 4.3M titles, write amplification on every lane) rather
 * than assumed. This also ends this path's dependency on `search.documents`.
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

import type { MeiliClient } from '../ports.js';

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
  /** Identities playing this role (a CUI can be organization + pnrr_entity). */
  readonly roles?: readonly string[];
  /** Only currently-active entities. */
  readonly isActive?: boolean;
  readonly limit?: number;
  readonly offset?: number;
}

export interface GlobalSearchResult {
  readonly query: string;
  readonly hits: readonly SearchHit[];
  readonly organizations: readonly OrgNameMatch[];
  readonly engine: 'meili' | 'postgres';
  /**
   * TRUE when the search engine could not answer and this result came from the
   * reduced outage path. Empty `hits` then means "we could not look", NOT "no
   * matches" — the caller must say so rather than render an empty state, and
   * must not cache the answer as truth.
   */
  readonly degraded: boolean;
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
  const { meiliClient, meiliIndexes, logger } = deps;
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
      degraded: false,
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
      degraded: false,
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
  const roles = validEntityDocTypes(input.roles);

  const filterArgs = {
    ...(docTypes.length > 0 && { docTypes }),
    ...(county !== undefined && { county }),
    ...(roles.length > 0 && { roles }),
    ...(input.isActive !== undefined && { isActive: input.isActive }),
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
      degraded: false,
      facets,
      estimatedTotalHits,
    });
  }

  // ── Meili down OR index missing/corrupt: the honest degrade ───────────────
  //
  // NO HITS. Not "no matches" — `degraded: true` says we could not look, and the
  // caller is expected to say so.
  //
  // AN EXACT-CUI LOOKUP WAS TRIED TWICE HERE AND REMOVED BOTH TIMES. D5 asked
  // for it ("the lookup that must survive an outage"), and the spine can indeed
  // resolve a CUI cheaply. The problem is not the lookup, it is the ANSWER: this
  // surface must return what the INDEX would have returned, and the index
  // collapses each identity to one `doc_type` by role priority
  // (public_entity → public_enterprise → ngo → company → pnrr_entity) across
  // several role tables, deriving title, activity and county with it.
  //
  //  - Attempt 1 emitted the spine's `kind`, which disagrees with the collapsed
  //    type for every dual-role identity — wrong badge, wrong deep-link.
  //  - Attempt 2 emitted `organization` as a supposedly generic identity type.
  //    It is not: the palette assigns it ONLY to `core.public_entities`
  //    identities, the client renders it as "Instituție", and `/entities/$cui`
  //    is the legacy budget/institution page. That labels a private company an
  //    institution and links it to the wrong place — and a company-only CUI
  //    filtered to `docTypes: ['organization']` would be returned here while
  //    healthy Meili excludes it.
  //
  // Reproducing the collapse rule in the server would make it correct today and
  // silently wrong the day the palette's priority changes, with nothing in this
  // repo able to notice. So the capability is deferred rather than faked: it
  // needs a palette-OWNED exact-CUI projection (or the index itself), not a
  // second implementation of the rule. Serving nothing is a smaller loss than
  // serving a confident wrong label.
  logSearch('postgres', 0, 0, false);
  return ok({
    query: input.q,
    hits: [],
    organizations: [],
    engine: 'postgres',
    degraded: true,
    facets: [],
    estimatedTotalHits: 0,
  });
};
