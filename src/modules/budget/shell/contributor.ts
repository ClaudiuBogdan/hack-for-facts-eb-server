/**
 * Budget module — cross-source contributor (plan §4.1, §14.7).
 *
 * Registers ONE `SourceContributor` into the kernel registry. `presenceFor` powers
 * entity-360 badges; `profileSlice` is the SINGLE cross-source mechanism — the
 * GraphQL `Entity.budget` resolver calls THIS, not a divergent path. The slice
 * wraps the rich `BudgetProfileSlice` (the usecase is the source of truth) into the
 * kernel's open `{ source, kind, summary?, data? }` shape.
 *
 * Grain Gate (§14.6): budget participates in entity-360 only via its native
 * MV-backed summary (income/expense/balance), NOT as `flows.money_flows` edges —
 * budget flows are not projected yet (the contributor advertises the
 * `budget_summary_annual` grain, never mixing with flow totals).
 */

import { err, ok, type Result } from 'neverthrow';

import { BUDGET_GRAIN_NOTE } from '../core/constants.js';
import { getBudgetProfileSlice } from '../core/usecases.js';

import type { BudgetRepo } from '../core/ports.js';
import type { BudgetProfileSlice } from '../core/types.js';
import type {
  ApiError,
  Cui,
  EntityProfileSlice,
  SourceContributor,
  SourcePresence,
} from '@/modules/shared/index.js';

const BUDGET_SOURCE = 'budget';

/** Build the open profile slice from the rich profile (one projection, no 2nd query). */
export const toProfileSlice = (profile: BudgetProfileSlice): EntityProfileSlice => {
  const summary =
    `Budget ${String(profile.latestCompleteYear)} (${profile.reportType}): ` +
    (profile.totalIncome !== null ? `income ${profile.totalIncome} RON, ` : '') +
    (profile.totalExpense !== null ? `expense ${profile.totalExpense} RON, ` : '') +
    (profile.budgetBalance !== null ? `balance ${profile.budgetBalance} RON.` : '.') +
    ` ${BUDGET_GRAIN_NOTE}`;
  return {
    source: BUDGET_SOURCE,
    kind: 'budget_summary_annual',
    summary,
    data: profile as unknown as Record<string, unknown>,
  };
};

export const makeBudgetContributor = (repo: BudgetRepo): SourceContributor => ({
  source: BUDGET_SOURCE,

  async presenceFor(cui: Cui): Promise<Result<SourcePresence | null, ApiError>> {
    return repo.presenceFor(cui);
  },

  async profileSlice(cui: Cui): Promise<Result<EntityProfileSlice | null, ApiError>> {
    const res = await getBudgetProfileSlice(repo, cui);
    if (res.isErr()) return err(res.error);
    return ok(res.value === null ? null : toProfileSlice(res.value));
  },
});
