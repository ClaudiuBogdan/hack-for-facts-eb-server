/**
 * Procurement filter helpers (no live DB): the DA selective-filter guard, the
 * index-safe CPV-division range, the year→date-range expansion, the canonical
 * predicate, and the year+date-range conflict guard. These encode the §3a/§7
 * perf invariants, so they are pinned here.
 */

import { Kysely, PostgresDialect, type RawBuilder } from 'kysely';
import { describe, expect, it } from 'vitest';

import {
  assertNoYearDateConflict,
} from '@/modules/procurement/core/filters.js';
import {
  assertDaSelective,
  canonicalPredicate,
  cpvDivisionRange,
  yearDateRange,
} from '@/modules/procurement/shell/repo/filter-helpers.js';

import type { FilterInput } from '@/modules/shared/index.js';

// A pool-less Kysely instance just for compiling raw fragments (never executes).
const db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool: null as unknown as never }) });

/** Render a Kysely raw fragment to its parameterized SQL + params for assertions. */
const render = (cond: RawBuilder<unknown> | undefined): { sql: string; params: readonly unknown[] } | undefined => {
  if (cond === undefined) return undefined;
  const compiled = cond.compile(db);
  return { sql: compiled.sql, params: compiled.parameters };
};

describe('assertDaSelective (the 20M-row guard, §3a(1))', () => {
  const MAX = 366;
  it('rejects an empty filter', () => {
    expect(assertDaSelective({}, MAX).isErr()).toBe(true);
  });
  it('rejects a filter with only includeDuplicates', () => {
    expect(assertDaSelective({ includeDuplicates: { eq: true } }, MAX).isErr()).toBe(true);
  });
  it('rejects an explicit empty in:[] (the empty-array footgun)', () => {
    expect(assertDaSelective({ authorityCui: { in: [] } }, MAX).isErr()).toBe(true);
  });
  it('accepts authorityCui / supplierCui / cpvCode / cpvDivision / uniqueCode', () => {
    expect(assertDaSelective({ authorityCui: { in: ['4305857'] } }, MAX).isOk()).toBe(true);
    expect(assertDaSelective({ supplierCui: { eq: '123' } }, MAX).isOk()).toBe(true);
    expect(assertDaSelective({ cpvCode: { in: ['45000000'] } }, MAX).isOk()).toBe(true);
    expect(assertDaSelective({ cpvDivision: { in: ['45'] } }, MAX).isOk()).toBe(true);
    expect(assertDaSelective({ uniqueCode: { eq: 'ABC' } }, MAX).isOk()).toBe(true);
  });
  it('accepts a single year, rejects a 10-year window', () => {
    expect(assertDaSelective({ year: { eq: 2024 } }, MAX).isOk()).toBe(true);
    expect(assertDaSelective({ year: { between: { from: 2015, to: 2025 } } }, MAX).isErr()).toBe(true);
  });
  it('accepts a bounded finalizationDate window, rejects an over-wide one', () => {
    expect(assertDaSelective({ finalizationDate: { between: { from: '2024-01-01', to: '2024-06-01' } } }, MAX).isOk()).toBe(true);
    const wide = assertDaSelective({ finalizationDate: { between: { from: '2010-01-01', to: '2025-01-01' } } }, MAX);
    expect(wide.isErr()).toBe(true);
  });
});

describe('cpvDivisionRange (index-safe; NOT substring, §7.1 I7)', () => {
  it('compiles a 2-digit division to a half-open range on cpv_code', () => {
    const r = cpvDivisionRange({ cpvDivision: { in: ['45'] } }, 'd');
    expect(r.isOk()).toBe(true);
    const rendered = render(r._unsafeUnwrap());
    expect(rendered?.sql).toContain('>=');
    expect(rendered?.sql).toContain('<');
    expect(rendered?.sql.toLowerCase()).not.toContain('substring');
    expect(rendered?.params).toContain('45000000');
    expect(rendered?.params).toContain('46000000');
  });
  it('handles division 99 with an all-9s ceiling', () => {
    const r = cpvDivisionRange({ cpvDivision: { in: ['99'] } }, 'd');
    expect(render(r._unsafeUnwrap())?.params).toContain('99999999');
  });
  it('rejects a non-2-digit division', () => {
    expect(cpvDivisionRange({ cpvDivision: { in: ['4'] } }, 'd').isErr()).toBe(true);
    expect(cpvDivisionRange({ cpvDivision: { in: ['450'] } }, 'd').isErr()).toBe(true);
  });
  it('returns undefined when no cpvDivision present', () => {
    expect(cpvDivisionRange({}, 'd')._unsafeUnwrap()).toBeUndefined();
  });
  it('explicit empty in:[] → FALSE (match nothing, not a no-op)', () => {
    const r = cpvDivisionRange({ cpvDivision: { in: [] } }, 'd');
    expect(render(r._unsafeUnwrap())?.sql.toLowerCase()).toContain('false');
  });
});

describe('yearDateRange (year → indexed date range)', () => {
  it('expands year eq to [yyyy-01-01, (yyyy+1)-01-01)', () => {
    const r = yearDateRange({ year: { eq: 2024 } }, 'd', 'finalization_date');
    const rendered = render(r._unsafeUnwrap());
    expect(rendered?.params).toContain('2024-01-01');
    expect(rendered?.params).toContain('2025-01-01');
  });
  it('expands in[2022,2024] to an OR of EXACT per-year ranges (NOT a 2022-2024 span)', () => {
    const r = yearDateRange({ year: { in: [2022, 2024] } }, 'd', 'finalization_date');
    const rendered = render(r._unsafeUnwrap());
    // Both 2022 and 2024 year boundaries present; the 2023 floor would only appear
    // if it were a broad span (it must NOT include 2023 as a separate range start).
    expect(rendered?.sql.toLowerCase()).toContain(' or ');
    expect(rendered?.params).toContain('2022-01-01');
    expect(rendered?.params).toContain('2023-01-01'); // = exclusive upper bound of 2022
    expect(rendered?.params).toContain('2024-01-01'); // = lower bound of 2024
    expect(rendered?.params).toContain('2025-01-01'); // = exclusive upper bound of 2024
    expect(rendered?.params).not.toContain('2023-12-31');
  });
});

describe('canonicalPredicate', () => {
  it('forces is_canonical=true by default', () => {
    const c = canonicalPredicate({}, 'd');
    expect(render(c)?.sql).toContain('is_canonical');
  });
  it('omits the predicate when includeDuplicates=true', () => {
    expect(canonicalPredicate({ includeDuplicates: { eq: true } }, 'd')).toBeUndefined();
  });
});

describe('assertNoYearDateConflict', () => {
  const f = (x: FilterInput): FilterInput => x;
  it('rejects year + the matching date range together', () => {
    expect(assertNoYearDateConflict(f({ year: { eq: 2024 }, finalizationDate: { between: {} } }), 'finalizationDate').ok).toBe(false);
  });
  it('allows year alone or date alone', () => {
    expect(assertNoYearDateConflict(f({ year: { eq: 2024 } }), 'finalizationDate').ok).toBe(true);
    expect(assertNoYearDateConflict(f({ finalizationDate: { between: {} } }), 'finalizationDate').ok).toBe(true);
  });
});
