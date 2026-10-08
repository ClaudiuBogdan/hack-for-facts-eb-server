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
 *    Meili's "return everything" default never leaks. It is a syntactic
 *    no-search, never a proven zero (`companyContribution: unavailable`).
 *
 * Search labels and company values come from a witnessed Meili generation.
 * The companies module refreshes a read-only access snapshot in the background
 * once per minute; it expires within the user-approved three-minute bound.
 * Search and final serialization read memory only, never hydrate or query PG.
 * Missing/expired access or an unwitnessed generation withholds CUI identities;
 * a source-scope change withholds company-owned values until a new generation.
 * Candidate caching, source-role separation, and honest outage behavior remain.
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

import { invalidInput, serviceUnavailable, type ApiError } from '../errors.js';
import {
  buildEntitiesFilter,
  normalizeCounty,
  validEntityDocTypes,
  validEntityRoles,
  validEntityTags,
} from '../filters/meili-array.js';
import { searchQueryProblem, type SearchPolicy } from '../filters/search-policy.js';
import { projectedCompanyValues } from '../projected-company-values.js';
import {
  PALETTE_GENERATION_CONTROL_ID,
  readGenerationControl,
  witnessGeneration,
  type GenerationControlReading,
  type GenerationWitness,
  type GenerationWitnessFailure,
} from '../search-generation.js';
import {
  MAX_SERVED_CUI_DIGITS,
  SEARCH_ENTITY_DOC_TYPES,
  SEARCH_ENTITY_ROLES,
  type OrgNameMatch,
  type SearchCompanyContribution,
  type SearchContinuation,
  type SearchFacet,
  type SearchGenerationRef,
  type SearchHit,
  type SearchHitCompany,
} from '../types.js';

import type {
  EntitiesSearchResult,
  MeiliClient,
  SearchCandidateCache,
  SearchCompanyContributionPort,
  SearchCuiParent,
} from '../ports.js';

/**
 * The minimal structured-logger contract the usecase accepts (a pino `Logger`,
 * Fastify's `app.log`, and the kernel `Logger` all satisfy it). Declared locally
 * so the pure core does not import the kernel shell/root (no circular dep).
 */
export interface GlobalSearchLogger {
  info(obj: unknown, msg?: string): void;
}

export interface GlobalSearchDeps {
  readonly searchPolicy?: SearchPolicy;
  readonly meiliClient: MeiliClient;
  /** Meili indexes to query (resolved from per-domain config at wiring time). */
  readonly meiliIndexes: readonly string[];
  /** Optional structured logger — one line per search; never throws. */
  readonly logger?: GlobalSearchLogger;
  /**
   * The company contribution (companies module, at composition). Absent: no
   * fresh check can be taken, so CUI identities are withheld and the company
   * contribution is unavailable.
   */
  readonly companySearch?: SearchCompanyContributionPort;
  /** Candidate-answer cache (GraphQL); absent → every request fetches candidates. */
  readonly candidateCache?: SearchCandidateCache;
}

export interface GlobalSearchInput {
  readonly q: string;
  readonly docTypes?: readonly string[];
  /** Canonical county name (Meili equality is case-sensitive — see the filter builder). */
  readonly county?: string;
  /** Identities playing this role (a CUI can be organization + pnrr_entity). */
  readonly roles?: readonly string[];
  /** Generic identity activity (not the directory's same-identifier ONRC criterion). */
  readonly isActive?: boolean;
  readonly isUat?: boolean;
  readonly entityTags?: readonly string[];
  readonly excludeEntityTags?: readonly string[];
  readonly limit?: number;
  readonly offset?: number;
}

/**
 * Why the company contribution is not `current` (codes only):
 *  - `no_search`: no engine query ran (empty input, no valid type);
 *  - `engine_unavailable`: the engine could not answer (`degraded`);
 *  - `control_*`: the generation was not witnessed (see `search-generation`);
 *  - `company_check_unavailable`: the fresh database check could not be
 *    taken, so every CUI identity was withheld;
 *  - `registry_not_published`: the request's company scope is not a
 *    published ONRC edition;
 *  - `generation_scope_stale` (`partial`): the witnessed generation was built
 *    for another published scope.
 */
