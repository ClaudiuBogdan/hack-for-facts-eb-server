/**
 * Reference filter-helper guards — covers the adversarial-review BLOCKER B2:
 * virtual fields MUST be stripped from both the top-level input AND the
 * `exclude.*` branch before the kernel composer sees them (else a placeholder
 * column like `county_code_virtual` compiles to invalid SQL).
 */

import { describe, expect, it } from 'vitest';

import {
  boolEq,
  eqValue,
  fieldOf,
  inValues,
  omitVirtualFields,
  validateVirtualEnum,
  virtualValues,
} from '@/modules/reference/shell/repo/filter-helpers.js';

const VIRTUAL = ['countyCode', 'region', 'parentCui', 'hasIssues'];

describe('omitVirtualFields — strips virtual fields from top-level AND exclude', () => {
  it('removes virtual fields at the top level', () => {
    const out = omitVirtualFields(
      { name: { contains: 'scoala' }, countyCode: { eq: 'CJ' }, region: { in: ['Centru'] } },
      VIRTUAL
    );
    expect(out).toEqual({ name: { contains: 'scoala' } });
  });

  it('removes virtual fields from the exclude branch (compiled separately by the kernel)', () => {
    const out = omitVirtualFields(
      { entityType: { eq: 'uat' }, exclude: { region: { in: ['Vest'] }, entityType: { eq: 'health' } } },
      VIRTUAL
    );
    expect(out).toEqual({ entityType: { eq: 'uat' }, exclude: { entityType: { eq: 'health' } } });
  });

  it('drops the exclude key entirely when it held only virtual fields', () => {
    const out = omitVirtualFields({ name: { prefix: 'a' }, exclude: { countyCode: { eq: 'CJ' } } }, VIRTUAL);
    expect(out).toEqual({ name: { prefix: 'a' } });
    expect('exclude' in out).toBe(false);
  });

  it('does not mutate the input', () => {
    const input = { countyCode: { eq: 'CJ' }, name: { contains: 'x' } };
    omitVirtualFields(input, VIRTUAL);
    expect(input.countyCode).toEqual({ eq: 'CJ' });
  });
});

describe('virtualValues — collects include + exclude values for a virtual field', () => {
  it('reads eq + in from the inclusion branch', () => {
    expect(virtualValues({ region: { eq: 'Centru' } }, 'region')).toEqual({ include: ['Centru'], exclude: [] });
    expect(virtualValues({ region: { in: ['Vest', 'Centru'] } }, 'region')).toEqual({
      include: ['Vest', 'Centru'],
      exclude: [],
    });
  });

  it('reads the exclude branch', () => {
    expect(virtualValues({ exclude: { region: { in: ['Vest'] } } }, 'region')).toEqual({
      include: [],
      exclude: ['Vest'],
    });
  });
});

describe('validateVirtualEnum — rejects bad values in include OR exclude', () => {
  const REGIONS = ['Centru', 'Vest'];
  it('ok for valid values', () => {
    expect(validateVirtualEnum({ region: { eq: 'Centru' } }, 'region', REGIONS).isOk()).toBe(true);
  });
  it('rejects an invalid inclusion value', () => {
    expect(validateVirtualEnum({ region: { eq: 'Atlantis' } }, 'region', REGIONS).isErr()).toBe(true);
  });
  it('rejects an invalid exclusion value (would silently no-op otherwise)', () => {
    expect(validateVirtualEnum({ exclude: { region: { in: ['Atlantis'] } } }, 'region', REGIONS).isErr()).toBe(true);
  });
});

describe('scalar readers', () => {
  it('eqValue / inValues / boolEq / fieldOf', () => {
    expect(eqValue({ eq: 'x' })).toBe('x');
    expect(eqValue({ eq: 42 })).toBe('42');
    expect(eqValue(undefined)).toBeUndefined();
    expect(inValues({ in: ['a', 1] })).toEqual(['a', '1']);
    expect(boolEq({ eq: true })).toBe(true);
    expect(boolEq({ eq: 'true' })).toBe(true);
    expect(boolEq({ eq: false })).toBe(false);
    expect(fieldOf({ a: { eq: '1' } }, 'a')).toEqual({ eq: '1' });
    expect(fieldOf({}, 'missing')).toBeUndefined();
  });
});
