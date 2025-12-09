/**
 * Unit tests for MCP core utilities.
 */

import { describe, it, expect } from 'vitest';

import {
  normalizeClassificationCode,
  normalizeClassificationCodes,
  normalizeFilterClassificationCodes,
  validatePeriodFormat,
  validatePeriods,
  validatePeriodInterval,
  validatePeriodSelection,
  formatCompact,
  formatStandard,
  formatAmountBilingual,
  clamp,
  generatePeriodRange,
  synthesizeLabelFromFilter,
} from '@/modules/mcp/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Classification Code Normalization Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('normalizeClassificationCode', () => {
  it('removes single trailing .00 segment', () => {
    expect(normalizeClassificationCode('65.00')).toBe('65');
  });

  it('removes multiple trailing .00 segments', () => {
    expect(normalizeClassificationCode('65.10.00')).toBe('65.10');
    expect(normalizeClassificationCode('65.00.00')).toBe('65');
  });

  it('preserves non-zero segments', () => {
    expect(normalizeClassificationCode('65.10.03')).toBe('65.10.03');
    expect(normalizeClassificationCode('65.10.03.00')).toBe('65.10.03');
  });

  it('handles codes without trailing zeros', () => {
    expect(normalizeClassificationCode('65')).toBe('65');
    expect(normalizeClassificationCode('65.10')).toBe('65.10');
  });

  it('handles empty string', () => {
    expect(normalizeClassificationCode('')).toBe('');
  });

  it('handles prefix codes with trailing dot', () => {
    // Prefix codes should remain unchanged
    expect(normalizeClassificationCode('65.')).toBe('65.');
  });
});

describe('normalizeClassificationCodes', () => {
  it('normalizes array of codes', () => {
    const codes = ['65.00', '66.10.00', '67'];
    expect(normalizeClassificationCodes(codes)).toEqual(['65', '66.10', '67']);
  });

  it('handles empty array', () => {
    expect(normalizeClassificationCodes([])).toEqual([]);
  });
});

