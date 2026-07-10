/**
 * PNRR filter-helper guards (review-hardening). Covers the bugs the adversarial
 * review found: empty `in: []` must NOT count as a driving predicate, and the
 * virtual fields (role/hub/hasNoHub/year) must validate rather than silently
 * no-op.
 */

import { describe, expect, it } from 'vitest';

import {
  hasField,
  requireDrivingPredicate,
  validateVirtualFilters,
} from '@/modules/pnrr/shell/repo/filter-helpers.js';

describe('hasField — only counts predicate-producing fields', () => {
  it('true for a non-empty eq / in', () => {
    expect(hasField({ beneficiaryCui: { eq: '16054368' } }, 'beneficiaryCui')).toBe(true);
    expect(hasField({ beneficiaryCui: { in: ['1'] } }, 'beneficiaryCui')).toBe(true);
  });

  it('FALSE for an empty in: [] (would emit no SQL → unbounded scan)', () => {
    expect(hasField({ beneficiaryCui: { in: [] } }, 'beneficiaryCui')).toBe(false);
  });

  it('FALSE for an empty between: {}', () => {
    expect(hasField({ paymentDate: { between: {} } }, 'paymentDate')).toBe(false);
    expect(hasField({ paymentDate: { between: { from: '2024-01-01' } } }, 'paymentDate')).toBe(
      true
    );
  });

  it('true for isNull (a real predicate)', () => {
    expect(hasField({ measureFenix: { isNull: true } }, 'measureFenix')).toBe(true);
  });
});

describe('requireDrivingPredicate — index-bound rule', () => {
  it('rejects when only an empty in is present', () => {
    const r = requireDrivingPredicate(
      { beneficiaryCui: { in: [] } },
      ['beneficiaryCui'],
      'beneficiaryCui'
    );
    expect(r.isErr()).toBe(true);
  });

  it('accepts a real driving predicate', () => {
    const r = requireDrivingPredicate(
      { beneficiaryCui: { eq: '1' } },
      ['beneficiaryCui'],
      'beneficiaryCui'
    );
    expect(r.isOk()).toBe(true);
  });
});

describe('validateVirtualFilters', () => {
  it('rejects a bad role enum', () => {
    expect(validateVirtualFilters({ role: { eq: 'mayor' } }).isErr()).toBe(true);
  });

  it('rejects a bad hub enum (in list)', () => {
    expect(validateVirtualFilters({ hub: { in: ['ngo'] } }).isErr()).toBe(true);
  });

  it('rejects a non-bool hasNoHub', () => {
    expect(validateVirtualFilters({ hasNoHub: { eq: 'maybe' } }).isErr()).toBe(true);
  });

  it('rejects a non-numeric / out-of-range year', () => {
    expect(validateVirtualFilters({ year: { eq: 'x' } }).isErr()).toBe(true);
    expect(validateVirtualFilters({ year: { eq: 1800 } }).isErr()).toBe(true);
  });

  it('accepts valid virtual filters', () => {
    expect(
      validateVirtualFilters({
        role: { eq: 'beneficiary' },
        hub: { in: ['companies'] },
        year: { eq: 2024 },
        hasNoHub: { eq: true },
      }).isOk()
    ).toBe(true);
  });

  it('is a no-op when no virtual fields are present', () => {
    expect(validateVirtualFilters({ beneficiaryCui: { eq: '1' } }).isOk()).toBe(true);
  });
});
