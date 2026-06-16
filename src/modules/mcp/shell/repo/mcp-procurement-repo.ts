/**
 * MCP Procurement Repository Adapter
 *
 * Reads deterministic public-contract aggregate views from transparenta_prod.
 */

import { sql, type RawBuilder } from 'kysely';
import { err, ok, type Result } from 'neverthrow';

import { setStatementTimeout } from '@/infra/database/query-builders/index.js';

import { databaseError, timeoutError, type McpError } from '../../core/errors.js';

import type { McpProcurementRepo } from '../../core/ports.js';
import type {
  ProcurementAggregateQuality,
  ProcurementCategoryBreakdownRow,
  ProcurementFilterQuery,
  ProcurementSameDayCandidateRow,
  ProcurementSourceGrain,
  ProcurementSupplierRankingRow,
} from '../../core/types.js';
import type { BudgetDbClient } from '@/infra/database/client.js';

const QUERY_TIMEOUT_MS = 10_000;

interface QualityRow {
  amount_coverage_rate: string | number;
  authority_cui_coverage_rate: string | number;
  authority_territory_coverage_rate: string | number;
  blockers: string[] | null;
  cpv_coverage_rate: string | number;
  date_coverage_rate: string | number;
  filter_answers_allowed: boolean;
  rows_count: string | number;
  source_grain: ProcurementSourceGrain;
  spend_rankings_allowed: boolean;
  supplier_cui_coverage_rate: string | number;
  supplier_region_filters_allowed: boolean;
}

interface SupplierRankingRow {
  amount_missing_count: string | number;
  amount_present_count: string | number;
  amount_ron_sum: string | number | null;
  authority_count: string | number;
  cpv_division_code: string | null;
  cpv_division_label_en: string | null;
  evidence_refs_sample: (string | null)[] | null;
  first_flow_date: Date | string | null;
  flow_count: string | number;
  last_flow_date: Date | string | null;
  supplier_cui: string;
  supplier_name: string | null;
}

interface CategoryBreakdownRow {
  amount_missing_count: string | number;
  amount_present_count: string | number;
  amount_ron_sum: string | number | null;
  cpv_division_code: string;
  cpv_division_label_en: string | null;
  distinct_supplier_count: string | number | null;
  evidence_refs_sample: (string | null)[] | null;
  first_flow_date: Date | string | null;
  flow_count: string | number;
  last_flow_date: Date | string | null;
}

interface SameDayCandidateRow {
  amount_missing_count: string | number;
  amount_present_count: string | number;
  authority_county_name: string | null;
  authority_cui: string;
  authority_name: string | null;
  authority_region: string | null;
  candidate_date: Date | string;
  cpv_code: string | null;
  cpv_division_code: string | null;
  cpv_division_label_en: string | null;
  evidence_refs_sample: (string | null)[] | null;
  max_single_amount_ron: string | number | null;
  same_day_count: string | number;
  same_day_total_ron: string | number | null;
  supplier_cui: string;
  supplier_name: string | null;
}

class KyselyMcpProcurementRepo implements McpProcurementRepo {
  constructor(private readonly db: BudgetDbClient) {}

  async getAggregateQuality(
    sourceGrains: ProcurementSourceGrain[]
  ): Promise<Result<ProcurementAggregateQuality[], McpError>> {
    try {
      await setStatementTimeout(this.db, QUERY_TIMEOUT_MS);

      const result = await sql<QualityRow>`
        select
          source_grain,
          rows_count,
          authority_cui_coverage_rate,
          supplier_cui_coverage_rate,
          amount_coverage_rate,
          cpv_coverage_rate,
          date_coverage_rate,
          authority_territory_coverage_rate,
          filter_answers_allowed,
          spend_rankings_allowed,
          supplier_region_filters_allowed,
          blockers
        from procurement.aggregate_quality_by_grain
        where source_grain = any(${sourceGrains})
        order by source_grain
      `.execute(this.db);

      return ok(
        result.rows.map((row) => ({
          amountCoverageRate: toNumber(row.amount_coverage_rate),
          authorityCuiCoverageRate: toNumber(row.authority_cui_coverage_rate),
          authorityTerritoryCoverageRate: toNumber(row.authority_territory_coverage_rate),
          blockers: row.blockers ?? [],
          cpvCoverageRate: toNumber(row.cpv_coverage_rate),
          dateCoverageRate: toNumber(row.date_coverage_rate),
          filterAnswersAllowed: row.filter_answers_allowed,
          rowsCount: toNumber(row.rows_count),
          sourceGrain: row.source_grain,
          spendRankingsAllowed: row.spend_rankings_allowed,
          supplierCuiCoverageRate: toNumber(row.supplier_cui_coverage_rate),
          supplierRegionFiltersAllowed: row.supplier_region_filters_allowed,
        }))
      );
    } catch (error) {
      return err(toQueryError(error));
    }
  }

