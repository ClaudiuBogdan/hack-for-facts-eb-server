import { Decimal } from 'decimal.js';
import { describe, it, expect } from 'vitest';

import {
  applyInflation,
  applyCurrency,
  applyPerCapita,
  applyPercentGDP,
  applyGrowth,
  normalizeData,
} from '@/modules/normalization/core/logic.js';

import type {
  DataPoint,
  NormalizationFactors,
  TransformationOptions,
} from '@/modules/normalization/core/types.js';

describe('Normalization Logic', () => {
  // String-keyed factor maps (new format)
  const factors: NormalizationFactors = {
    cpi: new Map([
      ['2023', new Decimal('1.1')],
      ['2024', new Decimal('1.0')],
    ]), // 2023 inflation factor 1.1 means 100 RON 2023 = 110 RON 2024
    eur: new Map([
      ['2023', new Decimal('5.0')],
      ['2024', new Decimal('5.0')],
    ]),
    usd: new Map([
      ['2023', new Decimal('4.5')],
      ['2024', new Decimal('4.6')],
    ]),
    gdp: new Map([
      ['2023', new Decimal('1000')],
      ['2024', new Decimal('1100')],
    ]),
    population: new Map([
      ['2023', new Decimal('10')],
      ['2024', new Decimal('10')],
    ]),
  };

  describe('applyInflation', () => {
    it('should multiply values by CPI factors', () => {
      const data: DataPoint[] = [
        { x: '2023', year: 2023, y: new Decimal(100) },
        { x: '2024', year: 2024, y: new Decimal(100) },
      ];
      const result = applyInflation(data, factors.cpi);

      expect(result[0]!.y.toNumber()).toBe(110); // 100 * 1.1
      expect(result[1]!.y.toNumber()).toBe(100); // 100 * 1.0
    });

    it('should use default factor (1.0) for missing periods', () => {
      const data: DataPoint[] = [{ x: '2025', year: 2025, y: new Decimal(100) }];
      const result = applyInflation(data, factors.cpi);

      expect(result[0]!.y.toNumber()).toBe(100); // 100 * 1.0 (default)
    });

    it('should handle empty data', () => {
      const result = applyInflation([], factors.cpi);
      expect(result).toHaveLength(0);
    });
  });

  describe('applyCurrency', () => {
    it('should return data unchanged for RON currency', () => {
      const data: DataPoint[] = [{ x: '2023', year: 2023, y: new Decimal(100) }];
      const result = applyCurrency(data, 'RON', factors);

      expect(result[0]!.y.toNumber()).toBe(100);
    });

    it('should divide by EUR exchange rate', () => {
      const data: DataPoint[] = [{ x: '2023', year: 2023, y: new Decimal(100) }];
      const result = applyCurrency(data, 'EUR', factors);

      expect(result[0]!.y.toNumber()).toBe(20); // 100 / 5.0
    });

    it('should divide by USD exchange rate', () => {
      const data: DataPoint[] = [{ x: '2023', year: 2023, y: new Decimal(90) }];
      const result = applyCurrency(data, 'USD', factors);

      expect(result[0]!.y.toNumber()).toBe(20); // 90 / 4.5
    });

    it('should handle zero exchange rate gracefully', () => {
      const factorsWithZeroRate: NormalizationFactors = {
        ...factors,
        eur: new Map([['2023', new Decimal('0')]]),
      };
      const data: DataPoint[] = [{ x: '2023', year: 2023, y: new Decimal(100) }];
      const result = applyCurrency(data, 'EUR', factorsWithZeroRate);

      // Should return unchanged value when rate is zero
      expect(result[0]!.y.toNumber()).toBe(100);
    });
  });

  describe('applyPerCapita', () => {
    it('should divide values by population', () => {
      const data: DataPoint[] = [{ x: '2023', year: 2023, y: new Decimal(1000) }];
      const result = applyPerCapita(data, factors.population);

      expect(result[0]!.y.toNumber()).toBe(100); // 1000 / 10
    });

    it('should handle missing population gracefully', () => {
      const data: DataPoint[] = [{ x: '2025', year: 2025, y: new Decimal(1000) }];
      const result = applyPerCapita(data, factors.population);

      // Returns unchanged when population not found
      expect(result[0]!.y.toNumber()).toBe(1000);
    });

    it('should handle zero population gracefully', () => {
      const zeroPop = new Map([['2023', new Decimal('0')]]);
      const data: DataPoint[] = [{ x: '2023', year: 2023, y: new Decimal(1000) }];
      const result = applyPerCapita(data, zeroPop);

      expect(result[0]!.y.toNumber()).toBe(1000); // unchanged
    });
  });

  describe('applyPercentGDP', () => {
    it('should calculate percentage of GDP', () => {
      const data: DataPoint[] = [{ x: '2023', year: 2023, y: new Decimal(50) }];
      const result = applyPercentGDP(data, factors.gdp);

      // 50 / 1000 * 100 = 5%
      expect(result[0]!.y.toNumber()).toBe(5);
    });

    it('should handle missing GDP by returning 0', () => {
      const data: DataPoint[] = [{ x: '2025', year: 2025, y: new Decimal(50) }];
      const result = applyPercentGDP(data, factors.gdp);

      expect(result[0]!.y.toNumber()).toBe(0);
    });

    it('should handle zero GDP by returning 0', () => {
      const zeroGdp = new Map([['2023', new Decimal('0')]]);
      const data: DataPoint[] = [{ x: '2023', year: 2023, y: new Decimal(50) }];
      const result = applyPercentGDP(data, zeroGdp);

      expect(result[0]!.y.toNumber()).toBe(0);
    });

    it('should handle small percentages accurately', () => {
      const data: DataPoint[] = [{ x: '2023', year: 2023, y: new Decimal(1) }];
      const result = applyPercentGDP(data, factors.gdp);

      // 1 / 1000 * 100 = 0.1%
      expect(result[0]!.y.toNumber()).toBe(0.1);
    });
  });

  describe('applyGrowth', () => {
    it('should calculate period-over-period growth', () => {
      const data: DataPoint[] = [
        { x: '2023', year: 2023, y: new Decimal(100) },
        { x: '2024', year: 2024, y: new Decimal(110) },
      ];
      const result = applyGrowth(data);

      expect(result[0]!.y.toNumber()).toBe(0); // First period has no growth
      expect(result[1]!.y.toNumber()).toBe(10); // (110-100)/100 * 100 = 10%
    });

    it('should handle negative growth', () => {
      const data: DataPoint[] = [
        { x: '2023', year: 2023, y: new Decimal(100) },
        { x: '2024', year: 2024, y: new Decimal(80) },
      ];
      const result = applyGrowth(data);

      expect(result[1]!.y.toNumber()).toBe(-20); // (80-100)/100 * 100 = -20%
    });

    it('should handle zero previous value', () => {
      const data: DataPoint[] = [
        { x: '2023', year: 2023, y: new Decimal(0) },
        { x: '2024', year: 2024, y: new Decimal(100) },
      ];
      const result = applyGrowth(data);

      // When previous is zero, growth is 0 (avoid division by zero)
      expect(result[1]!.y.toNumber()).toBe(0);
    });

    it('should handle single data point', () => {
      const data: DataPoint[] = [{ x: '2023', year: 2023, y: new Decimal(100) }];
      const result = applyGrowth(data);

      expect(result).toHaveLength(1);
      expect(result[0]!.y.toNumber()).toBe(0);
    });

    it('should handle multiple periods correctly', () => {
      const data: DataPoint[] = [
        { x: '2021', year: 2021, y: new Decimal(100) },
        { x: '2022', year: 2022, y: new Decimal(120) },
        { x: '2023', year: 2023, y: new Decimal(150) },
        { x: '2024', year: 2024, y: new Decimal(150) },
      ];
      const result = applyGrowth(data);

      expect(result[0]!.y.toNumber()).toBe(0); // First: 0
      expect(result[1]!.y.toNumber()).toBe(20); // (120-100)/100 * 100 = 20%
      expect(result[2]!.y.toNumber()).toBe(25); // (150-120)/120 * 100 = 25%
      expect(result[3]!.y.toNumber()).toBe(0); // (150-150)/150 * 100 = 0%
    });
  });

  describe('normalizeData - Full Pipeline', () => {
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

    it('should normalize percent gdp (ignores inflation and currency)', () => {
      const data: DataPoint[] = [{ x: '2023', year: 2023, y: new Decimal(50) }];
      const options: TransformationOptions = {
        normalization: 'percent_gdp',
        currency: 'EUR', // Should be ignored
        inflationAdjusted: true, // Should be ignored
      };

      const result = normalizeData(data, options, factors);
      // 50 / 1000 (GDP) * 100 = 5%
      expect(result[0]!.y.toNumber()).toBe(5);
    });

    it('should normalize per capita with inflation', () => {
      const data: DataPoint[] = [{ x: '2023', year: 2023, y: new Decimal(1000) }];
      const options: TransformationOptions = {
        normalization: 'per_capita',
        currency: 'RON',
        inflationAdjusted: true,
      };

      const result = normalizeData(data, options, factors);
      // 1000 * 1.1 (CPI) = 1100 RON (Real)
      // 1100 / 10 (population) = 110 per capita
      expect(result[0]!.y.toNumber()).toBe(110);
    });

    it('should normalize per capita with currency conversion', () => {
      const data: DataPoint[] = [{ x: '2023', year: 2023, y: new Decimal(1000) }];
      const options: TransformationOptions = {
        normalization: 'per_capita',
        currency: 'EUR',
        inflationAdjusted: false,
      };

      const result = normalizeData(data, options, factors);
      // 1000 / 5.0 (EUR) = 200 EUR
      // 200 / 10 (population) = 20 EUR per capita
      expect(result[0]!.y.toNumber()).toBe(20);
    });

    it('should apply growth calculation after normalization', () => {
      const data: DataPoint[] = [
        { x: '2023', year: 2023, y: new Decimal(100) },
        { x: '2024', year: 2024, y: new Decimal(110) },
      ];
      const options: TransformationOptions = {
        normalization: 'total',
        currency: 'RON',
        inflationAdjusted: false,
        showPeriodGrowth: true,
      };

      const result = normalizeData(data, options, factors);
      expect(result[0]!.y.toNumber()).toBe(0); // First period
      expect(result[1]!.y.toNumber()).toBe(10); // 10% growth
    });

    it('should handle total normalization without inflation', () => {
      const data: DataPoint[] = [{ x: '2023', year: 2023, y: new Decimal(100) }];
      const options: TransformationOptions = {
        normalization: 'total',
        currency: 'RON',
        inflationAdjusted: false,
      };

      const result = normalizeData(data, options, factors);
      expect(result[0]!.y.toNumber()).toBe(100); // unchanged
    });

    it('should handle combined inflation, currency, per_capita, and growth', () => {
      const data: DataPoint[] = [
        { x: '2023', year: 2023, y: new Decimal(1000) },
        { x: '2024', year: 2024, y: new Decimal(1200) },
      ];
      const options: TransformationOptions = {
        normalization: 'per_capita',
        currency: 'EUR',
        inflationAdjusted: true,
        showPeriodGrowth: true,
      };

      const result = normalizeData(data, options, factors);
      // 2023: 1000 * 1.1 (CPI) = 1100 / 5.0 (EUR) = 220 / 10 (pop) = 22
      // 2024: 1200 * 1.0 (CPI) = 1200 / 5.0 (EUR) = 240 / 10 (pop) = 24
      // Growth: (24-22)/22 * 100 ≈ 9.09%

      expect(result[0]!.y.toNumber()).toBe(0); // First period growth = 0
      expect(result[1]!.y.toNumber()).toBeCloseTo(9.09, 1);
    });
  });

  describe('normalizeData - Monthly Data', () => {
    const monthlyFactors: NormalizationFactors = {
      cpi: new Map([
        ['2023-01', new Decimal('1.12')],
        ['2023-02', new Decimal('1.11')],
        ['2023-03', new Decimal('1.10')],
      ]),
      eur: new Map([
        ['2023-01', new Decimal('4.9')],
        ['2023-02', new Decimal('5.0')],
        ['2023-03', new Decimal('5.1')],
      ]),
      usd: new Map(),
      gdp: new Map([['2023', new Decimal('1000')]]), // GDP is yearly even for monthly data
      population: new Map([['2023', new Decimal('10')]]),
    };

    it('should apply monthly CPI factors', () => {
      const data: DataPoint[] = [
        { x: '2023-01', year: 2023, y: new Decimal(100) },
        { x: '2023-02', year: 2023, y: new Decimal(100) },
        { x: '2023-03', year: 2023, y: new Decimal(100) },
      ];
      const result = applyInflation(data, monthlyFactors.cpi);

      expect(result[0]!.y.toNumber()).toBe(112); // 100 * 1.12
      expect(result[1]!.y.toNumber()).toBe(111); // 100 * 1.11
      expect(result[2]!.y.toNumber()).toBe(110); // 100 * 1.10
    });

    it('should apply monthly exchange rates', () => {
      const data: DataPoint[] = [
        { x: '2023-01', year: 2023, y: new Decimal(49) },
        { x: '2023-02', year: 2023, y: new Decimal(50) },
        { x: '2023-03', year: 2023, y: new Decimal(51) },
      ];
      const result = applyCurrency(data, 'EUR', monthlyFactors);

      expect(result[0]!.y.toNumber()).toBe(10); // 49 / 4.9
      expect(result[1]!.y.toNumber()).toBe(10); // 50 / 5.0
      expect(result[2]!.y.toNumber()).toBe(10); // 51 / 5.1
    });
  });

  describe('normalizeData - Edge Cases', () => {
    it('should handle empty data array', () => {
      const options: TransformationOptions = {
        normalization: 'total',
        currency: 'RON',
        inflationAdjusted: true,
      };

      const result = normalizeData([], options, factors);
      expect(result).toHaveLength(0);
    });

    it('should preserve original data points immutably', () => {
      const originalData: DataPoint[] = [{ x: '2023', year: 2023, y: new Decimal(100) }];
      const options: TransformationOptions = {
        normalization: 'total',
        currency: 'EUR',
        inflationAdjusted: true,
      };

      normalizeData(originalData, options, factors);

      // Original should be unchanged
      expect(originalData[0]!.y.toNumber()).toBe(100);
    });

    it('should handle very large numbers', () => {
      const data: DataPoint[] = [
        { x: '2023', year: 2023, y: new Decimal('1000000000000') }, // 1 trillion
      ];
      const options: TransformationOptions = {
        normalization: 'total',
        currency: 'EUR',
        inflationAdjusted: true,
      };

      const result = normalizeData(data, options, factors);
      // 1T * 1.1 = 1.1T / 5.0 = 220B EUR
      expect(result[0]!.y.toNumber()).toBe(220000000000);
    });

    it('should handle very small numbers with precision', () => {
      const data: DataPoint[] = [{ x: '2023', year: 2023, y: new Decimal('0.001') }];
      const options: TransformationOptions = {
        normalization: 'percent_gdp',
        currency: 'RON',
        inflationAdjusted: false,
      };

      const result = normalizeData(data, options, factors);
      // 0.001 / 1000 * 100 = 0.0001%
      expect(result[0]!.y.toNumber()).toBe(0.0001);
    });
  });
});
