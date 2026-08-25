/**
 * Pins the counterparty-name overlay rule (prod-db issue 36): a canonical
 * `core.organizations` name must LOSE to the flows-side contract name when it
 * is a placeholder (name = own CUI — 23,093 such rows, all `kind='unknown'`).
 * Reverting the predicate restores the "payer named 18264854" bug.
 */
import { describe, expect, it } from 'vitest';

import { isPlaceholderOrganizationName } from '@/modules/shared/shell/repo/flows-repo.js';

describe('isPlaceholderOrganizationName (getTopCounterparties overlay)', () => {
  it('rejects a self-named placeholder so the flows-side name wins', () => {
    expect(isPlaceholderOrganizationName('18264854', '18264854')).toBe(true);
  });

  it('rejects a whitespace-padded placeholder (trim-compared)', () => {
    expect(isPlaceholderOrganizationName(' 18264854 ', '18264854')).toBe(true);
  });

  it('accepts a real canonical name', () => {
    expect(isPlaceholderOrganizationName('ADMINISTRATIA NATIONALA APELE ROMANE', '18264854')).toBe(
      false
    );
  });

  it("accepts a numeric-looking name that is NOT this org's own CUI", () => {
    // A different number is odd data, but it is not the self-named placeholder
    // pattern this rule targets — do not widen the rule to "any numeric name".
    expect(isPlaceholderOrganizationName('12345678', '18264854')).toBe(false);
  });
});
