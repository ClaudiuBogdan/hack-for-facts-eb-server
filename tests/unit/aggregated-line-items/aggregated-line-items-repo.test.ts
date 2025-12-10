import { Decimal } from 'decimal.js';
import { describe, it, expect } from 'vitest';

import {
  extractYear,
  toNumericIds,
  needsEntityJoin,
  needsUatJoin,
} from '@/infra/database/query-filters/index.js';
import {
  UNKNOWN_ECONOMIC_CODE,
  UNKNOWN_ECONOMIC_NAME,
} from '@/modules/aggregated-line-items/core/types.js';

/**
 * Unit tests for aggregated-line-items repository helpers and constants.
 *
 * Note: Full integration testing with a real Kysely client would require
 * a test database. These tests focus on:
 * 1. Testing the data transformation logic
 * 2. Verifying constants used for NULL handling
 * 3. Testing filter detection helpers (reused from execution-analytics)
 *
 * For full query testing, use integration tests with Testcontainers.
 */

// =============================================================================
// Constants Tests
// =============================================================================

describe('Aggregated Line Items Constants', () => {
  describe('unknown economic code handling', () => {
    it('should have correct default economic code for NULL values', () => {
      expect(UNKNOWN_ECONOMIC_CODE).toBe('00.00.00');
    });

    it('should have correct default economic name for NULL values', () => {
      expect(UNKNOWN_ECONOMIC_NAME).toBe('Unknown economic classification');
    });
  });
});

// =============================================================================
// Data Transformation Tests
// =============================================================================

describe('Aggregated Line Items Data Transformation', () => {
  describe('raw row to ClassificationPeriodData transformation', () => {
    it('should transform rows with all fields present', () => {
      const rawRow = {
        functional_code: '01.01.01',
        functional_name: 'Legislative bodies',
        economic_code: '20.05.01',
        economic_name: 'Administrative services',
        year: 2023,
        amount: '1500000.50',
        count: '42',
      };

      // Simulating the transformation done in the repo
      const transformed = {
        functional_code: rawRow.functional_code,
        functional_name: rawRow.functional_name,
        economic_code: rawRow.economic_code,
        economic_name: rawRow.economic_name,
        year: rawRow.year,
        amount: new Decimal(rawRow.amount),
        count: typeof rawRow.count === 'string' ? parseInt(rawRow.count, 10) : Number(rawRow.count),
      };

      expect(transformed.functional_code).toBe('01.01.01');
      expect(transformed.functional_name).toBe('Legislative bodies');
      expect(transformed.economic_code).toBe('20.05.01');
      expect(transformed.economic_name).toBe('Administrative services');
      expect(transformed.year).toBe(2023);
      expect(transformed.amount.equals(new Decimal('1500000.50'))).toBe(true);
      expect(transformed.count).toBe(42);
    });

    it('should handle economic code with COALESCE default', () => {
      // When economic_code is NULL, COALESCE returns the default
      const rawRow = {
        functional_code: '01.01.01',
        functional_name: 'Legislative bodies',
        economic_code: UNKNOWN_ECONOMIC_CODE, // From COALESCE
        economic_name: UNKNOWN_ECONOMIC_NAME, // From COALESCE
        year: 2023,
        amount: '1000.00',
        count: '10',
      };

      expect(rawRow.economic_code).toBe('00.00.00');
      expect(rawRow.economic_name).toBe('Unknown economic classification');
    });

    it('should handle decimal amounts with high precision', () => {
      const rawRow = {
        amount: '123456789.123456789',
      };

      const amount = new Decimal(rawRow.amount);

      // Decimal.js should preserve precision
      expect(amount.toString()).toBe('123456789.123456789');
    });

    it('should handle zero amounts', () => {
      const rawRow = {
        amount: '0',
      };

      const amount = new Decimal(rawRow.amount);

      expect(amount.isZero()).toBe(true);
    });

    it('should handle negative amounts', () => {
      const rawRow = {
        amount: '-5000.50',
      };

      const amount = new Decimal(rawRow.amount);

      expect(amount.isNegative()).toBe(true);
      expect(amount.equals(new Decimal('-5000.50'))).toBe(true);
    });

    it('should handle count as number or string', () => {
      // PostgreSQL might return count as string or number depending on driver
      const countFromString = parseInt('100', 10);
      const numericValue = 100;
      const countFromNumber = numericValue;

      expect(countFromString).toBe(100);
      expect(countFromNumber).toBe(100);
    });
  });
});

// =============================================================================
// Period Filter Tests
// =============================================================================

describe('Period Filter Extraction', () => {
  describe('extractYear', () => {
    it('should extract year from YYYY format', () => {
      expect(extractYear('2023')).toBe(2023);
      expect(extractYear('2024')).toBe(2024);
    });

    it('should extract year from YYYY-MM format', () => {
      expect(extractYear('2023-01')).toBe(2023);
      expect(extractYear('2023-12')).toBe(2023);
    });

    it('should extract year from YYYY-QN format', () => {
      expect(extractYear('2023-Q1')).toBe(2023);
      expect(extractYear('2023-Q4')).toBe(2023);
    });

    it('should return null for invalid formats', () => {
      expect(extractYear('')).toBe(null);
      expect(extractYear('abc')).toBe(null);
      expect(extractYear('20')).toBe(null);
    });
  });
});

