/**
 * Procurement module — the 5 scope aggregates over the monthly rollups.
 *
 * PERFORMANCE (measured live 2026-07-09; statement timeout 15s):
 *   The empty-scope stats as ONE fused query (sums + 2 distincts, grouped) took
 *   14.6s — at the timeout edge. Decomposed and run CONCURRENTLY it is ~1.6s:
 *     sums + min/max, grouped by grain  1.57s
 *     count(distinct authority_cui)     0.64s   (ungrouped — grouping costs 5.8s)
 *     count(distinct supplier_cui)      0.92s   (ungrouped — grouping costs 6.0s)
 *   The distincts are deliberately UNGROUPED: a buyer active on both grains must be
 *   counted once, so summing per-grain distincts would over-count anyway.
 *
 * MONEY. `amount_ron_sum` is summed only for the spend-approved grains, via a
 * `filter (where source_grain in (…))` clause. A grain outside that set contributes
 * NOTHING (not zero) and its `amountRonSum` surfaces as null.
 */

import { sql, type Kysely, type RawBuilder, type SqlBool } from 'kysely';
import { err, ok, type Result } from 'neverthrow';

import { databaseError, type ApiError, type ProdDatabase } from '@/modules/shared/index.js';

import { monthStart, rankByValue, routeScope, type ScopeSource } from '../../core/scope.js';

import type { ScopeFlowStats } from '../../core/ports.js';
import type {
  CategoryRow,
  MonthlyPoint,
  ProcurementGrain,
  ScopeFilter,
  TopPartyRow,
} from '../../core/types.js';

type Db = Kysely<ProdDatabase>;

const TOPN_MAX = 50;

const MV: Readonly<Record<ScopeSource, string>> = {
  org_edge: 'procurement.org_edge_monthly_rollups',
  supplier_cpv: 'procurement.supplier_cpv_division_monthly_rollups',
};

const composeAnd = (conds: readonly RawBuilder<unknown>[]): RawBuilder<SqlBool> =>
  conds.length === 0 ? sql<SqlBool>`true` : sql<SqlBool>`${sql.join(conds, sql` and `)}`;

const grainList = (grains: readonly ProcurementGrain[]): RawBuilder<unknown> =>
  sql.join(
    grains.map((g) => sql`${g}`),
    sql`, `
  );

/**
 * The pruning predicate every scope query carries: the grain set, the caller's month
 * window (if any), and the scope dimensions themselves.
 *
 * NO implicit month floor. The legacy edge repo floors at `ROLLUP_MIN_MONTH`
 * (2011-07-01) so its dims index range-scans, but the MVs actually start at
 * 2007-03-01, and that floor silently drops the earliest bucket — which is exactly
 * the bucket `min(first_flow_date)` reports. `procurementStats.firstFlowDate` would
 * then claim 2011 for a flow the DB dates to 2007-03-12. Measured live, the floor
 * buys nothing here: the empty scope scans the MV either way (1.5–2.0s), and an
 * entity scope is driven by its cui index.
 */
const scopeConditions = (
  scope: ScopeFilter,
  grains: readonly ProcurementGrain[],
  source: ScopeSource
): RawBuilder<unknown>[] => {
  const conds: RawBuilder<unknown>[] = [sql`source_grain in (${grainList(grains)})`];
  if (scope.monthFrom !== undefined) conds.push(sql`month_start >= ${monthStart(scope.monthFrom)}::date`);
  if (scope.monthTo !== undefined) conds.push(sql`month_start <= ${monthStart(scope.monthTo)}::date`);
  if (scope.authorityCui !== undefined) conds.push(sql`authority_cui = ${scope.authorityCui}`);
  if (scope.supplierCui !== undefined) conds.push(sql`supplier_cui = ${scope.supplierCui}`);
  if (scope.cpvDivision !== undefined) {
    if (source !== 'supplier_cpv') {
      // Unreachable: `routeScope` sends any cpvDivision scope to the CPV MV. Guard
      // rather than silently drop the predicate (which would widen the answer).
      throw new Error('cpvDivision scope routed to a rollup without a CPV dimension');
    }
    conds.push(sql`cpv_division_code = ${scope.cpvDivision}`);
  }
  return conds;
};

