/**
 * Legal module — OpenSearch request bodies, compiled (pure).
 *
 * ONE filter compiler feeds every leg: the BM25 legs on both indexes AND the
 * kNN leg's `filter` clause. This is load-bearing honesty — an unfiltered
 * kNN leg silently answers a DIFFERENT question than the filtered BM25 leg
 * it is fused with (plan top-risk 4), so there is exactly one function that
 * turns a `LegalEngineFilter` into clauses, and every body-builder calls it.
 *
 * Field names bind to the exporter mappings in the scrapper repo
 * (`src/sources/portal-legislativ/prod/search/mappings.ts`, contract ids
 * `legal-acts/v1` / `legal-sections/v1`). The shared filter fields exist
 * with identical types in BOTH indexes, so the same clauses are valid on
 * either leg.
 *
 * Engine role follows procurement: keys-only (`_source` limited to id
 * fields), Postgres hydrates. An explicit empty `in: []` matches NOTHING.
 */

export interface LegalEngineFilter {
  readonly actType?: readonly string[];
  readonly issuerSlug?: readonly string[];
  readonly status?: readonly string[];
  readonly actClass?: readonly string[];
  readonly domain?: readonly string[];
  readonly category?: readonly string[];
  readonly year?: number;
  readonly yearFrom?: number;
  readonly yearTo?: number;
  readonly penaltiesMentioned?: boolean;
}

/** Acts-index BM25 fields; folded doubles per the procurement lesson. */
const ACTS_Q_FIELDS = [
  'display_citation^4',
  'display_citation.folded^4',
  'title^3',
  'title.folded^3',
  'keywords^2',
  'keywords.folded^2',
  'summary',
  'summary.folded',
  'description',
  'description.folded',
  'clean_text',
  'clean_text.folded',
] as const;

/** Sections-index BM25 fields. */
const SECTIONS_Q_FIELDS = [
  'text^2',
  'text.folded^2',
  'title',
  'title.folded',
  'display_citation',
  'display_citation.folded',
] as const;

/**
 * Highlighted fields, base + folded pairs (the highlighter analyzes the
 * query with the FIELD's analyzer; only asking the folded twin loses marks
 * on diacritic-less queries — procurement's measured lesson).
 */
export const ACTS_HIGHLIGHT_FIELDS = ['title', 'summary', 'clean_text'] as const;
export const SECTIONS_HIGHLIGHT_FIELDS = ['text'] as const;

/** NOT HTML: the client splits on these markers and renders its own element. */
export const HIGHLIGHT_OPEN = '⟦';
export const HIGHLIGHT_CLOSE = '⟧';

/**
 * The one compiler. Term-level clauses only; `privacy_class: 'public'` is
 * ALWAYS present — the engine never sees a request without the privacy gate.
 */
export function compileLegalFilter(filter: LegalEngineFilter): Record<string, unknown>[] {
  const clauses: Record<string, unknown>[] = [{ term: { privacy_class: 'public' } }];
  const terms = (field: string, values: readonly string[] | undefined): void => {
    if (values !== undefined) {
      clauses.push({ terms: { [field]: [...values] } });
    }
  };
  terms('act_type', filter.actType);
  terms('issuer_slug', filter.issuerSlug);
  terms('status', filter.status);
  terms('act_class', filter.actClass);
  terms('domains', filter.domain);
  terms('category', filter.category);
  if (filter.year !== undefined) {
    clauses.push({ term: { act_year: filter.year } });
  }
  if (filter.yearFrom !== undefined || filter.yearTo !== undefined) {
    clauses.push({
      range: {
        act_year: {
          ...(filter.yearFrom !== undefined && { gte: filter.yearFrom }),
          ...(filter.yearTo !== undefined && { lte: filter.yearTo }),
        },
      },
    });
  }
  if (filter.penaltiesMentioned !== undefined) {
    clauses.push({ term: { penalties_mentioned: filter.penaltiesMentioned } });
  }
  return clauses;
}

const bm25Query = (
  q: string,
  fields: readonly string[],
  filter: LegalEngineFilter
): Record<string, unknown> => ({
  bool: {
    must: [
      {
        multi_match: {
          query: q,
          fields: [...fields],
          type: 'best_fields',
          operator: 'or',
        },
      },
    ],
    filter: compileLegalFilter(filter),
  },
});

const highlight = (fields: readonly string[]): Record<string, unknown> => ({
  pre_tags: [HIGHLIGHT_OPEN],
  post_tags: [HIGHLIGHT_CLOSE],
  fields: Object.fromEntries(
    fields.flatMap((field) => [
      [field, {}],
      [`${field}.folded`, {}],
    ])
  ),
});

export interface LegalEngineWindow {
  readonly from: number;
  readonly size: number;
}

/** BM25 leg on `legal-acts`: keys + highlights, real total. */
export function buildActsBm25Body(
  q: string,
  filter: LegalEngineFilter,
  window: LegalEngineWindow
): Record<string, unknown> {
  return {
    query: bm25Query(q, ACTS_Q_FIELDS, filter),
    _source: ['document_id', 'act_id'],
    highlight: highlight(ACTS_HIGHLIGHT_FIELDS),
    from: window.from,
    size: window.size,
    track_total_hits: true,
  };
}

/** BM25 leg on `legal-sections`. */
export function buildSectionsBm25Body(
  q: string,
  filter: LegalEngineFilter,
  window: LegalEngineWindow
): Record<string, unknown> {
  return {
    query: bm25Query(q, SECTIONS_Q_FIELDS, filter),
    _source: ['document_id', 'act_id', 'section_key'],
    highlight: highlight(SECTIONS_HIGHLIGHT_FIELDS),
    from: window.from,
    size: window.size,
    track_total_hits: true,
  };
}

/**
 * kNN leg on `legal-sections`. THE SAME compiled filter rides inside the
 * knn clause, so the vector search is restricted to exactly the documents
 * the BM25 leg saw.
 */
export function buildSectionsKnnBody(
  queryVector: readonly number[],
  filter: LegalEngineFilter,
  size: number
): Record<string, unknown> {
  return {
    query: {
      knn: {
        embedding: {
          vector: [...queryVector],
          k: size,
          filter: { bool: { filter: compileLegalFilter(filter) } },
        },
      },
    },
    _source: ['document_id', 'act_id', 'section_key'],
    size,
  };
}
