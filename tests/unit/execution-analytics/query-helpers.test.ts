import { describe, it, expect } from 'vitest';

import { Frequency } from '@/common/types/temporal.js';
import {
  formatDateFromRow,
  extractYear,
  toNumericIds,
  needsEntityJoin,
  needsUatJoin,
} from '@/modules/execution-analytics/shell/repo/query-helpers.js';

// ============================================================================
// formatDateFromRow
// ============================================================================

describe('formatDateFromRow', () => {
  describe('MONTHLY frequency', () => {
    it('formats single-digit months with leading zero', () => {
      expect(formatDateFromRow(2024, 1, Frequency.MONTH)).toBe('2024-01');
      expect(formatDateFromRow(2024, 9, Frequency.MONTH)).toBe('2024-09');
    });

    it('formats double-digit months correctly', () => {
      expect(formatDateFromRow(2024, 10, Frequency.MONTH)).toBe('2024-10');
      expect(formatDateFromRow(2024, 12, Frequency.MONTH)).toBe('2024-12');
    });

    it('handles different years', () => {
      expect(formatDateFromRow(2020, 6, Frequency.MONTH)).toBe('2020-06');
      expect(formatDateFromRow(1999, 3, Frequency.MONTH)).toBe('1999-03');
    });
  });

  describe('QUARTERLY frequency', () => {
    it('formats quarters correctly', () => {
      expect(formatDateFromRow(2024, 1, Frequency.QUARTER)).toBe('2024-Q1');
      expect(formatDateFromRow(2024, 2, Frequency.QUARTER)).toBe('2024-Q2');
      expect(formatDateFromRow(2024, 3, Frequency.QUARTER)).toBe('2024-Q3');
      expect(formatDateFromRow(2024, 4, Frequency.QUARTER)).toBe('2024-Q4');
    });

    it('handles different years', () => {
      expect(formatDateFromRow(2020, 2, Frequency.QUARTER)).toBe('2020-Q2');
      expect(formatDateFromRow(1999, 4, Frequency.QUARTER)).toBe('1999-Q4');
    });
  });

  describe('YEARLY frequency', () => {
    it('returns year as string', () => {
      expect(formatDateFromRow(2024, 2024, Frequency.YEAR)).toBe('2024');
      expect(formatDateFromRow(2020, 2020, Frequency.YEAR)).toBe('2020');
      expect(formatDateFromRow(1999, 1999, Frequency.YEAR)).toBe('1999');
    });

    it('ignores period_value and uses year directly', () => {
      // For YEARLY frequency, period_value should equal year, but we test it ignores period_value
      expect(formatDateFromRow(2024, 1, Frequency.YEAR)).toBe('2024');
      expect(formatDateFromRow(2024, 999, Frequency.YEAR)).toBe('2024');
    });
  });
});

// ============================================================================
// extractYear
// ============================================================================

describe('extractYear', () => {
  describe('valid inputs', () => {
    it('extracts year from YYYY format', () => {
      expect(extractYear('2024')).toBe(2024);
      expect(extractYear('1999')).toBe(1999);
      expect(extractYear('2000')).toBe(2000);
    });

    it('extracts year from YYYY-MM format', () => {
      expect(extractYear('2024-01')).toBe(2024);
      expect(extractYear('2024-12')).toBe(2024);
      expect(extractYear('1999-06')).toBe(1999);
    });

    it('extracts year from YYYY-QN format', () => {
      expect(extractYear('2024-Q1')).toBe(2024);
      expect(extractYear('2024-Q4')).toBe(2024);
      expect(extractYear('1999-Q2')).toBe(1999);
    });

    it('extracts year from longer formats', () => {
      expect(extractYear('2024-01-15')).toBe(2024);
      expect(extractYear('2024-12-31T23:59:59')).toBe(2024);
    });
  });

  describe('invalid inputs', () => {
    it('returns null for strings shorter than 4 characters', () => {
      expect(extractYear('')).toBeNull();
      expect(extractYear('202')).toBeNull();
      expect(extractYear('20')).toBeNull();
      expect(extractYear('2')).toBeNull();
    });

    it('returns null for non-numeric year portions', () => {
      expect(extractYear('abcd')).toBeNull();
      expect(extractYear('YYYY-MM')).toBeNull();
      expect(extractYear('----')).toBeNull();
    });

    it('returns null for mixed invalid formats', () => {
      expect(extractYear('20a4')).toBeNull();
      expect(extractYear('2O24')).toBeNull(); // O instead of 0
    });
  });

  describe('edge cases', () => {
    it('handles exactly 4 character strings', () => {
      expect(extractYear('2024')).toBe(2024);
      expect(extractYear('0001')).toBe(1);
    });

    it('handles leading zeros', () => {
      expect(extractYear('0999')).toBe(999);
      expect(extractYear('0001')).toBe(1);
    });
  });
});

