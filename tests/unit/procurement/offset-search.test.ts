/**
 * Offset-search core: the page-window cap, the capped-count boundary, the
 * sort→column map (incl. the total-order tiebreak), `q` bounds + ILIKE escaping,
 * and the direct-acquisition selectivity matrix. Pure — no DB, no mocking library.
 */

import { describe, expect, it } from 'vitest';

import { SEARCH_COUNT_CAP, SEARCH_WINDOW_MAX } from '@/modules/procurement/core/constants.js';
import {
  assertDaOffsetSelective,
  escapeLikePattern,
  interpretCappedCount,
  offsetOf,
  parseOffsetRequest,
  parseQ,
  resolveSort,
  type ProcurementSearchFilter,
} from '@/modules/procurement/core/search.js';

const DA_WINDOW_DAYS = 366;

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

  it('a small exact count passes through', () => {
    expect(interpretCappedCount(items, 0)).toEqual({ items, total: 0, estimated: false });
    expect(interpretCappedCount(items, 42)).toEqual({ items, total: 42, estimated: false });
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
    expect(parseOffsetRequest(1, 20, 'relevance').isErr()).toBe(true);
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
    expect(resolveSort('procedures', 'value_asc').column).toBe('awarded_value_ron');
    expect(resolveSort('contracts', 'date_asc').column).toBe('contract_date');
    expect(resolveSort('contracts', 'value_desc').column).toBe('value_ron');
    // The DA date facet is named publicationDate but binds to the populated column.
    expect(resolveSort('direct_acquisitions', 'date_desc').column).toBe('finalization_date');
    expect(resolveSort('direct_acquisitions', 'value_desc').column).toBe('value_ron');
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
