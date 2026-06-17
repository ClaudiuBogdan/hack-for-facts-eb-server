/**
 * Procurement module — aggregate repository (plan §3a(2)). The ONLY place that
 * reads the 5 materialized views + the grain gate. NEVER scans the 20M-row fact
 * tables — all top-N / concentration / category / same-day answers come from the
 * pre-aggregated MVs, pruned by `source_grain = $g AND month_start BETWEEN …` +
 * the dimension equality (an index range-scan; verified EXPLAIN-bound).
 *
 * The gate (`aggregate_quality_by_grain`) is read by the USECASE, not here — this
 * repo trusts the usecase to have consulted it. The one exception: the BASIS for
 * concentration (value vs count) is passed in by the usecase from the live gate.
 *
 * Money is `::text`; bigint counts are `::text`. `month_start` floors to
 * `ROLLUP_MIN_MONTH` so the dims index always range-scans (never seq-scans the MV).
 */

import { sql, type Kysely, type RawBuilder, type SqlBool } from 'kysely';
import { err, ok, type Result } from 'neverthrow';

import {
  databaseError,
  invalidInput,
  normalizeCui,
  type ApiError,
  type ProdDatabase,
  type SourcePresence,
} from '@/modules/shared/index.js';

import { mapEdge } from './mappers.js';
import { PROCUREMENT_GRAIN_NOTE, ROLLUP_MIN_MONTH } from '../../core/constants.js';

import type {
  OffsetPageRequest,
  OffsetResult,
  ProcurementAggregateRepo,
} from '../../core/ports.js';
import type {
  AuthorityCpvRow,
  CpvAggFilter,
  EdgeAggFilter,
  GrainQuality,
  ProcurementEdge,
  ProcurementGrain,
  ProcurementProfileSlice,
  ProcurementRoleSummary,
  RegionCpvAggFilter,
  SameDayCandidate,
  SplitFilter,
  SupplierConcentration,
  SupplierCpvRow,
} from '../../core/types.js';

type Db = Kysely<ProdDatabase>;

const TOPN_MAX = 100;
const SAME_DAY_PAGE_MAX = 100;
const PROFILE_TOP = 5;

const clamp = (n: number, lo: number, hi: number): number =>
  Math.min(Math.max(Math.floor(n), lo), hi);

const composeAnd = (conds: readonly RawBuilder<unknown>[]): RawBuilder<SqlBool> =>
  conds.length === 0 ? sql<SqlBool>`true` : sql<SqlBool>`${sql.join(conds, sql` and `)}`;

/** The mandatory pruning predicate: source_grain + a bounded month_start range. */
const monthGrainPredicate = (
  alias: string,
  grain: ProcurementGrain,
  monthFrom: string | undefined,
  monthTo: string | undefined
): RawBuilder<unknown>[] => {
  const ms = sql.ref(`${alias}.month_start`);
  const from = monthFrom ?? ROLLUP_MIN_MONTH; // floor → index always range-scans
  const conds: RawBuilder<unknown>[] = [
    sql`${sql.ref(`${alias}.source_grain`)} = ${grain}`,
    sql`${ms} >= ${from}::date`,
  ];
  if (monthTo !== undefined) conds.push(sql`${ms} <= ${monthTo}::date`);
  return conds;
};