// ============================================================================
// toNumericIds
// ============================================================================

describe('toNumericIds', () => {
  describe('valid inputs', () => {
    it('converts string array to number array', () => {
      expect(toNumericIds(['1', '2', '3'])).toEqual([1, 2, 3]);
      expect(toNumericIds(['100', '200'])).toEqual([100, 200]);
    });

    it('handles single element arrays', () => {
      expect(toNumericIds(['42'])).toEqual([42]);
    });

    it('handles empty arrays', () => {
      expect(toNumericIds([])).toEqual([]);
    });
  });

  describe('filtering invalid values', () => {
    it('filters out NaN values from non-numeric strings', () => {
      expect(toNumericIds(['1', 'abc', '3'])).toEqual([1, 3]);
      expect(toNumericIds(['abc', 'def'])).toEqual([]);
    });

    it('filters out empty strings', () => {
      expect(toNumericIds(['1', '', '3'])).toEqual([1, 3]);
      expect(toNumericIds(['', ''])).toEqual([]);
    });

    it('handles mixed valid and invalid values', () => {
      expect(toNumericIds(['1', 'two', '3', '', '5', 'six'])).toEqual([1, 3, 5]);
    });
  });

  describe('edge cases', () => {
    it('handles decimal strings (converts to integers)', () => {
      expect(toNumericIds(['1.5', '2.9'])).toEqual([1.5, 2.9]);
    });

    it('handles negative numbers', () => {
      expect(toNumericIds(['-1', '-2'])).toEqual([-1, -2]);
    });

    it('handles whitespace strings', () => {
      expect(toNumericIds([' ', '  '])).toEqual([]);
    });

    it('handles string with leading/trailing spaces', () => {
      // Note: Number(' 123 ') = 123 in JavaScript
      expect(toNumericIds([' 1 ', ' 2 '])).toEqual([1, 2]);
    });
  });
});

// ============================================================================
// needsEntityJoin
// ============================================================================