export type SearchCompanyContributionReason =
  | 'no_search'
  | 'engine_unavailable'
  | GenerationWitnessFailure
  | 'company_check_unavailable'
  | 'registry_not_published'
  | 'generation_scope_stale';

export interface GlobalSearchResult {
  readonly query: string;
  readonly hits: readonly SearchHit[];
  readonly organizations: readonly OrgNameMatch[];
  /** `none`: no engine executed (the outage path serves nothing, see below). */
  readonly engine: 'meili' | 'postgres' | 'none';
  /**
   * TRUE when the search engine could not answer and this result came from the
   * reduced outage path. Empty `hits` then means "we could not look", NOT "no
   * matches" — the caller must say so rather than render an empty state, and
   * must not cache the answer as truth.
   */
  readonly degraded: boolean;
  /** Facet distribution of the candidates (a generation estimate, never post-hydration). */
  readonly facets: readonly SearchFacet[];
  /** Meili's approximate total of the generation (capped by `maxTotalHits`); not post-hydration. */
  readonly estimatedTotalHits: number;
  /** The witnessed palette generation of the candidates; null when none was witnessed. */
  readonly generation: SearchGenerationRef | null;
  /** The request's company scope key (captured once); null when it was not captured. */
  readonly companyScope: string | null;
  readonly companyContribution: SearchCompanyContribution;
  /** Null exactly when `companyContribution` is `current`. */
  readonly companyContributionReason: SearchCompanyContributionReason | null;
  readonly continuation: SearchContinuation;
}

const LIMIT_DEFAULT = 20;
const LIMIT_MAX = 50;
/** Meili stops scanning at `maxTotalHits` (default 1000); deeper offsets are pointless. */
const OFFSET_MAX = 1000;

/**
 * The palette identity types whose `doc_key` names a core organization by CUI
 * (catalogs, acts, MPs, committees and bills keep their own key domains).
 */
const CUI_IDENTITY_DOC_TYPES: ReadonlySet<string> = new Set([
  'organization',
  'company',
  'public_enterprise',
  'ngo',
  'organization_unclassified',
  'pnrr_entity',
]);
/**
 * The PRIVACY population: a canonical positive CUI (no sign, no leading zero)
 * within the served bound, short CUIs such as `1` or `4` included. Distinct
 * from the company contribution's ONRC shape (2–10 digits), which only the
 * companies module applies when deciding which parents receive company values.
 */
const CANONICAL_CUI = new RegExp(`^[1-9][0-9]{0,${String(MAX_SERVED_CUI_DIGITS - 1)}}$`, 'u');
/** A namespaced key of another identity domain (e.g. `registry:12345`): never a core CUI. */
const NAMESPACED_KEY = /^[a-z][a-z0-9_]*:\S+$/u;

/** The company-owned fields of a `palette-company-v1` document (null without a contribution). */
const COMPANY_KEYS = [
  'company_registry_state',
  'company_name',
  'company_name_source',
  'company_legal_form',
  'company_county_code',
  'company_active',
  'company_identifiers',
] as const;

/** Flatten Meili's `{ field: { value: count } }` distribution to typed buckets (control excluded). */
const toFacets = (
  distribution: Readonly<Record<string, Record<string, number>>>
): readonly SearchFacet[] =>
  Object.entries(distribution).flatMap(([field, buckets]) =>
    Object.entries(buckets)
      .filter(([value]) => value !== PALETTE_GENERATION_CONTROL_ID)
      .map(([value, count]): SearchFacet => ({ field, value, count }))
  );

