import { Decimal } from 'decimal.js';
import { describe, it, expect } from 'vitest';

import type { Dataset, DataPoint } from '@/modules/datasets/index.js';

/**
 * Helper to get a value from a dataset for a specific year.
 * This mirrors the implementation in get-analytics-series.ts for testing.
 */
const getDatasetValue = (dataset: Dataset, year: number): Decimal | null => {
  const yearStr = year.toString();

  // First try exact match
  const exactPoint = dataset.points.find((p: DataPoint) => p.x === yearStr);
  if (exactPoint !== undefined) {
    return exactPoint.y;
  }

  // Carry-forward: find the most recent year that has data before the requested year
  let bestYear: number | null = null;
  let bestValue: Decimal | null = null;

  for (const point of dataset.points) {
    const pointYear = parseInt(point.x, 10);
    if (!Number.isNaN(pointYear) && pointYear < year) {
      if (bestYear === null || pointYear > bestYear) {
        bestYear = pointYear;
        bestValue = point.y;
      }
    }
  }

  return bestValue;
};

/**
 * Creates a mock dataset for testing.
 */
function createMockDataset(id: string, points: { x: string; y: string }[]): Dataset {
  return {
    id,
    metadata: {
      id,
      source: 'Test',
      sourceUrl: 'https://test.example.com',
      lastUpdated: '2024-01-01',
      units: 'test_units',
    },
    i18n: {
      ro: { title: 'Test', xAxisLabel: 'X', yAxisLabel: 'Y' },
      en: { title: 'Test', xAxisLabel: 'X', yAxisLabel: 'Y' },
    },
    axes: {
      x: { label: 'Period', type: 'date', frequency: 'yearly', format: 'YYYY' },
      y: { label: 'Value', type: 'number', unit: 'test' },
    },
    points: points.map((p) => ({ x: p.x, y: new Decimal(p.y) })),
  };
}

describe('getDatasetValue - Carry-Forward Logic', () => {
  describe('exact match', () => {
    it('should return exact value when year exists', () => {
      const dataset = createMockDataset('test', [
        { x: '2023', y: '4.9464' },
        { x: '2024', y: '4.9746' },
      ]);

      expect(getDatasetValue(dataset, 2023)?.toNumber()).toBe(4.9464);
      expect(getDatasetValue(dataset, 2024)?.toNumber()).toBe(4.9746);
    });
  });

  describe('carry-forward for missing future years', () => {
    it('should carry forward from 2024 to 2025 when 2025 is missing', () => {
      // This simulates the real RON/EUR dataset scenario
      const dataset = createMockDataset('ro.economics.exchange.ron_eur.yearly', [
        { x: '2023', y: '4.9464' },
        { x: '2024', y: '4.9746' },
        // No 2025 data
      ]);

      const value2025 = getDatasetValue(dataset, 2025);

      expect(value2025).not.toBeNull();
      expect(value2025?.toNumber()).toBe(4.9746); // Should use 2024 value
    });

    it('should carry forward for multiple missing future years', () => {
      const dataset = createMockDataset('test', [
        { x: '2023', y: '5.0' },
        { x: '2024', y: '5.1' },
      ]);

      expect(getDatasetValue(dataset, 2025)?.toNumber()).toBe(5.1);
      expect(getDatasetValue(dataset, 2026)?.toNumber()).toBe(5.1);
      expect(getDatasetValue(dataset, 2030)?.toNumber()).toBe(5.1);
    });
  });

  describe('carry-forward with gaps in data', () => {
    it('should use the most recent year before the requested year', () => {
      const dataset = createMockDataset('test', [
        { x: '2020', y: '4.5' },
        { x: '2022', y: '4.7' },
        // Missing 2021, 2023, 2024
      ]);

      // 2021 should use 2020
      expect(getDatasetValue(dataset, 2021)?.toNumber()).toBe(4.5);
      // 2023 should use 2022
      expect(getDatasetValue(dataset, 2023)?.toNumber()).toBe(4.7);
      // 2024 should use 2022
      expect(getDatasetValue(dataset, 2024)?.toNumber()).toBe(4.7);
    });
  });

  describe('edge cases', () => {
    it('should return null when no data exists before requested year', () => {
      const dataset = createMockDataset('test', [
        { x: '2024', y: '5.0' },
        { x: '2025', y: '5.1' },
      ]);

      // 2023 has no data before it
      expect(getDatasetValue(dataset, 2023)).toBeNull();
      expect(getDatasetValue(dataset, 2020)).toBeNull();
    });

    it('should handle empty dataset', () => {
      const dataset = createMockDataset('test', []);

      expect(getDatasetValue(dataset, 2024)).toBeNull();
    });

    it('should handle single point dataset', () => {
      const dataset = createMockDataset('test', [{ x: '2024', y: '5.0' }]);

      expect(getDatasetValue(dataset, 2024)?.toNumber()).toBe(5.0);
      expect(getDatasetValue(dataset, 2025)?.toNumber()).toBe(5.0); // Carry forward
      expect(getDatasetValue(dataset, 2023)).toBeNull(); // No data before
    });

    it('should handle unsorted dataset points', () => {
      // Points not in chronological order
      const dataset = createMockDataset('test', [
        { x: '2022', y: '4.5' },
        { x: '2020', y: '4.3' },
        { x: '2024', y: '4.9' },
        { x: '2021', y: '4.4' },
      ]);

      // Should still find the correct most recent year
      expect(getDatasetValue(dataset, 2023)?.toNumber()).toBe(4.5); // Uses 2022, not 2021 or 2020
      expect(getDatasetValue(dataset, 2025)?.toNumber()).toBe(4.9); // Uses 2024
    });
  });

  describe('real-world RON/EUR scenario', () => {
    it('should correctly handle the 2025 EUR conversion bug scenario', () => {
      // Exact replica of the actual dataset structure
      const eurDataset = createMockDataset('ro.economics.exchange.ron_eur.yearly', [
        { x: '2020', y: '4.8376' },
        { x: '2021', y: '4.9207' },
        { x: '2022', y: '4.9313' },
        { x: '2023', y: '4.9464' },
        { x: '2024', y: '4.9746' },
        // No 2025 data - this was the bug!
      ]);

      // Before the fix, this would return null and currency conversion would be skipped
      // After the fix, it should return the 2024 value
      const rate2025 = getDatasetValue(eurDataset, 2025);

      expect(rate2025).not.toBeNull();
      expect(rate2025?.toNumber()).toBe(4.9746);

      // Verify the conversion would work correctly
      const amountRon = 100;
      const amountEur = amountRon / rate2025!.toNumber();
      expect(amountEur).toBeCloseTo(20.1, 1); // ~20.1 EUR, not 100 RON!
    });
  });
});
