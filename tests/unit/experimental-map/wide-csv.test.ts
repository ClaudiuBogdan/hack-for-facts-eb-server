import { describe, expect, it } from 'vitest';

import { serializeWideMatrixCsv } from '@/modules/experimental-map/index.js';

describe('serializeWideMatrixCsv', () => {
  it('serializes null markers for missing values', () => {
    const csv = serializeWideMatrixCsv(
      ['s1', 's2'],
      [
        {
          sirutaCode: '1001',
          valuesBySeriesId: new Map([
            ['s1', 10],
            ['s2', undefined],
          ]),
        },
      ]
    );

    expect(csv).toBe('siruta_code,s1,s2\n1001,10,null');
  });

  it('escapes header and siruta values when CSV quoting is needed', () => {
    const csv = serializeWideMatrixCsv(
      ['series,1', 'series"2'],
      [
        {
          sirutaCode: '10,01',
          valuesBySeriesId: new Map([
            ['series,1', 1],
            ['series"2', 2],
          ]),
        },
      ]
    );

    expect(csv).toBe('siruta_code,"series,1","series""2"\n"10,01",1,2');
  });
});
