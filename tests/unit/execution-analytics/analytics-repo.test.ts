import { Decimal } from 'decimal.js';
import { describe, it, expect } from 'vitest';

import { Frequency } from '@/common/types/temporal.js';
import {
  formatDateFromRow,
  extractYear,
  toNumericIds,
  needsEntityJoin,
  needsUatJoin,
} from '@/infra/database/query-filters/index.js';
import { makeAnalyticsRepo } from '@/modules/execution-analytics/shell/repo/analytics-repo.js';

/**
 * Integration tests for KyselyAnalyticsRepo.
 *
 * Note: Full integration testing with a real Kysely client would require
 * a test database. These tests focus on:
 * 1. Testing the data transformation logic
 * 2. Testing error handling patterns
 * 3. Verifying the Result type returns
 *
 * For full query testing, use integration tests with Testcontainers.
 */

// ============================================================================
// Data Transformation Tests
// ============================================================================

describe('Analytics Repo Data Transformation', () => {
  /**
   * These tests verify the transformation of raw database rows to DataSeries.
   * We test the helper functions that are used by the repo.
   */
  describe('row to DataPoint transformation', () => {
    describe('yearly data transformation', () => {
      it('transforms yearly rows correctly', () => {
        const rows = [
          { year: 2020, period_value: 2020, amount: '1000.50' },
          { year: 2021, period_value: 2021, amount: '2000.75' },
          { year: 2022, period_value: 2022, amount: '3000.00' },
        ];

        const dataPoints = rows.map((r) => ({
          date: formatDateFromRow(r.year, r.period_value, Frequency.YEAR),
          value: new Decimal(r.amount ?? '0'),
        }));

        expect(dataPoints).toHaveLength(3);
        expect(dataPoints[0]).toEqual({
          date: '2020',
          value: new Decimal('1000.50'),
        });
        expect(dataPoints[1]).toEqual({
          date: '2021',
          value: new Decimal('2000.75'),
        });
        expect(dataPoints[2]).toEqual({
          date: '2022',
          value: new Decimal('3000.00'),
        });
      });
    });

    describe('monthly data transformation', () => {
      it('transforms monthly rows correctly', () => {
        const rows = [
          { year: 2024, period_value: 1, amount: '100.00' },
          { year: 2024, period_value: 6, amount: '600.00' },
          { year: 2024, period_value: 12, amount: '1200.00' },
        ];

        const dataPoints = rows.map((r) => ({
          date: formatDateFromRow(r.year, r.period_value, Frequency.MONTH),
          value: new Decimal(r.amount ?? '0'),
        }));

        expect(dataPoints).toHaveLength(3);
        expect(dataPoints[0]?.date).toBe('2024-01');
        expect(dataPoints[1]?.date).toBe('2024-06');
        expect(dataPoints[2]?.date).toBe('2024-12');
      });
    });

    describe('quarterly data transformation', () => {
      it('transforms quarterly rows correctly', () => {
        const rows = [
          { year: 2024, period_value: 1, amount: '1000.00' },
          { year: 2024, period_value: 2, amount: '2000.00' },
          { year: 2024, period_value: 3, amount: '3000.00' },
          { year: 2024, period_value: 4, amount: '4000.00' },
        ];

        const dataPoints = rows.map((r) => ({
          date: formatDateFromRow(r.year, r.period_value, Frequency.QUARTER),
          value: new Decimal(r.amount ?? '0'),
        }));

        expect(dataPoints).toHaveLength(4);
        expect(dataPoints[0]?.date).toBe('2024-Q1');
        expect(dataPoints[1]?.date).toBe('2024-Q2');
        expect(dataPoints[2]?.date).toBe('2024-Q3');
        expect(dataPoints[3]?.date).toBe('2024-Q4');
      });
    });

    describe('edge cases', () => {
      it('handles null/undefined amount by defaulting to 0', () => {
        const rows = [
          { year: 2024, period_value: 2024, amount: null as unknown as string },
          { year: 2025, period_value: 2025, amount: undefined as unknown as string },
        ];

        const dataPoints = rows.map((r) => ({
          date: formatDateFromRow(r.year, r.period_value, Frequency.YEAR),
          value: new Decimal(r.amount ?? '0'),
        }));

        expect(dataPoints[0]?.value.toString()).toBe('0');
        expect(dataPoints[1]?.value.toString()).toBe('0');
      });

      it('handles empty result set', () => {
        const rows: { year: number; period_value: number; amount: string }[] = [];

        const dataPoints = rows.map((r) => ({
          date: formatDateFromRow(r.year, r.period_value, Frequency.YEAR),
          value: new Decimal(r.amount ?? '0'),
        }));

        expect(dataPoints).toHaveLength(0);
      });

      it('preserves decimal precision', () => {
        const rows = [{ year: 2024, period_value: 2024, amount: '1234567890.123456789' }];

        const dataPoints = rows.map((r) => ({
          date: formatDateFromRow(r.year, r.period_value, Frequency.YEAR),
          value: new Decimal(r.amount ?? '0'),
        }));

        expect(dataPoints[0]?.value.toString()).toBe('1234567890.123456789');
      });
    });
  });
});

// ============================================================================
// Error Handling Tests
// ============================================================================

