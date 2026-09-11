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

import { sql, type RawBuilder, type SqlBool } from 'kysely';
import { err, ok, type Result } from 'neverthrow';

import {
  type ApiError,
  type FilterInput,
  type SourcePresence,
  databaseError,
  invalidInput,
  normalizeCui,
  toConditionBuilders,
} from '@/modules/shared/index.js';

import { makeAggregateReads } from './aggregates.js';
import {
  DIM_LIMIT_MAX,
  OFFICIAL_PAGE_MAX,
  clamp,
  composeAnd,
  type BudgetRepoContext,
  type BudgetRepoOptions,
  type Db,
} from './budget-repo-shared.js';
import { makeEntityAnalyticsReads } from './entity-analytics.js';
import { fieldOf } from './filter-helpers.js';
import { makeFundingSourceMap } from './funding-source-map.js';
import { publicEntityIdentitySql } from './legacy-entity-predicates.js';
import { makeLineItemReads } from './line-items.js';
import {
  execReportType,
  mapApprovedFact,
  mapClassification,
  mapFundingSource,
  mapReport,
  mapSector,
  type ReportRow,
} from './mappers.js';
import { makeRankingReads } from './rankings.js';
import { EXECUTION_REPORT_TYPE_LABELS } from '../../core/constants.js';
import { budgetApprovedFactFilterSpec, budgetReportFilterSpec } from '../../core/filters.js';