/** The internal control is never a candidate, whatever the engine returned. */
const isPublicCandidate = (hit: SearchHit): boolean =>
  hit.id !== PALETTE_GENERATION_CONTROL_ID &&
  hit.docType !== PALETTE_GENERATION_CONTROL_ID &&
  hit.docKey !== PALETTE_GENERATION_CONTROL_ID &&
  (hit.attrs['privacy_class'] === undefined || hit.attrs['privacy_class'] === 'public');

/**
 * What a candidate's key says about the core parent it could name:
 *  - `cui`: an identity keyed by a canonical CUI: classified fresh (privacy
 *    batch and final check), whatever its role;
 *  - `foreign`: an identity of another key domain (a namespaced registry key):
 *    it names no core organization;
 *  - `malformed`: an identity key that is neither (missing, leading zero,
 *    sign or prefix, overlength / personal-shaped): never normalized or
 *    guessed, the candidate is withheld;
 *  - `document`: not an identity type (its key has its own domain).
 */
type IdentityKey =
  | { readonly kind: 'cui'; readonly cui: string }
  | { readonly kind: 'foreign' | 'malformed' | 'document' };

const identityKeyOf = (hit: SearchHit): IdentityKey => {
  if (!CUI_IDENTITY_DOC_TYPES.has(hit.docType)) return { kind: 'document' };
  const key = hit.docKey;
  if (key !== undefined && CANONICAL_CUI.test(key)) return { kind: 'cui', cui: key };
  if (key !== undefined && NAMESPACED_KEY.test(key)) return { kind: 'foreign' };
  return { kind: 'malformed' };
};

type Tri = boolean | null;

/** SQL-style three-valued OR: true wins, all false is false, otherwise unknown. */
const or3 = (a: Tri, b: Tri): Tri =>
  a === true || b === true ? true : a === false && b === false ? false : null;

/** What the index document says about its own company contribution (candidate data). */
interface IndexCompany {
  /** The document carried a company contribution (its registry state is set). */
  readonly present: boolean;
  /** Its company activity term; undefined when not well-formed. */
  readonly active: Tri | undefined;
  /** Its company identifiers; undefined when not well-formed. */
  readonly identifiers: readonly string[] | undefined;
}

const indexCompanyOf = (attrs: Readonly<Record<string, unknown>>): IndexCompany => {
  const state = attrs['company_registry_state'];
  // No contribution: the company term is false and adds no identifier (§2).
  if (state === undefined || state === null)
    return { present: false, active: false, identifiers: [] };
  const active = attrs['company_active'];
  const ids = attrs['company_identifiers'];
  return {
    present: true,
    active: typeof active === 'boolean' || active === null ? active : undefined,
    identifiers:
      Array.isArray(ids) && ids.every((v): v is string => typeof v === 'string') ? ids : undefined,
  };
};

/**
 * The activity of the identity's OTHER sources, recovered from the index's
 * OR (`independent ∨ ngo ∨ company`): false when the OR was false; when it was
 * true, true unless the index's own company term could explain it; when it
 * was null, false when only a null company term explains it. Unknown (null)
 * whenever the company term cannot be separated (no witnessed generation).
 */
const independentActivity = (
  indexActive: SearchHit['isActive'],
  company: IndexCompany,
  separable: boolean
): Tri => {
  if (indexActive === false) return false;
  if (!separable || company.active === undefined) return null;
  if (indexActive === true) return company.active === true ? null : true;
  return company.active === null ? false : null;
};

const dedupe = (values: readonly string[]): readonly string[] => [...new Set(values)];

/** `value` without `keys` (a copy). */
const omit = <T extends object, K extends keyof T>(value: T, keys: readonly K[]): Omit<T, K> =>
  Object.fromEntries(
    Object.entries(value).filter(([key]) => !(keys as readonly PropertyKey[]).includes(key))
  ) as Omit<T, K>;

const collapseSpace = (text: string): string => text.replace(/\s+/gu, ' ').trim();