/** `sum(amount_ron_sum) filter (where source_grain in (spendGrains))`, or NULL. */
const spendSum = (
  column: string,
  spendGrains: readonly ProcurementGrain[]
): RawBuilder<string | null> => {
  if (spendGrains.length === 0) return sql<string | null>`null::text`;
  return sql<string | null>`sum(${sql.ref(column)}) filter (where source_grain in (${grainList(spendGrains)}))::text`;
};

/**
 * Amount presence/absence are COUNTS, and counts are never gate-blocked — only the
 * SUM is. So these span every in-scope grain even when its money is suppressed:
 * "1.6M contract flows carry an amount we may not total" is the honest statement.
 */
const presenceCount = (column: string): RawBuilder<string> =>
  sql<string>`coalesce(sum(${sql.ref(column)}), 0)::text`;

export interface ProcurementScopeAggRepo {
  scopeStats(
    scope: ScopeFilter,
    grains: readonly ProcurementGrain[],
    spendGrains: readonly ProcurementGrain[]
  ): Promise<Result<ScopeFlowStats, ApiError>>;
  scopeTopParties(
    scope: ScopeFilter,
    grains: readonly ProcurementGrain[],
    spendGrains: readonly ProcurementGrain[],
    side: 'authority' | 'supplier',
    topN: number
  ): Promise<Result<readonly TopPartyRow[], ApiError>>;
  scopeCategoryBreakdown(
    scope: ScopeFilter,
    grains: readonly ProcurementGrain[],
    spendGrains: readonly ProcurementGrain[]
  ): Promise<Result<readonly CategoryRow[], ApiError>>;
  scopeSpendOverTime(
    scope: ScopeFilter,
    grains: readonly ProcurementGrain[],
    spendGrains: readonly ProcurementGrain[]
  ): Promise<Result<readonly MonthlyPoint[], ApiError>>;
}