import type { BudgetRepo } from '../../core/ports.js';
import type {
  ApprovedBudgetFact,
  BudgetAsOf,
  BudgetClassification,
  BudgetFundingSource,
  BudgetProfileSlice,
  BudgetReport,
  BudgetSector,
  BudgetVsExecutionRow,
  GatedOffsetPage,
} from '../../core/types.js';

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
  // execution + commitment line items (FACT path) — line-items.ts
  // ───────────────────────────────────────────────────────────────────────────

  const ctx: BudgetRepoContext = { db, options, fundingMap, asOf };

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
  // reports (metadata; ≥1 of entity/year/report_type required)
  // ───────────────────────────────────────────────────────────────────────────

  const listReports = async (q: {
    filter: FilterInput;
    page: number;
    pageSize: number;
  }): Promise<Result<GatedOffsetPage<BudgetReport>, ApiError>> => {
    const hasEntity = fieldOf(q.filter, 'entityCui') !== undefined;
    const hasYear = fieldOf(q.filter, 'reportingYear') !== undefined;
    const hasType = fieldOf(q.filter, 'reportType') !== undefined;
    if (!hasEntity && !hasYear && !hasType) {
      return err(
        invalidInput(
          'reports require at least one of entityCui / reportingYear / reportType',
          'filter'
        )
      );
    }
    const built = toConditionBuilders(budgetReportFilterSpec, q.filter);
    if (built.isErr()) return err(built.error);
    const page = clamp(q.page, 1, 100000);
    const pageSize = clamp(q.pageSize, 1, OFFICIAL_PAGE_MAX);
    const offset = (page - 1) * pageSize;
    try {
      // A report row names its entity: same identity rule as rankings (B/F5),
      // applied to the page and to the total so they agree.
      const rows = (await db
        .selectFrom('budget.reports as r')
        .leftJoin('core.public_entities as e', 'e.cui', 'r.entity_cui')
        .leftJoin('core.organizations as o', 'o.cui', 'r.entity_cui')
        .select([
          'r.report_id',
          'r.entity_cui',
          sql<string | null>`e.name`.as('entity_name'),
          'r.report_type',
          'r.main_creditor_cui',
          sql<string | null>`r.report_date::text`.as('report_date'),
          'r.reporting_year',
          'r.reporting_period',
          'r.budget_sector_id',
          'r.file_source',
          'r.download_links',
        ])
        .where(composeAnd(built.value))
        .where(publicEntityIdentitySql('r.entity_cui'))
        .orderBy(sql`r.report_date desc nulls last`)
        .orderBy('r.report_id', 'desc')
        .limit(pageSize)
        .offset(offset)
        .execute()) as ReportRow[];
      const countRow = await db
        .selectFrom('budget.reports as r')
        .leftJoin('core.organizations as o', 'o.cui', 'r.entity_cui')
        .select(sql<string>`count(*)`.as('cnt'))
        .where(composeAnd(built.value))
        .where(publicEntityIdentitySql('r.entity_cui'))
        .executeTakeFirst();
      return ok({
        items: rows.map(mapReport),
        total: countRow !== undefined ? Number(countRow.cnt) : null,
        estimated: false,
        caveats: [],
      });
    } catch (error) {
      return err(databaseError('listReports failed', error));
    }
  };

  const getReport = async (reportId: string): Promise<Result<BudgetReport | null, ApiError>> => {
    try {
      const row = (await db
        .selectFrom('budget.reports as r')
        .leftJoin('core.public_entities as e', 'e.cui', 'r.entity_cui')
        .leftJoin('core.organizations as o', 'o.cui', 'r.entity_cui')
        .select([
          'r.report_id',
          'r.entity_cui',
          sql<string | null>`e.name`.as('entity_name'),
          'r.report_type',
          'r.main_creditor_cui',
          sql<string | null>`r.report_date::text`.as('report_date'),
          'r.reporting_year',
          'r.reporting_period',
          'r.budget_sector_id',
          'r.file_source',
          'r.download_links',
        ])
        .where('r.report_id', '=', reportId)
        // Identity rule (B/F5): a restricted organization's report is absent, not named.
        .where(publicEntityIdentitySql('r.entity_cui'))
        .limit(1)
        .executeTakeFirst()) as ReportRow | undefined;
      return ok(row !== undefined ? mapReport(row) : null);
    } catch (error) {
      return err(databaseError('getReport failed', error));
    }
  };

  // ───────────────────────────────────────────────────────────────────────────
  // dimensions (functional/economic catalogs are EMPTY in prod → capability-gated)
  // ───────────────────────────────────────────────────────────────────────────

  const listFunctionalClassifications = (q: {
    search?: string;
    codes?: readonly string[];
    limit: number;
  }): Promise<Result<GatedOffsetPage<BudgetClassification>, ApiError>> =>
    listClassificationDim(
      'budget.functional_classifications',
      'functional_code',
      'functional_name',
      q
    );

  const listEconomicClassifications = (q: {
    search?: string;
    codes?: readonly string[];
    limit: number;
  }): Promise<Result<GatedOffsetPage<BudgetClassification>, ApiError>> =>
    listClassificationDim('budget.economic_classifications', 'economic_code', 'economic_name', q);

  const listClassificationDim = async (
    table: 'budget.functional_classifications' | 'budget.economic_classifications',
    codeCol: 'functional_code' | 'economic_code',
    nameCol: 'functional_name' | 'economic_name',
    q: { search?: string; codes?: readonly string[]; limit: number }
  ): Promise<Result<GatedOffsetPage<BudgetClassification>, ApiError>> => {
    const limit = clamp(q.limit, 1, DIM_LIMIT_MAX);
    try {
      // The two catalogs have distinct column names, so a typed Kysely builder
      // can't span both with dynamic refs — compose a single parameterized raw
      // statement instead (code/name columns + table are trusted internal idents
      // validated by the literal-union param types; values stay parameterized).
      const code = sql.ref(`d.${codeCol}`);
      const name = sql.ref(`d.${nameCol}`);
      const tableRef = sql.ref(table);
      const conds: RawBuilder<unknown>[] = [];
      if (q.codes !== undefined && q.codes.length > 0) {
        conds.push(
          sql`${code} in (${sql.join(
            q.codes.map((c) => sql`${c}`),
            sql`, `
          )})`
        );
      }
      if (q.search !== undefined && q.search.trim() !== '') {
        const pattern = `%${q.search.replace(/[\\%_]/gu, (m) => `\\${m}`)}%`;
        conds.push(
          sql`(${code} ilike ${pattern} escape '\\' or ${name} ilike ${pattern} escape '\\')`
        );
      }
      const where = conds.length > 0 ? sql`where ${sql.join(conds, sql` and `)}` : sql``;
      const stmt = sql<{ code: string; name: string | null }>`
        select ${code} as code, ${name} as name
        from ${tableRef} as d
        ${where}
        order by ${code} asc
        limit ${limit + 1}
      `;
      const result = await stmt.execute(db);
      const hasMore = result.rows.length > limit;
      const rows = result.rows.slice(0, limit);
      const caveats =
        rows.length === 0
          ? [
              'budget classification catalog is not loaded; functional/economic names are available on fact rows',
            ]
          : hasMore
            ? [`budget classification result exceeds the ${String(limit)}-item response limit`]
            : [];
      return ok({
        items: rows.map(mapClassification),
        total: hasMore ? null : rows.length,
        estimated: hasMore,
        caveats,
      });
    } catch (error) {
      return err(databaseError('listClassificationDim failed', error));
    }
  };

  const listBudgetSectors = async (q: {
    search?: string;
    ids?: readonly number[];
  }): Promise<Result<readonly BudgetSector[], ApiError>> => {
    try {
      let query = db
        .selectFrom('budget.budget_sectors as s')
        .select(['s.sector_id', 's.sector_description']);
      if (q.ids !== undefined && q.ids.length > 0)
        query = query.where('s.sector_id', 'in', [...q.ids]);
      if (q.search !== undefined && q.search.trim() !== '') {
        const pattern = `%${q.search.replace(/[\\%_]/gu, (m) => `\\${m}`)}%`;
        query = query.where(sql<SqlBool>`s.sector_description ilike ${pattern} escape '\\'`);
      }
      const rows = await query.orderBy('s.sector_id', 'asc').execute();
      return ok(rows.map(mapSector));
    } catch (error) {
      return err(databaseError('listBudgetSectors failed', error));
    }
  };

  const listFundingSources = async (q: {
    search?: string;
    ids?: readonly number[];
  }): Promise<Result<readonly BudgetFundingSource[], ApiError>> => {
    // Read the A1 compat view so `sourceId` is the CONVENTIONAL (phoenix) id, not
    // the arbitrary stored identity id. `q.ids` are public ids (they match the
    // view's `source_id`). The synthetic 0=Unknown row is excluded from the picker
    // list (source_code null) — it exists only to resolve unresolved-fact filters.
    try {
      let query = db
        .selectFrom('budget.v_funding_sources_compat as fs')
        .select(['fs.source_id', 'fs.source_code', 'fs.source_description'])
        .where('fs.source_code', 'is not', null);
      if (q.ids !== undefined && q.ids.length > 0)
        query = query.where('fs.source_id', 'in', [...q.ids]);
      if (q.search !== undefined && q.search.trim() !== '') {
        const pattern = `%${q.search.replace(/[\\%_]/gu, (m) => `\\${m}`)}%`;
        query = query.where(
          sql<SqlBool>`fs.source_code ilike ${pattern} escape '\\' or fs.source_description ilike ${pattern} escape '\\'`
        );
      }
      const rows = await query.orderBy('fs.source_id', 'asc').execute();
      return ok(rows.map(mapFundingSource));
    } catch (error) {
      return err(databaseError('listFundingSources failed', error));
    }
  };

  // ───────────────────────────────────────────────────────────────────────────
  // budget-official (capability-gated on row presence)
  // ───────────────────────────────────────────────────────────────────────────

  const listApprovedBudgetFacts = async (q: {
    filter: FilterInput;
    page: number;
    pageSize: number;
  }): Promise<Result<GatedOffsetPage<ApprovedBudgetFact>, ApiError>> => {
    const built = toConditionBuilders(budgetApprovedFactFilterSpec, q.filter);
    if (built.isErr()) return err(built.error);
    const page = clamp(q.page, 1, 100000);
    const pageSize = clamp(q.pageSize, 1, OFFICIAL_PAGE_MAX);
    try {
      const rows = await db
        .selectFrom('budget.approved_budget_facts as af')
        .select([
          'af.fact_id',
          'af.budget_year',
          'af.measure_year',
          'af.budget_component',
          'af.functional_code',
          'af.economic_code',
          'af.program_code',
          'af.label',
          'af.measure_kind',
          sql<string | null>`af.amount_value::text`.as('amount_value'),
          'af.unit',
        ])
        .where(composeAnd(built.value))
        .orderBy('af.budget_year', 'desc')
        .orderBy('af.fact_id', 'asc')
        .limit(pageSize)
        .offset((page - 1) * pageSize)
        .execute();
      return ok({ items: rows.map(mapApprovedFact), total: null, estimated: true, caveats: [] });
    } catch (error) {
      return err(databaseError('listApprovedBudgetFacts failed', error));
    }
  };

  const budgetVsExecution = async (q: {
    budgetYear?: number;
    page: number;
    pageSize: number;
  }): Promise<Result<GatedOffsetPage<BudgetVsExecutionRow>, ApiError>> => {
    // Capability gate keys on bgc_official_facts presence (the view's FROM) —
    // empty bgc ⇒ the view is empty (plan §13.2). Probe cheaply first.
    try {
      const probe = await db
        .selectFrom('budget.bgc_official_facts as b')
        .select(sql<string>`1`.as('one'))
        .limit(1)
        .executeTakeFirst();
      if (probe === undefined) {
        return ok({
          items: [],
          total: 0,
          estimated: false,
          caveats: [
            'budget-official execution bulletins not yet loaded; vs-execution comparison unavailable',
          ],
        });
      }
      const page = clamp(q.page, 1, 100000);
      const pageSize = clamp(q.pageSize, 1, OFFICIAL_PAGE_MAX);
      let vsQuery = db
        .selectFrom('budget.execution_vs_budget as v')
        .select([
          'v.component_key',
          'v.section',
          'v.line_item_key',
          'v.line_item_label',
          'v.period_year',
          'v.budget_year',
          sql<string | null>`v.execution_amount_ron::text`.as('execution_amount_ron'),
          sql<string | null>`v.approved_amount_ron::text`.as('approved_amount_ron'),
          sql<string | null>`v.delta_amount::text`.as('delta_amount'),
          'v.comparison_basis',
        ]);
      if (q.budgetYear !== undefined) vsQuery = vsQuery.where('v.budget_year', '=', q.budgetYear);
      const rows = await vsQuery
        .orderBy('v.budget_year', 'desc')
        .limit(pageSize)
        .offset((page - 1) * pageSize)
        .execute();
      return ok({
        items: rows.map((r) => ({
          componentKey: r.component_key,
          section: r.section,
          lineItemKey: r.line_item_key,
          lineItemLabel: r.line_item_label,
          periodYear: r.period_year,
          budgetYear: r.budget_year,
          executionAmountRon: r.execution_amount_ron,
          approvedAmountRon: r.approved_amount_ron,
          deltaAmount: r.delta_amount,
          comparisonBasis: r.comparison_basis,
        })),
        total: null,
        estimated: true,
        caveats: [],
      });
    } catch (error) {
      return err(databaseError('budgetVsExecution failed', error));
    }
  };

  // ───────────────────────────────────────────────────────────────────────────
  // contributor support (§4.1)
  // ───────────────────────────────────────────────────────────────────────────

  const profileSlice = async (
    rawCui: string
  ): Promise<Result<BudgetProfileSlice | null, ApiError>> => {
    const cui = normalizeCui(rawCui);
    if (cui === null) return err(invalidInput('invalid CUI format', 'cui'));
    const asOfR = await asOf();
    if (asOfR.isErr()) return err(asOfR.error);
    const { latestLoadedYear, latestCompleteYear } = asOfR.value;
    try {
      // The entity's own default report type drives the slice (its canonical view).
      const ent = await db
        .selectFrom('core.public_entities as e')
        .select(['e.default_report_type'])
        .where('e.cui', '=', cui)
        .limit(1)
        .executeTakeFirst();
      const defaultReportType = ent?.default_report_type ?? null;
      // Pick the latest year with an MV row for this entity (≤ latestComplete).
      let mvQuery = db
        .selectFrom('budget.mv_execution_summary_annual as mv')
        .select([
          'mv.year',
          'mv.report_type',
          sql<string>`mv.total_income::text`.as('total_income'),
          sql<string>`mv.total_expense::text`.as('total_expense'),
          sql<string>`mv.budget_balance::text`.as('budget_balance'),
        ])
        .where('mv.entity_cui', '=', cui);
      if (defaultReportType !== null)
        mvQuery = mvQuery.where('mv.report_type', '=', defaultReportType);
      const mvRow = await mvQuery
        .where('mv.year', '<=', latestCompleteYear)
        .orderBy('mv.year', 'desc')
        .limit(1)
        .executeTakeFirst();
      if (mvRow === undefined) return ok(null);

      // Top expense categories for that year (one pruned leaf; bounded LIMIT 5).
      const reportType = execReportType(mvRow.report_type);
      const reportLabel = EXECUTION_REPORT_TYPE_LABELS[reportType];
      const top = await db
        .selectFrom('budget.execution_line_items as eli')
        .select([
          'eli.functional_code',
          sql<string | null>`max(eli.functional_name)`.as('functional_name'),
          sql<string>`sum(eli.ytd_amount)::text`.as('amount'),
        ])
        .where('eli.reporting_year', '=', mvRow.year)
        .where('eli.report_type', '=', reportLabel)
        .where('eli.account_category', '=', 'ch')
        .where('eli.is_yearly', '=', true)
        .where('eli.entity_cui', '=', cui)
        .groupBy('eli.functional_code')
        .orderBy(sql`sum(eli.ytd_amount) desc nulls last`)
        .limit(5)
        .execute();

      return ok({
        cui,
        latestYear: latestLoadedYear,
        latestCompleteYear,
        reportType,
        totalIncome: mvRow.total_income,
        totalExpense: mvRow.total_expense,
        budgetBalance: mvRow.budget_balance,
        topExpenseCategories: top.map((t) => ({
          functionalCode: t.functional_code,
          functionalName: t.functional_name,
          amount: t.amount,
        })),
        refreshedAt: null,
      });
    } catch (error) {
      return err(databaseError('profileSlice failed', error));
    }
  };

  const presenceFor = async (rawCui: string): Promise<Result<SourcePresence | null, ApiError>> => {
    const cui = normalizeCui(rawCui);
    if (cui === null) return err(invalidInput('invalid CUI format', 'cui'));
    try {
      // One index probe on the annual MV (idx_..._entity_year).
      const row = await db
        .selectFrom('budget.mv_execution_summary_annual as mv')
        .select([sql<number>`max(mv.year)`.as('latest_year'), sql<string>`count(*)`.as('cnt')])
        .where('mv.entity_cui', '=', cui)
        .executeTakeFirst();
      const cnt = Number(row?.cnt ?? 0);
      if (cnt === 0) return ok(null);
      return ok({
        source: 'budget',
        present: true,
        label: 'Buget',
        count: cnt,
        badges: ['budget-reporting'],
        ...(row?.latest_year != null && { asOf: { execution: String(row.latest_year) } }),
        attrs: { reportedYears: cnt, latestYear: row?.latest_year ?? null },
      });
    } catch (error) {
      return err(databaseError('presenceFor failed', error));
    }
  };

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