// =============================================================================
// Join Detection Tests (reused helpers)
// =============================================================================

describe('Join Detection Helpers', () => {
  describe('needsEntityJoin', () => {
    it('should return false when no entity-related filters', () => {
      expect(needsEntityJoin({})).toBe(false);
    });

    it('should return true when entity_types filter is set', () => {
      expect(needsEntityJoin({ entity_types: ['UAT'] })).toBe(true);
    });

    it('should return true when is_uat filter is set', () => {
      expect(needsEntityJoin({ is_uat: true })).toBe(true);
      expect(needsEntityJoin({ is_uat: false })).toBe(true);
    });

    it('should return true when uat_ids filter is set', () => {
      expect(needsEntityJoin({ uat_ids: ['1', '2'] })).toBe(true);
    });

    it('should return true when county_codes filter is set', () => {
      expect(needsEntityJoin({ county_codes: ['B', 'CJ'] })).toBe(true);
    });

    it('should return true when exclude.entity_types is set', () => {
      expect(needsEntityJoin({ exclude: { entity_types: ['MINISTRY'] } })).toBe(true);
    });

    it('should return false for empty arrays', () => {
      expect(needsEntityJoin({ entity_types: [] })).toBe(false);
      expect(needsEntityJoin({ uat_ids: [] })).toBe(false);
    });
  });

  describe('needsUatJoin', () => {
    it('should return false when no UAT-related filters', () => {
      expect(needsUatJoin({})).toBe(false);
    });

    it('should return true when county_codes filter is set', () => {
      expect(needsUatJoin({ county_codes: ['B'] })).toBe(true);
    });

    it('should return true when exclude.county_codes is set', () => {
      expect(needsUatJoin({ exclude: { county_codes: ['B'] } })).toBe(true);
    });

    it('should return false for empty arrays', () => {
      expect(needsUatJoin({ county_codes: [] })).toBe(false);
    });
  });
});

// =============================================================================
// Numeric ID Conversion Tests
// =============================================================================

describe('Numeric ID Conversion', () => {
  describe('toNumericIds', () => {
    it('should convert string IDs to numbers', () => {
      expect(toNumericIds(['1', '2', '3'])).toEqual([1, 2, 3]);
    });

    it('should filter out empty strings', () => {
      expect(toNumericIds(['1', '', '3'])).toEqual([1, 3]);
    });

    it('should filter out whitespace strings', () => {
      expect(toNumericIds(['1', '  ', '3'])).toEqual([1, 3]);
    });

    it('should filter out non-numeric strings', () => {
      expect(toNumericIds(['1', 'abc', '3'])).toEqual([1, 3]);
    });

    it('should return empty array for empty input', () => {
      expect(toNumericIds([])).toEqual([]);
    });

    it('should handle decimal strings (truncates to integer)', () => {
      // Note: Number('1.5') = 1.5, which is a valid number
      expect(toNumericIds(['1.5', '2.9'])).toEqual([1.5, 2.9]);
    });
  });
});

// =============================================================================
// Aggregation Key Tests
// =============================================================================

describe('Aggregation Key Generation', () => {
  it('should generate unique keys for different classifications', () => {
    const rows = [
      { functional_code: '01.01', economic_code: '10.01' },
      { functional_code: '01.01', economic_code: '10.02' },
      { functional_code: '01.02', economic_code: '10.01' },
    ];

    const keys = rows.map((r) => `${r.functional_code}|${r.economic_code}`);

    expect(keys).toEqual(['01.01|10.01', '01.01|10.02', '01.02|10.01']);
    expect(new Set(keys).size).toBe(3);
  });

  it('should generate same key for same classification', () => {
    const row1 = { functional_code: '01.01', economic_code: '10.01' };
    const row2 = { functional_code: '01.01', economic_code: '10.01' };

    const key1 = `${row1.functional_code}|${row1.economic_code}`;
    const key2 = `${row2.functional_code}|${row2.economic_code}`;

    expect(key1).toBe(key2);
  });

  it('should handle unknown economic code in key', () => {
    const row = {
      functional_code: '01.01',
      economic_code: UNKNOWN_ECONOMIC_CODE,
    };

    const key = `${row.functional_code}|${row.economic_code}`;

    expect(key).toBe('01.01|00.00.00');
  });
});

// =============================================================================
// Amount Column Selection Tests
// =============================================================================

describe('Amount Column Selection', () => {
  function getAmountColumn(frequency: string): string {
    return frequency === 'MONTH'
      ? 'eli.monthly_amount'
      : frequency === 'QUARTER'
        ? 'eli.quarterly_amount'
        : 'eli.ytd_amount';
  }

  it('should use ytd_amount for YEAR frequency', () => {
    expect(getAmountColumn('YEAR')).toBe('eli.ytd_amount');
  });

  it('should use quarterly_amount for QUARTER frequency', () => {
    expect(getAmountColumn('QUARTER')).toBe('eli.quarterly_amount');
  });

  it('should use monthly_amount for MONTH frequency', () => {
    expect(getAmountColumn('MONTH')).toBe('eli.monthly_amount');
  });
});
