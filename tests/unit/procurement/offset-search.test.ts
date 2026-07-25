/**
 * Offset-search core: the page-window cap, the capped-count boundary, the
 * sort→column map (incl. the total-order tiebreak), `q` bounds + ILIKE escaping,
 * and the direct-acquisition selectivity matrix. Pure — no DB, no mocking library.
 */

import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely';
import { describe, expect, it } from 'vitest';

import { SEARCH_COUNT_CAP, SEARCH_WINDOW_MAX } from '@/modules/procurement/core/constants.js';
import {
  assertDaOffsetSelective,
  assertSortServeable,
  escapeLikePattern,
  interpretCappedCount,
  offsetOf,
  parseOffsetRequest,
  parseQ,
  resolveSort,
  usesEngineOnlyFilter,
  type ProcurementSearchFilter,
  type SearchGrain,
} from '@/modules/procurement/core/search.js';
import { buildSearchConditions } from '@/modules/procurement/shell/repo/offset-search-repo.js';

const DA_WINDOW_DAYS = 366;

/**
 * Compile the raw fragments to real SQL text — a `RawBuilder` is opaque
 * otherwise, and the point of these tests is the predicate that reaches
 * Postgres.
 */
const dummyDb = new Kysely<Record<string, never>>({
  dialect: {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (d) => new PostgresIntrospector(d),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  },
});

describe('capped exact count boundary', () => {
  const items = ['a'];

  it(`exactly ${String(SEARCH_COUNT_CAP)} is an EXACT total`, () => {
    const r = interpretCappedCount(items, SEARCH_COUNT_CAP);
    expect(r.total).toBe(SEARCH_COUNT_CAP);
    expect(r.estimated).toBe(false);
  });

  it(`${String(SEARCH_COUNT_CAP + 1)} (the cap was hit) → total null, estimated`, () => {
    const r = interpretCappedCount(items, SEARCH_COUNT_CAP + 1);
    expect(r.total).toBeNull();
    expect(r.estimated).toBe(true);
  });

  it('a count failure DEGRADES to null rather than failing the page', () => {
    const r = interpretCappedCount(items, null);
    expect(r.total).toBeNull();
    expect(r.estimated).toBe(true);
    expect(r.items).toEqual(items); // the page still serves
  });

  it('a small exact count passes through, and says the database answered', () => {
    const postgres = { engine: 'postgres', asOf: null };
    expect(interpretCappedCount(items, 0)).toEqual({
      items,
      total: 0,
      estimated: false,
      provenance: postgres,
    });
    expect(interpretCappedCount(items, 42)).toEqual({
      items,
      total: 42,
      estimated: false,
      provenance: postgres,
    });
    // A live page is dated by nothing: `asOf` is null, which is what the client
    // reads as "read live" rather than "as of a build".
    expect(interpretCappedCount(items, null).provenance).toEqual(postgres);
  });
});

describe('page window cap', () => {
  it('accepts a page at exactly the window limit', () => {
    const r = parseOffsetRequest(SEARCH_WINDOW_MAX / 100, 100, 'date_desc');
    expect(r.isOk()).toBe(true);
  });

  it('rejects page * pageSize beyond the window', () => {
    const r = parseOffsetRequest(SEARCH_WINDOW_MAX / 100 + 1, 100, undefined);
    expect(r.isErr()).toBe(true);
    if (r.isErr()) expect(r.error.type).toBe('InvalidInput');
  });

  it('rejects a pageSize over the max, a zero page, and a bad sort', () => {
    expect(parseOffsetRequest(1, 101, undefined).isErr()).toBe(true);
    expect(parseOffsetRequest(0, 20, undefined).isErr()).toBe(true);
    expect(parseOffsetRequest(1, 20, 'score_desc').isErr()).toBe(true);
  });

  it('makes an explicit default q-mode behave exactly like an absent one', () => {
    // Only `any` and `phrase` have no SQL expression. Treating the DEFAULT as
    // engine-only made the same request behave two ways depending on whether
    // the client sent the default explicitly: an implicit `q` on an unindexed
    // grain fell back to SQL while `qMode: all` failed outright.
    expect(usesEngineOnlyFilter({ q: 'spital' })).toBe(false);
    expect(usesEngineOnlyFilter({ q: 'spital', qMode: 'all' })).toBe(false);
    expect(usesEngineOnlyFilter({ q: 'spital', qMode: 'any' })).toBe(true);
    expect(usesEngineOnlyFilter({ q: 'spital', qMode: 'phrase' })).toBe(true);
  });

  // `relevance` parses (it is a real sort token); whether it can be SERVED
  // depends on the grain and the filter, which `parseOffsetRequest` cannot see.
  it('accepts relevance as a sort token but only serves it with a q on an indexed grain', () => {
    expect(parseOffsetRequest(1, 20, 'relevance').isOk()).toBe(true);
    expect(assertSortServeable('contracts', 'relevance', { q: 'spital' }).isOk()).toBe(true);
    // Nothing to rank against: every document ties at a constant score, so the
    // "ranking" would really be the pk tiebreak wearing a relevance label.
    expect(assertSortServeable('contracts', 'relevance', {}).isErr()).toBe(true);
    // SQL-only grain: no `_score` exists to order by.
    expect(assertSortServeable('modifications', 'relevance', { q: 'spital' }).isErr()).toBe(true);
    // Every other sort is serveable everywhere.
    expect(assertSortServeable('modifications', 'date_desc', {}).isOk()).toBe(true);
  });

  it('defaults to page 1 / date_desc', () => {
    const r = parseOffsetRequest(undefined, undefined, undefined);
    expect(r.isOk()).toBe(true);
    if (r.isOk()) {
      expect(r.value.page).toBe(1);
      expect(r.value.sort).toBe('date_desc');
      expect(offsetOf(r.value)).toBe(0);
    }
  });

  it('offset is (page - 1) * pageSize', () => {
    expect(offsetOf({ page: 3, pageSize: 25, sort: 'date_desc' })).toBe(50);
  });
});

