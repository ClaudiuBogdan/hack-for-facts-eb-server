import { describe, expect, it } from 'vitest';

import {
  dimensionCode,
  isTotalAlias,
  isoPeriodToken,
  memberCode,
  observationRef,
  parseDimensionCode,
  parseMemberCode,
  parseObservationRef,
  periodParts,
  periodTokenBounds,
} from '@/modules/ins-native/core/identity.js';

describe('ins-native identity contract', () => {
  it('dimension codes are D<dimIndex> and round-trip', () => {
    expect(dimensionCode(0)).toBe('D0');
    expect(parseDimensionCode('D3')).toBe(3);
    expect(parseDimensionCode(' D12 ')).toBe(12);
    expect(parseDimensionCode('SEX')).toBeNull();
    expect(parseDimensionCode('D')).toBeNull();
    expect(parseDimensionCode('d1')).toBeNull();
  });

  it('member codes are the TEMPO nomItemId; the legacy slugs are not member codes', () => {
    expect(memberCode(9685)).toBe('9685');
    expect(parseMemberCode('9685')).toBe(9685);
    expect(parseMemberCode('TOTAL')).toBeNull();
    expect(parseMemberCode('1634_ANI')).toBeNull();
    expect(parseMemberCode('-1')).toBeNull();
    expect(parseMemberCode('1.5')).toBeNull();
  });

  it('TOTAL is the only alias and is case-insensitive', () => {
    expect(isTotalAlias('TOTAL')).toBe(true);
    expect(isTotalAlias(' total ')).toBe(true);
    expect(isTotalAlias('TOTAL__1014_ANI')).toBe(false);
  });

  it('observation refs encode k slots and round-trip, including null slots inside k', () => {
    const coordinate = {
      datasetCode: 'POP107D',
      slots: [1, 105, 3075, 931, null, null, null],
      timeNomItemId: 4399,
      unitNomItemId: 9685,
    };
    const ref = observationRef(coordinate, 4);
    expect(ref).toBe('v1:POP107D:1:105:3075:931:4399:9685');
    expect(parseObservationRef(ref)).toEqual({
      datasetCode: 'POP107D',
      slots: [1, 105, 3075, 931],
      timeNomItemId: 4399,
      unitNomItemId: 9685,
    });
    const sparse = observationRef({ ...coordinate, slots: [7, null, 9] }, 3);
    expect(sparse).toBe('v1:POP107D:7::9:4399:9685');
    expect(parseObservationRef(sparse)?.slots).toEqual([7, null, 9]);
  });

  it('malformed observation refs are null, never a throw', () => {
    expect(parseObservationRef('')).toBeNull();
    expect(parseObservationRef('v0:POP107D:1:2:3')).toBeNull();
    expect(parseObservationRef('v1::1:2:3')).toBeNull();
    expect(parseObservationRef('v1:POP107D:x:2:3')).toBeNull();
    expect(parseObservationRef('v1:POP107D:1:2:z')).toBeNull();
  });

  it('period tokens map to inclusive bounds with the right periodicity', () => {
    expect(periodTokenBounds('2023')).toEqual({
      periodicity: 'ANNUAL',
      start: '2023-01-01',
      end: '2023-12-31',
    });
    expect(periodTokenBounds('2024-Q1')).toEqual({
      periodicity: 'QUARTERLY',
      start: '2024-01-01',
      end: '2024-03-31',
    });
    expect(periodTokenBounds('2024-Q4')).toEqual({
      periodicity: 'QUARTERLY',
      start: '2024-10-01',
      end: '2024-12-31',
    });
    expect(periodTokenBounds('2024-02')).toEqual({
      periodicity: 'MONTHLY',
      start: '2024-02-01',
      end: '2024-02-29',
    });
    expect(periodTokenBounds('2023-13')).toBeNull();
    expect(periodTokenBounds('23')).toBeNull();
  });

  it('iso period tokens and parts follow the legacy shape per periodicity', () => {
    expect(isoPeriodToken('ANNUAL', '2019-01-01')).toBe('2019');
    expect(isoPeriodToken('QUARTERLY', '2019-07-01')).toBe('2019-Q3');
    expect(isoPeriodToken('MONTHLY', '2019-11-01')).toBe('2019-11');
    expect(isoPeriodToken('OTHER', '2019-05-15')).toBe('2019-05-15');
    expect(periodParts('ANNUAL', '2019-01-01')).toEqual({ year: 2019, quarter: null, month: null });
    expect(periodParts('QUARTERLY', '2019-10-01')).toEqual({ year: 2019, quarter: 4, month: null });
    expect(periodParts('MONTHLY', '2019-11-01')).toEqual({ year: 2019, quarter: 4, month: 11 });
  });
});