  async rankSuppliers(
    query: ProcurementFilterQuery
  ): Promise<Result<ProcurementSupplierRankingRow[], McpError>> {
    try {
      await setStatementTimeout(this.db, QUERY_TIMEOUT_MS);

      const source =
        query.cpvDivisionCode === undefined
          ? sql`procurement.org_edge_monthly_rollups`
          : sql`procurement.supplier_cpv_division_monthly_rollups`;
      const cpvFields =
        query.cpvDivisionCode === undefined
          ? sql`
          null::text as cpv_division_code,
          null::text as cpv_division_label_en
        `
          : sql`
          max(cpv_division_code) as cpv_division_code,
          max(cpv_division_label_en) as cpv_division_label_en
        `;
      const result = await sql<SupplierRankingRow>`
        select
          supplier_cui,
          max(supplier_name) as supplier_name,
          count(distinct authority_cui)::text as authority_count,
          ${cpvFields},
          sum(flow_count)::text as flow_count,
          sum(amount_ron_sum)::text as amount_ron_sum,
          sum(amount_present_count)::text as amount_present_count,
          sum(amount_missing_count)::text as amount_missing_count,
          min(first_flow_date) as first_flow_date,
          max(last_flow_date) as last_flow_date,
          (array_agg(
            (evidence_refs_sample)[1]
            order by amount_ron_sum desc nulls last, supplier_cui
          ) filter (
            where evidence_refs_sample is not null
              and array_length(evidence_refs_sample, 1) > 0
              and (evidence_refs_sample)[1] is not null
              and (evidence_refs_sample)[1] <> ''
          ))[1:10] as evidence_refs_sample
        from ${source}
        where ${sql.join(buildAggregateWhere(query, 'month_start'), sql` and `)}
        group by supplier_cui
        order by ${rankingExpression(query)} desc nulls last, supplier_cui
        limit ${query.limit}
      `.execute(this.db);

      return ok(result.rows.map(mapSupplierRow));
    } catch (error) {
      return err(toQueryError(error));
    }
  }

  async rankCpvDivisions(
    query: ProcurementFilterQuery
  ): Promise<Result<ProcurementCategoryBreakdownRow[], McpError>> {
    try {
      await setStatementTimeout(this.db, QUERY_TIMEOUT_MS);

      const result = await sql<CategoryBreakdownRow>`
        select
          cpv_division_code,
          max(cpv_division_label_en) as cpv_division_label_en,
          sum(flow_count)::text as flow_count,
          sum(amount_ron_sum)::text as amount_ron_sum,
          sum(amount_present_count)::text as amount_present_count,
          sum(amount_missing_count)::text as amount_missing_count,
          null::text as distinct_supplier_count,
          min(first_flow_date) as first_flow_date,
          max(last_flow_date) as last_flow_date,
          (array_agg(
            (evidence_refs_sample)[1]
            order by amount_ron_sum desc nulls last, cpv_division_code
          ) filter (
            where evidence_refs_sample is not null
              and array_length(evidence_refs_sample, 1) > 0
              and (evidence_refs_sample)[1] is not null
              and (evidence_refs_sample)[1] <> ''
          ))[1:10] as evidence_refs_sample
        from procurement.authority_cpv_division_monthly_rollups
        where ${sql.join(buildAggregateWhere(query, 'month_start'), sql` and `)}
        group by cpv_division_code
        order by ${rankingExpression(query)} desc nulls last, cpv_division_code
        limit ${query.limit}
      `.execute(this.db);

      return ok(result.rows.map(mapCategoryRow));
    } catch (error) {
      return err(toQueryError(error));
    }
  }

  async listSameDayDirectAcquisitionCandidates(
    query: ProcurementFilterQuery
  ): Promise<Result<ProcurementSameDayCandidateRow[], McpError>> {
    try {
      await setStatementTimeout(this.db, QUERY_TIMEOUT_MS);

      const result = await sql<SameDayCandidateRow>`
        select
          candidate_date,
          authority_cui,
          authority_name,
          supplier_cui,
          supplier_name,
          authority_county_name,
          authority_region,
          cpv_code,
          cpv_division_code,
          cpv_division_label_en,
          same_day_count,
          same_day_total_ron,
          max_single_amount_ron,
          amount_present_count,
          amount_missing_count,
          evidence_refs_sample
        from procurement.same_day_direct_acquisition_candidates
        where ${sql.join(buildAggregateWhere(query, 'candidate_date', false), sql` and `)}
        order by ${sameDayRankingExpression(query)} desc nulls last, authority_cui, supplier_cui
        limit ${query.limit}
      `.execute(this.db);

      return ok(result.rows.map(mapSameDayRow));
    } catch (error) {
      return err(toQueryError(error));
    }
  }
}

