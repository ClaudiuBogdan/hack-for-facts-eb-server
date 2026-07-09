/**
 * Budget funding-source id translation (A1). The load-bearing checks:
 *  - the in-process map reproduces the phoenix convention from prod's arbitrary
 *    stored identity ids, both directions (public⇄stored), over the 10 real codes
 *    inserted in prod's ACTUAL arrival order + the 0=Unknown row;
 *  - `toPublicId` on a fact row's stored id yields the CONVENTIONAL id;
 *  - `translateFundingSourceIds` rewrites a PUBLIC `fundingSourceIds` filter to the
 *    stored column values, mapping unknown public ids to the no-match sentinel.
 */

import { describe, expect, it } from 'vitest';

import {
  FUNDING_SOURCE_NO_MATCH,
  normalizeFundingSourceCodes,
  translateFundingSourceIds,
} from '@/modules/budget/shell/repo/filter-helpers.js';
import {
  buildFundingSourceMap,
  type FundingSourceCompatRow,
} from '@/modules/budget/shell/repo/funding-source-map.js';

// The rows exactly as `budget.v_funding_sources_compat` returns them for prod's
// real arrival order (stored 1=A, 2=D, 3=J, 4=E, 5=H, 6=F, 7=B, 8=I, 9=G, 10=C):
// public source_id = the A..J ordinal; internal_source_id = the stored id.
const COMPAT_ROWS: readonly FundingSourceCompatRow[] = [
  { sourceId: 0, sourceCode: null, sourceDescription: 'Unknown', internalSourceId: 0 },
  { sourceId: 1, sourceCode: 'A', sourceDescription: 'Integral de la buget', internalSourceId: 1 },
  { sourceId: 2, sourceCode: 'B', sourceDescription: 'Credite externe', internalSourceId: 7 },
  { sourceId: 3, sourceCode: 'C', sourceDescription: 'Credite interne', internalSourceId: 10 },
  {
    sourceId: 4,
    sourceCode: 'D',
    sourceDescription: 'Fonduri externe nerambursabile',
    internalSourceId: 2,
  },
  {
    sourceId: 5,
    sourceCode: 'E',
    sourceDescription: 'Activitati finantate integral din venituri proprii',
    internalSourceId: 4,
  },
  {
    sourceId: 6,
    sourceCode: 'F',
    sourceDescription: 'Integral venituri proprii',
    internalSourceId: 6,
  },
  {
    sourceId: 7,
    sourceCode: 'G',
    sourceDescription: 'Venituri proprii si subventii',
    internalSourceId: 9,
  },
  {
    sourceId: 8,
    sourceCode: 'H',
    sourceDescription: 'Buget aferent activitatii din privatizare',
    internalSourceId: 5,
  },
  {
    sourceId: 9,
    sourceCode: 'I',
    sourceDescription: 'Bugetul Fondului pentru Mediu',
    internalSourceId: 8,
  },
  {
    sourceId: 10,
    sourceCode: 'J',
    sourceDescription: 'Bugetul Trezoreriei Statului',
    internalSourceId: 3,
  },
];

describe('funding-source translation map (A1)', () => {
  const map = buildFundingSourceMap(COMPAT_ROWS);

  it('toPublicId: stored fact id → conventional (phoenix) id', () => {
    // stored 7 = code B → public 2; stored 3 = code J → public 10; stored 1 = A → 1.
    expect(map.toPublicId(7)).toBe(2);
    expect(map.toPublicId(3)).toBe(10);
    expect(map.toPublicId(1)).toBe(1);
    expect(map.toPublicId(0)).toBe(0); // unresolved → Unknown
  });

  it('toStoredId: public (phoenix) id → stored column value', () => {
    // public 2 (B) → stored 7; public 10 (J) → stored 3; public 1 (A) → 1.
    expect(map.toStoredId(2)).toBe(7);
    expect(map.toStoredId(10)).toBe(3);
    expect(map.toStoredId(1)).toBe(1);
    expect(map.toStoredId(0)).toBe(0);
  });

  it('unknown public id → undefined (no stored counterpart)', () => {
    expect(map.toStoredId(999)).toBeUndefined();
  });

  it('round-trips every real code (public → stored → public)', () => {
    for (const r of COMPAT_ROWS) {
      const stored = map.toStoredId(r.sourceId);
      expect(stored).toBe(r.internalSourceId);
      expect(map.toPublicId(stored!)).toBe(r.sourceId);
    }
  });
});

describe('translateFundingSourceIds (PUBLIC filter → stored column values)', () => {
  const map = buildFundingSourceMap(COMPAT_ROWS);

  it('rewrites an `in` list from public to stored, preserving other fields', () => {
    const out = translateFundingSourceIds(
      { reportingYear: { eq: 2024 }, fundingSourceIds: { in: [2, 10, 1] } },
      map.toStoredId
    );
    expect(out['fundingSourceIds']).toEqual({ in: [7, 3, 1] });
    expect(out['reportingYear']).toEqual({ eq: 2024 }); // untouched
  });

  it('rewrites an `eq` value from public to stored', () => {
    const out = translateFundingSourceIds({ fundingSourceIds: { eq: 10 } }, map.toStoredId);
    expect(out['fundingSourceIds']).toEqual({ eq: 3 });
  });

  it('maps unknown public ids to the no-match sentinel (empty-set semantics)', () => {
    const out = translateFundingSourceIds({ fundingSourceIds: { in: [2, 999] } }, map.toStoredId);
    expect(out['fundingSourceIds']).toEqual({ in: [7, FUNDING_SOURCE_NO_MATCH] });
    const solo = translateFundingSourceIds({ fundingSourceIds: { eq: 999 } }, map.toStoredId);
    expect(solo['fundingSourceIds']).toEqual({ eq: FUNDING_SOURCE_NO_MATCH });
  });

  it('is a no-op when the field is absent', () => {
    const input = { reportingYear: { eq: 2024 } };
    expect(translateFundingSourceIds(input, map.toStoredId)).toBe(input);
  });
});

describe('normalizeFundingSourceCodes (case-fold so cursor-fhash matches SQL)', () => {
  it('uppercases `in` codes (the fhash lowercases; SQL is case-sensitive)', () => {
    const out = normalizeFundingSourceCodes({ fundingSourceCodes: { in: ['b', 'J', 'c'] } });
    expect(out['fundingSourceCodes']).toEqual({ in: ['B', 'J', 'C'] });
  });

  it('uppercases an `eq` code', () => {
    expect(
      normalizeFundingSourceCodes({ fundingSourceCodes: { eq: 'a' } })['fundingSourceCodes']
    ).toEqual({ eq: 'A' });
  });

  it('is a no-op when the field is absent', () => {
    const input = { reportingYear: { eq: 2024 } };
    expect(normalizeFundingSourceCodes(input)).toBe(input);
  });
});