describe('normalizeFilterClassificationCodes', () => {
  it('normalizes camelCase functional codes', () => {
    const filter = {
      functionalCodes: ['65.00', '66.10.00'],
      functionalPrefixes: ['65.00.', '66.'],
      otherField: 'unchanged',
    };

    const result = normalizeFilterClassificationCodes(filter);

    expect(result['functionalCodes']).toEqual(['65', '66.10']);
    expect(result['functionalPrefixes']).toEqual(['65.', '66.']);
    expect(result['otherField']).toBe('unchanged');
  });

  it('normalizes snake_case functional codes', () => {
    const filter = {
      functional_codes: ['65.00'],
      functional_prefixes: ['65.00.'],
    };

    const result = normalizeFilterClassificationCodes(filter);

    expect(result['functional_codes']).toEqual(['65']);
    expect(result['functional_prefixes']).toEqual(['65.']);
  });

  it('normalizes economic codes', () => {
    const filter = {
      economicCodes: ['10.00', '20.10.00'],
      economic_prefixes: ['10.00.'],
    };

    const result = normalizeFilterClassificationCodes(filter);

    expect(result['economicCodes']).toEqual(['10', '20.10']);
    expect(result['economic_prefixes']).toEqual(['10.']);
  });

  it('preserves non-array fields', () => {
    const filter = {
      accountCategory: 'ch',
      entityCuis: ['123', '456'],
    };

    const result = normalizeFilterClassificationCodes(filter);

    expect(result['accountCategory']).toBe('ch');
    expect(result['entityCuis']).toEqual(['123', '456']);
  });

  it('returns new object (immutable)', () => {
    const filter = { functionalCodes: ['65.00'] };
    const result = normalizeFilterClassificationCodes(filter);

    expect(result).not.toBe(filter);
    expect(filter.functionalCodes).toEqual(['65.00']); // Original unchanged
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Period Format Validation Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('validatePeriodFormat', () => {
  describe('YEAR granularity', () => {
    it('accepts valid year format', () => {
      const result = validatePeriodFormat('2023', 'YEAR');
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toBe('2023');
    });

    it('rejects month format', () => {
      const result = validatePeriodFormat('2023-06', 'YEAR');
      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().code).toBe('INVALID_PERIOD');
    });

    it('rejects quarter format', () => {
      const result = validatePeriodFormat('2023-Q2', 'YEAR');
      expect(result.isErr()).toBe(true);
    });

    it('rejects invalid year', () => {
      const result = validatePeriodFormat('23', 'YEAR');
      expect(result.isErr()).toBe(true);
    });
  });

  describe('MONTH granularity', () => {
    it('accepts valid month format', () => {
      const result = validatePeriodFormat('2023-06', 'MONTH');
      expect(result.isOk()).toBe(true);
    });

    it('accepts all valid months', () => {
      for (let m = 1; m <= 12; m++) {
        const month = String(m).padStart(2, '0');
        const result = validatePeriodFormat(`2023-${month}`, 'MONTH');
        expect(result.isOk()).toBe(true);
      }
    });

    it('rejects invalid month 00', () => {
      const result = validatePeriodFormat('2023-00', 'MONTH');
      expect(result.isErr()).toBe(true);
    });

    it('rejects invalid month 13', () => {
      const result = validatePeriodFormat('2023-13', 'MONTH');
      expect(result.isErr()).toBe(true);
    });

    it('rejects year-only format', () => {
      const result = validatePeriodFormat('2023', 'MONTH');
      expect(result.isErr()).toBe(true);
    });
  });

  describe('QUARTER granularity', () => {
    it('accepts valid quarter format', () => {
      const result = validatePeriodFormat('2023-Q2', 'QUARTER');
      expect(result.isOk()).toBe(true);
    });

    it('accepts all valid quarters', () => {
      for (let q = 1; q <= 4; q++) {
        const result = validatePeriodFormat(`2023-Q${String(q)}`, 'QUARTER');
        expect(result.isOk()).toBe(true);
      }
    });

    it('rejects invalid quarter Q0', () => {
      const result = validatePeriodFormat('2023-Q0', 'QUARTER');
      expect(result.isErr()).toBe(true);
    });

    it('rejects invalid quarter Q5', () => {
      const result = validatePeriodFormat('2023-Q5', 'QUARTER');
      expect(result.isErr()).toBe(true);
    });

    it('rejects lowercase q', () => {
      const result = validatePeriodFormat('2023-q2', 'QUARTER');
      expect(result.isErr()).toBe(true);
    });
  });
});

describe('validatePeriods', () => {
  it('validates array of periods', () => {
    const result = validatePeriods(['2020', '2021', '2022'], 'YEAR');
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual(['2020', '2021', '2022']);
  });

  it('returns error on first invalid period', () => {
    const result = validatePeriods(['2020', 'invalid', '2022'], 'YEAR');
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain('invalid');
  });

  it('handles empty array', () => {
    const result = validatePeriods([], 'YEAR');
    expect(result.isOk()).toBe(true);
  });
});

describe('validatePeriodInterval', () => {
  it('validates valid interval', () => {
    const result = validatePeriodInterval('2020', '2023', 'YEAR');
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({ start: '2020', end: '2023' });
  });

  it('accepts same start and end', () => {
    const result = validatePeriodInterval('2023', '2023', 'YEAR');
    expect(result.isOk()).toBe(true);
  });

  it('rejects start after end', () => {
    const result = validatePeriodInterval('2024', '2020', 'YEAR');
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain('before or equal');
  });

  it('validates format of both start and end', () => {
    const result = validatePeriodInterval('invalid', '2023', 'YEAR');
    expect(result.isErr()).toBe(true);
  });
});

describe('validatePeriodSelection', () => {
  it('validates interval selection', () => {
    const selection = { interval: { start: '2020', end: '2023' } };
    const result = validatePeriodSelection(selection, 'YEAR');
    expect(result.isOk()).toBe(true);
  });

  it('validates dates selection', () => {
    const selection = { dates: ['2020', '2022', '2024'] };
    const result = validatePeriodSelection(selection, 'YEAR');
    expect(result.isOk()).toBe(true);
  });

  it('rejects invalid interval', () => {
    const selection = { interval: { start: '2024', end: '2020' } };
    const result = validatePeriodSelection(selection, 'YEAR');
    expect(result.isErr()).toBe(true);
  });

  it('rejects invalid dates', () => {
    const selection = { dates: ['2020', 'invalid'] };
    const result = validatePeriodSelection(selection, 'YEAR');
    expect(result.isErr()).toBe(true);
  });

  it('rejects empty selection', () => {
    const selection = {};
    const result = validatePeriodSelection(selection, 'YEAR');
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain('interval or dates');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Number Formatting Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('formatCompact', () => {
  it('formats billions', () => {
    expect(formatCompact(1_500_000_000)).toBe('1.50B RON');
    expect(formatCompact(2_345_678_901)).toBe('2.35B RON');
  });

  it('formats millions', () => {
    expect(formatCompact(5_234_567)).toBe('5.23M RON');
    expect(formatCompact(1_000_000)).toBe('1.00M RON');
  });

  it('formats thousands', () => {
    expect(formatCompact(50_000)).toBe('50.00K RON');
    expect(formatCompact(1_234)).toBe('1.23K RON');
  });

  it('formats small numbers', () => {
    expect(formatCompact(999)).toBe('999.00 RON');
    expect(formatCompact(123.45)).toBe('123.45 RON');
  });

  it('handles negative numbers', () => {
    expect(formatCompact(-5_000_000)).toBe('-5.00M RON');
  });

  it('accepts custom currency', () => {
    expect(formatCompact(1_000_000, 'EUR')).toBe('1.00M EUR');
  });
});

describe('formatStandard', () => {
  it('formats with thousands separator', () => {
    expect(formatStandard(5_234_567.89)).toBe('5,234,567.89 RON');
  });

  it('formats small numbers with decimals', () => {
    expect(formatStandard(123.4)).toBe('123.40 RON');
  });

  it('accepts custom currency', () => {
    expect(formatStandard(1000, 'EUR')).toBe('1,000.00 EUR');
  });
});

describe('formatAmountBilingual', () => {
  it('creates bilingual formatted string', () => {
    const result = formatAmountBilingual(5_234_567, 'Venituri', 'Income');
    expect(result).toContain('Venituri / Income');
    expect(result).toContain('5.23M RON');
    expect(result).toContain('5,234,567.00 RON');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// General Utility Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('clamp', () => {
  it('returns value when within range', () => {
    expect(clamp(50, 0, 100)).toBe(50);
  });

  it('clamps to minimum', () => {
    expect(clamp(-10, 0, 100)).toBe(0);
  });

  it('clamps to maximum', () => {
    expect(clamp(150, 0, 100)).toBe(100);
  });

  it('handles edge cases', () => {
    expect(clamp(0, 0, 100)).toBe(0);
    expect(clamp(100, 0, 100)).toBe(100);
  });
});

describe('generatePeriodRange', () => {
  describe('YEAR granularity', () => {
    it('generates yearly range', () => {
      const result = generatePeriodRange('2020', '2023', 'YEAR');
      expect(result).toEqual(['2020', '2021', '2022', '2023']);
    });

    it('handles single year', () => {
      const result = generatePeriodRange('2023', '2023', 'YEAR');
      expect(result).toEqual(['2023']);
    });
  });

  describe('MONTH granularity', () => {
    it('generates monthly range within year', () => {
      const result = generatePeriodRange('2023-10', '2023-12', 'MONTH');
      expect(result).toEqual(['2023-10', '2023-11', '2023-12']);
    });

    it('generates monthly range across years', () => {
      const result = generatePeriodRange('2022-11', '2023-02', 'MONTH');
      expect(result).toEqual(['2022-11', '2022-12', '2023-01', '2023-02']);
    });
  });

  describe('QUARTER granularity', () => {
    it('generates quarterly range within year', () => {
      const result = generatePeriodRange('2023-Q1', '2023-Q4', 'QUARTER');
      expect(result).toEqual(['2023-Q1', '2023-Q2', '2023-Q3', '2023-Q4']);
    });

    it('generates quarterly range across years', () => {
      const result = generatePeriodRange('2022-Q3', '2023-Q2', 'QUARTER');
      expect(result).toEqual(['2022-Q3', '2022-Q4', '2023-Q1', '2023-Q2']);
    });
  });
});

describe('synthesizeLabelFromFilter', () => {
  it('generates label from entity CUIs', () => {
    const filter = { entityCuis: ['123'] };
    expect(synthesizeLabelFromFilter(filter)).toBe('Entity 123');
  });

  it('generates label for multiple entities', () => {
    const filter = { entityCuis: ['123', '456', '789'] };
    expect(synthesizeLabelFromFilter(filter)).toBe('3 entities');
  });

  it('generates label from UAT IDs', () => {
    const filter = { uatIds: ['54975'] };
    expect(synthesizeLabelFromFilter(filter)).toBe('UAT 54975');
  });

  it('generates label from county codes', () => {
    const filter = { countyCodes: ['CJ', 'BH'] };
    expect(synthesizeLabelFromFilter(filter)).toBe('CJ, BH');
  });

  it('includes functional prefixes', () => {
    const filter = { functionalPrefixes: ['65.'] };
    expect(synthesizeLabelFromFilter(filter)).toContain('Fn: 65.');
  });

  it('includes economic prefixes', () => {
    const filter = { economicPrefixes: ['10.'] };
    expect(synthesizeLabelFromFilter(filter)).toContain('Ec: 10.');
  });

  it('includes account category', () => {
    expect(synthesizeLabelFromFilter({ accountCategory: 'ch' })).toBe('Expenses');
    expect(synthesizeLabelFromFilter({ accountCategory: 'vn' })).toBe('Income');
  });

  it('combines multiple parts', () => {
    const filter = {
      countyCodes: ['CJ'],
      functionalPrefixes: ['65.'],
      accountCategory: 'ch',
    };
    const label = synthesizeLabelFromFilter(filter);
    expect(label).toContain('CJ');
    expect(label).toContain('Fn: 65.');
    expect(label).toContain('Expenses');
  });

  it('returns "Series" for empty filter', () => {
    expect(synthesizeLabelFromFilter({})).toBe('Series');
  });
});
