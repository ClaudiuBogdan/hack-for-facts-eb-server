/**
 * Word search on the legal-v2 test indexes (search-design.md §5; the query of
 * the data repo's search-test/ask.ts). Pure: the bodies, the hit grouping and
 * the usecase over ports.
 *
 * Two BM25 legs, no vector leg (the units index's vectors are 2,560-d Qwen3;
 * no embedder is configured for them, so meaning search reports unavailable):
 *  - acts index: the act's name, title and Portal listing label;
 *  - units index: the provisions' text (`text`, `text.folded`), heading path,
 *    act name and title, with the fields and weights of ask.ts WORD_FIELDS.
 * Both filter `privacy_class = public` and the act facts the index holds
 * (type, issuer, year). Status, domain, category and penalties are not in the
 * index: they are BRIDGED facts and filter the hydrated page only, which makes
 * totals non-exhaustive.
 *
 * Hits are ACTS: name matches first in their rank order, then acts reached
 * through their provisions in the order of their best provision; each act
 * carries its provision hits. No rank fusion (search-design §5.6). Acts are
 * hydrated from legal_v2 by act_id (never by the index's form or unit ids:
 * the 2026-11-18 index predates generation 4 and option B replaces units).
 */

import { err, ok, type Result } from 'neverthrow';

import { invalidInput, type ApiError, type FilterInput } from '@/modules/shared/index.js';

import { LEGAL_LIVE_STATUSES, toEngineFilter } from '../legal-engine-filter.js';

import type { LegalActsRepo } from '../ports.js';
import type {
  LegalAct,
  LegalActSummary,
  LegalVersionProvenance,
  LegalDocHit,
  LegalSearchResult,
  LegalSectionHit,
} from '../types.js';

export const V2_INDEX_CONTRACT_ACTS = 'legal-v2-test/acts/1';
export const V2_INDEX_CONTRACT_UNITS = 'legal-v2-test/units/1';

/** ask.ts WORD_FIELDS: "a first guess, not measured". */
export const V2_UNIT_WORD_FIELDS = [
  'text',
  'text.folded^0.5',
  'heading_path^0.5',
  'act_name^1.5',
  'act_title',
] as const;
/** The acts index's searched names (mappings.ts actsIndexBody). Not measured. */
export const V2_ACT_WORD_FIELDS = [
  'act_name^1.5',
  'act_name.folded',
  'act_title',
  'act_title.folded^0.5',
  'listing_label',
  'listing_label.folded^0.5',
] as const;
/** Unit hits read per request; the acts they reach fill the page. Not measured. */
export const V2_UNIT_WINDOW = 100;
/** Provision hits kept per act. */
export const V2_SECTIONS_PER_ACT = 3;

export const V2_SEMANTIC_CAVEAT = 'semantic search unavailable';
export const V2_BRIDGED_FILTER_CAVEAT =
  'Filtrele de stare, domeniu și categorie provin din corpusul anterior și se aplică doar rezultatelor afișate; totalurile nu le reflectă.';
export const V2_CONSOLIDATION_CAVEAT =
  'Formele consolidate sunt neoficiale, cu caracter informativ; textul unui act nu este „textul în vigoare la o dată”.';

export interface V2EngineFilter {
  readonly actType?: readonly string[];
  readonly issuerSlug?: readonly string[];
  readonly year?: number;
  readonly yearFrom?: number;
  readonly yearTo?: number;
}

const filterClauses = (f: V2EngineFilter): unknown[] => {
  const clauses: unknown[] = [
    { term: { privacy_class: 'public' } },
    { exists: { field: 'act_id' } },
  ];
  if (f.actType !== undefined) clauses.push({ terms: { act_type: [...f.actType] } });
  if (f.issuerSlug !== undefined) clauses.push({ terms: { issuer_slug: [...f.issuerSlug] } });
  if (f.year !== undefined) clauses.push({ term: { act_year: f.year } });
  if (f.yearFrom !== undefined || f.yearTo !== undefined) {
    clauses.push({
      range: {
        act_year: {
          ...(f.yearFrom !== undefined && { gte: f.yearFrom }),
          ...(f.yearTo !== undefined && { lte: f.yearTo }),
        },
      },
    });
  }
  return clauses;
};