/** Raw document keys that duplicate the typed fields refreshed or removed here. */
const sanitizedAttrs = (
  attrs: Readonly<Record<string, unknown>>,
  companyTouched: boolean,
  companyDocument: boolean
): Record<string, unknown> => {
  const omitted = new Set<string>(COMPANY_KEYS);
  if (companyTouched) {
    for (const key of ['is_active', 'identifiers', 'county_name', 'rank_boost']) omitted.add(key);
  }
  // A company document's title, subtitle and display attrs are company-owned.
  if (companyDocument) for (const key of ['title', 'subtitle', 'attrs']) omitted.add(key);
  return Object.fromEntries(Object.entries(attrs).filter(([key]) => !omitted.has(key)));
};

/** The hydration decisions every hit of one answer is served under. */
interface ServingContext {
  readonly state: SearchCompanyContribution;
  /** Null: the fresh check could not be taken (every CUI identity is withheld). */
  readonly parents: ReadonlyMap<string, SearchCuiParent> | null;
  /** A witnessed `palette-company-v1` generation: company keys are separable. */
  readonly separable: boolean;
}

/** One CUI-identity hit with its company-owned fields refreshed from `values`, or removed. */
const refreshIdentity = (
  hit: SearchHit,
  cui: string,
  parent: Exclude<SearchCuiParent, { readonly kind: 'private' }>,
  values: SearchHitCompany | null,
  separable: boolean
): SearchHit => {
  const companyParent = parent.kind === 'company';
  const indexCompany = indexCompanyOf(hit.attrs);
  const companyDocument = hit.docType === 'company';
  // Without a witnessed generation the index's company term and identifiers
  // cannot be told apart from the other sources': only the CUI is certain.
  const canSeparate = separable && indexCompany.identifiers !== undefined;
  const companyTerm: Tri = companyParent ? (values === null ? null : values.active) : false;
  const isActive = or3(independentActivity(hit.isActive, indexCompany, canSeparate), companyTerm);
  const independentIds = canSeparate
    ? (hit.identifiers ?? [cui]).filter((v) => !(indexCompany.identifiers ?? []).includes(v))
    : [cui];
  const identifiers = dedupe([...independentIds, ...(values?.identifiers ?? [])]);
  // Generic county of a company parent: the ONRC company county; when that is
  // known to be absent (values read, county null), the identity's own public
  // institution role may supply its current territory county (fresh database
  // evidence only, never the index's or a stale core county). For another
  // identity only an index company contribution made it company-derived.
  const institutionCounty =
    parent.kind === 'company' ? (parent.independentCountyName ?? null) : null;
  const countyName = companyParent
    ? values === null
      ? null
      : (values.countyName ?? institutionCounty)
    : indexCompany.present
      ? null
      : (hit.countyName ?? null);
  const companyTouched = companyParent || indexCompany.present || !canSeparate;
  const companySubtitle = [values?.legalForm ?? null, values?.countyName ?? null]
    .filter((part): part is string => part !== null && part !== '')
    .join(', ');
  const subtitle = companyDocument
    ? companySubtitle === ''
      ? undefined
      : companySubtitle
    : hit.subtitle;
  const rest = omit(hit, [
    'countyName',
    'rankBoost',
    'subtitle',
    'isActive',
    'identifiers',
    'company',
  ] as const);
  return {
    ...rest,
    title: companyDocument && values !== null ? collapseSpace(values.name) : hit.title,
    snippet: companyDocument ? (subtitle ?? null) : hit.snippet,
    ...(subtitle !== undefined && { subtitle }),
    ...(countyName !== null && { countyName }),
    // A ranking boost carries the index's company activity term: dropped when touched.
    ...(!companyTouched && hit.rankBoost !== undefined && { rankBoost: hit.rankBoost }),
    isActive,
    identifiers,
    attrs: sanitizedAttrs(hit.attrs, companyTouched, companyDocument),
    company: values,
  };
};

