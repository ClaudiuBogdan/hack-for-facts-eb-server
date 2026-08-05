import { describe, expect, it } from 'vitest';

import {
  buildActsBm25Body,
  buildSectionsBm25Body,
  buildSectionsKnnBody,
  compileLegalFilter,
  HIGHLIGHT_CLOSE,
  HIGHLIGHT_OPEN,
  type LegalEngineFilter,
} from '@/modules/legal/core/legal-opensearch-query.js';
import { rrfFuse, RRF_K_DEFAULT } from '@/modules/legal/core/legal-search-fusion.js';

describe('compileLegalFilter', () => {
  it('always includes the privacy gate, even on an empty filter', () => {
    expect(compileLegalFilter({})).toEqual([{ term: { privacy_class: 'public' } }]);
  });

  it('compiles an explicit empty in:[] to an empty terms clause (matches nothing)', () => {
    const clauses = compileLegalFilter({ actType: [] });
    expect(clauses).toContainEqual({ terms: { act_type: [] } });
  });

  it('compiles year range bounds together', () => {
    const clauses = compileLegalFilter({ yearFrom: 2000, yearTo: 2010 });
    expect(clauses).toContainEqual({
      range: { act_year: { gte: 2000, lte: 2010 } },
    });
  });

  it('covers every declared filter family', () => {
    const filter: LegalEngineFilter = {
      actType: ['lege'],
      issuerSlug: ['parlamentul'],
      status: ['in-vigoare'],
      actClass: ['normativ'],
      domain: ['fiscal-si-bugetar'],
      category: ['lege'],
      year: 2001,
      penaltiesMentioned: true,
    };
    const clauses = compileLegalFilter(filter);
    expect(clauses).toHaveLength(9);
  });
});

describe('engine bodies share the one compiled filter', () => {
  const filter: LegalEngineFilter = {
    actType: ['lege', 'oug'],
    yearFrom: 1990,
    domain: ['justitie'],
  };

  const filterOf = (body: Record<string, unknown>): unknown => {
    const query = body['query'] as Record<string, unknown>;
    if ('knn' in query) {
      const knn = query['knn'] as { embedding: { filter: { bool: { filter: unknown } } } };
      return knn.embedding.filter.bool.filter;
    }
    return (query['bool'] as { filter: unknown }).filter;
  };

  it('BM25 acts, BM25 sections and kNN sections carry IDENTICAL filter clauses', () => {
    const acts = buildActsBm25Body('impozit', filter, { from: 0, size: 20 });
    const sections = buildSectionsBm25Body('impozit', filter, { from: 0, size: 20 });
    const knn = buildSectionsKnnBody([0.1, 0.2], filter, 20);
    expect(filterOf(acts)).toEqual(compileLegalFilter(filter));
    expect(filterOf(sections)).toEqual(compileLegalFilter(filter));
    expect(filterOf(knn)).toEqual(compileLegalFilter(filter));
  });

  it('legs are keys-only and count honestly', () => {
    const acts = buildActsBm25Body('impozit', filter, { from: 0, size: 20 });
    expect(acts['_source']).toEqual(['document_id', 'act_id']);
    expect(acts['track_total_hits']).toBe(true);
    const knn = buildSectionsKnnBody([0.1], filter, 10);
    expect(knn['_source']).toEqual(['document_id', 'act_id', 'section_key']);
  });

  it('highlights request base AND folded twins with non-HTML markers', () => {
    const acts = buildActsBm25Body('scoala', {}, { from: 0, size: 10 });
    const hl = acts['highlight'] as {
      pre_tags: string[];
      post_tags: string[];
      fields: Record<string, unknown>;
    };
    expect(hl.pre_tags).toEqual([HIGHLIGHT_OPEN]);
    expect(hl.post_tags).toEqual([HIGHLIGHT_CLOSE]);
    expect(Object.keys(hl.fields)).toContain('title');
    expect(Object.keys(hl.fields)).toContain('title.folded');
  });
});

describe('rrfFuse', () => {
  it('fuses two legs with the RRF formula and orders deterministically', () => {
    const fused = rrfFuse([
      { leg: 'bm25', keys: ['a', 'b', 'c'] },
      { leg: 'knn', keys: ['b', 'a'] },
    ]);
    // a: 1/(k+1) + 1/(k+2); b: 1/(k+2) + 1/(k+1) — tie, broken by key.
    expect(fused[0]?.key).toBe('a');
    expect(fused[1]?.key).toBe('b');
    expect(fused[2]?.key).toBe('c');
    expect(fused[0]?.score).toBeCloseTo(1 / (RRF_K_DEFAULT + 1) + 1 / (RRF_K_DEFAULT + 2), 12);
    expect(fused[0]?.sources).toEqual([
      { leg: 'bm25', rank: 1 },
      { leg: 'knn', rank: 2 },
    ]);
  });

  it('a key repeated WITHIN a leg contributes only its best rank', () => {
    const fused = rrfFuse([{ leg: 'bm25', keys: ['a', 'a', 'b'] }]);
    expect(fused[0]?.key).toBe('a');
    expect(fused[0]?.score).toBeCloseTo(1 / (RRF_K_DEFAULT + 1), 12);
    // 'b' keeps rank 3 (positional), not a compacted rank 2.
    expect(fused[1]?.score).toBeCloseTo(1 / (RRF_K_DEFAULT + 3), 12);
  });

  it('a single-leg fusion preserves the leg order', () => {
    const fused = rrfFuse([{ leg: 'bm25', keys: ['x', 'y', 'z'] }]);
    expect(fused.map((hit) => hit.key)).toEqual(['x', 'y', 'z']);
  });

  it('fuses nothing to nothing', () => {
    expect(rrfFuse([])).toEqual([]);
  });
});