export const makeScopeAggRepo = (db: Db): ProcurementScopeAggRepo => {
  // ── stats: 3 concurrent statements (see the header measurements) ───────────

  const scopeStats = async (
    scope: ScopeFilter,
    grains: readonly ProcurementGrain[],
    spendGrains: readonly ProcurementGrain[]
  ): Promise<Result<ScopeFlowStats, ApiError>> => {
    const source = routeScope(scope, false);
    const table = sql.table(MV[source]);
    const where = composeAnd(scopeConditions(scope, grains, source));
    try {
      const [perGrain, buyers, suppliers] = await Promise.all([
        sql<{
          source_grain: string;
          flow_count: string;
          amount_ron_sum: string | null;
          first_flow_date: string | null;
          last_flow_date: string | null;
        }>`
          select source_grain,
                 sum(flow_count)::text as flow_count,
                 sum(amount_ron_sum)::text as amount_ron_sum,
                 min(first_flow_date)::text as first_flow_date,
                 max(last_flow_date)::text as last_flow_date
            from ${table}
           where ${where}
           group by source_grain
        `.execute(db),
        sql<{ n: string }>`select count(distinct authority_cui)::text as n from ${table} where ${where}`.execute(db),
        sql<{ n: string }>`select count(distinct supplier_cui)::text as n from ${table} where ${where}`.execute(db),
      ]);

      const byGrain = new Map(perGrain.rows.map((r) => [r.source_grain as ProcurementGrain, r]));
      const spendSet = new Set(spendGrains);

      // Sum money across the spend-approved grains only. A single suppressed grain
      // contributes nothing; if none is approved the total is null, not 0.
      let total: string | null = null;
      for (const grain of grains) {
        if (!spendSet.has(grain)) continue;
        const amount = byGrain.get(grain)?.amount_ron_sum ?? null;
        if (amount === null) continue;
        total = total === null ? amount : addDecimalStrings(total, amount);
      }

      const dates = perGrain.rows
        .flatMap((r) => [r.first_flow_date, r.last_flow_date])
        .filter((d): d is string => d !== null)
        .sort();

      return ok({
        totalValueRon: total,
        contractsCount: byGrain.get('procurement_contract')?.flow_count ?? '0',
        directAcquisitionsCount: byGrain.get('direct_acquisition')?.flow_count ?? '0',
        buyersCount: buyers.rows[0]?.n ?? '0',
        suppliersCount: suppliers.rows[0]?.n ?? '0',
        firstFlowDate: dates[0] ?? null,
        lastFlowDate: dates[dates.length - 1] ?? null,
      });
    } catch (error) {
      return err(databaseError('scopeStats failed', error));
    }
  };

  // ── top authorities / suppliers ────────────────────────────────────────────

  const scopeTopParties = async (
    scope: ScopeFilter,
    grains: readonly ProcurementGrain[],
    spendGrains: readonly ProcurementGrain[],
    side: 'authority' | 'supplier',
    topN: number
  ): Promise<Result<readonly TopPartyRow[], ApiError>> => {
    const limit = Math.min(Math.max(Math.floor(topN), 1), TOPN_MAX);
    const source = routeScope(scope, false);
    const table = sql.table(MV[source]);
    const where = composeAnd(scopeConditions(scope, grains, source));
    const cuiColumn = side === 'authority' ? 'authority_cui' : 'supplier_cui';
    const nameColumn = side === 'authority' ? 'authority_name' : 'supplier_name';
    const cui = sql.ref(cuiColumn);
    const name = sql.ref(nameColumn);

    // Rows are (party, grain) — NEVER one row summing both grains. Ranking compares
    // across grains, which is a comparison, not a sum. Rank by value only when EVERY
    // in-scope grain is spend-approved; otherwise the suppressed grain's null amount
    // would sink its rows regardless of size, so rank by flow_count (§14.6 / I6).
    const orderBy = rankByValue(grains, spendGrains)
      ? sql`sum(amount_ron_sum) desc nulls last`
      : sql`sum(flow_count) desc`;
    try {
      const result = await sql<{
        cui: string;
        name: string | null;
        source_grain: string;
        flow_count: string;
        amount_ron_sum: string | null;
        amount_present_count: string;
        amount_missing_count: string;
        first_flow_date: string | null;
        last_flow_date: string | null;
      }>`
        select ${cui} as cui,
               max(${name}) as name,
               source_grain,
               sum(flow_count)::text as flow_count,
               ${spendSum('amount_ron_sum', spendGrains)} as amount_ron_sum,
               ${presenceCount('amount_present_count')} as amount_present_count,
               ${presenceCount('amount_missing_count')} as amount_missing_count,
               min(first_flow_date)::text as first_flow_date,
               max(last_flow_date)::text as last_flow_date
          from ${table}
         where ${where}
         group by ${cui}, source_grain
         order by ${orderBy}, ${cui} asc
         limit ${sql.lit(limit)}
      `.execute(db);

      return ok(
        result.rows.map((r) => ({
          authorityCui: side === 'authority' ? r.cui : null,
          authorityName: side === 'authority' ? r.name : null,
          supplierCui: side === 'supplier' ? r.cui : null,
          supplierName: side === 'supplier' ? r.name : null,
          grain: r.source_grain as ProcurementGrain,
          flowCount: r.flow_count,
          amountRonSum: r.amount_ron_sum,
          amountPresentCount: r.amount_present_count,
          amountMissingCount: r.amount_missing_count,
          firstFlowDate: r.first_flow_date,
          lastFlowDate: r.last_flow_date,
          // Per-month in the rollup; an edge aggregated across months has no single
          // canonical sample. Per-row evidence is reachable via the search lists.
          evidenceRefsSample: [],
        }))
      );
    } catch (error) {
      return err(databaseError('scopeTopParties failed', error));
    }
  };

  // ── category breakdown (always a CPV MV) ───────────────────────────────────

  const scopeCategoryBreakdown = async (
    scope: ScopeFilter,
    grains: readonly ProcurementGrain[],
    spendGrains: readonly ProcurementGrain[]
  ): Promise<Result<readonly CategoryRow[], ApiError>> => {
    const source = routeScope(scope, true);
    const table = sql.table(MV[source]);
    const where = composeAnd(scopeConditions(scope, grains, source));
    try {
      const result = await sql<{
        cpv_division_code: string | null;
        cpv_division_label_en: string | null;
        label_ro: string | null;
        source_grain: string;
        flow_count: string;
        amount_ron_sum: string | null;
        amount_present_count: string;
        amount_missing_count: string;
      }>`
        select r.cpv_division_code,
               max(r.cpv_division_label_en) as cpv_division_label_en,
               max(cd.label_ro) as label_ro,
               r.source_grain,
               sum(r.flow_count)::text as flow_count,
               ${spendSum('r.amount_ron_sum', spendGrains)} as amount_ron_sum,
               ${presenceCount('r.amount_present_count')} as amount_present_count,
               ${presenceCount('r.amount_missing_count')} as amount_missing_count
          from ${table} as r
          left join procurement.cpv_divisions cd on cd.division_code = r.cpv_division_code
         where ${where}
         group by r.cpv_division_code, r.source_grain
         order by sum(r.flow_count) desc, r.cpv_division_code asc
      `.execute(db);

      return ok(
        result.rows.map((r) => ({
          cpvDivisionCode: r.cpv_division_code,
          cpvDivisionLabelEn: r.cpv_division_label_en,
          cpvDivisionLabelRo: r.label_ro,
          grain: r.source_grain as ProcurementGrain,
          flowCount: r.flow_count,
          amountRonSum: r.amount_ron_sum,
          amountPresentCount: r.amount_present_count,
          amountMissingCount: r.amount_missing_count,
        }))
      );
    } catch (error) {
      return err(databaseError('scopeCategoryBreakdown failed', error));
    }
  };

  // ── spend over time (one point per MONTH, grains merged) ───────────────────

  const scopeSpendOverTime = async (
    scope: ScopeFilter,
    grains: readonly ProcurementGrain[],
    spendGrains: readonly ProcurementGrain[]
  ): Promise<Result<readonly MonthlyPoint[], ApiError>> => {
    const source = routeScope(scope, false);
    const table = sql.table(MV[source]);
    const where = composeAnd(scopeConditions(scope, grains, source));
    try {
      // `flowCount` sums every in-scope grain (counts merge); the amount columns
      // sum only the spend-approved ones. The client keys its timeline on `month`,
      // so a per-grain row here would break it.
      const result = await sql<{
        month: string;
        flow_count: string;
        amount_ron_sum: string | null;
        amount_present_count: string;
        amount_missing_count: string;
      }>`
        select to_char(month_start, 'YYYY-MM') as month,
               sum(flow_count)::text as flow_count,
               ${spendSum('amount_ron_sum', spendGrains)} as amount_ron_sum,
               ${presenceCount('amount_present_count')} as amount_present_count,
               ${presenceCount('amount_missing_count')} as amount_missing_count
          from ${table}
         where ${where}
         group by month_start
         order by month_start asc
      `.execute(db);
      return ok(
        result.rows.map((r) => ({
          month: r.month,
          flowCount: r.flow_count,
          amountRonSum: r.amount_ron_sum,
          amountPresentCount: r.amount_present_count,
          amountMissingCount: r.amount_missing_count,
        }))
      );
    } catch (error) {
      return err(databaseError('scopeSpendOverTime failed', error));
    }
  };

  return { scopeStats, scopeTopParties, scopeCategoryBreakdown, scopeSpendOverTime };
};

/**
 * Add two fixed-scale RON decimal strings without touching a float. Both operands
 * come from `numeric(20,2)::text`, so they carry at most two fraction digits.
 */
export const addDecimalStrings = (a: string, b: string): string => {
  const scale = (s: string): bigint => {
    const negative = s.startsWith('-');
    const body = negative ? s.slice(1) : s;
    const [whole = '0', fraction = ''] = body.split('.');
    const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0').slice(0, 2));
    return negative ? -cents : cents;
  };
  const total = scale(a) + scale(b);
  const negative = total < 0n;
  const abs = negative ? -total : total;
  const whole = abs / 100n;
  const cents = abs % 100n;
  return `${negative ? '-' : ''}${whole.toString()}.${cents.toString().padStart(2, '0')}`;
};