export const buildV2ActsBody = (
  q: string,
  f: V2EngineFilter,
  size: number
): Record<string, unknown> => ({
  size,
  // The act list merges two legs and serves no acts total, so none is counted.
  track_total_hits: false,
  _source: ['act_id'],
  query: {
    bool: {
      must: [
        {
          multi_match: {
            query: q,
            type: 'best_fields',
            operator: 'or',
            fields: [...V2_ACT_WORD_FIELDS],
          },
        },
      ],
      filter: filterClauses(f),
    },
  },
});

export const buildV2UnitsBody = (
  q: string,
  f: V2EngineFilter,
  size: number,
  countTotal = true
): Record<string, unknown> => ({
  size,
  // Counting every OR match costs the cluster; only a served total pays it.
  track_total_hits: countTotal,
  _source: [
    'act_id',
    'citation_path',
    'heading_path',
    'level',
    'uses.form_id',
    'uses.text_unit_id',
    'uses.provision_seq',
    'uses.char_start',
    'uses.char_end',
  ],
  query: {
    bool: {
      must: [
        {
          multi_match: {
            query: q,
            type: 'best_fields',
            operator: 'or',
            fields: [...V2_UNIT_WORD_FIELDS],
          },
        },
      ],
      filter: filterClauses(f),
    },
  },
  highlight: {
    fields: {
      text: { number_of_fragments: 1, fragment_size: 200 },
      'text.folded': { number_of_fragments: 1, fragment_size: 200 },
    },
  },
});

/** One place the index says a unit's wording is used (the exporter's `uses`). */
export interface V2HitUse {
  readonly formId: string;
  readonly unitId: string;
  readonly provisionSeq: number | null;
  readonly charStart: number | null;
  readonly charEnd: number | null;
}

export interface V2EngineHit {
  readonly actId: string;
  readonly score: number;
  readonly citationPath: string | null;
  readonly headingPath: string | null;
  readonly snippet: string | null;
  /** Units index only: where the wording is used, as the index recorded it. */
  readonly uses: readonly V2HitUse[];
}

/**
 * Verifies unit hits against legal_v2 BEFORE any of their text is served: a
 * use counts only when its form is public and servable (the render's rule,
 * consolidation label included), the unit is that form's current public
 * component, the provision is public, and the chunks over the hit's range are
 * public. The 2026-11-18 index predates generation 4, so a hit whose unit was
 * replaced fails this check and is dropped. Returns, per candidate key, the
 * served form of its first verified use.
 */
export interface LegalV2HitVerifier {
  verifyUses(
    candidates: readonly {
      readonly key: number;
      readonly actId: string;
      readonly uses: readonly V2HitUse[];
    }[]
  ): Promise<Result<ReadonlyMap<number, VerifiedUse>, ApiError>>;
}

export interface VerifiedUse {
  readonly use: V2HitUse;
  readonly servedForm: LegalVersionProvenance;
}

export interface V2EnginePage {
  readonly hits: readonly V2EngineHit[];
  /** Null when the leg did not count (`track_total_hits: false`). */
  readonly total: number | null;
  readonly totalExhaustive: boolean;
  readonly asOf: string;
}

export interface LegalV2SearchEngine {
  searchActs(q: string, f: V2EngineFilter, size: number): Promise<Result<V2EnginePage, ApiError>>;
  searchUnits(
    q: string,
    f: V2EngineFilter,
    size: number,
    countTotal?: boolean
  ): Promise<Result<V2EnginePage, ApiError>>;
}

/** The legacy filter translation, split into engine clauses and bridged post-filters. */
export interface V2FilterSplit {
  readonly engine: V2EngineFilter;
  readonly status?: readonly string[];
  readonly domain?: readonly string[];
  readonly category?: readonly string[];
  readonly penaltiesMentioned?: boolean;
  readonly unsupported: readonly string[];
}