describe('sort → column map (per grain) and the total order', () => {
  it('maps date/value sorts to each grain’s own columns', () => {
    expect(resolveSort('procedures', 'date_desc').column).toBe('publication_date');
    // Value sorts order by the RESOLVED comparable measure (value model).
    expect(resolveSort('procedures', 'value_asc').column).toBe('value_ron_comparable');
    expect(resolveSort('contracts', 'date_asc').column).toBe('contract_date');
    expect(resolveSort('contracts', 'value_desc').column).toBe('value_ron_comparable');
    // The DA date facet is named publicationDate but binds to the populated column.
    expect(resolveSort('direct_acquisitions', 'date_desc').column).toBe('finalization_date');
    expect(resolveSort('direct_acquisitions', 'value_desc').column).toBe('value_ron_comparable');
    expect(resolveSort('modifications', 'date_desc').column).toBe('modification_date');
    expect(resolveSort('modifications', 'value_desc').column).toBe('value_delta_ron');
  });

  it('maps direction from the token', () => {
    expect(resolveSort('contracts', 'date_desc').direction).toBe('desc');
    expect(resolveSort('contracts', 'date_asc').direction).toBe('asc');
    expect(resolveSort('contracts', 'value_asc').direction).toBe('asc');
  });

  it('always carries the surrogate PK as the tiebreak — pages must not shuffle', () => {
    expect(resolveSort('procedures', 'value_desc').pk).toBe('procedure_id');
    expect(resolveSort('contracts', 'date_asc').pk).toBe('contract_id');
    expect(resolveSort('direct_acquisitions', 'value_asc').pk).toBe('da_id');
    expect(resolveSort('modifications', 'date_desc').pk).toBe('modification_id');
  });
});

describe('filters SQL can serve without the search index', () => {
  const db = dummyDb;
  const sqlOf = (grain: SearchGrain, f: ProcurementSearchFilter) =>
    buildSearchConditions(grain, f)
      .map((c) => {
        const compiled = c.compile(db);
        return `${compiled.sql} ${JSON.stringify(compiled.parameters)}`;
      })
      .join(' ');

  it('filters BUYER territory through the analysis fact row', () => {
    // Not index-only: the fact row carries the buyer's resolved territory, so a
    // grain with no index still filters by it. Before this, the DA list dropped
    // territory and showed 1,736 records under a header counting 31.
    const sql = sqlOf('direct_acquisitions', { buyerGeo: { region: 'Sud-Est' } });
    expect(sql).toContain('analysis_facts_direct_acquisitions');
    expect(sql).toContain('buyer_region');
    expect(sql).toContain('Sud-Est');
  });

  it('filters a CPV mid-level as a left-anchored code range', () => {
    // A level is its canonical 8-digit code truncated to the level's length —
    // the same prefix the engine uses, and an index range in Postgres.
    expect(sqlOf('direct_acquisitions', { cpvGroup: '45200000' })).toContain('452%');
    // Finest wins, exactly as the engine resolves it.
    expect(sqlOf('contracts', { cpvGroup: '45200000', cpvCategory: '45233000' })).toContain(
      '45233%'
    );
  });

  it('resolves modification territory through the PARENT contract fact row', () => {
    // Modifications are the one grain with no fact row of their own — the
    // reason territory was missing. An amendment belongs to a contract
    // (99.93% carry `contract_id`), so it inherits the contract's buyer.
    const sql = sqlOf('modifications', { buyerGeo: { region: 'Sud-Est' } });
    expect(sql).toContain('analysis_facts_contracts');
    expect(sql).toContain('contract_id');
    expect(sql).toContain('buyer_region');
  });

  it('still has no CPV of its own on modifications', () => {
    expect(sqlOf('modifications', { cpvGroup: '45200000' })).not.toContain('452%');
  });

  it('leaves SUPPLIER territory to the engine — no fact table carries it', () => {
    expect(usesEngineOnlyFilter({ supplierGeo: { countyCode: 'SB' } })).toBe(true);
    expect(usesEngineOnlyFilter({ buyerGeo: { countyCode: 'SB' } })).toBe(false);
    expect(usesEngineOnlyFilter({ cpvGroup: '45200000' })).toBe(false);
  });
});

