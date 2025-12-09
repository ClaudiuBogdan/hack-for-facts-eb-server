/**
 * Unit tests for MCP classification utilities
 */

import { describe, it, expect } from 'vitest';

import {
  normalizeClassificationCode,
  normalizeClassificationCodes,
  isClassificationPrefix,
  getChapterCode,
  getSubchapterCode,
  getClassificationDepth,
} from '@/modules/mcp/core/utils/classification-utils.js';

describe('normalizeClassificationCode', () => {
  it('removes trailing .00 segments', () => {
    expect(normalizeClassificationCode('65.10.00')).toBe('65.10');
    expect(normalizeClassificationCode('65.00.00')).toBe('65');
    expect(normalizeClassificationCode('65.10.03.00')).toBe('65.10.03');
  });

  it('preserves codes without trailing .00', () => {
    expect(normalizeClassificationCode('65.10.03')).toBe('65.10.03');
    expect(normalizeClassificationCode('65.10')).toBe('65.10');
    expect(normalizeClassificationCode('65')).toBe('65');
  });

  it('preserves prefix codes (ending with dot)', () => {
    expect(normalizeClassificationCode('65.')).toBe('65.');
    expect(normalizeClassificationCode('65.10.')).toBe('65.10.');
  });

  it('handles multiple trailing .00 segments', () => {
    expect(normalizeClassificationCode('65.00.00.00')).toBe('65');
    expect(normalizeClassificationCode('65.10.00.00')).toBe('65.10');
  });
});

describe('normalizeClassificationCodes', () => {
  it('normalizes array of codes', () => {
    const input = ['65.10.00', '66.00.00', '67.10.03'];
    const expected = ['65.10', '66', '67.10.03'];
    expect(normalizeClassificationCodes(input)).toEqual(expected);
  });

  it('handles empty array', () => {
    expect(normalizeClassificationCodes([])).toEqual([]);
  });

  it('preserves prefixes in array', () => {
    const input = ['65.', '66.10.', '67.10.03'];
    const expected = ['65.', '66.10.', '67.10.03'];
    expect(normalizeClassificationCodes(input)).toEqual(expected);
  });
});

describe('isClassificationPrefix', () => {
  it('returns true for codes ending with dot', () => {
    expect(isClassificationPrefix('65.')).toBe(true);
    expect(isClassificationPrefix('65.10.')).toBe(true);
    expect(isClassificationPrefix('65.10.03.')).toBe(true);
  });

  it('returns false for exact codes', () => {
    expect(isClassificationPrefix('65')).toBe(false);
    expect(isClassificationPrefix('65.10')).toBe(false);
    expect(isClassificationPrefix('65.10.03')).toBe(false);
  });
});

describe('getChapterCode', () => {
  it('extracts chapter from full code', () => {
    expect(getChapterCode('65.10.03')).toBe('65');
    expect(getChapterCode('65.10')).toBe('65');
    expect(getChapterCode('65')).toBe('65');
  });

  it('handles prefix codes', () => {
    expect(getChapterCode('65.')).toBe('65');
    expect(getChapterCode('65.10.')).toBe('65');
  });

  it('handles codes with trailing .00', () => {
    expect(getChapterCode('65.00.00')).toBe('65');
    expect(getChapterCode('65.10.00')).toBe('65');
  });
});

describe('getSubchapterCode', () => {
  it('extracts subchapter from full code', () => {
    expect(getSubchapterCode('65.10.03')).toBe('65.10');
    expect(getSubchapterCode('65.10')).toBe('65.10');
  });

  it('returns null for chapter-only codes', () => {
    expect(getSubchapterCode('65')).toBeNull();
    expect(getSubchapterCode('65.')).toBeNull();
  });

  it('handles prefix codes', () => {
    expect(getSubchapterCode('65.10.')).toBe('65.10');
    expect(getSubchapterCode('65.10.03.')).toBe('65.10');
  });

  it('handles codes with trailing .00', () => {
    expect(getSubchapterCode('65.10.00')).toBe('65.10');
    expect(getSubchapterCode('65.00.00')).toBe('65.00');
  });
});

describe('getClassificationDepth', () => {
  it('returns correct depth for chapter codes', () => {
    expect(getClassificationDepth('65')).toBe(1);
    expect(getClassificationDepth('65.')).toBe(1);
  });

  it('returns correct depth for subchapter codes', () => {
    expect(getClassificationDepth('65.10')).toBe(2);
    expect(getClassificationDepth('65.10.')).toBe(2);
  });

  it('returns correct depth for paragraph codes', () => {
    expect(getClassificationDepth('65.10.03')).toBe(3);
    expect(getClassificationDepth('65.10.03.')).toBe(3);
  });

  it('handles deeper nesting levels', () => {
    expect(getClassificationDepth('65.10.03.01')).toBe(4);
    expect(getClassificationDepth('65.10.03.01.02')).toBe(5);
    expect(getClassificationDepth('65.10.03.01.02.03')).toBe(6);
  });
});
