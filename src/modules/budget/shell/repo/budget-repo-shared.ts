/**
 * Budget repository — helpers shared by the per-concern read families
 * (codebase plan §WP5): limits, SQL fragments, MV name resolution, the
 * commitment metric column maps and row mappers, and the context every
 * family receives from `makeBudgetRepo`. Moved out of `budget-repo.ts`
 * unchanged; see that file's header for the two load-bearing invariants.
 */
import { sql, type Kysely, type RawBuilder, type SqlBool } from 'kysely';

import { isCountyTerritory, type ApiError, type ProdDatabase } from '@/modules/shared/index.js';

import { commitReportType } from './mappers.js';

import type { FundingSourceMap, FundingSourceMapLoader } from './funding-source-map.js';
import type { BudgetFrequency } from '../../core/constants.js';
import type { FactorSource } from '../../core/legacy-analytics/ports.js';
import type { BudgetAsOf, BudgetSeriesPoint, CommitmentEntitySummary } from '../../core/types.js';
import type { Result } from 'neverthrow';

export type Db = Kysely<ProdDatabase>;

export const FACT_LIMIT_MAX = 100;
export const AGG_LIMIT_MAX = 100;
export const COMPLETE_AGGREGATE_GUARD = 10_000;
export const RANK_LIMIT_MAX = 100;
export const RANK_PAGE_LIMIT_MAX = 500;
export const DIM_LIMIT_MAX = 200;
export const OFFICIAL_PAGE_MAX = 100;
export const DECIMAL_MONEY_PATTERN = /^-?\d+(\.\d+)?$/u;

export const clamp = (n: number, lo: number, hi: number): number =>
  Math.min(Math.max(Math.floor(n), lo), hi);

export const composeAnd = (conds: readonly RawBuilder<unknown>[]): RawBuilder<SqlBool> =>
  conds.length === 0 ? sql<SqlBool>`true` : sql<SqlBool>`${sql.join(conds, sql` and `)}`;

/** ASC/DESC as a SQL fragment (no `sql.raw`, which is banned in repos). */
export const dirSql = (dir: 'asc' | 'desc'): RawBuilder<unknown> =>
  dir === 'asc' ? sql`asc` : sql`desc`;

/**
 * Resolve the execution MV table name (aliased `mv`) for a frequency. All reads
 * select from a SINGLE static type (the annual MV — its column set is the common
 * subset) and swap the runtime table via this name through `selectFrom(name)`;
 * month/quarter columns are read via dynamic `sql.ref('mv.month')` so the static
 * type never needs them. This keeps Kysely typing stable (a union of aliased
 * literals collapses the builder to `never` because the 3 MVs differ).
 */
export type ExecMvName = 'budget.mv_execution_summary_annual as mv';
export type CommitMvName = 'budget.mv_commitment_summary_annual as mv';

export const execMvName = (freq: BudgetFrequency): ExecMvName =>
  (freq === 'MONTH'
    ? 'budget.mv_execution_summary_monthly as mv'
    : freq === 'QUARTER'
      ? 'budget.mv_execution_summary_quarterly as mv'
      : 'budget.mv_execution_summary_annual as mv') as ExecMvName;

export const commitMvName = (freq: BudgetFrequency): CommitMvName =>
  (freq === 'MONTH'
    ? 'budget.mv_commitment_summary_monthly as mv'
    : freq === 'QUARTER'
      ? 'budget.mv_commitment_summary_quarterly as mv'
      : 'budget.mv_commitment_summary_annual as mv') as CommitMvName;

/** The MV money column an execution ranking/series metric selects (§0.4). */
export const metricColumn = (
  m: 'INCOME' | 'EXPENSE' | 'BALANCE'
): 'total_income' | 'total_expense' | 'budget_balance' =>
  m === 'INCOME' ? 'total_income' : m === 'EXPENSE' ? 'total_expense' : 'budget_balance';

/** Canonical county population rule of the heatmaps (rankings and series read the admitted population relation). */
export const canonicalCountyPopulationAggregate = (alias: string): RawBuilder<unknown> =>
  sql`max(${sql.ref(`${alias}.population`)}) filter (where ${isCountyTerritory(alias)})`;

/**
 * The MONTHLY commitment MV carries ONLY these 4 cumulative metrics (+ a separate
 * `receptii_neplatite_change` delta this module does not surface). Every other
 * metric is a gap at MONTH grain and is returned as `null` — selecting it would
 * reference a non-existent column and crash (R1 review, found by both reviewers).
 */
export const MONTHLY_COMMITMENT_METRICS = new Set([
  'crediteAngajament',
  'platiTrezor',
  'platiNonTrezor',
  'receptiiTotale',
]);
/** A camelCase metric is unavailable at MONTH grain iff the monthly MV lacks it. */
export const monthlyCommitmentGap = (camelMetric: string): boolean =>
  !MONTHLY_COMMITMENT_METRICS.has(camelMetric);

export interface BudgetRepoOptions {
  /** Present for native serving; exact-year failures never fall back to embedded factors. */
  readonly moneyFactors?: FactorSource;
  /** At most one row per territory/year; caller owns the complete read snapshot. */
  readonly populationRelation?: (selection: {
    readonly territoryIds: readonly number[];
    readonly years: readonly number[];
  }) => Promise<Result<RawBuilder<unknown>, ApiError>>;
}