describe('q bounds and ILIKE escaping', () => {
  it('rejects under 3 and over 100 characters', () => {
    expect(parseQ('ab').isErr()).toBe(true);
    expect(parseQ('a'.repeat(101)).isErr()).toBe(true);
  });

  it('accepts the boundaries and trims', () => {
    expect(parseQ('abc')._unsafeUnwrap()).toBe('abc');
    expect(parseQ('a'.repeat(100))._unsafeUnwrap()).toHaveLength(100);
    expect(parseQ('  scoala  ')._unsafeUnwrap()).toBe('scoala');
  });

  it('undefined stays undefined (no filter)', () => {
    expect(parseQ(undefined)._unsafeUnwrap()).toBeUndefined();
  });

  it('escapes the LIKE metacharacters so a literal % or _ matches itself', () => {
    expect(escapeLikePattern('100%')).toBe('%100\\%%');
    expect(escapeLikePattern('a_b')).toBe('%a\\_b%');
    expect(escapeLikePattern('c\\d')).toBe('%c\\\\d%');
    expect(escapeLikePattern('plain')).toBe('%plain%');
  });
});

describe('what free text searches, per grain', () => {
  const sqlOf = (grain: SearchGrain, f: ProcurementSearchFilter) =>
    buildSearchConditions(grain, f)
      .map((c) => c.compile(dummyDb).sql)
      .join(' ');

  it('searches the modification DESCRIPTION — the grain has no title', () => {
    // `modification_type` is free text ("…s-a modificat taxa pe valoarea
    // adăugată (TVA) de la 19% la 21%"), not an enum. Searching only the two
    // numbers made the grain unsearchable: `tva` matched 14,322 rows in the
    // description and 1 in the numbers.
    const sql = sqlOf('modifications', { q: 'tva' });
    expect(sql).toContain('modification_type');
    expect(sql).toContain('contract_no');
  });

  it('searches party names everywhere the grain has them', () => {
    expect(sqlOf('contracts', { q: 'primaria' })).toContain('supplier_name');
    expect(sqlOf('direct_acquisitions', { q: 'primaria' })).toContain('authority_name');
    // A procedure predates its award, so there is no supplier column to search.
    const procedures = sqlOf('procedures', { q: 'primaria' });
    expect(procedures).toContain('authority_name');
    expect(procedures).not.toContain('supplier_name');
  });
});

describe('direct-acquisition offset selectivity matrix', () => {
  const check = (f: ProcurementSearchFilter): boolean =>
    assertDaOffsetSelective(f, DA_WINDOW_DAYS).isOk();

  it('QUALIFIES: an entity dimension', () => {
    expect(check({ authorityCui: '4267117' })).toBe(true);
    expect(check({ supplierCui: '11805367' })).toBe(true);
  });

  it('QUALIFIES: a fully-bounded date window within the cap', () => {
    expect(check({ dateRange: { gte: '2025-07-01', lte: '2026-06-30' } })).toBe(true);
  });

  it('REJECTS: cpvDivision alone (16.6s live — over the 15s statement timeout)', () => {
    expect(check({ cpvDivision: '33' })).toBe(false);
  });

  it('REJECTS: cpvCode alone, uniqueCode-style filters, and q alone', () => {
    expect(check({ cpvCode: '33600000' })).toBe(false);
    expect(check({ q: 'hartie' })).toBe(false);
  });

  it('REJECTS: an empty filter', () => {
    expect(check({})).toBe(false);
  });

  it('REJECTS: a half-open date range (no bound on one side)', () => {
    expect(check({ dateRange: { gte: '2020-01-01' } })).toBe(false);
    expect(check({ dateRange: { lte: '2026-01-01' } })).toBe(false);
  });

  it('REJECTS: a date window wider than the cap', () => {
    const r = assertDaOffsetSelective(
      { dateRange: { gte: '2015-01-01', lte: '2026-01-01' } },
      DA_WINDOW_DAYS
    );
    expect(r.isErr()).toBe(true);
    if (r.isErr()) expect(r.error.message).toContain('366 days');
  });

  it('REJECTS: an inverted date range', () => {
    expect(check({ dateRange: { gte: '2026-01-01', lte: '2025-01-01' } })).toBe(false);
  });

  it('CPV and q REFINE a qualifying filter', () => {
    expect(check({ authorityCui: '4267117', cpvDivision: '33', q: 'hartie' })).toBe(true);
  });

  it('an empty-string cui does not qualify', () => {
    expect(check({ authorityCui: '  ' })).toBe(false);
  });
});