function buildAggregateWhere(
  query: ProcurementFilterQuery,
  dateColumn: 'candidate_date' | 'month_start',
  includeSourceGrain = true
): RawBuilder<unknown>[] {
  const conditions: RawBuilder<unknown>[] = includeSourceGrain
    ? [sql`source_grain = ${query.sourceGrain}`]
    : [sql`true`];
  if (query.authorityCui !== undefined) {
    conditions.push(sql`authority_cui = ${query.authorityCui}`);
  }
  if (query.authorityCountyCode !== undefined) {
    conditions.push(sql`authority_county_code = ${query.authorityCountyCode}`);
  }
  if (query.authorityRegion !== undefined) {
    conditions.push(sql`authority_region = ${query.authorityRegion}`);
  }
  if (query.cpvDivisionCode !== undefined) {
    conditions.push(sql`cpv_division_code = ${query.cpvDivisionCode}`);
  }
  if (query.yearStart !== undefined) {
    conditions.push(sql`${sql.ref(dateColumn)} >= ${`${String(query.yearStart)}-01-01`}::date`);
  }
  if (query.yearEnd !== undefined) {
    conditions.push(sql`${sql.ref(dateColumn)} <= ${`${String(query.yearEnd)}-12-31`}::date`);
  }
  return conditions;
}

function rankingExpression(query: ProcurementFilterQuery): RawBuilder<unknown> {
  return query.rankBy === 'amount_ron' ? sql`sum(amount_ron_sum)` : sql`sum(flow_count)`;
}

function sameDayRankingExpression(query: ProcurementFilterQuery): RawBuilder<unknown> {
  return query.rankBy === 'amount_ron' ? sql`same_day_total_ron` : sql`same_day_count`;
}

function mapSupplierRow(row: SupplierRankingRow): ProcurementSupplierRankingRow {
  return {
    amountMissingCount: toNumber(row.amount_missing_count),
    amountPresentCount: toNumber(row.amount_present_count),
    amountRonSum: toNullableNumber(row.amount_ron_sum),
    authorityCount: toNumber(row.authority_count),
    cpvDivisionCode: row.cpv_division_code,
    cpvDivisionLabelEn: row.cpv_division_label_en,
    evidenceRefsSample: compactRefs(row.evidence_refs_sample),
    firstFlowDate: toIsoDate(row.first_flow_date),
    flowCount: toNumber(row.flow_count),
    lastFlowDate: toIsoDate(row.last_flow_date),
    supplierCui: row.supplier_cui,
    supplierName: row.supplier_name,
  };
}

function mapCategoryRow(row: CategoryBreakdownRow): ProcurementCategoryBreakdownRow {
  return {
    amountMissingCount: toNumber(row.amount_missing_count),
    amountPresentCount: toNumber(row.amount_present_count),
    amountRonSum: toNullableNumber(row.amount_ron_sum),
    cpvDivisionCode: row.cpv_division_code,
    cpvDivisionLabelEn: row.cpv_division_label_en,
    distinctSupplierCount:
      row.distinct_supplier_count === null ? null : toNumber(row.distinct_supplier_count),
    evidenceRefsSample: compactRefs(row.evidence_refs_sample),
    firstFlowDate: toIsoDate(row.first_flow_date),
    flowCount: toNumber(row.flow_count),
    lastFlowDate: toIsoDate(row.last_flow_date),
  };
}

function mapSameDayRow(row: SameDayCandidateRow): ProcurementSameDayCandidateRow {
  return {
    amountMissingCount: toNumber(row.amount_missing_count),
    amountPresentCount: toNumber(row.amount_present_count),
    authorityCountyName: row.authority_county_name,
    authorityCui: row.authority_cui,
    authorityName: row.authority_name,
    authorityRegion: row.authority_region,
    candidateDate: toIsoDate(row.candidate_date) ?? '',
    cpvCode: row.cpv_code,
    cpvDivisionCode: row.cpv_division_code,
    cpvDivisionLabelEn: row.cpv_division_label_en,
    evidenceRefsSample: compactRefs(row.evidence_refs_sample),
    maxSingleAmountRon: toNullableNumber(row.max_single_amount_ron),
    sameDayCount: toNumber(row.same_day_count),
    sameDayTotalRon: toNullableNumber(row.same_day_total_ron),
    supplierCui: row.supplier_cui,
    supplierName: row.supplier_name,
  };
}

function compactRefs(value: (string | null)[] | null): string[] {
  return (value ?? []).filter(
    (item): item is string => typeof item === 'string' && item.length > 0
  );
}

function toIsoDate(value: Date | string | null): string | null {
  if (value === null) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return value.slice(0, 10);
}

function toNumber(value: string | number | null): number {
  if (value === null) return 0;
  return typeof value === 'number' ? value : Number(value);
}

function toNullableNumber(value: string | number | null): number | null {
  if (value === null) return null;
  return typeof value === 'number' ? value : Number(value);
}

function toQueryError(error: unknown): McpError {
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    if (message.includes('timeout') || message.includes('canceling statement')) {
      return timeoutError();
    }
    return databaseError(error.message);
  }
  return databaseError();
}

export const makeMcpProcurementRepo = (db: BudgetDbClient): McpProcurementRepo =>
  new KyselyMcpProcurementRepo(db);