/** Withhold, keep or refresh one candidate under the answer's serving context. */
const serveCandidate = (hit: SearchHit, context: ServingContext): SearchHit | null => {
  const key = identityKeyOf(hit);
  // An identity key that could name a core parent but is not canonical is
  // never guessed into one: withheld (fail closed).
  if (key.kind === 'malformed') return null;
  if (key.kind !== 'cui') {
    // No core parent: no company contribution can be hydrated, so a company
    // document's title cannot be served and stray company keys are dropped.
    if (hit.docType === 'company') return null;
    return COMPANY_KEYS.some((companyKey) => companyKey in hit.attrs)
      ? { ...hit, attrs: sanitizedAttrs(hit.attrs, false, false) }
      : hit;
  }
  // No fresh decision (unreadable or unregistered check): every CUI identity is withheld.
  if (context.parents === null) return null;
  const parent = context.parents.get(key.cui);
  // A known private parent (any kind, NULL class) vetoes the identity, whatever role it plays.
  if (parent === undefined || parent.kind === 'private') return null;
  const values =
    parent.kind === 'company' && context.state !== 'unavailable' ? parent.values : null;
  // A company document is all company-owned: nothing current to show → withheld.
  if (hit.docType === 'company' && values === null) return null;
  return refreshIdentity(hit, key.cui, parent, values, context.separable);
};

/** The CUIs of an answer's CUI identities (the privacy batch, and what the final check rechecks). */
export const servedIdentityCuis = (hits: readonly SearchHit[]): readonly string[] =>
  dedupe(
    hits.flatMap((hit) => {
      const key = identityKeyOf(hit);
      return key.kind === 'cui' ? [key.cui] : [];
    })
  );

const NO_CONTINUATION: SearchContinuation = { candidatesReturned: 0, nextOffset: null };

/** An answer with no company part (no search ran, or the engine could not answer). */
const withoutCompany = (
  reason: 'no_search' | 'engine_unavailable'
): Pick<
  GlobalSearchResult,
  | 'generation'
  | 'companyScope'
  | 'companyContribution'
  | 'companyContributionReason'
  | 'continuation'
> => ({
  generation: null,
  companyScope: null,
  companyContribution: 'unavailable',
  companyContributionReason: reason,
  continuation: NO_CONTINUATION,
});

/**
 * One fetch of a candidate page and the control read right after it (also
 * the cached value: on a cache hit `after` is history, never the current read).
 */
interface CandidateFetch {
  readonly result: Result<EntitiesSearchResult, ApiError>;
  readonly after: GenerationControlReading;
}

