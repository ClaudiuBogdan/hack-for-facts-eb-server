import { Decimal } from 'decimal.js';
import { describe, it, expect } from 'vitest';

import { Frequency } from '@/common/types/temporal.js';
import {
  generateFactorMap,
  datasetToFactorMap,
  createFactorDatasets,
  getFactorOrDefault,
  type FactorDatasets,
  type FactorMap,
} from '@/modules/normalization/core/factor-maps.js';

describe('Factor Maps', () => {
  describe('datasetToFactorMap', () => {
    it('should convert array of points to a Map', () => {
      const points = [
        { x: '2023', y: new Decimal('1.1') },
        { x: '2024', y: new Decimal('1') },
      ];

      const result = datasetToFactorMap(points);

      expect(result.size).toBe(2);
      expect(result.get('2023')?.toNumber()).toBe(1.1);
      expect(result.get('2024')?.toNumber()).toBe(1);
    });

    it('should handle empty array', () => {
      const result = datasetToFactorMap([]);
      expect(result.size).toBe(0);
    });
  });

  describe('createFactorDatasets', () => {
    it('should create datasets with only yearly data', () => {
      const yearly = [{ x: '2023', y: new Decimal('100') }];

      const result = createFactorDatasets(yearly);

      expect(result.yearly.size).toBe(1);
      expect(result.quarterly).toBeUndefined();
      expect(result.monthly).toBeUndefined();
    });

    it('should create datasets with all frequencies', () => {
      const yearly = [{ x: '2023', y: new Decimal('100') }];
      const quarterly = [{ x: '2023-Q1', y: new Decimal('25') }];
      const monthly = [{ x: '2023-01', y: new Decimal('8.33') }];

      const result = createFactorDatasets(yearly, quarterly, monthly);

      expect(result.yearly.size).toBe(1);
      expect(result.quarterly?.size).toBe(1);
      expect(result.monthly?.size).toBe(1);
    });
  });

  describe('getFactorOrDefault', () => {
    const map: FactorMap = new Map([
      ['2023', new Decimal('1.1')],
      ['2024', new Decimal('1')],
    ]);

    it('should return value when key exists', () => {
      const result = getFactorOrDefault(map, '2023');
      expect(result.toNumber()).toBe(1.1);
    });

    it('should return default (1) when key not found', () => {
      const result = getFactorOrDefault(map, '2025');
      expect(result.toNumber()).toBe(1);
    });

    it('should return custom default when provided', () => {
      const result = getFactorOrDefault(map, '2025', new Decimal('0'));
      expect(result.toNumber()).toBe(0);
    });
  });

  describe('generateFactorMap - Yearly Frequency', () => {
    it('should generate yearly factors from yearly data', () => {
      const datasets: FactorDatasets = {
        yearly: new Map([
          ['2023', new Decimal('1.1')],
          ['2024', new Decimal('1')],
        ]),
      };

      const result = generateFactorMap(Frequency.YEAR, 2023, 2024, datasets);

      expect(result.size).toBe(2);
      expect(result.get('2023')?.toNumber()).toBe(1.1);
      expect(result.get('2024')?.toNumber()).toBe(1);
    });

    it('should use previous value for missing years', () => {
      const datasets: FactorDatasets = {
        yearly: new Map([['2023', new Decimal('1.1')]]),
      };

      const result = generateFactorMap(Frequency.YEAR, 2023, 2025, datasets);

      expect(result.size).toBe(3);
      expect(result.get('2023')?.toNumber()).toBe(1.1);
      expect(result.get('2024')?.toNumber()).toBe(1.1); // previous value
      expect(result.get('2025')?.toNumber()).toBe(1.1); // previous value
    });

    it('should not include periods before first data point', () => {
      const datasets: FactorDatasets = {
        yearly: new Map([['2024', new Decimal('1.1')]]),
      };

      const result = generateFactorMap(Frequency.YEAR, 2023, 2025, datasets);

      // 2023 has no data and no previous value, so not included
      expect(result.size).toBe(2);
      expect(result.has('2023')).toBe(false);
      expect(result.get('2024')?.toNumber()).toBe(1.1);
      expect(result.get('2025')?.toNumber()).toBe(1.1); // previous value
    });

    it('should carry forward from latest year before range', () => {
      const datasets: FactorDatasets = {
        yearly: new Map([['2024', new Decimal('1.1')]]),
      };

      const result = generateFactorMap(Frequency.YEAR, 2025, 2025, datasets);

      expect(result.size).toBe(1);
      expect(result.get('2025')?.toNumber()).toBe(1.1); // carry-forward from 2024
    });
  });

  describe('generateFactorMap - Monthly Frequency with Fallback', () => {
    it('should use monthly data when available', () => {
      const datasets: FactorDatasets = {
        yearly: new Map([['2023', new Decimal('1.1')]]),
        monthly: new Map([
          ['2023-01', new Decimal('1.12')],
          ['2023-02', new Decimal('1.11')],
        ]),
      };

      const result = generateFactorMap(Frequency.MONTH, 2023, 2023, datasets);

      // Should have all 12 months
      expect(result.size).toBe(12);
      // January and February use monthly data
      expect(result.get('2023-01')?.toNumber()).toBe(1.12);
      expect(result.get('2023-02')?.toNumber()).toBe(1.11);
      // March through December fallback to yearly
      expect(result.get('2023-03')?.toNumber()).toBe(1.1);
      expect(result.get('2023-12')?.toNumber()).toBe(1.1);
    });

    it('should fallback to yearly when monthly not available', () => {
      const datasets: FactorDatasets = {
        yearly: new Map([
          ['2023', new Decimal('1.1')],
          ['2024', new Decimal('1')],
        ]),
        // No monthly data
      };

      const result = generateFactorMap(Frequency.MONTH, 2023, 2024, datasets);

      // Should have 24 months (2 years)
      expect(result.size).toBe(24);
      // All 2023 months use yearly 2023 value
      expect(result.get('2023-01')?.toNumber()).toBe(1.1);
      expect(result.get('2023-06')?.toNumber()).toBe(1.1);
      expect(result.get('2023-12')?.toNumber()).toBe(1.1);
      // All 2024 months use yearly 2024 value
      expect(result.get('2024-01')?.toNumber()).toBe(1);
      expect(result.get('2024-12')?.toNumber()).toBe(1);
    });

    it('should handle partial monthly data - use previous value for gaps', () => {
      const datasets: FactorDatasets = {
        yearly: new Map([['2023', new Decimal('1.1')]]),
        monthly: new Map([
          // Only some months of 2024 have monthly data
          ['2024-01', new Decimal('1.02')],
          ['2024-02', new Decimal('1.01')],
        ]),
      };

      const result = generateFactorMap(Frequency.MONTH, 2023, 2024, datasets);

      expect(result.size).toBe(24);
      // 2023 months fallback to yearly
      expect(result.get('2023-01')?.toNumber()).toBe(1.1);
      expect(result.get('2023-12')?.toNumber()).toBe(1.1);
      // 2024-01 and 2024-02 use monthly data
      expect(result.get('2024-01')?.toNumber()).toBe(1.02);
      expect(result.get('2024-02')?.toNumber()).toBe(1.01);
      // 2024-03 onwards use PREVIOUS VALUE (1.01 from 2024-02)
      expect(result.get('2024-03')?.toNumber()).toBe(1.01);
      expect(result.get('2024-12')?.toNumber()).toBe(1.01);
    });

    it('should use previous value when both monthly and yearly missing', () => {
      const datasets: FactorDatasets = {
        yearly: new Map([['2023', new Decimal('1.1')]]),
        monthly: new Map(),
      };

      const result = generateFactorMap(Frequency.MONTH, 2023, 2024, datasets);

      expect(result.size).toBe(24);
      // 2023 months use yearly
      expect(result.get('2023-12')?.toNumber()).toBe(1.1);
      // 2024 has no yearly data, so use previous value (1.1 from 2023-12)
      expect(result.get('2024-01')?.toNumber()).toBe(1.1);
      expect(result.get('2024-12')?.toNumber()).toBe(1.1);
    });

    it('should carry forward monthly values through year boundary', () => {
      const datasets: FactorDatasets = {
        yearly: new Map([['2023', new Decimal('1.1')]]),
        monthly: new Map([
          ['2023-11', new Decimal('1.15')],
          ['2023-12', new Decimal('1.2')],
        ]),
      };

      const result = generateFactorMap(Frequency.MONTH, 2023, 2024, datasets);

      // 2023 months before Nov use yearly
      expect(result.get('2023-01')?.toNumber()).toBe(1.1);
      expect(result.get('2023-10')?.toNumber()).toBe(1.1);
      // Nov and Dec use monthly
      expect(result.get('2023-11')?.toNumber()).toBe(1.15);
      expect(result.get('2023-12')?.toNumber()).toBe(1.2);
      // 2024 has no yearly, carries forward from 2023-12
      expect(result.get('2024-01')?.toNumber()).toBe(1.2);
      expect(result.get('2024-12')?.toNumber()).toBe(1.2);
    });
  });

  describe('generateFactorMap - Quarterly Frequency with Fallback', () => {
    it('should use quarterly data when available', () => {
      const datasets: FactorDatasets = {
        yearly: new Map([['2023', new Decimal('1.1')]]),
        quarterly: new Map([
          ['2023-Q1', new Decimal('1.12')],
          ['2023-Q2', new Decimal('1.11')],
        ]),
      };

      const result = generateFactorMap(Frequency.QUARTER, 2023, 2023, datasets);

      // Should have all 4 quarters
      expect(result.size).toBe(4);
      // Q1 and Q2 use quarterly data
      expect(result.get('2023-Q1')?.toNumber()).toBe(1.12);
      expect(result.get('2023-Q2')?.toNumber()).toBe(1.11);
      // Q3 and Q4 fallback to yearly
      expect(result.get('2023-Q3')?.toNumber()).toBe(1.1);
      expect(result.get('2023-Q4')?.toNumber()).toBe(1.1);
    });

    it('should fallback to yearly when quarterly not available', () => {
      const datasets: FactorDatasets = {
        yearly: new Map([
          ['2023', new Decimal('1.1')],
          ['2024', new Decimal('1')],
        ]),
        // No quarterly data
      };

      const result = generateFactorMap(Frequency.QUARTER, 2023, 2024, datasets);

      // Should have 8 quarters (2 years)
      expect(result.size).toBe(8);
      // All 2023 quarters use yearly 2023 value
      expect(result.get('2023-Q1')?.toNumber()).toBe(1.1);
      expect(result.get('2023-Q4')?.toNumber()).toBe(1.1);
      // All 2024 quarters use yearly 2024 value
      expect(result.get('2024-Q1')?.toNumber()).toBe(1);
      expect(result.get('2024-Q4')?.toNumber()).toBe(1);
    });

    it('should handle partial quarterly data - use previous value for gaps', () => {
      const datasets: FactorDatasets = {
        yearly: new Map([['2023', new Decimal('1.1')]]),
        quarterly: new Map([
          ['2024-Q1', new Decimal('1.02')],
          ['2024-Q2', new Decimal('1.01')],
        ]),
      };

      const result = generateFactorMap(Frequency.QUARTER, 2023, 2024, datasets);

      expect(result.size).toBe(8);
      // 2023 quarters fallback to yearly
      expect(result.get('2023-Q1')?.toNumber()).toBe(1.1);
      expect(result.get('2023-Q4')?.toNumber()).toBe(1.1);
      // 2024-Q1 and 2024-Q2 use quarterly data
      expect(result.get('2024-Q1')?.toNumber()).toBe(1.02);
      expect(result.get('2024-Q2')?.toNumber()).toBe(1.01);
      // 2024-Q3 and Q4 use PREVIOUS VALUE (1.01 from 2024-Q2)
      expect(result.get('2024-Q3')?.toNumber()).toBe(1.01);
      expect(result.get('2024-Q4')?.toNumber()).toBe(1.01);
    });
  });

  describe('generateFactorMap - Label Generation', () => {
    it('should generate correct month labels with zero-padding', () => {
      const datasets: FactorDatasets = {
        yearly: new Map([['2023', new Decimal('1')]]),
      };

      const result = generateFactorMap(Frequency.MONTH, 2023, 2023, datasets);

      // Check zero-padding for single-digit months
      expect(result.has('2023-01')).toBe(true);
      expect(result.has('2023-09')).toBe(true);
      expect(result.has('2023-10')).toBe(true);
      expect(result.has('2023-12')).toBe(true);
      // Ensure no invalid formats
      expect(result.has('2023-1')).toBe(false);
    });

    it('should generate correct quarter labels', () => {
      const datasets: FactorDatasets = {
        yearly: new Map([['2023', new Decimal('1')]]),
      };

      const result = generateFactorMap(Frequency.QUARTER, 2023, 2023, datasets);

      expect(result.has('2023-Q1')).toBe(true);
      expect(result.has('2023-Q2')).toBe(true);
      expect(result.has('2023-Q3')).toBe(true);
      expect(result.has('2023-Q4')).toBe(true);
    });

    it('should handle multi-year ranges correctly', () => {
      const datasets: FactorDatasets = {
        yearly: new Map([
          ['2020', new Decimal('1.2')],
          ['2021', new Decimal('1.15')],
          ['2022', new Decimal('1.1')],
          ['2023', new Decimal('1.05')],
          ['2024', new Decimal('1')],
        ]),
      };

      const result = generateFactorMap(Frequency.YEAR, 2020, 2024, datasets);

      expect(result.size).toBe(5);
      expect(result.get('2020')?.toNumber()).toBe(1.2);
      expect(result.get('2024')?.toNumber()).toBe(1);
    });
  });

  describe('generateFactorMap - Edge Cases', () => {
    it('should carry forward last known value when range is after dataset', () => {
      const datasets: FactorDatasets = {
        yearly: new Map([['2020', new Decimal('1.1')]]),
      };

      const result = generateFactorMap(Frequency.YEAR, 2023, 2024, datasets);

      expect(result.size).toBe(2);
      expect(result.get('2023')?.toNumber()).toBe(1.1);
      expect(result.get('2024')?.toNumber()).toBe(1.1);
    });

    it('should handle single year with gaps in monthly data', () => {
      const datasets: FactorDatasets = {
        yearly: new Map(), // No yearly data
        monthly: new Map([
          ['2023-03', new Decimal('1.1')], // Only March has data
        ]),
      };

      const result = generateFactorMap(Frequency.MONTH, 2023, 2023, datasets);

      // Jan and Feb have no data (no yearly, no monthly, no previous)
      expect(result.has('2023-01')).toBe(false);
      expect(result.has('2023-02')).toBe(false);
      // March has data
      expect(result.get('2023-03')?.toNumber()).toBe(1.1);
      // April onwards carry forward from March
      expect(result.get('2023-04')?.toNumber()).toBe(1.1);
      expect(result.get('2023-12')?.toNumber()).toBe(1.1);
      expect(result.size).toBe(10); // March through December
    });

    it('should prioritize monthly over yearly even when yearly exists', () => {
      const datasets: FactorDatasets = {
        yearly: new Map([['2023', new Decimal('1.1')]]),
        monthly: new Map([
          ['2023-06', new Decimal('1.5')], // Different value in June
        ]),
      };

      const result = generateFactorMap(Frequency.MONTH, 2023, 2023, datasets);

      expect(result.get('2023-01')?.toNumber()).toBe(1.1); // yearly
      expect(result.get('2023-05')?.toNumber()).toBe(1.1); // yearly
      expect(result.get('2023-06')?.toNumber()).toBe(1.5); // monthly overrides
      expect(result.get('2023-07')?.toNumber()).toBe(1.1); // back to yearly
    });
  });
});