describe('Analytics Repo Error Handling', () => {
  describe('error classification', () => {
    /**
     * Tests for the error handling logic.
     * We test the pattern used in handleQueryError method.
     */
    const classifyError = (error: unknown) => {
      const message = error instanceof Error ? error.message : 'Unknown database error';

      const isTimeout =
        message.includes('statement timeout') ||
        message.includes('57014') ||
        message.includes('canceling statement due to statement timeout');

      if (isTimeout) {
        return {
          type: 'TimeoutError' as const,
          message: 'Analytics query timed out',
          retryable: true,
          cause: error,
        };
      }

      return {
        type: 'DatabaseError' as const,
        message: 'Failed to fetch analytics data',
        retryable: true,
        cause: error,
      };
    };

    it('classifies statement timeout errors', () => {
      const error = new Error('canceling statement due to statement timeout');
      const result = classifyError(error);

      expect(result.type).toBe('TimeoutError');
      expect(result.message).toBe('Analytics query timed out');
      expect(result.retryable).toBe(true);
    });

    it('classifies PostgreSQL timeout code (57014)', () => {
      const error = new Error('ERROR 57014: query canceled');
      const result = classifyError(error);

      expect(result.type).toBe('TimeoutError');
    });

    it('classifies statement timeout message', () => {
      const error = new Error('statement timeout');
      const result = classifyError(error);

      expect(result.type).toBe('TimeoutError');
    });

    it('classifies generic database errors', () => {
      const error = new Error('Connection refused');
      const result = classifyError(error);

      expect(result.type).toBe('DatabaseError');
      expect(result.message).toBe('Failed to fetch analytics data');
      expect(result.retryable).toBe(true);
    });

    it('handles non-Error exceptions', () => {
      const result = classifyError('string error');

      expect(result.type).toBe('DatabaseError');
      expect(result.message).toBe('Failed to fetch analytics data');
    });

    it('handles null/undefined errors', () => {
      const result = classifyError(null);

      expect(result.type).toBe('DatabaseError');
    });

    it('preserves the original error as cause', () => {
      const originalError = new Error('Original error');
      const result = classifyError(originalError);

      expect(result.cause).toBe(originalError);
    });
  });
});

// ============================================================================
// Join Logic Tests
// ============================================================================

describe('Analytics Repo Join Logic', () => {
  describe('entity join requirements', () => {
    it('requires entity join for entity_types filter', () => {
      expect(needsEntityJoin({ entity_types: ['MINISTRY'] })).toBe(true);
    });

    it('requires entity join for is_uat filter (true)', () => {
      expect(needsEntityJoin({ is_uat: true })).toBe(true);
    });

    it('requires entity join for is_uat filter (false)', () => {
      expect(needsEntityJoin({ is_uat: false })).toBe(true);
    });

    it('does not require entity join when is_uat is omitted', () => {
      expect(needsEntityJoin({})).toBe(false);
    });

    it('requires entity join for uat_ids filter', () => {
      expect(needsEntityJoin({ uat_ids: ['1', '2'] })).toBe(true);
    });

    it('requires entity join for county_codes filter', () => {
      expect(needsEntityJoin({ county_codes: ['AB'] })).toBe(true);
    });

    it('requires entity join for exclude.entity_types', () => {
      expect(needsEntityJoin({ exclude: { entity_types: ['UAT'] } })).toBe(true);
    });

    it('does not require entity join when no entity filters present', () => {
      expect(needsEntityJoin({})).toBe(false);
    });
  });

  describe('UAT join requirements', () => {
    it('requires UAT join for county_codes filter', () => {
      expect(needsUatJoin({ county_codes: ['AB', 'BC'] })).toBe(true);
    });

    it('requires UAT join for exclude.county_codes', () => {
      expect(needsUatJoin({ exclude: { county_codes: ['AB'] } })).toBe(true);
    });

    it('does not require UAT join when no county filters present', () => {
      expect(needsUatJoin({})).toBe(false);
    });
  });
});

// ============================================================================
// Numeric ID Conversion Tests
// ============================================================================

describe('Analytics Repo Numeric ID Conversion', () => {
  it('converts valid string IDs to numbers', () => {
    expect(toNumericIds(['1', '2', '3'])).toEqual([1, 2, 3]);
  });

  it('filters out invalid string IDs', () => {
    expect(toNumericIds(['1', 'invalid', '3'])).toEqual([1, 3]);
  });

  it('filters out empty strings', () => {
    expect(toNumericIds(['1', '', '3'])).toEqual([1, 3]);
  });

  it('filters out whitespace-only strings', () => {
    expect(toNumericIds(['1', '   ', '3'])).toEqual([1, 3]);
  });

  it('returns empty array for all invalid inputs', () => {
    expect(toNumericIds(['invalid', '', '   '])).toEqual([]);
  });

  it('handles empty input array', () => {
    expect(toNumericIds([])).toEqual([]);
  });
});

// ============================================================================
// Year Extraction Tests
// ============================================================================

describe('Analytics Repo Year Extraction', () => {
  it('extracts year from YYYY format', () => {
    expect(extractYear('2024')).toBe(2024);
  });

  it('extracts year from YYYY-MM format', () => {
    expect(extractYear('2024-06')).toBe(2024);
  });

  it('extracts year from YYYY-QN format', () => {
    expect(extractYear('2024-Q2')).toBe(2024);
  });

  it('returns null for invalid year portion', () => {
    expect(extractYear('20a4')).toBeNull();
  });

  it('returns null for short strings', () => {
    expect(extractYear('202')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(extractYear('')).toBeNull();
  });
});

// ============================================================================
// Factory Function Tests
// ============================================================================

describe('makeAnalyticsRepo factory', () => {
  it('creates an AnalyticsRepository instance', () => {
    // Create a minimal mock DB
    const mockDb = {} as never;

    const repo = makeAnalyticsRepo(mockDb);

    expect(repo).toBeDefined();
    expect(typeof repo.getAggregatedSeries).toBe('function');
  });
});
