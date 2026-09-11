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

import { isPerCapita } from './analytics.js';
import {
  AGG_LIMIT_MAX,
  COMPLETE_AGGREGATE_GUARD,
  DECIMAL_MONEY_PATTERN,
  DIM_LIMIT_MAX,
  OFFICIAL_PAGE_MAX,
  RANK_LIMIT_MAX,
  RANK_PAGE_LIMIT_MAX,
  canonicalCountyPopulationAggregate,
  clamp,
  commitMvName,
  composeAnd,
  dirSql,
  execMvName,
  metricColumn,
  type BudgetRepoContext,
  type BudgetRepoOptions,
  type Db,
} from './budget-repo-shared.js';
import { countyExecutiveCuiSql } from './county-executive.js';
import { makeEntityAnalyticsReads } from './entity-analytics.js';
import {
  EXEC_CORE_FIELDS,
  amountRange,
  execGatePredicates,
  needsCoreJoin,
  periodTuple,
  transferExclusion,
  wantsExcludeTransfers,
} from './fact-predicates.js';
import {
  fieldOf,
  omitFields,
  prepareFundingFactFilter,
  resolveExecutionGate,
} from './filter-helpers.js';
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
import { availableSingleYearMoneyFactor, singleYearMoneyFactor } from './money-factor.js';
import {
  COMMITMENT_REPORT_TYPE_LABELS,
  EXECUTION_AMOUNT_COLUMN,
  EXECUTION_REPORT_TYPE_LABELS,
} from '../../core/constants.js';
import {
  BUDGET_FACT_VIRTUAL_FIELDS,
  budgetApprovedFactFilterSpec,
  budgetFactKernelSpec,
  budgetReportFilterSpec,
} from '../../core/filters.js';

