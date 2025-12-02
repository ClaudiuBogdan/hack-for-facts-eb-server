import { Decimal } from 'decimal.js';
import { describe, it, expect } from 'vitest';

import { applyInflation, normalizeData } from '@/common/modules/normalization/core/logic.js';
import {
  DataPoint,
  NormalizationFactors,
  TransformationOptions,
} from '@/common/modules/normalization/core/types.js';

describe('Normalization Logic', () => {
  const factors: NormalizationFactors = {
    cpi: new Map([
      [2023, new Decimal(1.1)],
      [2024, new Decimal(1.0)],
    ]), // 2023 inflation factor 1.1 means 100 RON 2023 = 110 RON 2024
    eur: new Map([
      [2023, new Decimal(5.0)],
      [2024, new Decimal(5.0)],
    ]),
    usd: new Map(),
    gdp: new Map([[2023, new Decimal(1000)]]),
    population: new Map([[2023, new Decimal(10)]]),
  };

  it('should apply inflation', () => {
    const data: DataPoint[] = [
      { x: '2023', year: 2023, y: new Decimal(100) },
      { x: '2024', year: 2024, y: new Decimal(100) },
    ];
    const result = applyInflation(data, factors.cpi);

    expect(result[0]!.y.toNumber()).toBe(110); // 100 * 1.1
    expect(result[1]!.y.toNumber()).toBe(100); // 100 * 1.0
  });

  it('should normalize total with inflation and currency', () => {
    const data: DataPoint[] = [{ x: '2023', year: 2023, y: new Decimal(100) }];
    const options: TransformationOptions = {
      normalization: 'total',
      currency: 'EUR',
      inflationAdjusted: true,
    };

    const result = normalizeData(data, options, factors);
    // 100 * 1.1 (CPI) = 110 RON (Real)
    // 110 / 5.0 (EUR) = 22 EUR
    expect(result[0]!.y.toNumber()).toBe(22);
  });

  it('should normalize percent gdp', () => {
    const data: DataPoint[] = [{ x: '2023', year: 2023, y: new Decimal(50) }];
    const options: TransformationOptions = {
      normalization: 'percent_gdp',
      currency: 'RON', // Ignored
      inflationAdjusted: true, // Ignored
    };

    const result = normalizeData(data, options, factors);
    // 50 / 1000 (GDP) * 100 = 5%
    expect(result[0]!.y.toNumber()).toBe(5);
  });
});
