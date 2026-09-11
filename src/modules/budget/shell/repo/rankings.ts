/**
 * Budget repository — ENTITY RANKINGS on the MV path (codebase plan §WP5):
 * the bounded top-N execution rankings (list and page forms, with the money
 * factor and per-capita denominators from the admitted population relation,
 * territorial executives only) and the commitment
 * ranking, read from the summary MVs, never the fact table (invariant 2 of
 * `budget-repo.ts`). Moved out of the `makeBudgetRepo` closure unchanged; the
 * closure state it used arrives as the shared context.
 */
import { sql, type RawBuilder, type SqlBool } from 'kysely';
import { err, ok, type Result } from 'neverthrow';

import { type ApiError, databaseError, invalidInput } from '@/modules/shared/index.js';

import { isPerCapita } from './analytics.js';
import {
  RANK_LIMIT_MAX,
  RANK_PAGE_LIMIT_MAX,
  commitMvName,
  composeAnd,
  dirSql,
  execMvName,
  metricColumn,
  type BudgetRepoContext,
} from './budget-repo-shared.js';
import { publicEntityIdentitySql } from './legacy-entity-predicates.js';
import { availableSingleYearMoneyFactor, singleYearMoneyFactor } from './money-factor.js';
import {
  COMMITMENT_REPORT_TYPE_LABELS,
  EXECUTION_REPORT_TYPE_LABELS,
} from '../../core/constants.js';

import type {
  CommitmentRankingQuery,
  EntityRankingQuery,
  EntityRankingPageQuery,
  RankedCommitmentEntity,
  RankedEntity,
  RankedEntityPage,
} from '../../core/types.js';

export const makeRankingReads = (ctx: BudgetRepoContext) => {
  const { db, options } = ctx;

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

  return { rankEntities, rankEntitiesPage, rankCommitmentEntities };
};
