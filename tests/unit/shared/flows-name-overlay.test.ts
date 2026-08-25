/**
 * Pins the counterparty-name overlay rule (prod-db issue 36): a canonical
 * `core.organizations` name must LOSE to the flows-side contract name when it
 * is a placeholder (name = own CUI — 23,093 such rows, all `kind='unknown'`).
 * The predicate is the KERNEL's one definition (organization-labels), shared
 * with the flows overlay — reverting either restores the "payer named
 * 18264854" bug.
 */
import { describe, expect, it } from 'vitest';

import { isPlaceholderName } from '@/modules/shared/core/usecases/organization-labels.js';

describe('isPlaceholderName (kernel labels + getTopCounterparties overlay)', () => {
  it('rejects a self-named placeholder so the flows-side name wins', () => {
    expect(isPlaceholderName('18264854', '18264854')).toBe(true);
  });

  it('rejects a whitespace-padded placeholder (trim-compared)', () => {
    expect(isPlaceholderName(' 18264854 ', '18264854')).toBe(true);
  });

  it('accepts a real canonical name', () => {
    expect(isPlaceholderName('ADMINISTRATIA NATIONALA APELE ROMANE', '18264854')).toBe(false);
  });

  it("accepts a numeric-looking name that is NOT this org's own CUI", () => {
    // A different number is odd data, but it is not the self-named placeholder
    // pattern this rule targets — do not widen the rule to "any numeric name".
    expect(isPlaceholderName('12345678', '18264854')).toBe(false);
  });
});