export const splitV2Filter = (input: FilterInput, includeHistorical: boolean): V2FilterSplit => {
  const t = toEngineFilter(input, includeHistorical);
  const f = t.filter;
  return {
    engine: {
      ...(f.actType !== undefined && { actType: f.actType }),
      ...(f.issuerSlug !== undefined && { issuerSlug: f.issuerSlug }),
      ...(f.year !== undefined && { year: f.year }),
      ...(f.yearFrom !== undefined && { yearFrom: f.yearFrom }),
      ...(f.yearTo !== undefined && { yearTo: f.yearTo }),
    },
    ...(f.status !== undefined && { status: f.status }),
    ...(f.domain !== undefined && { domain: f.domain }),
    ...(f.category !== undefined && { category: f.category }),
    ...(f.penaltiesMentioned !== undefined && { penaltiesMentioned: f.penaltiesMentioned }),
    unsupported: t.unsupported,
  };
};

/** True when only the historical gate (not the caller) set the status filter. */
const isDefaultLiveGate = (status: readonly string[] | undefined): boolean =>
  status?.length === LEGAL_LIVE_STATUSES.length &&
  status.every((s) => LEGAL_LIVE_STATUSES.includes(s));

/** Does a hydrated act pass the bridged post-filters? */
export const passesBridgedFilters = (
  act: LegalAct,
  summary: LegalActSummary | null,
  split: V2FilterSplit
): boolean => {
  if (split.status !== undefined) {
    // An act the old corpus does not hold has an unknown status: it is
    // `necunoscut`, which the historical gate keeps.
    const status = act.bridged === false ? 'necunoscut' : act.status;
    if (!split.status.includes(status)) return false;
  }
  const domains = split.domain;
  if (domains !== undefined) {
    const held = summary?.domains.some((d) => domains.includes(d)) ?? false;
    if (!held) return false;
  }
  if (split.category !== undefined) {
    if (summary?.documentCategory == null || !split.category.includes(summary.documentCategory)) {
      return false;
    }
  }
  if (split.penaltiesMentioned !== undefined) {
    if (summary?.penaltiesMentioned !== split.penaltiesMentioned) return false;
  }
  return true;
};

/** Ranked act ids: name hits first, then acts reached through provisions. */
export const rankV2Acts = (
  actHits: readonly V2EngineHit[],
  unitHits: readonly V2EngineHit[]
): { order: string[]; sections: Map<string, V2EngineHit[]>; scores: Map<string, number> } => {
  const order: string[] = [];
  const scores = new Map<string, number>();
  const sections = new Map<string, V2EngineHit[]>();
  for (const h of actHits) {
    if (!scores.has(h.actId)) {
      order.push(h.actId);
      scores.set(h.actId, h.score);
    }
  }
  for (const h of unitHits) {
    if (!scores.has(h.actId)) {
      order.push(h.actId);
      scores.set(h.actId, h.score);
    }
    const list = sections.get(h.actId) ?? [];
    if (list.length < V2_SECTIONS_PER_ACT) list.push(h);
    sections.set(h.actId, list);
  }
  return { order, sections, scores };
};

export interface V2SearchQuery {
  readonly q: string;
  readonly filter: FilterInput;
  readonly channel: 'auto' | 'sections' | 'docs';
  readonly includeHistorical: boolean;
  readonly limit: number;
}

export interface V2SearchDeps {
  readonly engine: LegalV2SearchEngine;
  readonly acts: LegalActsRepo;
  readonly verifier: LegalV2HitVerifier;
  readonly clientBaseUrl: string;
}

export const V2_VERIFIED_CAVEAT =
  'Fragmentele sunt verificate pe textul public servit acum; potrivirile care nu pot fi verificate sunt omise și nu sunt numărate.';

/**
 * The engine part of `legalSearch` on the v2 source. The identifier router
 * (an exact citation) runs before this in `searchLegal`, unchanged, over the
 * v2 acts repo.
 */
