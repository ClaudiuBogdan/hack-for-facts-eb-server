/**
 * GraphQL arg translation: the spec's operator inputs (`{ eq }`, `{ in }`,
 * `{ contains }`, `{ gte, lte }`) → the core filter / scope objects. A malformed
 * operator must be an InvalidInput, never a silently dropped predicate.
 */

import { describe, expect, it } from 'vitest';

import {
  translateAnalysisScope,
  translateSearchFilter,
} from '@/modules/procurement/shell/graphql/arg-translation.js';

describe('translateSearchFilter', () => {
  it('an absent or null filter is the empty filter', () => {
    expect(translateSearchFilter(undefined, 'contractDate')._unsafeUnwrap()).toEqual({});
    expect(translateSearchFilter(null, 'contractDate')._unsafeUnwrap()).toEqual({});
  });

  it('lowers every operator shape the client sends', () => {
    const f = translateSearchFilter(
      {
        q: { contains: 'scoala' },
        authorityCui: { eq: 'RO 4267117' },
        supplierCui: { eq: '11805367' },
        cpvDivision: { eq: '33' },
        sourceSystem: { in: ['seap_contracts'] },
        status: { in: ['awarded', 'closed'] },
        contractDate: { gte: '2024-01-01', lte: '2024-12-31' },
        valueRon: { gte: '1000.00', lte: '5000.50' },
      },
      'contractDate'
    )._unsafeUnwrap();

    expect(f.q).toBe('scoala');
    // CUIs are normalized so a base-table filter matches the rows the aggregates find.
    expect(f.authorityCui).toBe('4267117');
    expect(f.supplierCui).toBe('11805367');
    expect(f.cpvDivision).toBe('33');
    expect(f.sourceSystem).toEqual(['seap_contracts']);
    expect(f.status).toEqual(['awarded', 'closed']);
    expect(f.dateRange).toEqual({ gte: '2024-01-01', lte: '2024-12-31' });
    expect(f.valueRon).toEqual({ gte: '1000.00', lte: '5000.50' });
  });

  it('reads the date facet the grain declares, and ignores the others', () => {
    const f = translateSearchFilter(
      { publicationDate: { gte: '2024-01-01' } },
      'publicationDate'
    )._unsafeUnwrap();
    expect(f.dateRange).toEqual({ gte: '2024-01-01' });
    const g = translateSearchFilter(
      { publicationDate: { gte: '2024-01-01' } },
      'contractDate'
    )._unsafeUnwrap();
    expect(g.dateRange).toBeUndefined();
  });

  it('preserves an EXPLICIT empty in:[] (match nothing), never widening the query', () => {
    const f = translateSearchFilter({ status: { in: [] } }, 'contractDate')._unsafeUnwrap();
    expect(f.status).toEqual([]);
  });

  it('rejects a q outside the 3–100 char bounds', () => {
    expect(translateSearchFilter({ q: { contains: 'ab' } }, 'contractDate').isErr()).toBe(true);
  });

  it('rejects a non-date range bound', () => {
    const r = translateSearchFilter({ contractDate: { gte: '2024-1-1' } }, 'contractDate');
    expect(r.isErr()).toBe(true);
    if (r.isErr()) expect(r.error.type).toBe('InvalidInput');
  });

  it('rejects an inverted date range', () => {
    expect(
      translateSearchFilter(
        { contractDate: { gte: '2025-01-01', lte: '2024-01-01' } },
        'contractDate'
      ).isErr()
    ).toBe(true);
  });

  it('rejects a money bound that is not a decimal string (no floats on the wire)', () => {
    expect(translateSearchFilter({ valueRon: { gte: 1000 } }, 'contractDate').isErr()).toBe(true);
    expect(translateSearchFilter({ valueRon: { gte: '1e5' } }, 'contractDate').isErr()).toBe(true);
    expect(translateSearchFilter({ valueRon: { gte: '-5.25' } }, 'contractDate').isOk()).toBe(true);
  });

  it('rejects a malformed cpvDivision / cpvCode', () => {
    expect(translateSearchFilter({ cpvDivision: { eq: '3' } }, 'contractDate').isErr()).toBe(true);
    expect(translateSearchFilter({ cpvDivision: { eq: 'ab' } }, 'contractDate').isErr()).toBe(true);
    expect(translateSearchFilter({ cpvCode: { eq: '336000001' } }, 'contractDate').isErr()).toBe(
      true
    );
    expect(translateSearchFilter({ cpvCode: { eq: '33600000' } }, 'contractDate').isOk()).toBe(
      true
    );
  });

  it('rejects an invalid CUI rather than passing it through', () => {
    expect(
      translateSearchFilter({ authorityCui: { eq: 'not-a-cui' } }, 'contractDate').isErr()
    ).toBe(true);
  });

  it('carries the modifications-only facets', () => {
    const f = translateSearchFilter(
      { linked: false, minDeltaPct: 0.25 },
      'modificationDate'
    )._unsafeUnwrap();
    expect(f.linked).toBe(false);
    expect(f.minDeltaPct).toBe(0.25);
  });

  it('rejects a non-boolean linked and a non-finite minDeltaPct', () => {
    expect(translateSearchFilter({ linked: 'yes' }, 'modificationDate').isErr()).toBe(true);
    expect(translateSearchFilter({ minDeltaPct: Number.NaN }, 'modificationDate').isErr()).toBe(
      true
    );
  });
});

describe('translateAnalysisScope (delegates to core parseAnalysisScope)', () => {
  it('an absent scope is platform-wide', () => {
    expect(translateAnalysisScope(undefined)._unsafeUnwrap()).toEqual({});
    expect(translateAnalysisScope(null)._unsafeUnwrap()).toEqual({});
  });

  it('normalizes CUIs and passes the CPV division + month window', () => {
    const s = translateAnalysisScope({
      authorityCui: 'RO4267117',
      supplierCui: '11805367',
      cpvDivision: '33',
      from: '2024-01',
      to: '2024-12',
    })._unsafeUnwrap();
    expect(s).toEqual({
      authorityCui: '4267117',
      supplierCui: '11805367',
      cpvDivision: '33',
      from: '2024-01',
      to: '2024-12',
    });
  });

  it('rejects a month that is not YYYY-MM (the rollups are monthly)', () => {
    expect(translateAnalysisScope({ from: '2024-01-01' }).isErr()).toBe(true);
    expect(translateAnalysisScope({ to: '2024' }).isErr()).toBe(true);
  });

  it('rejects an inverted month window, and year XOR from/to', () => {
    expect(translateAnalysisScope({ from: '2025-01', to: '2024-01' }).isErr()).toBe(true);
    expect(translateAnalysisScope({ year: 2024, from: '2024-01' }).isErr()).toBe(true);
  });

  it('rejects a malformed division and a division×code combination', () => {
    expect(translateAnalysisScope({ cpvDivision: '333' }).isErr()).toBe(true);
    expect(translateAnalysisScope({ cpvDivision: '33', cpvCode: '33600000' }).isErr()).toBe(true);
    expect(translateAnalysisScope({ cpvCode: '33600000' })._unsafeUnwrap().cpvCode).toBe(
      '33600000'
    );
  });

  it('rejects an invalid CUI and an unknown grain', () => {
    expect(translateAnalysisScope({ supplierCui: 'zzz' }).isErr()).toBe(true);
    expect(translateAnalysisScope({ grain: 'purchases' }).isErr()).toBe(true);
  });
});
