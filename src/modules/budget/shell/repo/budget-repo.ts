/**
 * Budget module — repository over the live `budget.*` schema (plan §3).
 *
 * The home of `makeBudgetRepo` and of the two invariants every `budget.*`
 * reader in this directory follows (the read families live in their own files
 * since codebase plan §WP5 and receive this repo's context). Reads go through
 * the kernel's typed Kysely instance (`Kysely<ProdDatabase>` augmented by
 * `shell/db/schema.ts`). The invariants:
 *
 *  1. PARTITION PRUNING (§0.3): every FACT query supplies the literals
 *     `(reporting_year, report_type, account_category)` (commitments: the pair) as
 *     the FIRST predicates so the planner prunes to ONE leaf. Clean enums are
 *     mapped to partition literals here (constants.ts); the literal NEVER leaks to
 *     the surface but the SQL always uses it. `resolveExecutionGate` enforces it,
 *     and the gate fields are repo-intercepted (the kernel composer never compiles
 *     them with the clean-enum value — the R1 review fix).
 *  2. MV-FIRST ROLLUP (§0.4): summaries/rankings/timeseries/heatmap read the 6 MVs,
 *     never the 126M fact rows. The execution MVs pre-pivot vn/ch into
 *     total_income/total_expense/budget_balance, so an MV read filters only on
 *     (year, report_type) and picks the COLUMN from the metric — NO
 *     `account_category` predicate (it does not exist on the MV).
 *
 * Money is `::text` at the SQL boundary (precision-safe strings, never floats);
 * bigint ids stay strings. Cursor lists use the kernel envelope; the `fhash` binds
 * the cursor to the active filter set (§14.3). No COUNT(*) on the fact tables.
 * Transfer exclusions are baked into the MVs — NEVER re-applied on MV reads.
 */

import { sql } from 'kysely';
import { err, ok, type Result } from 'neverthrow';

import { type ApiError, databaseError } from '@/modules/shared/index.js';

import { makeAggregateReads } from './aggregates.js';
import { makeCatalogReads } from './catalog.js';
import { makeEntityAnalyticsReads } from './entity-analytics.js';
import { makeFundingSourceMap } from './funding-source-map.js';
import { makeLineItemReads } from './line-items.js';
import { makeRankingReads } from './rankings.js';

import type { BudgetRepoContext, BudgetRepoOptions, Db } from './budget-repo-shared.js';
import type { BudgetRepo } from '../../core/ports.js';
import type { BudgetAsOf } from '../../core/types.js';

export type { BudgetRepoOptions } from './budget-repo-shared.js';

export const makeBudgetRepo = (db: Db, options: BudgetRepoOptions = {}): BudgetRepo => {
  // ───────────────────────────────────────────────────────────────────────────
  // funding-source id translation (A1) — stored identity id ⇄ public convention id
  // ───────────────────────────────────────────────────────────────────────────

  const fundingMap = makeFundingSourceMap(db);

  // ───────────────────────────────────────────────────────────────────────────
  // freshness
  // ───────────────────────────────────────────────────────────────────────────

  const asOf = async (): Promise<Result<BudgetAsOf, ApiError>> => {
    try {
      // Both reads hit the small summary MVs (NOT the 126M fact table): the
      // annual MV gives the latest loaded year; the MONTHLY MV gives the latest
      // year with 12 distinct months (the latest COMPLETE year for safe defaults).
      const row = await db
        .selectFrom('budget.mv_execution_summary_annual as mv')
        .select([sql<number | null>`max(mv.year)`.as('latest_year')])
        .executeTakeFirst();
      const completeResult = await sql<{ latest_complete: number | null }>`
        select max(year) as latest_complete from (
          select year, count(distinct month) as mc
          from budget.mv_execution_summary_monthly group by year
        ) y where y.mc >= 12
      `
        .execute(db)
        .catch(() => ({ rows: [] as { latest_complete: number | null }[] }));
      const latestYear = row?.latest_year ?? new Date().getFullYear();
      const latestComplete = completeResult.rows[0]?.latest_complete ?? latestYear - 1;
      return ok({
        latestLoadedYear: latestYear,
        latestCompleteYear: latestComplete,
        refreshedAt: null, // no refresh-timestamp signal in serving yet (plan §10)
      });
    } catch (error) {
      return err(databaseError('asOf failed', error));
    }
  };

  // ───────────────────────────────────────────────────────────────────────────
  // the read families (codebase plan §WP5), each over this one context
  // ───────────────────────────────────────────────────────────────────────────

  const ctx: BudgetRepoContext = { db, options, fundingMap, asOf };

  // ───────────────────────────────────────────────────────────────────────────
  // execution + commitment line items (FACT path) — line-items.ts
  // ───────────────────────────────────────────────────────────────────────────

  const { listExecutionLineItems, getExecutionLineItem, listCommitmentLineItems } =
    makeLineItemReads(ctx);

  // ───────────────────────────────────────────────────────────────────────────
  // entity/period summaries + timeseries — entity-analytics.ts
  // ───────────────────────────────────────────────────────────────────────────

  const {
    getEntitySummary,
    getCommitmentSummary,
    executionTimeseries,
    aggregateTimeseries,
    commitmentTimeseries,
  } = makeEntityAnalyticsReads(ctx);

  // ───────────────────────────────────────────────────────────────────────────
  // rankings — rankings.ts
  // ───────────────────────────────────────────────────────────────────────────

  const { rankEntities, rankEntitiesPage, rankCommitmentEntities } = makeRankingReads(ctx);

  // ───────────────────────────────────────────────────────────────────────────
  // classification aggregate + UAT/county heatmaps — aggregates.ts
  // ───────────────────────────────────────────────────────────────────────────

  const { aggregateByClassification, uatHeatmap, countyHeatmap } = makeAggregateReads(ctx);

  // ───────────────────────────────────────────────────────────────────────────
  // reports + dimensions + budget-official + contributor support — catalog.ts
  // ───────────────────────────────────────────────────────────────────────────

  const {
    listReports,
    getReport,
    listFunctionalClassifications,
    listEconomicClassifications,
    listBudgetSectors,
    listFundingSources,
    listApprovedBudgetFacts,
    budgetVsExecution,
    presenceFor,
    profileSlice,
  } = makeCatalogReads(ctx);

  return {
    asOf,
    listExecutionLineItems,
    getExecutionLineItem,
    listCommitmentLineItems,
    getEntitySummary,
    getCommitmentSummary,
    executionTimeseries,
    aggregateTimeseries,
    commitmentTimeseries,
    rankEntities,
    rankEntitiesPage,
    rankCommitmentEntities,
    aggregateByClassification,
    uatHeatmap,
    countyHeatmap,
    listReports,
    getReport,
    listFunctionalClassifications,
    listEconomicClassifications,
    listBudgetSectors,
    listFundingSources,
    listApprovedBudgetFacts,
    budgetVsExecution,
    presenceFor,
    profileSlice,
  };
};