export const makeProcurementAggregateRepo = (db: Db): ProcurementAggregateRepo => {
  // ───────────────────────────────────────────────────────────────────────────
  // grain gate (the 2-row MV)
  // ───────────────────────────────────────────────────────────────────────────

  const grainQuality = async (): Promise<Result<readonly GrainQuality[], ApiError>> => {
    try {
      const rows = await db
        .selectFrom('procurement.aggregate_quality_by_grain as g')
        .select([
          'g.source_grain',
          sql<string>`g.rows_count::text`.as('rows_count'),
          sql<number>`g.authority_cui_coverage_rate::float8`.as('authority_cui_coverage_rate'),
          sql<number>`g.supplier_cui_coverage_rate::float8`.as('supplier_cui_coverage_rate'),
          sql<number>`g.amount_coverage_rate::float8`.as('amount_coverage_rate'),
          sql<number>`g.cpv_coverage_rate::float8`.as('cpv_coverage_rate'),
          sql<number>`g.date_coverage_rate::float8`.as('date_coverage_rate'),
          sql<number>`g.authority_territory_coverage_rate::float8`.as(
            'authority_territory_coverage_rate'
          ),
          'g.filter_answers_allowed',
          'g.spend_rankings_allowed',
          'g.supplier_region_filters_allowed',
          sql<string[] | null>`g.blockers`.as('blockers'),
          sql<string | null>`g.refreshed_at::text`.as('refreshed_at'),
          'g.projection_version',
        ])
        .execute();
      return ok(
        rows.map((r) => ({
          grain: r.source_grain as ProcurementGrain,
          rowsCount: r.rows_count,
          authorityCuiCoverageRate: r.authority_cui_coverage_rate,
          supplierCuiCoverageRate: r.supplier_cui_coverage_rate,
          amountCoverageRate: r.amount_coverage_rate,
          cpvCoverageRate: r.cpv_coverage_rate,
          dateCoverageRate: r.date_coverage_rate,
          authorityTerritoryCoverageRate: r.authority_territory_coverage_rate,
          filterAnswersAllowed: r.filter_answers_allowed,
          spendRankingsAllowed: r.spend_rankings_allowed,
          supplierRegionFiltersAllowed: r.supplier_region_filters_allowed,
          blockers: r.blockers ?? [],
          refreshedAt: r.refreshed_at,
          projectionVersion: r.projection_version,
        }))
      );
    } catch (error) {
      return err(databaseError('grainQuality failed', error));
    }
  };

  // ───────────────────────────────────────────────────────────────────────────
  // org_edge rollups (PC-1 / PC-3 / PC-6) — aggregate months → one edge row
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Aggregate org_edge monthly rows for an anchor (authority or supplier) into edge
   * rows over the whole period, ordered by the gate-chosen basis (value or count).
   */
  const edgesForAnchor = async (
    anchorCol: 'authority_cui' | 'supplier_cui',
    cui: string,
    f: EdgeAggFilter,
    orderByValue: boolean
  ): Promise<Result<readonly ProcurementEdge[], ApiError>> => {
    const norm = normalizeCui(cui);
    if (norm === null) return err(invalidInput('invalid CUI format', 'cui'));
    const limit = clamp(f.topN, 1, TOPN_MAX);
    const conds: RawBuilder<unknown>[] = [
      sql`${sql.ref(`oe.${anchorCol}`)} = ${norm}`,
      ...monthGrainPredicate('oe', f.grain, f.monthFrom, f.monthTo),
    ];
    try {
      const orderExpr = orderByValue
        ? sql`sum(oe.amount_ron_sum) desc nulls last`
        : sql`sum(oe.flow_count) desc`;
      const rows = await db
        .selectFrom('procurement.org_edge_monthly_rollups as oe')
        .select([
          'oe.authority_cui',
          sql<string | null>`max(oe.authority_name)`.as('authority_name'),
          'oe.supplier_cui',
          sql<string | null>`max(oe.supplier_name)`.as('supplier_name'),
          sql<string>`max(oe.source_grain)`.as('source_grain'),
          sql<string>`sum(oe.flow_count)::text`.as('flow_count'),
          sql<string | null>`sum(oe.amount_ron_sum)::text`.as('amount_ron_sum'),
          sql<string>`sum(oe.amount_present_count)::text`.as('amount_present_count'),
          sql<string>`sum(oe.amount_missing_count)::text`.as('amount_missing_count'),
          sql<string | null>`min(oe.first_flow_date)::text`.as('first_flow_date'),
          sql<string | null>`max(oe.last_flow_date)::text`.as('last_flow_date'),
          // Evidence sample is per-MONTH in the rollup; an edge aggregated across
          // months has no single canonical sample, so this multi-month rollup
          // returns none. Per-row evidence is reachable via the base DA/contract list.
          sql<string[]>`'{}'::text[]`.as('evidence_refs_sample'),
        ])
        .where(composeAnd(conds))
        .groupBy(['oe.authority_cui', 'oe.supplier_cui'])
        .orderBy(orderExpr)
        .limit(limit)
        .execute();
      return ok(rows.map((r) => mapEdge(r)));
    } catch (error) {
      return err(databaseError('edgesForAnchor failed', error));
    }
  };

  const topSuppliersForAuthority = (
    cui: string,
    f: EdgeAggFilter,
    orderByValue: boolean
  ): Promise<Result<readonly ProcurementEdge[], ApiError>> =>
    edgesForAnchor('authority_cui', cui, f, orderByValue);

  const topAuthoritiesForSupplier = (
    cui: string,
    f: EdgeAggFilter,
    orderByValue: boolean
  ): Promise<Result<readonly ProcurementEdge[], ApiError>> =>
    edgesForAnchor('supplier_cui', cui, f, orderByValue);

  /**
   * PC-6 repeated pairs: edges (anchored on one side) active in ≥ minMonths distinct
   * months, ordered by recurrence (distinct months desc).
   */
  const repeatedPairs = async (
    cui: string,
    side: 'authority' | 'supplier',
    f: EdgeAggFilter
  ): Promise<Result<readonly ProcurementEdge[], ApiError>> => {
    const norm = normalizeCui(cui);
    if (norm === null) return err(invalidInput('invalid CUI format', 'cui'));
    const anchorCol = side === 'authority' ? 'authority_cui' : 'supplier_cui';
    const minMonths = Math.max(2, f.minMonths ?? 2);
    const limit = clamp(f.topN, 1, TOPN_MAX);
    const conds: RawBuilder<unknown>[] = [
      sql`${sql.ref(`oe.${anchorCol}`)} = ${norm}`,
      ...monthGrainPredicate('oe', f.grain, f.monthFrom, f.monthTo),
    ];
    try {
      const rows = await db
        .selectFrom('procurement.org_edge_monthly_rollups as oe')
        .select([
          'oe.authority_cui',
          sql<string | null>`max(oe.authority_name)`.as('authority_name'),
          'oe.supplier_cui',
          sql<string | null>`max(oe.supplier_name)`.as('supplier_name'),
          sql<string>`max(oe.source_grain)`.as('source_grain'),
          sql<string>`sum(oe.flow_count)::text`.as('flow_count'),
          sql<string | null>`sum(oe.amount_ron_sum)::text`.as('amount_ron_sum'),
          sql<string>`sum(oe.amount_present_count)::text`.as('amount_present_count'),
          sql<string>`sum(oe.amount_missing_count)::text`.as('amount_missing_count'),
          sql<string | null>`min(oe.first_flow_date)::text`.as('first_flow_date'),
          sql<string | null>`max(oe.last_flow_date)::text`.as('last_flow_date'),
          sql<string[]>`'{}'::text[]`.as('evidence_refs_sample'),
        ])
        .where(composeAnd(conds))
        .groupBy(['oe.authority_cui', 'oe.supplier_cui'])
        .having(sql<SqlBool>`count(distinct oe.month_start) >= ${minMonths}`)
        .orderBy(sql`count(distinct oe.month_start) desc`)
        .limit(limit)
        .execute();
      return ok(rows.map((r) => mapEdge({ ...r, evidence_refs_sample: [] })));
    } catch (error) {
      return err(databaseError('repeatedPairs failed', error));
    }
  };

  // ───────────────────────────────────────────────────────────────────────────
  // PC-5 supplier concentration / HHI (over org_edge edges for one authority)
  // ───────────────────────────────────────────────────────────────────────────

  const supplierConcentration = async (
    cui: string,
    f: EdgeAggFilter,
    basis: 'value' | 'count'
  ): Promise<Result<SupplierConcentration, ApiError>> => {
    const norm = normalizeCui(cui);
    if (norm === null) return err(invalidInput('invalid CUI format', 'cui'));
    const conds: RawBuilder<unknown>[] = [
      sql`oe.authority_cui = ${norm}`,
      ...monthGrainPredicate('oe', f.grain, f.monthFrom, f.monthTo),
    ];
    // The per-supplier basis measure: value sum (when gate-approved) or flow_count.
    const measure = basis === 'value' ? sql`sum(oe.amount_ron_sum)` : sql`sum(oe.flow_count)`;
    try {
      const rows = await db
        .selectFrom('procurement.org_edge_monthly_rollups as oe')
        .select([sql<string>`coalesce(${measure}, 0)::text`.as('measure')])
        .where(composeAnd(conds))
        .groupBy('oe.supplier_cui')
        .execute();
      const values = rows.map((r) => Number(r.measure)).filter((v) => v > 0);
      const supplierCount = values.length;
      if (supplierCount === 0) {
        return ok({
          authorityCui: norm,
          grain: f.grain,
          supplierCount: 0,
          basis,
          top1Share: null,
          top5Share: null,
          hhi: null,
          totalRon: basis === 'value' ? '0' : null,
          caveats:
            basis === 'count'
              ? ['count-based (spend rankings not gate-approved for this grain)']
              : [],
        });
      }
      const total = values.reduce((a, b) => a + b, 0);
      const sorted = [...values].sort((a, b) => b - a);
      const top1 = sorted[0] ?? 0;
      const top5 = sorted.slice(0, 5).reduce((a, b) => a + b, 0);
      const hhi = values.reduce((acc, v) => acc + (v / total) ** 2, 0); // 0..1 (Herfindahl)
      return ok({
        authorityCui: norm,
        grain: f.grain,
        supplierCount,
        basis,
        top1Share: total > 0 ? top1 / total : null,
        top5Share: total > 0 ? top5 / total : null,
        hhi,
        totalRon: basis === 'value' ? String(total) : null,
        caveats:
          basis === 'count'
            ? ['count-based (spend rankings not gate-approved for this grain)']
            : [],
      });
    } catch (error) {
      return err(databaseError('supplierConcentration failed', error));
    }
  };

  // ───────────────────────────────────────────────────────────────────────────
  // PC-4 authority spend by CPV division
  // ───────────────────────────────────────────────────────────────────────────

  const authorityCpvSpend = async (
    cui: string,
    f: CpvAggFilter,
    orderByValue: boolean
  ): Promise<Result<readonly AuthorityCpvRow[], ApiError>> => {
    const norm = normalizeCui(cui);
    if (norm === null) return err(invalidInput('invalid CUI format', 'cui'));
    const limit = clamp(f.topN, 1, TOPN_MAX);
    const conds: RawBuilder<unknown>[] = [
      sql`ac.authority_cui = ${norm}`,
      ...monthGrainPredicate('ac', f.grain, f.monthFrom, f.monthTo),
    ];
    if (f.cpvDivisions !== undefined && f.cpvDivisions.length > 0) {
      conds.push(
        sql`ac.cpv_division_code in (${sql.join(
          f.cpvDivisions.map((d) => sql`${d}`),
          sql`, `
        )})`
      );
    }
    try {
      const orderExpr = orderByValue
        ? sql`sum(ac.amount_ron_sum) desc nulls last`
        : sql`sum(ac.flow_count) desc`;
      const rows = await db
        .selectFrom('procurement.authority_cpv_division_monthly_rollups as ac')
        .select([
          'ac.authority_cui',
          'ac.cpv_division_code',
          sql<string | null>`max(ac.cpv_division_label_en)`.as('cpv_division_label_en'),
          sql<string>`max(ac.source_grain)`.as('source_grain'),
          sql<string>`sum(ac.flow_count)::text`.as('flow_count'),
          sql<string | null>`sum(ac.amount_ron_sum)::text`.as('amount_ron_sum'),
          sql<string>`sum(ac.distinct_supplier_count)::text`.as('distinct_supplier_count'),
          sql<string | null>`min(ac.first_flow_date)::text`.as('first_flow_date'),
          sql<string | null>`max(ac.last_flow_date)::text`.as('last_flow_date'),
        ])
        .where(composeAnd(conds))
        .groupBy(['ac.authority_cui', 'ac.cpv_division_code'])
        .orderBy(orderExpr)
        .orderBy('ac.cpv_division_code')
        .limit(limit)
        .execute();
      return ok(
        rows.map((r) => ({
          authorityCui: r.authority_cui,
          cpvDivisionCode: r.cpv_division_code,
          cpvDivisionLabelEn: r.cpv_division_label_en,
          grain: r.source_grain as ProcurementGrain,
          flowCount: r.flow_count,
          amountRonSum: r.amount_ron_sum,
          supplierMonthCount: r.distinct_supplier_count,
          firstFlowDate: r.first_flow_date,
          lastFlowDate: r.last_flow_date,
        }))
      );
    } catch (error) {
      return err(databaseError('authorityCpvSpend failed', error));
    }
  };

  // ───────────────────────────────────────────────────────────────────────────
  // PC-2 top suppliers by region × CPV division
  // ───────────────────────────────────────────────────────────────────────────

  const topSuppliersByRegionCpv = async (
    f: RegionCpvAggFilter,
    orderByValue: boolean
  ): Promise<Result<readonly SupplierCpvRow[], ApiError>> => {
    const limit = clamp(f.topN, 1, TOPN_MAX);
    const conds: RawBuilder<unknown>[] = [
      sql`sc.authority_region = ${f.region}`,
      sql`sc.cpv_division_code = ${f.cpvDivision}`,
      ...monthGrainPredicate('sc', f.grain, f.monthFrom, f.monthTo),
    ];
    try {
      const orderExpr = orderByValue
        ? sql`sum(sc.amount_ron_sum) desc nulls last`
        : sql`sum(sc.flow_count) desc`;
      // Aggregate per SUPPLIER across all buyers in the region+CPV (Codex #2): the
      // region + cpv_division are fixed predicates, so the group key is supplier only.
      const rows = await db
        .selectFrom('procurement.supplier_cpv_division_monthly_rollups as sc')
        .select([
          'sc.supplier_cui',
          sql<string | null>`max(sc.supplier_name)`.as('supplier_name'),
          sql<string | null>`max(sc.authority_region)`.as('authority_region'),
          sql<string>`max(sc.source_grain)`.as('source_grain'),
          sql<string>`sum(sc.flow_count)::text`.as('flow_count'),
          sql<string | null>`sum(sc.amount_ron_sum)::text`.as('amount_ron_sum'),
          sql<string>`count(distinct sc.authority_cui)::text`.as('distinct_authority_count'),
        ])
        .where(composeAnd(conds))
        .groupBy('sc.supplier_cui')
        .orderBy(orderExpr)
        .orderBy('sc.supplier_cui')
        .limit(limit)
        .execute();
      return ok(
        rows.map((r) => ({
          supplierCui: r.supplier_cui,
          supplierName: r.supplier_name,
          authorityRegion: r.authority_region ?? f.region,
          cpvDivisionCode: f.cpvDivision,
          grain: r.source_grain as ProcurementGrain,
          flowCount: r.flow_count,
          amountRonSum: r.amount_ron_sum,
          distinctAuthorityCount: r.distinct_authority_count,
        }))
      );
    } catch (error) {
      return err(databaseError('topSuppliersByRegionCpv failed', error));
    }
  };

  // ───────────────────────────────────────────────────────────────────────────
  // PC-7 same-day DA splitting candidates
  // ───────────────────────────────────────────────────────────────────────────

  const sameDaySplittingCandidates = async (
    f: SplitFilter,
    page: OffsetPageRequest
  ): Promise<Result<OffsetResult<SameDayCandidate>, ApiError>> => {
    // Require a selective filter (authority or a date window) — never a bare MV scan.
    if (
      f.authorityCui === undefined &&
      f.candidateDateFrom === undefined &&
      f.candidateDateTo === undefined
    ) {
      return err(
        invalidInput('same-day candidates require authorityCui or a candidateDate window', 'filter')
      );
    }
    const pageNum = clamp(page.page, 1, 100000);
    const pageSize = clamp(page.pageSize, 1, SAME_DAY_PAGE_MAX);
    const conds: RawBuilder<unknown>[] = [
      sql`sd.same_day_count >= ${Math.max(2, f.minSameDayCount)}`,
    ];
    if (f.authorityCui !== undefined) {
      const norm = normalizeCui(f.authorityCui);
      if (norm === null) return err(invalidInput('invalid CUI format', 'authorityCui'));
      conds.push(sql`sd.authority_cui = ${norm}`);
    }
    if (f.candidateDateFrom !== undefined)
      conds.push(sql`sd.candidate_date >= ${f.candidateDateFrom}::date`);
    if (f.candidateDateTo !== undefined)
      conds.push(sql`sd.candidate_date <= ${f.candidateDateTo}::date`);
    if (f.cpvDivision !== undefined) conds.push(sql`sd.cpv_division_code = ${f.cpvDivision}`);
    try {
      const rows = await db
        .selectFrom('procurement.same_day_direct_acquisition_candidates as sd')
        .select([
          sql<string>`sd.candidate_date::text`.as('candidate_date'),
          'sd.authority_cui',
          'sd.authority_name',
          'sd.supplier_cui',
          'sd.supplier_name',
          'sd.cpv_code',
          'sd.cpv_division_code',
          sql<string>`sd.same_day_count::text`.as('same_day_count'),
          sql<string | null>`sd.same_day_total_ron::text`.as('same_day_total_ron'),
          sql<string | null>`sd.max_single_amount_ron::text`.as('max_single_amount_ron'),
          sql<string[] | null>`sd.evidence_refs_sample`.as('evidence_refs_sample'),
        ])
        .where(composeAnd(conds))
        .orderBy('sd.same_day_count', 'desc')
        .orderBy('sd.candidate_date', 'desc')
        // Deterministic tie-breakers so offset pages don't duplicate/shift equal
        // rows between pages (Codex #10).
        .orderBy('sd.authority_cui', 'asc')
        .orderBy('sd.supplier_cui', 'asc')
        .orderBy(sql`sd.cpv_code nulls last`)
        .limit(pageSize)
        .offset((pageNum - 1) * pageSize)
        .execute();
      const items: SameDayCandidate[] = rows.map((r) => ({
        candidateDate: r.candidate_date,
        authorityCui: r.authority_cui,
        authorityName: r.authority_name,
        supplierCui: r.supplier_cui,
        supplierName: r.supplier_name,
        cpvCode: r.cpv_code,
        cpvDivisionCode: r.cpv_division_code,
        sameDayCount: r.same_day_count,
        sameDayTotalRon: r.same_day_total_ron,
        maxSingleAmountRon: r.max_single_amount_ron,
        evidenceRefsSample: r.evidence_refs_sample ?? [],
      }));
      return ok({ items, total: null, estimated: true });
    } catch (error) {
      return err(databaseError('sameDaySplittingCandidates failed', error));
    }
  };

  // ───────────────────────────────────────────────────────────────────────────
  // contributor support (entity-360) — cheap, indexed by cui
  // ───────────────────────────────────────────────────────────────────────────

  const presenceFor = async (rawCui: string): Promise<Result<SourcePresence | null, ApiError>> => {
    const cui = normalizeCui(rawCui);
    if (cui === null) return err(invalidInput('invalid CUI format', 'cui'));
    try {
      // One pass over org_edge for this cui on either side, split by grain + role.
      const rows = await db
        .selectFrom('procurement.org_edge_monthly_rollups as oe')
        .select([
          sql<string>`sum(case when oe.authority_cui = ${cui} then oe.flow_count else 0 end)::text`.as(
            'as_authority'
          ),
          sql<string>`sum(case when oe.supplier_cui = ${cui} then oe.flow_count else 0 end)::text`.as(
            'as_supplier'
          ),
          sql<string | null>`max(oe.last_flow_date)::text`.as('last_flow_date'),
        ])
        .where(sql<SqlBool>`oe.authority_cui = ${cui} or oe.supplier_cui = ${cui}`)
        .executeTakeFirst();
      const asAuthority = Number(rows?.as_authority ?? 0);
      const asSupplier = Number(rows?.as_supplier ?? 0);
      if (asAuthority === 0 && asSupplier === 0) return ok(null);
      const badges: string[] = [];
      if (asAuthority > 0) badges.push('procurement-buyer');
      if (asSupplier > 0) badges.push('procurement-supplier');
      return ok({
        source: 'procurement',
        present: true,
        label: 'Achiziții publice',
        count: asAuthority + asSupplier,
        badges,
        ...(rows?.last_flow_date != null && { asOf: { procurement: rows.last_flow_date } }),
        attrs: { asAuthorityFlows: asAuthority, asSupplierFlows: asSupplier },
      });
    } catch (error) {
      return err(databaseError('presenceFor failed', error));
    }
  };

  /** Build a per-role summary (counts per grain + per-grain RON subtotals + top-5). */
  const roleSummary = async (
    cui: string,
    role: 'authority' | 'supplier',
    gateByGrain: Map<ProcurementGrain, GrainQuality>
  ): Promise<Result<ProcurementRoleSummary, ApiError>> => {
    const anchorCol = role === 'authority' ? 'authority_cui' : 'supplier_cui';
    // Per-grain counts + value subtotals in one indexed pass.
    const totalsRows = await db
      .selectFrom('procurement.org_edge_monthly_rollups as oe')
      .select([
        'oe.source_grain',
        sql<string>`sum(oe.flow_count)::text`.as('flow_count'),
        sql<string | null>`sum(oe.amount_ron_sum)::text`.as('amount_ron_sum'),
      ])
      .where(sql<SqlBool>`${sql.ref(`oe.${anchorCol}`)} = ${cui}`)
      .groupBy('oe.source_grain')
      .execute();

    const byGrain = new Map(totalsRows.map((r) => [r.source_grain as ProcurementGrain, r]));
    const contract = byGrain.get('procurement_contract');
    const da = byGrain.get('direct_acquisition');
    // Value subtotal is surfaced only when that grain's spend is gate-approved.
    const contractSpendOk = gateByGrain.get('procurement_contract')?.spendRankingsAllowed ?? false;
    const daSpendOk = gateByGrain.get('direct_acquisition')?.spendRankingsAllowed ?? false;

    // Top-5 counterparties for the DA grain (the higher-coverage default), ranked by
    // the gate basis for that grain.
    const rankBasis: 'value' | 'count' = daSpendOk ? 'value' : 'count';
    const topR = await edgesForAnchor(
      anchorCol,
      cui,
      { grain: 'direct_acquisition', topN: PROFILE_TOP },
      daSpendOk
    );
    if (topR.isErr()) return err(topR.error);

    return ok({
      contractCount: contract?.flow_count ?? '0',
      daCount: da?.flow_count ?? '0',
      contractTotalRon: contractSpendOk ? (contract?.amount_ron_sum ?? null) : null,
      daTotalRon: daSpendOk ? (da?.amount_ron_sum ?? null) : null,
      top: topR.value,
      rankBasis,
    });
  };

  const profileSlice = async (
    rawCui: string
  ): Promise<Result<ProcurementProfileSlice | null, ApiError>> => {
    const cui = normalizeCui(rawCui);
    if (cui === null) return err(invalidInput('invalid CUI format', 'cui'));
    const gateR = await grainQuality();
    if (gateR.isErr()) return err(gateR.error);
    const gateByGrain = new Map(gateR.value.map((g) => [g.grain, g]));
    const daSpendOk = gateByGrain.get('direct_acquisition')?.spendRankingsAllowed ?? false;
    const refreshedAt = gateR.value[0]?.refreshedAt ?? null;
    try {
      const presence = await presenceFor(cui);
      if (presence.isErr()) return err(presence.error);
      if (presence.value === null) return ok(null);

      const [authR, suppR, cpvR] = await Promise.all([
        roleSummary(cui, 'authority', gateByGrain),
        roleSummary(cui, 'supplier', gateByGrain),
        authorityCpvSpend(cui, { grain: 'direct_acquisition', topN: PROFILE_TOP }, daSpendOk),
      ]);
      if (authR.isErr()) return err(authR.error);
      if (suppR.isErr()) return err(suppR.error);
      if (cpvR.isErr()) return err(cpvR.error);

      const caveats: string[] = [PROCUREMENT_GRAIN_NOTE];
      if (!(gateByGrain.get('procurement_contract')?.spendRankingsAllowed ?? false)) {
        caveats.push('contract spend totals suppressed (amount coverage below gate threshold)');
      }
      if (!daSpendOk) {
        caveats.push(
          'direct-acquisition CPV breakdown ranked by flow count (amount coverage below gate threshold)'
        );
      }
      return ok({
        cui,
        asAuthority: authR.value,
        asSupplier: suppR.value,
        spendByCpvDivision: cpvR.value,
        caveats,
        refreshedAt,
      });
    } catch (error) {
      return err(databaseError('profileSlice failed', error));
    }
  };

  return {
    grainQuality,
    topSuppliersForAuthority,
    topAuthoritiesForSupplier,
    repeatedPairs,
    supplierConcentration,
    authorityCpvSpend,
    topSuppliersByRegionCpv,
    sameDaySplittingCandidates,
    presenceFor,
    profileSlice,
  };
};