/** Re-expose fact-row `fundingSourceId` as the PUBLIC (conventional) id. */
export const withPublicFunding = <T extends { readonly fundingSourceId: number }>(
  items: readonly T[],
  fm: FundingSourceMap
): T[] => items.map((it) => ({ ...it, fundingSourceId: fm.toPublicId(it.fundingSourceId) }));

// ── helpers shared outside the closure ────────────────────────────────────────

/** snake_case → camelCase (for the monthly-MV gap check). */
export const toCamel = (s: string): string =>
  s.replace(/_([a-z])/gu, (_m, c: string) => c.toUpperCase());

/** All ytd/monthly/quarterly/latest commitment fact columns (in CommitmentRow order). */
export const COMMIT_FACT_METRIC_COLUMNS = [
  'ytd_credite_angajament',
  'monthly_credite_angajament',
  'quarterly_credite_angajament',
  'credite_angajament',
  'ytd_limita_credit_angajament',
  'monthly_limita_credit_angajament',
  'quarterly_limita_credit_angajament',
  'limita_credit_angajament',
  'ytd_credite_bugetare',
  'monthly_credite_bugetare',
  'quarterly_credite_bugetare',
  'credite_bugetare',
  'ytd_credite_angajament_initiale',
  'monthly_credite_angajament_initiale',
  'quarterly_credite_angajament_initiale',
  'credite_angajament_initiale',
  'ytd_credite_bugetare_initiale',
  'monthly_credite_bugetare_initiale',
  'quarterly_credite_bugetare_initiale',
  'credite_bugetare_initiale',
  'ytd_credite_angajament_definitive',
  'monthly_credite_angajament_definitive',
  'quarterly_credite_angajament_definitive',
  'credite_angajament_definitive',
  'ytd_credite_bugetare_definitive',
  'monthly_credite_bugetare_definitive',
  'quarterly_credite_bugetare_definitive',
  'credite_bugetare_definitive',
  'ytd_credite_angajament_disponibile',
  'monthly_credite_angajament_disponibile',
  'quarterly_credite_angajament_disponibile',
  'credite_angajament_disponibile',
  'ytd_credite_bugetare_disponibile',
  'monthly_credite_bugetare_disponibile',
  'quarterly_credite_bugetare_disponibile',
  'credite_bugetare_disponibile',
  'ytd_receptii_totale',
  'monthly_receptii_totale',
  'quarterly_receptii_totale',
  'receptii_totale',
  'ytd_plati_trezor',
  'monthly_plati_trezor',
  'quarterly_plati_trezor',
  'plati_trezor',
  'ytd_plati_non_trezor',
  'monthly_plati_non_trezor',
  'quarterly_plati_non_trezor',
  'plati_non_trezor',
  'ytd_receptii_neplatite',
  'monthly_receptii_neplatite',
  'quarterly_receptii_neplatite',
  'receptii_neplatite',
] as const;

/** Map a commitment MV summary row (camelCase metric fields) to the view model. */
export const mapCommitmentSummaryRow = (r: Record<string, unknown>): CommitmentEntitySummary => {
  const m = (col: string): string | null => (r[col] as string | null) ?? null;
  return {
    entityCui: r['entity_cui'] as string,
    mainCreditorCui: (r['main_creditor_cui'] as string | null) ?? null,
    reportType: commitReportType(r['report_type'] as string),
    period: {
      year: r['year'] as number,
      month: (r['month'] as number | null) ?? null,
      quarter: (r['quarter'] as number | null) ?? null,
    },
    crediteAngajament: m('credite_angajament'),
    limitaCreditAngajament: m('limita_credit_angajament'),
    crediteBugetare: m('credite_bugetare'),
    crediteAngajamentInitiale: m('credite_angajament_initiale'),
    crediteBugetareInitiale: m('credite_bugetare_initiale'),
    crediteAngajamentDefinitive: m('credite_angajament_definitive'),
    crediteBugetareDefinitive: m('credite_bugetare_definitive'),
    crediteAngajamentDisponibile: m('credite_angajament_disponibile'),
    crediteBugetareDisponibile: m('credite_bugetare_disponibile'),
    receptiiTotale: m('receptii_totale'),
    platiTrezor: m('plati_trezor'),
    platiNonTrezor: m('plati_non_trezor'),
    receptiiNeplatite: m('receptii_neplatite'),
  };
};

/** Build a series point with the right period label for the frequency. */
export const seriesPoint = (
  year: number,
  period: number | null,
  freq: BudgetFrequency,
  amount: string
): BudgetSeriesPoint => {
  const y = String(year);
  const label =
    freq === 'MONTH'
      ? `${y}-${String(period ?? 0).padStart(2, '0')}`
      : freq === 'QUARTER'
        ? `${y}-Q${String(period ?? 0)}`
        : y;
  return {
    period: {
      year,
      month: freq === 'MONTH' ? period : null,
      quarter: freq === 'QUARTER' ? period : null,
    },
    periodLabel: label,
    amount,
  };
};

/** What every extracted read family receives from `makeBudgetRepo` (WP5). */
export interface BudgetRepoContext {
  readonly db: Db;
  readonly options: BudgetRepoOptions;
  readonly fundingMap: FundingSourceMapLoader;
  /** The freshness read; the MV families derive their default year from it. */
  readonly asOf: () => Promise<Result<BudgetAsOf, ApiError>>;
}