export const makeGlobalSearch = async (
  deps: GlobalSearchDeps,
  input: GlobalSearchInput
): Promise<Result<GlobalSearchResult, ApiError>> => {
  const { meiliClient, meiliIndexes, logger } = deps;
  const startedAt = Date.now();
  const problem = searchQueryProblem(input.q, deps.searchPolicy);
  if (problem !== undefined) return err(invalidInput(problem, 'q'));
  // Bound the page window: clamp limit to [1,50] and offset to [0,1000] so a
  // hostile/garbage paginator can never push Meili past its scan cap or send a
  // negative limit (which Meili rejects and pg silently clamps to 1).
  const limit = Math.min(Math.max(input.limit ?? LIMIT_DEFAULT, 1), LIMIT_MAX);
  const offsetClamped = Math.min(Math.max(input.offset ?? 0, 0), OFFSET_MAX);
  const offset = offsetClamped > 0 ? offsetClamped : undefined;

  const logSearch = (
    engine: 'meili' | 'postgres' | 'none',
    hitCount: number,
    facetCount: number,
    meiliOk: boolean,
    company: {
      readonly contribution: SearchCompanyContribution;
      readonly reason: SearchCompanyContributionReason | null;
      readonly candidates: number;
    }
  ): void => {
    try {
      logger?.info(
        {
          component: 'kernel.globalSearch',
          policy: deps.searchPolicy ?? 'baseline',
          queryLength: input.q.length,
          engine,
          hitCount,
          facetCount,
          latencyMs: Date.now() - startedAt,
          meiliOk,
          companyContribution: company.contribution,
          companyContributionReason: company.reason,
          candidateCount: company.candidates,
        },
        'global search'
      );
    } catch {
      // Logging must never break the request path.
    }
  };

  for (const field of ['entityTags', 'excludeEntityTags'] as const) {
    if (!validEntityTags(input[field])) {
      return err(
        invalidInput(
          'Expected at most 100 namespaced entity tags, each at most 200 characters',
          field
        )
      );
    }
  }
  if (
    input.roles?.some(
      (role) => !SEARCH_ENTITY_ROLES.includes(role as (typeof SEARCH_ENTITY_ROLES)[number])
    ) === true
  ) {
    return err(invalidInput('Unknown entity role', 'roles'));
  }

  const noSearch = (): Result<GlobalSearchResult, ApiError> => {
    logSearch('meili', 0, 0, true, {
      contribution: 'unavailable',
      reason: 'no_search',
      candidates: 0,
    });
    return ok({
      query: input.q,
      hits: [],
      organizations: [],
      engine: 'meili',
      degraded: false,
      facets: [],
      estimatedTotalHits: 0,
      ...withoutCompany('no_search'),
    });
  };

  // Empty/whitespace q → never query either engine (don't leak Meili's
  // "return everything" default). Report as the meili engine (nothing degraded).
  if (input.q.trim() === '') return noSearch();

  // Validate filter inputs ONCE. A requested-but-all-invalid docTypes set
  // matches nothing → short-circuit to empty (mirrors the empty-q guard).
  const requested = validEntityDocTypes(input.docTypes);
  if (input.docTypes !== undefined && requested.length === 0) return noSearch();
  // No docTypes requested → pin the FULL entity-grade allowlist (not just the
  // visibility clause) so a mispointed or polluted index can never surface
  // public non-entity docs.
  const docTypes = input.docTypes === undefined ? [...SEARCH_ENTITY_DOC_TYPES] : requested;
  const county = normalizeCounty(input.county);
  if (input.county !== undefined && county === undefined) {
    return err(invalidInput('county must be a canonical county name', 'county'));
  }
  const roles = validEntityRoles(input.roles);

  const filterArgs = {
    ...(docTypes.length > 0 && { docTypes }),
    ...(county !== undefined && { county }),
    ...(roles.length > 0 && { roles }),
    ...(input.isActive !== undefined && { isActive: input.isActive }),
    ...(input.isUat !== undefined && { isUat: input.isUat }),
    ...(input.entityTags !== undefined && { entityTags: input.entityTags }),
    ...(input.excludeEntityTags !== undefined && { excludeEntityTags: input.excludeEntityTags }),
  };

  const degradedAnswer = (): Result<GlobalSearchResult, ApiError> => {
    // ── Meili down OR index missing/corrupt: the honest degrade ─────────────
    //
    // NO HITS. Not "no matches" — `degraded: true` says we could not look, and
    // the caller is expected to say so.
    //
    // AN EXACT-CUI LOOKUP WAS TRIED TWICE HERE AND REMOVED BOTH TIMES. D5 asked
    // for it ("the lookup that must survive an outage"), and the spine can
    // indeed resolve a CUI cheaply. The problem is not the lookup, it is the
    // ANSWER: this surface must return what the INDEX would have returned, and
    // the index collapses each identity to one `doc_type` by role priority
    // (public_entity → public_enterprise → ngo → company → pnrr_entity) across
    // several role tables, deriving title, activity and county with it.
    //
    //  - Attempt 1 emitted the spine's `kind`, which disagrees with the
    //    collapsed type for every dual-role identity — wrong badge, wrong link.
    //  - Attempt 2 emitted `organization` as a supposedly generic identity
    //    type. It is not: the palette assigns it ONLY to `core.public_entities`
    //    identities, the client renders it as "Instituție", and
    //    `/entities/$cui` is the legacy budget/institution page. That labels a
    //    private company an institution and links it to the wrong place — and a
    //    company-only CUI filtered to `docTypes: ['organization']` would be
    //    returned here while healthy Meili excludes it.
    //
    // Reproducing the collapse rule in the server would make it correct today
    // and silently wrong the day the palette's priority changes, with nothing
    // in this repo able to notice. So the capability is deferred rather than
    // faked: it needs a palette-OWNED exact-CUI projection (or the index
    // itself), not a second implementation of the rule. Serving nothing is a
    // smaller loss than serving a confident wrong label.
    logSearch('none', 0, 0, false, {
      contribution: 'unavailable',
      reason: 'engine_unavailable',
      candidates: 0,
    });
    return ok({
      query: input.q,
      hits: [],
      organizations: [],
      // No query ran: reporting 'postgres' described an execution that did not happen.
      engine: 'none',
      degraded: true,
      facets: [],
      estimatedTotalHits: 0,
      ...withoutCompany('engine_unavailable'),
    });
  };

  // No Meili index configured → the honest degrade.
  if (meiliIndexes.length === 0) return degradedAnswer();
  const index = meiliIndexes[0] ?? 'entities';

  const readControl = (): Promise<GenerationControlReading> =>
    readGenerationControl(meiliClient, index);
  const fetchCandidates = async (): Promise<CandidateFetch> => {
    const result = await meiliClient.searchEntities(input.q, index, {
      policy: deps.searchPolicy ?? 'baseline',
      filter: buildEntitiesFilter(filterArgs),
      facets: ['doc_type'],
      limit,
      ...(offset !== undefined && { offset }),
    });
    // Nothing to witness when the engine did not answer.
    const after: GenerationControlReading = result.isOk()
      ? await readControl()
      : { state: 'unreadable' };
    return { result, after };
  };
  /** The candidate cache key: the witnessed generation + scope and the normalized query. */
  const candidateKey = (generationId: string, registryScopeKey: string): string =>
    `entities-search:${JSON.stringify({
      generationId,
      registryScopeKey,
      policy: deps.searchPolicy ?? 'baseline',
      q: input.q,
      docTypes: [...docTypes].sort(),
      county: county ?? null,
      roles: [...roles].sort(),
      isActive: input.isActive ?? null,
      isUat: input.isUat ?? null,
      entityTags: [...new Set(input.entityTags ?? [])].sort(),
      excludeEntityTags: [...new Set(input.excludeEntityTags ?? [])].sort(),
      limit,
      offset: offset ?? 0,
    })}`;

  // Candidates between two FRESH control reads of this request; a generation
  // that changed between them is retried once, then served as not witnessed.
  let answer: EntitiesSearchResult | undefined;
  let witness: GenerationWitness = { witnessed: false, reason: 'control_incoherent' };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const before = await readControl();
    const cache = deps.candidateCache;
    const computation = { ran: false };
    const fetchNow = (): Promise<CandidateFetch> => {
      computation.ran = true;
      return fetchCandidates();
    };
    const fetched =
      before.state === 'valid' && cache !== undefined
        ? await cache.wrap(
            candidateKey(before.control.generationId, before.control.registryScopeKey),
            fetchNow,
            // Only a witnessed engine answer is a cacheable candidate fact.
            (f) => f.result.isOk() && witnessGeneration(before, f.after).witnessed
          )
        : await fetchNow();
    if (fetched.result.isErr()) return degradedAnswer();
    answer = fetched.result.value;
    // A cached entry's stored after-read only proved it valid when it was
    // stored; a warm hit takes its own after-read now (the cold path already did).
    const after = computation.ran ? fetched.after : await readControl();
    witness = witnessGeneration(before, after);
    if (witness.witnessed || witness.reason !== 'control_incoherent') break;
  }
  if (answer === undefined) return degradedAnswer();

  const candidates = answer.hits.filter(isPublicCandidate);
  // Data is served from Meili; access policy is refreshed independently in the background.
  const access = deps.companySearch?.readAccessSnapshot?.() ?? null;
  const parents = new Map<string, SearchCuiParent>();
  let malformed = false;
  const current =
    access !== null &&
    access.published &&
    witness.witnessed &&
    witness.control.registryScopeKey === access.scopeKey;
  for (const hit of candidates) {
    const key = identityKeyOf(hit);
    if (key.kind !== 'cui') continue;
    if (access?.privateCuis.has(key.cui) === true) {
      parents.set(key.cui, { kind: 'private' });
      continue;
    }
    const projected = projectedCompanyValues(hit);
    if (projected === undefined || (projected !== null && key.cui.length < 2)) {
      malformed = true;
      continue;
    }
    parents.set(
      key.cui,
      projected === null
        ? { kind: 'none' }
        : {
            kind: 'company',
            values: current ? projected : null,
            independentCountyName:
              current &&
              projected.countyCode === null &&
              !access.privateInstitutionCuis.has(key.cui)
                ? (hit.countyName ?? null)
                : null,
          }
    );
  }
  const companyScope = access?.scopeKey ?? null;
  const context: ServingContext = {
    state: current && !malformed ? 'current' : 'unavailable',
    parents: access !== null && witness.witnessed ? parents : null,
    separable: witness.witnessed,
  };
  const reason: SearchCompanyContributionReason | null =
    current && !malformed
      ? null
      : access === null || malformed
        ? 'company_check_unavailable'
        : !witness.witnessed
          ? witness.reason
          : !access.published
            ? 'registry_not_published'
            : 'generation_scope_stale';

  const hits = candidates.flatMap((hit) => serveCandidate(hit, context) ?? []);
  const facets = toFacets(answer.facetDistribution);
  // Continuation follows the engine's candidate page, never the visible hits:
  // a page whose candidates were all withheld can still have a next page.
  const candidatesReturned = answer.hits.length;
  const next = offsetClamped + candidatesReturned;
  const continuation: SearchContinuation = {
    candidatesReturned,
    nextOffset: candidatesReturned === limit && next <= OFFSET_MAX ? next : null,
  };
  logSearch('meili', hits.length, facets.length, true, {
    contribution: context.state,
    reason,
    candidates: candidatesReturned,
  });
  return ok({
    query: input.q,
    hits,
    organizations: [],
    engine: 'meili',
    degraded: false,
    facets,
    estimatedTotalHits: answer.estimatedTotalHits,
    generation: witness.witnessed
      ? {
          generationId: witness.control.generationId,
          registryScopeKey: witness.control.registryScopeKey,
        }
      : null,
    companyScope,
    companyContribution: context.state,
    companyContributionReason: reason,
    continuation,
  });
};