export const searchLegalV2Engine = async (
  deps: V2SearchDeps,
  query: V2SearchQuery
): Promise<Result<LegalSearchResult, ApiError>> => {
  const split = splitV2Filter(query.filter, query.includeHistorical);
  if (split.unsupported.length > 0) {
    return err(
      invalidInput(
        `legal search: the engine cannot express ${split.unsupported.join(', ')}`,
        'filter'
      )
    );
  }
  const limit = Math.min(Math.max(query.limit, 1), 50);
  const [actsRes, unitsRes] = await Promise.all([
    deps.engine.searchActs(query.q, split.engine, limit),
    // Totals are never served on v2 (unverifiable hits are dropped), so none is counted.
    deps.engine.searchUnits(query.q, split.engine, V2_UNIT_WINDOW, false),
  ]);
  if (actsRes.isErr()) return err(actsRes.error);
  if (unitsRes.isErr()) return err(unitsRes.error);

  // Verify every unit hit against public, servable legal_v2 rows first.
  const unitHits = unitsRes.value.hits;
  const verified = await deps.verifier.verifyUses(
    unitHits.map((h, key) => ({ key, actId: h.actId, uses: h.uses }))
  );
  if (verified.isErr()) return err(verified.error);
  const kept = unitHits.flatMap((h, key) => {
    const v = verified.value.get(key);
    return v === undefined ? [] : [{ hit: h, verified: v }];
  });
  const verifiedOf = new Map(kept.map((k) => [k.hit, k.verified]));

  const ranked = rankV2Acts(
    actsRes.value.hits,
    kept.map((k) => k.hit)
  );
  const wanted = ranked.order;
  const [found, provRes] = await Promise.all([
    deps.acts.findActsByIds(wanted),
    deps.acts.versionProvenanceForActs(wanted),
  ]);
  if (found.isErr()) return err(found.error);
  if (provRes.isErr()) return err(provRes.error);
  const byId = new Map(found.value.map((a) => [a.actId, a]));
  const canon = await deps.acts.canonicalDocumentsForActs(wanted);
  if (canon.isErr()) return err(canon.error);
  const docIds = [...canon.value.values()].map((d) => d.documentId);
  const sums = await deps.acts.summariesForDocuments(docIds);
  if (sums.isErr()) return err(sums.error);
  const summaryOf = (actId: string): LegalActSummary | null => {
    const doc = canon.value.get(actId);
    return doc === undefined ? null : (sums.value.get(doc.documentId) ?? null);
  };

  let postFiltered = 0;
  const acts: LegalDocHit[] = [];
  const sections: LegalSectionHit[] = [];
  for (const actId of wanted) {
    if (acts.length >= limit) break;
    const act = byId.get(actId);
    // Not a public current legal_v2 act: dropped, and (privacy) not counted.
    if (act === undefined || act.ended === true) continue;
    const summary = summaryOf(actId);
    if (!passesBridgedFilters(act, summary, split)) {
      postFiltered += 1;
      continue;
    }
    const provenance = provRes.value.get(actId) ?? null;
    acts.push({ act, summary, score: ranked.scores.get(actId) ?? 0, provenance });
    for (const h of ranked.sections.get(actId) ?? []) {
      const v = verifiedOf.get(h);
      if (v === undefined) continue;
      sections.push({
        actId,
        displayCitation: act.displayCitation,
        status: act.status,
        documentId: v.servedForm.documentId ?? '',
        sectionKey: h.citationPath ?? '',
        articleNumber: null,
        nodeLabel: h.headingPath,
        nodePath: h.citationPath,
        charStart: v.use.charStart,
        charEnd: v.use.charEnd,
        snippet: h.snippet,
        portalDeepLink: `${deps.clientBaseUrl}/legislation/acts/${actId}`,
        score: h.score,
        // The text is this form's, so its provenance is this form's.
        provenance: v.servedForm,
        servedForm: v.servedForm,
      });
    }
  }

  const caveats = [V2_SEMANTIC_CAVEAT, V2_VERIFIED_CAVEAT];
  if (acts.length > 0) caveats.push(V2_CONSOLIDATION_CAVEAT);
  const callerFilteredBridged =
    (split.status !== undefined && !isDefaultLiveGate(split.status)) ||
    split.domain !== undefined ||
    split.category !== undefined ||
    split.penaltiesMentioned !== undefined;
  if (callerFilteredBridged || postFiltered > 0) caveats.push(V2_BRIDGED_FILTER_CAVEAT);

  const wantSections = query.channel !== 'docs';
  return ok({
    acts,
    sections: wantSections ? sections : [],
    caveats,
    engine: 'opensearch',
    // Merged legs, dropped unverifiable hits, bridged post-filters: no total
    // is exact, and the dropped hits are deliberately not counted (privacy).
    actsTotal: null,
    sectionsTotal: null,
    totalsExhaustive: false,
    degraded: false,
    asOf: unitsRes.value.asOf < actsRes.value.asOf ? unitsRes.value.asOf : actsRes.value.asOf,
    unhydratedHits: 0,
  });
};