import type { BudgetRepo } from '../../core/ports.js';
import type {
  AggregatedBudgetRow,
  ApprovedBudgetFact,
  BudgetAsOf,
  BudgetClassification,
  BudgetFundingSource,
  BudgetProfileSlice,
  BudgetReport,
  BudgetSector,
  BudgetVsExecutionRow,
  ClassificationAggregateQuery,
  CommitmentRankingQuery,
  CountyHeatmapPoint,
  EntityRankingQuery,
  EntityRankingPageQuery,
  GatedOffsetPage,
  HeatmapQuery,
  RankedCommitmentEntity,
  RankedEntity,
  RankedEntityPage,
  UatHeatmapPoint,
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
  // rankings (MV path + factor; bounded top-N)
  // ───────────────────────────────────────────────────────────────────────────

  const rankEntitiesPage = async (
    q: EntityRankingPageQuery
  ): Promise<Result<RankedEntityPage, ApiError>> => {
    const hasMoneyOptions = q.currency !== undefined || q.inflationAdjusted !== undefined;
    if (hasMoneyOptions && options.moneyFactors === undefined)
      return err({
        type: 'ServiceUnavailable',
        message: 'Native monetary options are unavailable',
      });
    if (!Number.isInteger(q.year) || q.year <= 0) {
      return err(invalidInput('ranking year must be a positive integer', 'year'));
    }
    if (q.mainCreditorCui === '') {
      return err(invalidInput('ranking main creditor CUI cannot be empty', 'mainCreditorCui'));
    }
    if (q.frequency === 'YEAR' && (q.month !== undefined || q.quarter !== undefined)) {
      return err(invalidInput('yearly ranking cannot filter month or quarter', 'frequency'));
    }
    if (q.frequency === 'MONTH' && q.quarter !== undefined) {
      return err(invalidInput('monthly ranking cannot filter quarter', 'quarter'));
    }
    if (q.frequency === 'MONTH' && q.month === undefined) {
      return err(invalidInput('monthly ranking requires a month', 'month'));
    }
    if (q.frequency === 'QUARTER' && q.month !== undefined) {
      return err(invalidInput('quarterly ranking cannot filter month', 'month'));
    }
    if (q.frequency === 'QUARTER' && q.quarter === undefined) {
      return err(invalidInput('quarterly ranking requires a quarter', 'quarter'));
    }
    if (q.month !== undefined && (!Number.isInteger(q.month) || q.month < 1 || q.month > 12)) {
      return err(invalidInput('ranking month must be between 1 and 12', 'month'));
    }
    if (
      q.quarter !== undefined &&
      (!Number.isInteger(q.quarter) || q.quarter < 1 || q.quarter > 4)
    ) {
      return err(invalidInput('ranking quarter must be between 1 and 4', 'quarter'));
    }

    const reportLabel = EXECUTION_REPORT_TYPE_LABELS[q.reportType];
    const col = metricColumn(q.metric);
    if (!Number.isInteger(q.limit) || q.limit < 1 || q.limit > RANK_PAGE_LIMIT_MAX) {
      return err(
        invalidInput(`ranking limit must be between 1 and ${String(RANK_PAGE_LIMIT_MAX)}`, 'limit')
      );
    }
    if (!Number.isInteger(q.offset) || q.offset < 0 || q.offset > 100_000) {
      return err(invalidInput('ranking offset must be between 0 and 100000', 'offset'));
    }
    if (
      options.moneyFactors !== undefined &&
      q.normalization === 'PERCENT_GDP' &&
      q.sort === 'PER_CAPITA'
    ) {
      return err(invalidInput('GDP percentages have no per-capita ranking', 'sort'));
    }
    const limit = q.limit;
    const perCapita = isPerCapita(q.normalization);
    const money =
      hasMoneyOptions && options.moneyFactors !== undefined
        ? await availableSingleYearMoneyFactor(options.moneyFactors, q.normalization, q.year, q)
        : await singleYearMoneyFactor(options.moneyFactors, q.normalization, q.year);
    if (money.isErr()) return err(money.error);
    if (money.value === null) return ok({ items: [], total: 0 });
    const multiplier = money.value;
    try {
      const conds: RawBuilder<unknown>[] = [
        sql`mv.year = ${q.year}`,
        sql`mv.report_type = ${reportLabel}`,
      ];
      if (q.month !== undefined) {
        conds.push(sql`${sql.ref('mv.month')} = ${q.month}`);
      }
      if (q.quarter !== undefined) {
        conds.push(sql`${sql.ref('mv.quarter')} = ${q.quarter}`);
      }
      if (q.entityCuis !== undefined) {
        conds.push(
          q.entityCuis.length === 0
            ? sql`false`
            : sql`mv.entity_cui in (${sql.join(
                q.entityCuis.map((cui) => sql`${cui}`),
                sql`, `
              )})`
        );
      }
      if (q.mainCreditorCui !== undefined) {
        conds.push(sql`mv.main_creditor_cui = ${q.mainCreditorCui}`);
      }
      if (q.excludeEntityCuis !== undefined && q.excludeEntityCuis.length > 0) {
        conds.push(
          sql`mv.entity_cui not in (${sql.join(
            q.excludeEntityCuis.map((cui) => sql`${cui}`),
            sql`, `
          )})`
        );
      }
      if (q.countyCodes !== undefined) {
        conds.push(
          q.countyCodes.length === 0
            ? sql`false`
            : sql`t.county_code in (${sql.join(
                q.countyCodes.map((c) => sql`${c}`),
                sql`, `
              )})`
        );
      }
      if (q.regions !== undefined) {
        conds.push(
          q.regions.length === 0
            ? sql`false`
            : sql`t.region in (${sql.join(
                q.regions.map((r) => sql`${r}`),
                sql`, `
              )})`
        );
      }
      if (q.isUat !== undefined) conds.push(sql`e.is_uat = ${q.isUat}`);
      if (q.isTerritorialExecutive !== undefined)
        conds.push(sql`e.is_territorial_executive = ${q.isTerritorialExecutive}`);
      // Same identity rule as grouped entityAnalytics (B/F5): a ranked row
      // names an entity, so a restricted organization never appears in one.
      conds.push(publicEntityIdentitySql('mv.entity_cui'));
      // Collapse creditor rows before ranking. Keep population out of this
      // candidate set: native annual values may change eligibility and order.
      const candidates = db
        .selectFrom(execMvName(q.frequency))
        .leftJoin('core.public_entities as e', 'e.cui', 'mv.entity_cui')
        .leftJoin('core.organizations as o', 'o.cui', 'mv.entity_cui')
        .leftJoin('core.territories as t', 't.id', 'e.territory_id')
        .select([
          'mv.entity_cui',
          'mv.year',
          sql<string | null>`e.name`.as('entity_name'),
          sql`sum(coalesce(mv.${sql.ref(col)},0)) * ${multiplier}::numeric`.as('amount'),
          sql<boolean | null>`e.is_territorial_executive`.as('is_executive'),
          sql<number | null>`t.id`.as('territory_id'),
          sql`case when e.is_territorial_executive then t.population else null end`.as(
            'population'
          ),
          sql<string | null>`t.county_code`.as('county_code'),
          sql<string | null>`t.county_name`.as('county_name'),
          sql<string | null>`e.entity_type`.as('entity_type'),
        ])
        .where(composeAnd(conds))
        .groupBy(
          sql`mv.entity_cui, mv.year, e.name, e.entity_type, e.is_territorial_executive, t.id, t.population, t.county_code, t.county_name`
        );

      const sort = q.sort ?? (perCapita ? 'PER_CAPITA' : 'AMOUNT');
      const sortColumn = {
        PER_CAPITA: 'r.per_capita',
        ENTITY_NAME: 'r.entity_name',
        ENTITY_TYPE: 'r.entity_type',
        POPULATION: 'r.population',
        COUNTY: 'r.county_name',
        AMOUNT: 'r.amount',
      }[sort];
      const order = sql`${sql.ref(sortColumn)} ${dirSql(q.ascending === true ? 'asc' : 'desc')} nulls last, r.entity_cui asc`;
      let populationJoin = sql``;
      let populationExpr = sql`r.population`;
      if (options.populationRelation !== undefined) {
        const populationAffectsSelection =
          perCapita ||
          sort === 'PER_CAPITA' ||
          sort === 'POPULATION' ||
          q.minPopulation !== undefined ||
          q.maxPopulation !== undefined;
        // Nominal pages need population only as metadata. Select the exact page
        // first, including ordinary institutions; then deduplicate its anchors.
        const selected = await sql<{ territory_id: number | null; is_executive: boolean | null }>`
          select r.territory_id, r.is_executive from (${candidates}) r
          ${populationAffectsSelection ? sql`` : sql`order by ${order} limit ${limit} offset ${q.offset}`}
        `.execute(db);
        const territoryIds = [
          ...new Set(
            selected.rows.flatMap((row) =>
              row.is_executive === true && row.territory_id !== null ? [row.territory_id] : []
            )
          ),
        ];
        let relation: RawBuilder<unknown> = sql`select null::bigint territory_id, null::int as year, null::numeric population where false`;
        if (territoryIds.length > 0) {
          const result = await options.populationRelation({ territoryIds, years: [q.year] });
          if (result.isErr()) return err(result.error);
          relation = result.value;
        }
        populationJoin = sql`left join (${relation}) population
          on population.territory_id = r.territory_id and population.year = r.year`;
        populationExpr = sql`case when r.is_executive then population.population else null end`;
      }
      const populationConds: RawBuilder<unknown>[] = [];
      if (perCapita) populationConds.push(sql`r.population > 0`);
      if (q.minPopulation !== undefined)
        populationConds.push(sql`r.population >= ${q.minPopulation}`);
      if (q.maxPopulation !== undefined)
        populationConds.push(sql`r.population <= ${q.maxPopulation}`);

      // A count row survives even when the requested offset is past the end.
      // This avoids recursively fetching another page (and another INS read).
      const { rows } = await sql<{
        entity_cui: string | null;
        entity_name: string | null;
        year: number;
        amount: string;
        per_capita: string | null;
        population: number | null;
        county_code: string | null;
        county_name: string | null;
        entity_type: string | null;
        territory_id: number | null;
        total_count: string;
      }>`
        with candidates as (${candidates}),
        populated as (
          select r.entity_cui, r.entity_name, r.year, r.amount, r.territory_id,
            r.county_code, r.county_name, r.entity_type, ${populationExpr} as population
          from candidates r ${populationJoin}
        ),
        ranked as (
          select r.*, case when ${options.moneyFactors === undefined || q.normalization !== 'PERCENT_GDP'} and r.population > 0 then r.amount / r.population else null end as per_capita
          from populated r where ${composeAnd(populationConds)}
        ),
        totals as (select count(*)::text as total_count from ranked),
        page as (select r.* from ranked r order by ${order} limit ${limit} offset ${q.offset})
        select r.entity_cui, r.entity_name, r.year, r.amount::text, r.per_capita::text,
          r.population::int, r.county_code, r.county_name, r.entity_type, r.territory_id, totals.total_count
        from totals left join page r on true order by ${order}
      `.execute(db);
      const total = Number(rows[0]?.total_count ?? 0);
      return ok({
        items: rows.flatMap((r) =>
          r.entity_cui === null
            ? []
            : [
                {
                  entityCui: r.entity_cui,
                  entityName: r.entity_name,
                  reportType: q.reportType,
                  year: r.year,
                  amount: r.amount,
                  perCapita: r.per_capita,
                  population: r.population,
                  countyCode: r.county_code,
                  countyName: r.county_name,
                  entityType: r.entity_type,
                  territoryId: r.territory_id,
                },
              ]
        ),
        total,
      });
    } catch (error) {
      return err(databaseError('rankEntitiesPage failed', error));
    }
  };

  const rankEntities = async (
    q: EntityRankingQuery
  ): Promise<Result<readonly RankedEntity[], ApiError>> => {
    if (!Number.isInteger(q.limit) || q.limit < 1 || q.limit > RANK_LIMIT_MAX) {
      return err(
        invalidInput(`ranking limit must be between 1 and ${String(RANK_LIMIT_MAX)}`, 'limit')
      );
    }
    const page = await rankEntitiesPage({ ...q, offset: 0 });
    return page.map((value) => value.items);
  };

  const rankCommitmentEntities = async (
    q: CommitmentRankingQuery
  ): Promise<Result<readonly RankedCommitmentEntity[], ApiError>> => {
    if (!Number.isInteger(q.year) || q.year <= 0) {
      return err(invalidInput('ranking year must be a positive integer', 'year'));
    }
    if (!Number.isInteger(q.limit) || q.limit < 1 || q.limit > RANK_LIMIT_MAX) {
      return err(
        invalidInput(`ranking limit must be between 1 and ${String(RANK_LIMIT_MAX)}`, 'limit')
      );
    }
    const reportLabel = COMMITMENT_REPORT_TYPE_LABELS[q.reportType];
    const limit = q.limit;
    try {
      const rows = await db
        .selectFrom(commitMvName('YEAR'))
        .leftJoin('core.public_entities as e', 'e.cui', 'mv.entity_cui')
        .leftJoin('core.organizations as o', 'o.cui', 'mv.entity_cui')
        .select([
          'mv.entity_cui',
          sql<string | null>`e.name`.as('entity_name'),
          'mv.year',
          sql<string>`sum(coalesce(mv.${sql.ref(q.metric)},0))::text`.as('amount'),
        ])
        .where(sql<SqlBool>`mv.year = ${q.year} and mv.report_type = ${reportLabel}`)
        .where(publicEntityIdentitySql('mv.entity_cui'))
        .groupBy(['mv.entity_cui', 'e.name', 'mv.year'])
        // Order by the same coalesced sum that is selected: an all-null scope
        // is a zero amount, not a "nulls last" row sorted below negatives.
        .orderBy(sql`sum(coalesce(mv.${sql.ref(q.metric)},0)) desc`)
        .orderBy('mv.entity_cui', 'asc')
        .limit(limit)
        .execute();
      return ok(
        rows.map((r) => ({
          entityCui: r.entity_cui,
          entityName: r.entity_name,
          reportType: q.reportType,
          year: r.year,
          amount: r.amount,
        }))
      );
    } catch (error) {
      return err(databaseError('rankCommitmentEntities failed', error));
    }
  };

  // ───────────────────────────────────────────────────────────────────────────
  // classification aggregate (FACT path; ONE pruned leaf)
  // ───────────────────────────────────────────────────────────────────────────

  const aggregateByClassification = async (
    q: ClassificationAggregateQuery
  ): Promise<Result<readonly AggregatedBudgetRow[], ApiError>> => {
    const gateR = resolveExecutionGate(q.filter, {
      reportType: 'EXECUTION_DETAILED',
      accountCategory: 'EXPENSE',
      frequency: 'YEAR',
    });
    if (gateR.isErr()) return err(gateR.error);
    const gate = gateR.value;
    if (
      q.complete !== true &&
      (!Number.isInteger(q.limit) || q.limit < 1 || q.limit > AGG_LIMIT_MAX)
    ) {
      return err(
        invalidInput(`classification limit must be between 1 and ${String(AGG_LIMIT_MAX)}`, 'limit')
      );
    }
    if (q.complete === true && q.limit !== 50) {
      return err(
        invalidInput('complete classification mode does not accept a custom limit', 'limit')
      );
    }
    // Complete mode is an explicit, fail-closed capability. Its safety guard is
    // server-owned so clients neither duplicate nor silently drift from it.
    const limit = q.complete === true ? COMPLETE_AGGREGATE_GUARD : q.limit;

    // Normalization for a classification aggregate: per-capita has NO bucket-grain
    // population, so it is rejected; TOTAL_EURO / PERCENT_GDP apply a single-year
    // scalar multiplier (a classification aggregate must scope to ONE year so the
    // factor is well-defined). The multiplier is applied in SQL (numeric-exact).
    if (isPerCapita(q.normalization)) {
      return err(
        invalidInput(
          'per-capita normalization is not defined for a classification aggregate',
          'normalization'
        )
      );
    }
    if (q.normalization !== 'TOTAL' && gate.years.eq === undefined) {
      return err(
        invalidInput(
          'non-TOTAL normalization requires a single reportingYear (eq)',
          'reportingYear'
        )
      );
    }
    if (q.minAmount !== undefined && !DECIMAL_MONEY_PATTERN.test(q.minAmount)) {
      return err(invalidInput('classification minimum amount must be a decimal', 'minAmount'));
    }
    if (q.maxAmount !== undefined && !DECIMAL_MONEY_PATTERN.test(q.maxAmount)) {
      return err(invalidInput('classification maximum amount must be a decimal', 'maxAmount'));
    }
    const rowMinAmount = fieldOf(q.filter, 'minAmount')?.['gte'];
    const rowMaxAmount = fieldOf(q.filter, 'maxAmount')?.['lte'];
    if (
      rowMinAmount !== undefined &&
      (typeof rowMinAmount !== 'string' || !DECIMAL_MONEY_PATTERN.test(rowMinAmount))
    ) {
      return err(invalidInput('row minimum amount must be a decimal', 'filter.minAmount'));
    }
    if (
      rowMaxAmount !== undefined &&
      (typeof rowMaxAmount !== 'string' || !DECIMAL_MONEY_PATTERN.test(rowMaxAmount))
    ) {
      return err(invalidInput('row maximum amount must be a decimal', 'filter.maxAmount'));
    }
    const money =
      gate.years.eq === undefined
        ? ok('1') // Only TOTAL reaches this branch; normalized ranges are rejected above.
        : await singleYearMoneyFactor(options.moneyFactors, q.normalization, gate.years.eq);
    if (money.isErr()) return err(money.error);
    const aggMult = money.value;

    const fm = await fundingMap.load();
    const translated = prepareFundingFactFilter(q.filter, fm.toStoredId);
    const physical = omitFields(translated, [...BUDGET_FACT_VIRTUAL_FIELDS]);
    const built = toConditionBuilders(budgetFactKernelSpec, physical);
    if (built.isErr()) return err(built.error);

    const conds: RawBuilder<unknown>[] = [...execGatePredicates(gate, 'eli'), ...built.value];
    conds.push(...amountRange(q.filter, gate.frequency, 'eli'));
    const tuple = periodTuple(q.filter, gate.frequency, 'eli');
    if (tuple !== undefined) conds.push(tuple);
    if (wantsExcludeTransfers(q.filter)) conds.push(transferExclusion('eli'));

    const amountCol = EXECUTION_AMOUNT_COLUMN[gate.frequency];
    // The normalized aggregate sum (multiplier applied in numeric SQL).
    const sumExpr = sql`(sum(eli.${sql.ref(amountCol)}) * ${aggMult}::numeric)`;
    const havingConds: RawBuilder<unknown>[] = [];
    if (q.minAmount !== undefined) {
      havingConds.push(sql`${sumExpr} >= ${q.minAmount}::numeric`);
    }
    if (q.maxAmount !== undefined) {
      havingConds.push(sql`${sumExpr} <= ${q.maxAmount}::numeric`);
    }

    const needsJoin = needsCoreJoin(q.filter, EXEC_CORE_FIELDS);
    try {
      let base = db.selectFrom('budget.execution_line_items as eli');
      if (needsJoin) {
        base = base
          .leftJoin('core.public_entities as e', 'e.cui', 'eli.entity_cui')
          .leftJoin('core.territories as t', 't.id', 'e.territory_id');
      }
      let query = base
        .select([
          'eli.functional_code',
          sql<string | null>`max(eli.functional_name)`.as('functional_name'),
          'eli.economic_code',
          sql<string | null>`max(eli.economic_name)`.as('economic_name'),
          sql<string>`${sumExpr}::text`.as('amount'),
          sql<string>`count(*)`.as('line_count'),
        ])
        .where(composeAnd(conds))
        .groupBy(['eli.functional_code', 'eli.economic_code']);
      if (havingConds.length > 0) query = query.having(composeAnd(havingConds));
      const rows = await query
        .orderBy(sql`${sumExpr} desc nulls last`)
        .limit(q.complete === true ? limit + 1 : limit)
        .execute();
      if (q.complete === true && rows.length > limit) {
        return err(
          invalidInput(
            `classification aggregate exceeds the ${String(limit)}-row completeness guard`,
            'limit'
          )
        );
      }
      return ok(
        rows.map((r) => ({
          functionalCode: r.functional_code,
          functionalName: r.functional_name,
          economicCode: r.economic_code,
          economicName: r.economic_name,
          amount: r.amount,
          lineCount: Number(r.line_count),
        }))
      );
    } catch (error) {
      return err(databaseError('aggregateByClassification failed', error));
    }
  };

  // ───────────────────────────────────────────────────────────────────────────
  // UAT/county heatmaps (MV → canonical territory rollups)
  // ───────────────────────────────────────────────────────────────────────────

  const uatHeatmap = async (
    q: HeatmapQuery
  ): Promise<Result<readonly UatHeatmapPoint[], ApiError>> => {
    const reportLabel = EXECUTION_REPORT_TYPE_LABELS[q.reportType];
    const col = metricColumn(q.metric);
    const money = await singleYearMoneyFactor(options.moneyFactors, q.normalization, q.year);
    if (money.isErr()) return err(money.error);
    const multiplier = money.value;
    const amountExpr = sql`sum(coalesce(mv.${sql.ref(col)},0)) * ${multiplier}::numeric`;
    try {
      const result = await sql<{
        territory_id: number;
        entity_cui: string;
        uat_name: string;
        siruta_code: string | null;
        county_code: string | null;
        county_name: string | null;
        region: string | null;
        amount: string;
        per_capita: string | null;
        population: number | null;
      }>`
        select
          territory.id as territory_id,
          territory.uat_code as entity_cui,
          territory.name as uat_name,
          territory.siruta_code,
          territory.county_code,
          territory.county_name,
          territory.region,
          (${amountExpr})::text as amount,
          case
            when ${options.moneyFactors === undefined || q.normalization !== 'PERCENT_GDP'} and territory.population > 0
              then ((${amountExpr}) / territory.population)::text
            else null
          end as per_capita,
          territory.population
        from core.territories territory
        inner join budget.mv_execution_summary_annual mv
          on mv.entity_cui = territory.uat_code
          and mv.year = ${q.year}
          and mv.report_type = ${reportLabel}
        where territory.uat_code is not null
        group by
          territory.id,
          territory.uat_code,
          territory.name,
          territory.siruta_code,
          territory.county_code,
          territory.county_name,
          territory.region,
          territory.population
        order by territory.id asc
      `.execute(db);
      return ok(
        result.rows.map((row) => ({
          territoryId: row.territory_id,
          entityCui: row.entity_cui,
          uatName: row.uat_name,
          sirutaCode: row.siruta_code,
          countyCode: row.county_code,
          countyName: row.county_name,
          region: row.region,
          year: q.year,
          amount: row.amount,
          perCapita: row.per_capita,
          population: row.population,
        }))
      );
    } catch (error) {
      return err(databaseError('uatHeatmap failed', error));
    }
  };

  const countyHeatmap = async (
    q: HeatmapQuery
  ): Promise<Result<readonly CountyHeatmapPoint[], ApiError>> => {
    const reportLabel = EXECUTION_REPORT_TYPE_LABELS[q.reportType];
    const col = metricColumn(q.metric);
    const money = await singleYearMoneyFactor(options.moneyFactors, q.normalization, q.year);
    if (money.isErr()) return err(money.error);
    const multiplier = money.value;
    try {
      // Map data is UAT-grain: join the entity CUI directly to the canonical
      // territory's uat_code. Joining every located public entity through
      // core.public_entities over-counts Bucharest and other institution-rich
      // counties. County population is the canonical county territory value,
      // not SUM(DISTINCT population), which deduplicates equal *values* rather
      // than territories and can double-count county + locality populations.
      const amountExpr = sql`sum(coalesce(mv.${sql.ref(col)},0)) * ${multiplier}::numeric`;
      const rows = await sql<{
        county_code: string;
        county_name: string | null;
        county_entity_cui: string | null;
        amount: string;
        per_capita: string | null;
        population: number | null;
        entity_count: string;
      }>`
        with county_info as (
          select distinct on (territory.county_code)
            territory.county_code,
            territory.county_name,
            ${countyExecutiveCuiSql(sql`territory.county_code`)} as county_entity_cui,
            (
              select ${canonicalCountyPopulationAggregate('candidate')}
              from core.territories candidate
              where candidate.county_code = territory.county_code
            )::int as population
          from core.territories territory
          where territory.county_code is not null
          order by
            territory.county_code,
            territory.county_name nulls last,
            territory.id
        )
        select
          county.county_code,
          county.county_name,
          county.county_entity_cui,
          (${amountExpr})::text as amount,
          case
            when ${options.moneyFactors === undefined || q.normalization !== 'PERCENT_GDP'} and county.population > 0
              then ((${amountExpr}) / county.population)::text
            else null
          end as per_capita,
          county.population,
          count(distinct mv.entity_cui)::text as entity_count
        from county_info county
        left join core.territories territory
          on territory.county_code = county.county_code
        left join budget.mv_execution_summary_annual mv
          on mv.entity_cui = territory.uat_code
          and mv.year = ${q.year}
          and mv.report_type = ${reportLabel}
        group by
          county.county_code,
          county.county_name,
          county.county_entity_cui,
          county.population
        having count(mv.entity_cui) > 0
        order by (${amountExpr}) desc nulls last, county.county_code asc
      `.execute(db);
      return ok(
        rows.rows.map((r) => ({
          countyCode: r.county_code,
          countyName: r.county_name,
          countyEntityCui: r.county_entity_cui,
          year: q.year,
          amount: r.amount,
          perCapita: r.per_capita,
          population: r.population,
          entityCount: Number(r.entity_count),
        }))
      );
    } catch (error) {
      return err(databaseError('countyHeatmap failed', error));
    }
  };

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