/** The final decision could not be taken for served CUI identities (fail closed). */
const COMPANY_CHECK_NOT_TAKEN_MESSAGE =
  'the access of the served identities could not be rechecked; retry';

/**
 * The final decision for an answer about to be serialized (GraphQL: the
 * owning-result guard after the whole operation settled; MCP: eagerly). The
 * request's company scope must still hold and no served CUI identity (short
 * CUIs such as `1` included) may have a non-public organization now. An answer
 * without a captured scope served no CUI identity, so there is nothing to
 * recheck; one that did would be refused (never a pass without a read).
 */

export const confirmGlobalSearchServed = async (
  deps: Pick<GlobalSearchDeps, 'companySearch'>,
  result: GlobalSearchResult
): Promise<Result<void, ApiError>> => {
  const cuis = servedIdentityCuis(result.hits);
  if (result.companyScope === null) {
    return cuis.length === 0
      ? ok(undefined)
      : err(serviceUnavailable(COMPANY_CHECK_NOT_TAKEN_MESSAGE));
  }
  const access = await Promise.resolve(deps.companySearch?.readAccessSnapshot?.() ?? null);
  if (access?.scopeKey !== result.companyScope || cuis.some((cui) => access.privateCuis.has(cui))) {
    return err(serviceUnavailable(COMPANY_CHECK_NOT_TAKEN_MESSAGE));
  }
  return ok(undefined);
};
