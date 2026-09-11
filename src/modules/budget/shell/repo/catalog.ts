/**
 * Budget repository — REPORTS, DIMENSIONS, OFFICIAL BUDGET and CONTRIBUTOR
 * SUPPORT (codebase plan §WP5): report metadata, the capability-gated
 * functional/economic/sector/funding-source catalogs, the approved-budget
 * facts and the budget-vs-execution rows, and the entity presence and profile
 * slice the contributor surface reads. Moved out of the `makeBudgetRepo`
 * closure unchanged; the closure state it used arrives as the shared context.
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

import {
  DIM_LIMIT_MAX,
  OFFICIAL_PAGE_MAX,
  clamp,
  composeAnd,
  type BudgetRepoContext,
} from './budget-repo-shared.js';
import { fieldOf } from './filter-helpers.js';
import { publicEntityIdentitySql } from './legacy-entity-predicates.js';
import {
  execReportType,
  mapApprovedFact,
  mapClassification,
  mapFundingSource,
  mapReport,
  mapSector,
  type ReportRow,
} from './mappers.js';
import { EXECUTION_REPORT_TYPE_LABELS } from '../../core/constants.js';
import { budgetApprovedFactFilterSpec, budgetReportFilterSpec } from '../../core/filters.js';

import type {
  ApprovedBudgetFact,
  BudgetClassification,
  BudgetFundingSource,
  BudgetProfileSlice,
  BudgetReport,
  BudgetSector,
  BudgetVsExecutionRow,
  GatedOffsetPage,
} from '../../core/types.js';

export const makeCatalogReads = (ctx: BudgetRepoContext) => {
  const { db, asOf } = ctx;

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
