import { describe, it, expect } from 'vitest';

import { Frequency } from '@/common/types/temporal.js';
import {
  frequencyToDatasetFrequency,
  getRequiredDatasetIds,
  getDimensionDatasetIds,
  getAllDatasetIds,
  getBestAvailableDatasetId,
  hasHigherFrequencyData,
  NORMALIZATION_DATASETS,
  type NormalizationDimension,
} from '@/modules/normalization/core/dataset-registry.js';

describe('Dataset Registry', () => {
  describe('frequencyToDatasetFrequency', () => {
    it('should map MONTHLY to monthly', () => {
      expect(frequencyToDatasetFrequency(Frequency.MONTHLY)).toBe('monthly');
    });

    it('should map QUARTERLY to quarterly', () => {
      expect(frequencyToDatasetFrequency(Frequency.QUARTERLY)).toBe('quarterly');
    });

    it('should map YEARLY to yearly', () => {
      expect(frequencyToDatasetFrequency(Frequency.YEARLY)).toBe('yearly');
    });
  });

  describe('NORMALIZATION_DATASETS registry', () => {
    it('should have all required dimensions', () => {
      expect(NORMALIZATION_DATASETS).toHaveProperty('cpi');
      expect(NORMALIZATION_DATASETS).toHaveProperty('eur');
      expect(NORMALIZATION_DATASETS).toHaveProperty('usd');
      expect(NORMALIZATION_DATASETS).toHaveProperty('gdp');
      expect(NORMALIZATION_DATASETS).toHaveProperty('population');
    });

    it('should have yearly datasets for all dimensions', () => {
      expect(NORMALIZATION_DATASETS.cpi.yearly).toBe('ro.economics.cpi.annual');
      expect(NORMALIZATION_DATASETS.eur.yearly).toBe('ro.economics.exchange.ron_eur.annual');
      expect(NORMALIZATION_DATASETS.usd.yearly).toBe('ro.economics.exchange.ron_usd.annual');
      expect(NORMALIZATION_DATASETS.gdp.yearly).toBe('ro.economics.gdp.annual');
      expect(NORMALIZATION_DATASETS.population.yearly).toBe('ro.demographics.population.annual');
    });
  });

  describe('getRequiredDatasetIds', () => {
    it('should return all required yearly dataset IDs', () => {
      const ids = getRequiredDatasetIds();

      expect(ids).toHaveLength(5);
      expect(ids).toContain('ro.economics.cpi.annual');
      expect(ids).toContain('ro.economics.exchange.ron_eur.annual');
      expect(ids).toContain('ro.economics.exchange.ron_usd.annual');
      expect(ids).toContain('ro.economics.gdp.annual');
      expect(ids).toContain('ro.demographics.population.annual');
    });

    it('should return only yearly datasets (minimum required)', () => {
      const ids = getRequiredDatasetIds();

      // Verify no quarterly or monthly datasets in required list
      for (const id of ids) {
        expect(id).toMatch(/\.annual$/);
      }
    });
  });

  describe('getDimensionDatasetIds', () => {
    it('should return yearly ID for dimension with only yearly', () => {
      const ids = getDimensionDatasetIds('population');

      expect(ids).toHaveLength(1);
      expect(ids).toContain('ro.demographics.population.annual');
    });

    it('should return all available frequency IDs for dimension', () => {
      // Currently all dimensions only have yearly
      const cpiIds = getDimensionDatasetIds('cpi');

      expect(cpiIds).toHaveLength(1);
      expect(cpiIds).toContain('ro.economics.cpi.annual');
    });
  });

  describe('getAllDatasetIds', () => {
    it('should return at least the required dataset IDs', () => {
      const allIds = getAllDatasetIds();
      const requiredIds = getRequiredDatasetIds();

      for (const required of requiredIds) {
        expect(allIds).toContain(required);
      }
    });

    it('should return 5 or more datasets', () => {
      const ids = getAllDatasetIds();
      expect(ids.length).toBeGreaterThanOrEqual(5);
    });
  });

  describe('getBestAvailableDatasetId', () => {
    const dimensions: NormalizationDimension[] = ['cpi', 'eur', 'usd', 'gdp', 'population'];

    it('should return yearly dataset for yearly frequency', () => {
      for (const dimension of dimensions) {
        const id = getBestAvailableDatasetId(dimension, 'yearly');
        expect(id).toBe(NORMALIZATION_DATASETS[dimension].yearly);
      }
    });

    it('should fallback to yearly for quarterly when quarterly not available', () => {
      // Currently no quarterly datasets configured
      for (const dimension of dimensions) {
        const id = getBestAvailableDatasetId(dimension, 'quarterly');
        expect(id).toBe(NORMALIZATION_DATASETS[dimension].yearly);
      }
    });

    it('should fallback to yearly for monthly when monthly not available', () => {
      // Currently no monthly datasets configured
      for (const dimension of dimensions) {
        const id = getBestAvailableDatasetId(dimension, 'monthly');
        expect(id).toBe(NORMALIZATION_DATASETS[dimension].yearly);
      }
    });
  });

  describe('hasHigherFrequencyData', () => {
    it('should return false for all dimensions at yearly frequency (no higher available)', () => {
      const dimensions: NormalizationDimension[] = ['cpi', 'eur', 'usd', 'gdp', 'population'];

      for (const dimension of dimensions) {
        // Currently all dimensions only have yearly data
        expect(hasHigherFrequencyData(dimension, 'yearly')).toBe(false);
      }
    });

    it('should return false for monthly (no higher frequency possible)', () => {
      expect(hasHigherFrequencyData('cpi', 'monthly')).toBe(false);
    });

    it('should return false for quarterly when no monthly available', () => {
      // Currently no monthly CPI data
      expect(hasHigherFrequencyData('cpi', 'quarterly')).toBe(false);
    });
  });

  describe('Registry Consistency', () => {
    it('should have valid dataset ID format for all datasets', () => {
      const allIds = getAllDatasetIds();

      for (const id of allIds) {
        // Dataset IDs should follow format: region.category[.subcategory].name.frequency
        // e.g., ro.economics.cpi.annual or ro.economics.exchange.ron_eur.annual
        expect(id).toMatch(/^[a-z]+(\.[a-z_]+)+$/);
      }
    });

    it('should have unique dataset IDs', () => {
      const allIds = getAllDatasetIds();
      const uniqueIds = new Set(allIds);

      expect(uniqueIds.size).toBe(allIds.length);
    });
  });
});