describe('needsEntityJoin', () => {
  describe('returns true when', () => {
    it('entity_types is non-empty', () => {
      expect(needsEntityJoin({ entity_types: ['type1'] })).toBe(true);
      expect(needsEntityJoin({ entity_types: ['type1', 'type2'] })).toBe(true);
    });

    it('is_uat is defined', () => {
      expect(needsEntityJoin({ is_uat: true })).toBe(true);
      expect(needsEntityJoin({ is_uat: false })).toBe(true);
    });

    it('uat_ids is non-empty', () => {
      expect(needsEntityJoin({ uat_ids: ['1'] })).toBe(true);
      expect(needsEntityJoin({ uat_ids: ['1', '2'] })).toBe(true);
    });

    it('county_codes is non-empty', () => {
      expect(needsEntityJoin({ county_codes: ['AB'] })).toBe(true);
      expect(needsEntityJoin({ county_codes: ['AB', 'CD'] })).toBe(true);
    });

    it('exclude.entity_types is non-empty', () => {
      expect(needsEntityJoin({ exclude: { entity_types: ['type1'] } })).toBe(true);
    });

    it('exclude.uat_ids is non-empty', () => {
      expect(needsEntityJoin({ exclude: { uat_ids: ['1'] } })).toBe(true);
    });

    it('exclude.county_codes is non-empty', () => {
      expect(needsEntityJoin({ exclude: { county_codes: ['AB'] } })).toBe(true);
    });

    it('search is non-empty', () => {
      expect(needsEntityJoin({ search: 'test' })).toBe(true);
      expect(needsEntityJoin({ search: 'test entity' })).toBe(true);
    });
  });

  describe('returns false when', () => {
    it('all relevant fields are undefined', () => {
      expect(needsEntityJoin({})).toBe(false);
    });

    it('entity_types is empty', () => {
      expect(needsEntityJoin({ entity_types: [] })).toBe(false);
    });

    it('is_uat is omitted', () => {
      expect(needsEntityJoin({})).toBe(false);
    });

    it('uat_ids is empty', () => {
      expect(needsEntityJoin({ uat_ids: [] })).toBe(false);
    });

    it('county_codes is empty', () => {
      expect(needsEntityJoin({ county_codes: [] })).toBe(false);
    });

    it('exclude has empty arrays', () => {
      expect(
        needsEntityJoin({
          exclude: { entity_types: [], uat_ids: [], county_codes: [] },
        })
      ).toBe(false);
    });

    it('search is empty or whitespace', () => {
      expect(needsEntityJoin({ search: '' })).toBe(false);
      expect(needsEntityJoin({ search: '   ' })).toBe(false);
    });
  });
});

// ============================================================================
// needsUatJoin
// ============================================================================

describe('needsUatJoin', () => {
  describe('returns true when', () => {
    it('county_codes is non-empty', () => {
      expect(needsUatJoin({ county_codes: ['AB'] })).toBe(true);
      expect(needsUatJoin({ county_codes: ['AB', 'CD'] })).toBe(true);
    });

    it('regions is non-empty', () => {
      expect(needsUatJoin({ regions: ['Centru'] })).toBe(true);
      expect(needsUatJoin({ regions: ['Centru', 'Nord-Est'] })).toBe(true);
    });

    it('min_population is specified', () => {
      expect(needsUatJoin({ min_population: 10000 })).toBe(true);
    });

    it('max_population is specified', () => {
      expect(needsUatJoin({ max_population: 100000 })).toBe(true);
    });

    it('exclude.county_codes is non-empty', () => {
      expect(needsUatJoin({ exclude: { county_codes: ['AB'] } })).toBe(true);
    });

    it('exclude.regions is non-empty', () => {
      expect(needsUatJoin({ exclude: { regions: ['Centru'] } })).toBe(true);
    });
  });

  describe('returns false when', () => {
    it('all relevant fields are undefined', () => {
      expect(needsUatJoin({})).toBe(false);
    });

    it('county_codes is empty', () => {
      expect(needsUatJoin({ county_codes: [] })).toBe(false);
    });

    it('regions is empty', () => {
      expect(needsUatJoin({ regions: [] })).toBe(false);
    });

    it('population filters are null', () => {
      expect(needsUatJoin({ min_population: null, max_population: null })).toBe(false);
    });

    it('exclude is omitted', () => {
      expect(needsUatJoin({})).toBe(false);
    });

    it('exclude.county_codes is empty', () => {
      expect(needsUatJoin({ exclude: { county_codes: [] } })).toBe(false);
    });

    it('exclude.regions is empty', () => {
      expect(needsUatJoin({ exclude: { regions: [] } })).toBe(false);
    });

    it('exclude.county_codes is omitted', () => {
      expect(needsUatJoin({ exclude: {} })).toBe(false);
    });
  });
});
