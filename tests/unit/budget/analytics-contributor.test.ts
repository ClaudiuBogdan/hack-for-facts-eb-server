/**
 * Budget analytics (normalization) + transfer-exclusion constants + contributor
 * profile-slice (no live DB). Pins:
 *  - the transfer-exclusion code set MUST match the set the MVs bake in (§3.4);
 *  - normalization multipliers are deterministic (TOTAL = identity, EURO < 1);
 *  - per-capita is flagged (population divided per-entity, never in the factor);
 *  - the contributor wraps the rich profile into the kernel open slice shape +
 *    carries the grain note (§14.6) and never mixes flow grains.
 */

import { ok } from 'neverthrow';
import { describe, expect, it, vi } from 'vitest';

import { BUDGET_TRANSFER_EXCLUSIONS } from '@/modules/budget/core/constants.js';
import { makeBudgetContributor, toProfileSlice } from '@/modules/budget/shell/contributor.js';
import { isPerCapita, yearMultiplier } from '@/modules/budget/shell/repo/analytics.js';

import type { BudgetRepo } from '@/modules/budget/core/ports.js';
import type { BudgetProfileSlice } from '@/modules/budget/core/types.js';

describe('transfer-exclusion set (must match the MV-baked set verbatim)', () => {
  it('pins the exact economic (expense) + functional (income) prefixes', () => {
    expect([...BUDGET_TRANSFER_EXCLUSIONS.economicPrefixes]).toEqual(['51.01', '51.02']);
    expect([...BUDGET_TRANSFER_EXCLUSIONS.functionalPrefixes]).toEqual([
      '36.02.05',
      '37.02.03',
      '37.02.04',
      '47.02.04',
    ]);
  });
});

describe('normalization multipliers (the single consolidated mechanism)', () => {
  it('TOTAL is the identity (multiplier = 1)', () => {
    expect(yearMultiplier('TOTAL', 2025)).toBe(1);
  });

  it('TOTAL_EURO divides RON by the year FX rate (multiplier < 1)', () => {
    const m = yearMultiplier('TOTAL_EURO', 2025);
    expect(m).toBeGreaterThan(0);
    expect(m).toBeLessThan(1);
  });

  it('PER_CAPITA keeps money in RON (population divided per-entity in SQL)', () => {
    expect(yearMultiplier('PER_CAPITA', 2025)).toBe(1);
    expect(isPerCapita('PER_CAPITA')).toBe(true);
    expect(isPerCapita('PER_CAPITA_EURO')).toBe(true);
    expect(isPerCapita('TOTAL')).toBe(false);
  });

  it('PERCENT_GDP is a small positive factor (amount * 100 / nominal GDP)', () => {
    const m = yearMultiplier('PERCENT_GDP', 2025);
    expect(m).toBeGreaterThan(0);
    expect(m).toBeLessThan(1e-6);
  });

  it('years beyond the table carry the last factor forward (no crash)', () => {
    expect(() => yearMultiplier('TOTAL_EURO', 2099)).not.toThrow();
    expect(yearMultiplier('TOTAL_EURO', 2099)).toBeGreaterThan(0);
  });
});

describe('budget contributor — profile slice + grain note', () => {
  const profile: BudgetProfileSlice = {
    cui: '4305857',
    latestYear: 2026,
    latestCompleteYear: 2025,
    reportType: 'EXECUTION_AGG_PRINCIPAL',
    totalIncome: '2656460197.71',
    totalExpense: '2259241251.68',
    budgetBalance: '397218946.03',
    topExpenseCategories: [
      { functionalCode: '66.05', functionalName: 'Spitale generale', amount: '308718837.89' },
    ],
    refreshedAt: null,
  };

  it('toProfileSlice wraps the rich profile into the kernel open shape + grain note', () => {
    const slice = toProfileSlice(profile);
    expect(slice.source).toBe('budget');
    expect(slice.kind).toBe('budget_summary_annual');
    expect(slice.summary).toContain('2259241251.68');
    expect(slice.summary).toContain('NEVER summed'); // the grain note rides along
    expect(slice.data).toBe(profile as unknown as Record<string, unknown>);
  });

  it('the contributor profileSlice goes through the SAME usecase (parity)', async () => {
    const repo = {
      profileSlice: vi.fn().mockResolvedValue(ok(profile)),
    } as unknown as BudgetRepo;
    const contributor = makeBudgetContributor(repo);
    const res = await contributor.profileSlice!('4305857');
    expect(res.isOk()).toBe(true);
    expect(res._unsafeUnwrap()?.source).toBe('budget');
    expect(repo.profileSlice).toHaveBeenCalledWith('4305857');
  });

  it('contributor returns null slice when the entity has no budget data', async () => {
    const repo = { profileSlice: vi.fn().mockResolvedValue(ok(null)) } as unknown as BudgetRepo;
    const res = await makeBudgetContributor(repo).profileSlice!('999');
    expect(res._unsafeUnwrap()).toBeNull();
  });
});
