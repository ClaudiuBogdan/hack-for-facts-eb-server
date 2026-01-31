import { Decimal } from 'decimal.js';
import {
  sql,
  type ExpressionBuilder,
  type RawBuilder,
  type SelectExpression,
  type SelectQueryBuilder,
} from 'kysely';
import { err, ok, type Result } from 'neverthrow';

import {
  COMMITMENTS_REPORT_TYPE_PRIORITY,
  EXECUTION_REPORT_TYPE_BY_COMMITMENTS,
  isMetricAvailableForPeriod,
  metricToBaseColumn,
  metricToFactColumn,
  shouldUseMV,
  type CommitmentsMetric,
  type DbCommitmentsReportType,
} from '@/common/types/commitments.js';
import { Frequency, type DataPoint, type DataSeries } from '@/common/types/temporal.js';
import { setStatementTimeout } from '@/infra/database/query-builders/index.js';
import {
  escapeLikeWildcards,
  extractYear,
  parsePeriodDate,
  toNumericIds,
  needsEntityJoin,
  needsUatJoin,
  formatDateFromRow,
} from '@/infra/database/query-filters/index.js';

import {
  createDatabaseError,
  createTimeoutError,
  type CommitmentsError,
} from '../../core/errors.js';

import type {
  AggregateFilters,
  CommitmentsRepository,
  CommitmentExecutionMonthData,
  PeriodFactorMap,
  PaginationParams,
} from '../../core/ports.js';
import type {
  CommitmentsAggregatedConnection,
  CommitmentsFilter,
  CommitmentsLineItem,
  CommitmentsLineItemConnection,
  CommitmentsSummaryConnection,
  CommitmentsSummaryResult,
} from '../../core/types.js';
import type { BudgetDbClient } from '@/infra/database/client.js';

// ============================================================================
// Constants
// ============================================================================

const QUERY_TIMEOUT_MS = 30_000;
const MAX_DATA_POINTS = 10_000;

// ============================================================================
// Helpers
// ============================================================================

const isTimeoutError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes('statement timeout') ||
    message.includes('57014') ||
    message.includes('canceling statement due to statement timeout')
  );
};

const toNumericString = (value: number): string => {
  return new Decimal(value).toString();
};

const reportTypePriorityExpr = (reportTypeRef: RawBuilder<unknown>): RawBuilder<number> => {
  const principal = COMMITMENTS_REPORT_TYPE_PRIORITY[0];
  const secondary = COMMITMENTS_REPORT_TYPE_PRIORITY[1];
  const detailed = COMMITMENTS_REPORT_TYPE_PRIORITY[2];

  return sql<number>`
    CASE
      WHEN ${reportTypeRef} = ${principal} THEN 1
      WHEN ${reportTypeRef} = ${secondary} THEN 2
      WHEN ${reportTypeRef} = ${detailed} THEN 3
      ELSE 4
    END
  `;
};

const emptyFactorsCteValues = (factorMap: PeriodFactorMap): ReturnType<typeof sql> => {
  const entries = Array.from(factorMap.entries());
  const valuesList = entries.map(([period, mult]) => sql`(${period}, ${mult.toString()}::numeric)`);
  return sql.join(valuesList, sql`, `);
};

// ============================================================================
// Period Filter Helpers (MV + Fact)
// ============================================================================

function applyIntervalPeriodFilter<DB, TB extends keyof DB & string, O>(
  query: SelectQueryBuilder<DB, TB, O>,
  frequency: Frequency,
  interval: { start: string; end: string },
  alias: string,
  yearCol: string,
  monthCol?: string,
  quarterCol?: string
): SelectQueryBuilder<DB, TB, O> {
  const start = parsePeriodDate(interval.start);
  const end = parsePeriodDate(interval.end);

  if (frequency === Frequency.MONTH && start?.month !== undefined && end?.month !== undefined) {
    // (year, month) tuple filter
    query = query.where((eb: ExpressionBuilder<DB, TB>) =>
      eb(
        sql`(${sql.ref(`${alias}.${yearCol}`)}, ${sql.ref(`${alias}.${monthCol ?? 'month'}`)})`,
        '>=',
        sql`(${start.year}, ${start.month})`
      )
    );
    query = query.where((eb: ExpressionBuilder<DB, TB>) =>
      eb(
        sql`(${sql.ref(`${alias}.${yearCol}`)}, ${sql.ref(`${alias}.${monthCol ?? 'month'}`)})`,
        '<=',
        sql`(${end.year}, ${end.month})`
      )
    );
    return query;
  }

  if (
    frequency === Frequency.QUARTER &&
    start?.quarter !== undefined &&
    end?.quarter !== undefined
  ) {
    query = query.where((eb: ExpressionBuilder<DB, TB>) =>
      eb(
        sql`(${sql.ref(`${alias}.${yearCol}`)}, ${sql.ref(`${alias}.${quarterCol ?? 'quarter'}`)})`,
        '>=',
        sql`(${start.year}, ${start.quarter})`
      )
    );
    query = query.where((eb: ExpressionBuilder<DB, TB>) =>
      eb(
        sql`(${sql.ref(`${alias}.${yearCol}`)}, ${sql.ref(`${alias}.${quarterCol ?? 'quarter'}`)})`,
        '<=',
        sql`(${end.year}, ${end.quarter})`
      )
    );
    return query;
  }

  // YEAR or fallback
  const startYear = start?.year ?? extractYear(interval.start);
  const endYear = end?.year ?? extractYear(interval.end);

  if (startYear !== null) {
    query = query.where(sql.ref(`${alias}.${yearCol}`), '>=', startYear);
  }
  if (endYear !== null) {
    query = query.where(sql.ref(`${alias}.${yearCol}`), '<=', endYear);
  }

  return query;
}

function applyDatesPeriodFilter<DB, TB extends keyof DB & string, O>(
  query: SelectQueryBuilder<DB, TB, O>,
  frequency: Frequency,
  dates: readonly string[],
  alias: string,
  yearCol: string,
  monthCol?: string,
  quarterCol?: string
): SelectQueryBuilder<DB, TB, O> {
  if (dates.length === 0) return query;

  if (frequency === Frequency.MONTH) {
    const periods = dates
      .map((d) => parsePeriodDate(d))
      .filter((p): p is { year: number; month: number } => p?.month !== undefined);

    if (periods.length === 0) return query;

    return query.where((eb: ExpressionBuilder<DB, TB>) =>
      eb.or(
        periods.map((p) =>
          eb.and([
            eb(sql.ref(`${alias}.${yearCol}`), '=', p.year),
            eb(sql.ref(`${alias}.${monthCol ?? 'month'}`), '=', p.month),
          ])
        )
      )
    );
  }

  if (frequency === Frequency.QUARTER) {
    const periods = dates
      .map((d) => parsePeriodDate(d))
      .filter((p): p is { year: number; quarter: number } => p?.quarter !== undefined);

    if (periods.length === 0) return query;

    return query.where((eb: ExpressionBuilder<DB, TB>) =>
      eb.or(
        periods.map((p) =>
          eb.and([
            eb(sql.ref(`${alias}.${yearCol}`), '=', p.year),
            eb(sql.ref(`${alias}.${quarterCol ?? 'quarter'}`), '=', p.quarter),
          ])
        )
      )
    );
  }

  // YEAR
  const years = dates.map((d) => extractYear(d)).filter((y): y is number => y !== null);
  if (years.length === 0) return query;

  return query.where(sql.ref(`${alias}.${yearCol}`), 'in', years);
}

// ============================================================================
// Repo
// ============================================================================

class KyselyCommitmentsRepo implements CommitmentsRepository {
  constructor(private readonly db: BudgetDbClient) {}

  async listSummary(
    filter: CommitmentsFilter,
    limit: number,
    offset: number
  ): Promise<Result<CommitmentsSummaryConnection, CommitmentsError>> {
    const frequency = filter.report_period.type;

    // Decide MV vs fact based on routing rules.
    const useMv = shouldUseMV(
      filter as unknown as import('@/common/types/commitments.js').CommitmentsFilter
    );

    try {
      await setStatementTimeout(this.db, QUERY_TIMEOUT_MS);

      if (useMv) {
        return await this.listSummaryFromMV(filter, frequency, limit, offset);
      }

      return await this.listSummaryFromFact(filter, frequency, limit, offset);
    } catch (error) {
      if (isTimeoutError(error)) {
        return err(createTimeoutError('commitmentsSummary query timed out', error));
      }
      return err(createDatabaseError('commitmentsSummary query failed', error));
    }
  }

  // --------------------------------------------------------------------------
  // Summary - MV
  // --------------------------------------------------------------------------

  private async listSummaryFromMV(
    filter: CommitmentsFilter,
    frequency: Frequency,
    limit: number,
    offset: number
  ): Promise<Result<CommitmentsSummaryConnection, CommitmentsError>> {
    const reportTypeParam = filter.report_type ?? null;

    // NOTE: We always join entities + uats for:
    // - entity_name output
    // - optional population (per-capita normalization in core)
    // - geographic/entity filters
    const selection = filter.report_period.selection;

    if (frequency === Frequency.MONTH) {
      let base = this.db
        .selectFrom('mv_angajamente_summary_monthly as s')
        .innerJoin('entities as e', 's.entity_cui', 'e.cui')
        .leftJoin('uats as u', 'e.uat_id', 'u.id')
        .select([
          's.year',
          's.month',
          's.entity_cui',
          sql<string>`e.name`.as('entity_name'),
          's.main_creditor_cui',
          's.report_type',
          sql<number | null>`u.population`.as('population'),
          's.credite_angajament',
          's.plati_trezor',
          's.plati_non_trezor',
          's.receptii_totale',
          's.receptii_neplatite_change',
          reportTypePriorityExpr(sql.ref('s.report_type')).as('priority'),
          sql<number>`MIN(${reportTypePriorityExpr(sql.ref('s.report_type'))}) OVER (PARTITION BY s.entity_cui, s.year)`.as(
            'min_priority'
          ),
        ]);

      base = this.applySummaryCommonFilters(base, filter, 's');
      base = this.applySummaryPeriodFilters(base, selection, frequency, 's', 'year', 'month');

      // Thresholds (post-aggregation) apply to plati_trezor for summary.
      if (filter.aggregate_min_amount !== undefined && filter.aggregate_min_amount !== null) {
        base = base.where('s.plati_trezor', '>=', toNumericString(filter.aggregate_min_amount));
      }
      if (filter.aggregate_max_amount !== undefined && filter.aggregate_max_amount !== null) {
        base = base.where('s.plati_trezor', '<=', toNumericString(filter.aggregate_max_amount));
      }

      let rowsQuery = this.db
        .with('base', () => base)
        .selectFrom('base')
        .select([
          'year',
          'month',
          'entity_cui',
          'entity_name',
          'main_creditor_cui',
          'report_type',
          'population',
          'credite_angajament',
          'plati_trezor',
          'plati_non_trezor',
          'receptii_totale',
          'receptii_neplatite_change',
          sql<string>`COUNT(*) OVER()`.as('total_count'),
        ]);

      rowsQuery =
        reportTypeParam !== null
          ? rowsQuery.where(sql<boolean>`report_type = ${reportTypeParam}`)
          : rowsQuery.whereRef('priority', '=', 'min_priority');

      const rows = await rowsQuery
        .orderBy('plati_trezor', 'desc')
        .limit(limit)
        .offset(offset)
        .execute();

      const totalCount =
        rows[0]?.total_count !== undefined ? Number.parseInt(rows[0].total_count, 10) : 0;

      const nodes: CommitmentsSummaryResult[] = rows.map((r) => ({
        __typename: 'CommitmentsMonthlySummary',
        year: r.year,
        month: r.month,
        entity_cui: r.entity_cui,
        entity_name: r.entity_name,
        main_creditor_cui: r.main_creditor_cui,
        report_type: r.report_type as DbCommitmentsReportType,
        population: r.population,
        credite_angajament: new Decimal(r.credite_angajament),
        plati_trezor: new Decimal(r.plati_trezor),
        plati_non_trezor: new Decimal(r.plati_non_trezor),
        receptii_totale: new Decimal(r.receptii_totale),
        receptii_neplatite_change: new Decimal(r.receptii_neplatite_change),
        total_plati: new Decimal(r.plati_trezor).add(new Decimal(r.plati_non_trezor)),
      }));

      return ok({
        nodes,
        pageInfo: {
          totalCount,
          hasNextPage: offset + limit < totalCount,
          hasPreviousPage: offset > 0,
        },
      });
    }

    if (frequency === Frequency.QUARTER) {
      let base = this.db
        .selectFrom('mv_angajamente_summary_quarterly as s')
        .innerJoin('entities as e', 's.entity_cui', 'e.cui')
        .leftJoin('uats as u', 'e.uat_id', 'u.id')
        .select([
          's.year',
          's.quarter',
          's.entity_cui',
          sql<string>`e.name`.as('entity_name'),
          's.main_creditor_cui',
          's.report_type',
          sql<number | null>`u.population`.as('population'),
          's.credite_angajament',
          's.limita_credit_angajament',
          's.credite_bugetare',
          's.credite_angajament_initiale',
          's.credite_bugetare_initiale',
          's.credite_angajament_definitive',
          's.credite_bugetare_definitive',
          's.credite_angajament_disponibile',
          's.credite_bugetare_disponibile',
          's.receptii_totale',
          's.plati_trezor',
          's.plati_non_trezor',
          's.receptii_neplatite',
          reportTypePriorityExpr(sql.ref('s.report_type')).as('priority'),
          sql<number>`MIN(${reportTypePriorityExpr(sql.ref('s.report_type'))}) OVER (PARTITION BY s.entity_cui, s.year)`.as(
            'min_priority'
          ),
        ]);

      base = this.applySummaryCommonFilters(base, filter, 's');
      base = this.applySummaryPeriodFilters(
        base,
        selection,
        frequency,
        's',
        'year',
        undefined,
        'quarter'
      );

      if (filter.aggregate_min_amount !== undefined && filter.aggregate_min_amount !== null) {
        base = base.where('s.plati_trezor', '>=', toNumericString(filter.aggregate_min_amount));
      }
      if (filter.aggregate_max_amount !== undefined && filter.aggregate_max_amount !== null) {
        base = base.where('s.plati_trezor', '<=', toNumericString(filter.aggregate_max_amount));
      }

      let rowsQuery = this.db
        .with('base', () => base)
        .selectFrom('base')
        .select([
          'year',
          'quarter',
          'entity_cui',
          'entity_name',
          'main_creditor_cui',
          'report_type',
          'population',
          'credite_angajament',
          'limita_credit_angajament',
          'credite_bugetare',
          'credite_angajament_initiale',
          'credite_bugetare_initiale',
          'credite_angajament_definitive',
          'credite_bugetare_definitive',
          'credite_angajament_disponibile',
          'credite_bugetare_disponibile',
          'receptii_totale',
          'plati_trezor',
          'plati_non_trezor',
          'receptii_neplatite',
          sql<string>`COUNT(*) OVER()`.as('total_count'),
        ]);

      rowsQuery =
        reportTypeParam !== null
          ? rowsQuery.where(sql<boolean>`report_type = ${reportTypeParam}`)
          : rowsQuery.whereRef('priority', '=', 'min_priority');

      const rows = await rowsQuery
        .orderBy('plati_trezor', 'desc')
        .limit(limit)
        .offset(offset)
        .execute();

      const totalCount =
        rows[0]?.total_count !== undefined ? Number.parseInt(rows[0].total_count, 10) : 0;

      const nodes: CommitmentsSummaryResult[] = rows.map((r) => {
        const platiTrezor = new Decimal(r.plati_trezor);
        const platiNonTrezor = new Decimal(r.plati_non_trezor);

        const crediteBugetareDef = new Decimal(r.credite_bugetare_definitive);
        const crediteAngajamentDef = new Decimal(r.credite_angajament_definitive);

        return {
          __typename: 'CommitmentsQuarterlySummary',
          year: r.year,
          quarter: r.quarter,
          entity_cui: r.entity_cui,
          entity_name: r.entity_name,
          main_creditor_cui: r.main_creditor_cui,
          report_type: r.report_type as DbCommitmentsReportType,
          population: r.population,
          credite_angajament: new Decimal(r.credite_angajament),
          limita_credit_angajament: new Decimal(r.limita_credit_angajament),
          credite_bugetare: new Decimal(r.credite_bugetare),
          credite_angajament_initiale: new Decimal(r.credite_angajament_initiale),
          credite_bugetare_initiale: new Decimal(r.credite_bugetare_initiale),
          credite_angajament_definitive: crediteAngajamentDef,
          credite_bugetare_definitive: crediteBugetareDef,
          credite_angajament_disponibile: new Decimal(r.credite_angajament_disponibile),
          credite_bugetare_disponibile: new Decimal(r.credite_bugetare_disponibile),
          receptii_totale: new Decimal(r.receptii_totale),
          plati_trezor: platiTrezor,
          plati_non_trezor: platiNonTrezor,
          receptii_neplatite: new Decimal(r.receptii_neplatite),
          total_plati: platiTrezor.add(platiNonTrezor),
          execution_rate: crediteBugetareDef.isZero()
            ? null
            : platiTrezor.div(crediteBugetareDef).mul(100),
          commitment_rate: crediteAngajamentDef.isZero()
            ? null
            : new Decimal(r.credite_angajament).div(crediteAngajamentDef).mul(100),
        };
      });

      return ok({
        nodes,
        pageInfo: {
          totalCount,
          hasNextPage: offset + limit < totalCount,
          hasPreviousPage: offset > 0,
        },
      });
    }

    // YEAR
    let base = this.db
      .selectFrom('mv_angajamente_summary_annual as s')
      .innerJoin('entities as e', 's.entity_cui', 'e.cui')
      .leftJoin('uats as u', 'e.uat_id', 'u.id')
      .select([
        's.year',
        's.entity_cui',
        sql<string>`e.name`.as('entity_name'),
        's.main_creditor_cui',
        's.report_type',
        sql<number | null>`u.population`.as('population'),
        's.credite_angajament',
        's.limita_credit_angajament',
        's.credite_bugetare',
        's.credite_angajament_initiale',
        's.credite_bugetare_initiale',
        's.credite_angajament_definitive',
        's.credite_bugetare_definitive',
        's.credite_angajament_disponibile',
        's.credite_bugetare_disponibile',
        's.receptii_totale',
        's.plati_trezor',
        's.plati_non_trezor',
        's.receptii_neplatite',
        reportTypePriorityExpr(sql.ref('s.report_type')).as('priority'),
        sql<number>`MIN(${reportTypePriorityExpr(sql.ref('s.report_type'))}) OVER (PARTITION BY s.entity_cui, s.year)`.as(
          'min_priority'
        ),
      ]);

    base = this.applySummaryCommonFilters(base, filter, 's');
    base = this.applySummaryPeriodFilters(base, selection, frequency, 's', 'year');

    if (filter.aggregate_min_amount !== undefined && filter.aggregate_min_amount !== null) {
      base = base.where('s.plati_trezor', '>=', toNumericString(filter.aggregate_min_amount));
    }
    if (filter.aggregate_max_amount !== undefined && filter.aggregate_max_amount !== null) {
      base = base.where('s.plati_trezor', '<=', toNumericString(filter.aggregate_max_amount));
    }

    let rowsQuery = this.db
      .with('base', () => base)
      .selectFrom('base')
      .select([
        'year',
        'entity_cui',
        'entity_name',
        'main_creditor_cui',
        'report_type',
        'population',
        'credite_angajament',
        'limita_credit_angajament',
        'credite_bugetare',
        'credite_angajament_initiale',
        'credite_bugetare_initiale',
        'credite_angajament_definitive',
        'credite_bugetare_definitive',
        'credite_angajament_disponibile',
        'credite_bugetare_disponibile',
        'receptii_totale',
        'plati_trezor',
        'plati_non_trezor',
        'receptii_neplatite',
        sql<string>`COUNT(*) OVER()`.as('total_count'),
      ]);

    rowsQuery =
      reportTypeParam !== null
        ? rowsQuery.where('report_type', '=', reportTypeParam)
        : rowsQuery.whereRef('priority', '=', 'min_priority');

    const rows = await rowsQuery
      .orderBy('plati_trezor', 'desc')
      .limit(limit)
      .offset(offset)
      .execute();

    const totalCount =
      rows[0]?.total_count !== undefined ? Number.parseInt(rows[0].total_count, 10) : 0;

    const nodes: CommitmentsSummaryResult[] = rows.map((r) => {
      const platiTrezor = new Decimal(r.plati_trezor);
      const platiNonTrezor = new Decimal(r.plati_non_trezor);

      const crediteBugetareDef = new Decimal(r.credite_bugetare_definitive);
      const crediteAngajamentDef = new Decimal(r.credite_angajament_definitive);

      return {
        __typename: 'CommitmentsAnnualSummary',
        year: r.year,
        entity_cui: r.entity_cui,
        entity_name: r.entity_name,
        main_creditor_cui: r.main_creditor_cui,
        report_type: r.report_type as DbCommitmentsReportType,
        population: r.population,
        credite_angajament: new Decimal(r.credite_angajament),
        limita_credit_angajament: new Decimal(r.limita_credit_angajament),
        credite_bugetare: new Decimal(r.credite_bugetare),
        credite_angajament_initiale: new Decimal(r.credite_angajament_initiale),
        credite_bugetare_initiale: new Decimal(r.credite_bugetare_initiale),
        credite_angajament_definitive: crediteAngajamentDef,
        credite_bugetare_definitive: crediteBugetareDef,
        credite_angajament_disponibile: new Decimal(r.credite_angajament_disponibile),
        credite_bugetare_disponibile: new Decimal(r.credite_bugetare_disponibile),
        receptii_totale: new Decimal(r.receptii_totale),
        plati_trezor: platiTrezor,
        plati_non_trezor: platiNonTrezor,
        receptii_neplatite: new Decimal(r.receptii_neplatite),
        total_plati: platiTrezor.add(platiNonTrezor),
        execution_rate: crediteBugetareDef.isZero()
          ? null
          : platiTrezor.div(crediteBugetareDef).mul(100),
        commitment_rate: crediteAngajamentDef.isZero()
          ? null
          : new Decimal(r.credite_angajament).div(crediteAngajamentDef).mul(100),
      };
    });

    return ok({
      nodes,
      pageInfo: {
        totalCount,
        hasNextPage: offset + limit < totalCount,
        hasPreviousPage: offset > 0,
      },
    });
  }

  private applySummaryPeriodFilters<DB, TB extends keyof DB & string, O>(
    query: SelectQueryBuilder<DB, TB, O>,
    selection: CommitmentsFilter['report_period']['selection'],
    frequency: Frequency,
    alias: string,
    yearCol: string,
    monthCol?: string,
    quarterCol?: string
  ): SelectQueryBuilder<DB, TB, O> {
    if (selection.interval !== undefined) {
      query = applyIntervalPeriodFilter(
        query,
        frequency,
        selection.interval,
        alias,
        yearCol,
        monthCol,
        quarterCol
      );
    }
    if (selection.dates !== undefined && selection.dates.length > 0) {
      query = applyDatesPeriodFilter(
        query,
        frequency,
        selection.dates,
        alias,
        yearCol,
        monthCol,
        quarterCol
      );
    }
    return query;
  }

  private applySummaryCommonFilters<DB, TB extends keyof DB & string, O>(
    query: SelectQueryBuilder<DB, TB, O>,
    filter: CommitmentsFilter,
    alias: string
  ): SelectQueryBuilder<DB, TB, O> {
    if (filter.entity_cuis !== undefined && filter.entity_cuis.length > 0) {
      query = query.where(sql.ref(`${alias}.entity_cui`), 'in', filter.entity_cuis);
    }

    if (filter.main_creditor_cui !== undefined) {
      query = query.where(sql.ref(`${alias}.main_creditor_cui`), '=', filter.main_creditor_cui);
    }

    // Entity / geographic filters
    if (filter.entity_types !== undefined && filter.entity_types.length > 0) {
      query = query.where(sql.ref('e.entity_type'), 'in', filter.entity_types);
    }

    if (filter.is_uat !== undefined) {
      query = query.where(sql.ref('e.is_uat'), '=', filter.is_uat);
    }

    if (filter.uat_ids !== undefined && filter.uat_ids.length > 0) {
      const ids = toNumericIds(filter.uat_ids);
      if (ids.length > 0) {
        query = query.where(sql.ref('e.uat_id'), 'in', ids);
      }
    }

    if (filter.search !== undefined && filter.search.trim() !== '') {
      const pattern = '%' + escapeLikeWildcards(filter.search.trim()) + '%';
      query = query.where(sql.ref('e.name'), 'ilike', pattern);
    }

    if (filter.county_codes !== undefined && filter.county_codes.length > 0) {
      query = query.where(sql.ref('u.county_code'), 'in', filter.county_codes);
    }

    if (filter.regions !== undefined && filter.regions.length > 0) {
      query = query.where(sql.ref('u.region'), 'in', filter.regions);
    }

    if (filter.min_population !== undefined && filter.min_population !== null) {
      query = query.where(sql.ref('u.population'), '>=', filter.min_population);
    }

    if (filter.max_population !== undefined && filter.max_population !== null) {
      query = query.where(sql.ref('u.population'), '<=', filter.max_population);
    }

    // Exclusions that are applicable at MV grain
    const exclude = filter.exclude;

    if (exclude?.entity_cuis !== undefined && exclude.entity_cuis.length > 0) {
      query = query.where(sql.ref(`${alias}.entity_cui`), 'not in', exclude.entity_cuis);
    }

    if (exclude?.entity_types !== undefined && exclude.entity_types.length > 0) {
      query = query.where((eb: ExpressionBuilder<DB, TB>) =>
        eb.or([
          eb(sql.ref('e.entity_type'), 'is', null),
          eb(sql.ref('e.entity_type'), 'not in', exclude.entity_types),
        ])
      );
    }

    if (exclude?.uat_ids !== undefined && exclude.uat_ids.length > 0) {
      const ids = toNumericIds(exclude.uat_ids);
      if (ids.length > 0) {
        query = query.where((eb: ExpressionBuilder<DB, TB>) =>
          eb.or([eb(sql.ref('e.uat_id'), 'is', null), eb(sql.ref('e.uat_id'), 'not in', ids)])
        );
      }
    }

    if (exclude?.county_codes !== undefined && exclude.county_codes.length > 0) {
      query = query.where((eb: ExpressionBuilder<DB, TB>) =>
        eb.or([
          eb(sql.ref('u.county_code'), 'is', null),
          eb(sql.ref('u.county_code'), 'not in', exclude.county_codes),
        ])
      );
    }

    if (exclude?.regions !== undefined && exclude.regions.length > 0) {
      query = query.where((eb: ExpressionBuilder<DB, TB>) =>
        eb.or([
          eb(sql.ref('u.region'), 'is', null),
          eb(sql.ref('u.region'), 'not in', exclude.regions),
        ])
      );
    }

    return query;
  }

  // --------------------------------------------------------------------------
  // Summary - Fact
  // --------------------------------------------------------------------------

  private async listSummaryFromFact(
    filter: CommitmentsFilter,
    frequency: Frequency,
    limit: number,
    offset: number
  ): Promise<Result<CommitmentsSummaryConnection, CommitmentsError>> {
    const selection = filter.report_period.selection;
    const reportTypeParam = filter.report_type ?? null;

    const monthlyMetricCols = {
      credite_angajament: sql.ref('eli.monthly_credite_angajament'),
      plati_trezor: sql.ref('eli.monthly_plati_trezor'),
      plati_non_trezor: sql.ref('eli.monthly_plati_non_trezor'),
      receptii_totale: sql.ref('eli.monthly_receptii_totale'),
      receptii_neplatite_change: sql.ref('eli.monthly_receptii_neplatite_change'),
    } as const;

    const base = this.db
      .selectFrom('angajamentelineitems as eli')
      .innerJoin('entities as e', 'eli.entity_cui', 'e.cui')
      .leftJoin('uats as u', 'e.uat_id', 'u.id')
      .select((_eb) => {
        type Db = typeof _eb extends ExpressionBuilder<infer DB, infer _TB> ? DB : never;
        type Tb = typeof _eb extends ExpressionBuilder<infer _DB, infer TB> ? TB : never;

        const cols: SelectExpression<Db, Tb>[] = [
          'eli.entity_cui',
          sql<string>`e.name`.as('entity_name'),
          'eli.main_creditor_cui',
          'eli.report_type',
          sql<number | null>`u.population`.as('population'),
          'eli.year',
          reportTypePriorityExpr(sql.ref('eli.report_type')).as('priority'),
        ];

        if (frequency === Frequency.MONTH) {
          cols.push('eli.month');
          cols.push(
            sql<string>`COALESCE(SUM(${monthlyMetricCols.credite_angajament}), 0)`.as(
              'credite_angajament'
            )
          );
          cols.push(
            sql<string>`COALESCE(SUM(${monthlyMetricCols.plati_trezor}), 0)`.as('plati_trezor')
          );
          cols.push(
            sql<string>`COALESCE(SUM(${monthlyMetricCols.plati_non_trezor}), 0)`.as(
              'plati_non_trezor'
            )
          );
          cols.push(
            sql<string>`COALESCE(SUM(${monthlyMetricCols.receptii_totale}), 0)`.as(
              'receptii_totale'
            )
          );
          cols.push(
            sql<string>`COALESCE(SUM(${monthlyMetricCols.receptii_neplatite_change}), 0)`.as(
              'receptii_neplatite_change'
            )
          );
        } else if (frequency === Frequency.QUARTER) {
          cols.push('eli.quarter');
          cols.push(
            sql<string>`COALESCE(SUM(COALESCE(eli.quarterly_credite_angajament, 0)), 0)`.as(
              'credite_angajament'
            )
          );
          cols.push(
            sql<string>`COALESCE(SUM(COALESCE(eli.quarterly_limita_credit_angajament, 0)), 0)`.as(
              'limita_credit_angajament'
            )
          );
          cols.push(
            sql<string>`COALESCE(SUM(COALESCE(eli.quarterly_credite_bugetare, 0)), 0)`.as(
              'credite_bugetare'
            )
          );
          cols.push(
            sql<string>`COALESCE(SUM(COALESCE(eli.quarterly_credite_angajament_initiale, 0)), 0)`.as(
              'credite_angajament_initiale'
            )
          );
          cols.push(
            sql<string>`COALESCE(SUM(COALESCE(eli.quarterly_credite_bugetare_initiale, 0)), 0)`.as(
              'credite_bugetare_initiale'
            )
          );
          cols.push(
            sql<string>`COALESCE(SUM(COALESCE(eli.quarterly_credite_angajament_definitive, 0)), 0)`.as(
              'credite_angajament_definitive'
            )
          );
          cols.push(
            sql<string>`COALESCE(SUM(COALESCE(eli.quarterly_credite_bugetare_definitive, 0)), 0)`.as(
              'credite_bugetare_definitive'
            )
          );
          cols.push(
            sql<string>`COALESCE(SUM(COALESCE(eli.quarterly_credite_angajament_disponibile, 0)), 0)`.as(
              'credite_angajament_disponibile'
            )
          );
          cols.push(
            sql<string>`COALESCE(SUM(COALESCE(eli.quarterly_credite_bugetare_disponibile, 0)), 0)`.as(
              'credite_bugetare_disponibile'
            )
          );
          cols.push(
            sql<string>`COALESCE(SUM(COALESCE(eli.quarterly_receptii_totale, 0)), 0)`.as(
              'receptii_totale'
            )
          );
          cols.push(
            sql<string>`COALESCE(SUM(COALESCE(eli.quarterly_plati_trezor, 0)), 0)`.as(
              'plati_trezor'
            )
          );
          cols.push(
            sql<string>`COALESCE(SUM(COALESCE(eli.quarterly_plati_non_trezor, 0)), 0)`.as(
              'plati_non_trezor'
            )
          );
          cols.push(
            sql<string>`COALESCE(SUM(COALESCE(eli.quarterly_receptii_neplatite, 0)), 0)`.as(
              'receptii_neplatite'
            )
          );
        } else {
          cols.push(sql<string>`COALESCE(SUM(eli.credite_angajament), 0)`.as('credite_angajament'));
          cols.push(
            sql<string>`COALESCE(SUM(eli.limita_credit_angajament), 0)`.as(
              'limita_credit_angajament'
            )
          );
          cols.push(sql<string>`COALESCE(SUM(eli.credite_bugetare), 0)`.as('credite_bugetare'));
          cols.push(
            sql<string>`COALESCE(SUM(eli.credite_angajament_initiale), 0)`.as(
              'credite_angajament_initiale'
            )
          );
          cols.push(
            sql<string>`COALESCE(SUM(eli.credite_bugetare_initiale), 0)`.as(
              'credite_bugetare_initiale'
            )
          );
          cols.push(
            sql<string>`COALESCE(SUM(eli.credite_angajament_definitive), 0)`.as(
              'credite_angajament_definitive'
            )
          );
          cols.push(
            sql<string>`COALESCE(SUM(eli.credite_bugetare_definitive), 0)`.as(
              'credite_bugetare_definitive'
            )
          );
          cols.push(
            sql<string>`COALESCE(SUM(eli.credite_angajament_disponibile), 0)`.as(
              'credite_angajament_disponibile'
            )
          );
          cols.push(
            sql<string>`COALESCE(SUM(eli.credite_bugetare_disponibile), 0)`.as(
              'credite_bugetare_disponibile'
            )
          );
          cols.push(sql<string>`COALESCE(SUM(eli.receptii_totale), 0)`.as('receptii_totale'));
          cols.push(sql<string>`COALESCE(SUM(eli.plati_trezor), 0)`.as('plati_trezor'));
          cols.push(sql<string>`COALESCE(SUM(eli.plati_non_trezor), 0)`.as('plati_non_trezor'));
          cols.push(sql<string>`COALESCE(SUM(eli.receptii_neplatite), 0)`.as('receptii_neplatite'));
        }

        return cols;
      });

    let query = base;

    // Apply period flags first (index usage)
    if (frequency === Frequency.QUARTER) {
      query = query.where('eli.is_quarterly', '=', true);
    } else if (frequency === Frequency.YEAR) {
      query = query.where('eli.is_yearly', '=', true);
    }

    // Period selection filters
    query = this.applySummaryPeriodFilters(
      query,
      selection,
      frequency,
      'eli',
      'year',
      'month',
      'quarter'
    );

    // Optional explicit report type filter (reduces scanned rows)
    if (filter.report_type !== undefined) {
      query = query.where('eli.report_type', '=', filter.report_type);
    }

    // Dimension filters
    if (filter.entity_cuis !== undefined && filter.entity_cuis.length > 0) {
      query = query.where('eli.entity_cui', 'in', filter.entity_cuis);
    }

    if (filter.main_creditor_cui !== undefined) {
      query = query.where('eli.main_creditor_cui', '=', filter.main_creditor_cui);
    }

    if (filter.funding_source_ids !== undefined && filter.funding_source_ids.length > 0) {
      const ids = toNumericIds(filter.funding_source_ids);
      if (ids.length > 0) {
        query = query.where('eli.funding_source_id', 'in', ids);
      }
    }

    if (filter.budget_sector_ids !== undefined && filter.budget_sector_ids.length > 0) {
      const ids = toNumericIds(filter.budget_sector_ids);
      if (ids.length > 0) {
        query = query.where('eli.budget_sector_id', 'in', ids);
      }
    }

    // Classification filters
    if (filter.functional_codes !== undefined && filter.functional_codes.length > 0) {
      query = query.where('eli.functional_code', 'in', filter.functional_codes);
    }
    if (filter.functional_prefixes !== undefined && filter.functional_prefixes.length > 0) {
      const prefixes = filter.functional_prefixes;
      query = query.where((eb) =>
        eb.or(prefixes.map((p) => eb('eli.functional_code', 'like', escapeLikeWildcards(p) + '%')))
      );
    }

    if (filter.economic_codes !== undefined && filter.economic_codes.length > 0) {
      query = query.where('eli.economic_code', 'in', filter.economic_codes);
    }
    if (filter.economic_prefixes !== undefined && filter.economic_prefixes.length > 0) {
      const prefixes = filter.economic_prefixes;
      query = query.where((eb) =>
        eb.or(prefixes.map((p) => eb('eli.economic_code', 'like', escapeLikeWildcards(p) + '%')))
      );
    }

    // Transfer exclusion (NULL-safe)
    if (filter.exclude_transfers) {
      query = query.where((eb) =>
        eb.and([
          eb.or([
            eb('eli.economic_code', 'is', null),
            eb.and([
              eb('eli.economic_code', 'not like', '51.01%'),
              eb('eli.economic_code', 'not like', '51.02%'),
            ]),
          ]),
          eb.and([
            eb('eli.functional_code', 'not like', '36.02.05%'),
            eb('eli.functional_code', 'not like', '37.02.03%'),
            eb('eli.functional_code', 'not like', '37.02.04%'),
            eb('eli.functional_code', 'not like', '47.02.04%'),
          ]),
        ])
      );
    }

    // Entity/geographic filters via joined entities/uats
    query = this.applySummaryCommonFilters(query, filter, 'eli');

    // Exclusion filters that force fact (still supported)
    const exclude = filter.exclude;

    if (exclude?.functional_codes !== undefined && exclude.functional_codes.length > 0) {
      query = query.where('eli.functional_code', 'not in', exclude.functional_codes);
    }
    if (exclude?.functional_prefixes !== undefined && exclude.functional_prefixes.length > 0) {
      const prefixes = exclude.functional_prefixes;
      query = query.where((eb) =>
        eb.and(
          prefixes.map((p) => eb('eli.functional_code', 'not like', escapeLikeWildcards(p) + '%'))
        )
      );
    }

    if (exclude?.economic_codes !== undefined && exclude.economic_codes.length > 0) {
      const codes = exclude.economic_codes;
      query = query.where((eb) =>
        eb.or([eb('eli.economic_code', 'is', null), eb('eli.economic_code', 'not in', codes)])
      );
    }
    if (exclude?.economic_prefixes !== undefined && exclude.economic_prefixes.length > 0) {
      const prefixes = exclude.economic_prefixes;
      query = query.where((eb) =>
        eb.or([
          eb('eli.economic_code', 'is', null),
          eb.and(
            prefixes.map((p) => eb('eli.economic_code', 'not like', escapeLikeWildcards(p) + '%'))
          ),
        ])
      );
    }

    // Per-row amount thresholds apply to period-appropriate plati_trezor column.
    if (filter.item_min_amount !== undefined && filter.item_min_amount !== null) {
      const min = filter.item_min_amount;
      if (frequency === Frequency.MONTH)
        query = query.where('eli.monthly_plati_trezor', '>=', toNumericString(min));
      else if (frequency === Frequency.QUARTER)
        query = query.where(sql`COALESCE(eli.quarterly_plati_trezor, 0)`, '>=', min);
      else query = query.where('eli.plati_trezor', '>=', toNumericString(min));
    }

    if (filter.item_max_amount !== undefined && filter.item_max_amount !== null) {
      const max = filter.item_max_amount;
      if (frequency === Frequency.MONTH)
        query = query.where('eli.monthly_plati_trezor', '<=', toNumericString(max));
      else if (frequency === Frequency.QUARTER)
        query = query.where(sql`COALESCE(eli.quarterly_plati_trezor, 0)`, '<=', max);
      else query = query.where('eli.plati_trezor', '<=', toNumericString(max));
    }

    // GROUP BY and HAVING
    if (frequency === Frequency.MONTH) {
      query = query.groupBy([
        'eli.year',
        'eli.month',
        'eli.entity_cui',
        'e.name',
        'eli.main_creditor_cui',
        'eli.report_type',
        'u.population',
      ]);
    } else if (frequency === Frequency.QUARTER) {
      query = query.groupBy([
        'eli.year',
        'eli.quarter',
        'eli.entity_cui',
        'e.name',
        'eli.main_creditor_cui',
        'eli.report_type',
        'u.population',
      ]);
    } else {
      query = query.groupBy([
        'eli.year',
        'eli.entity_cui',
        'e.name',
        'eli.main_creditor_cui',
        'eli.report_type',
        'u.population',
      ]);
    }

    // Post-aggregation thresholds (apply to plati_trezor metric)
    const platiTrezorHavingExpr =
      frequency === Frequency.MONTH
        ? sql`COALESCE(SUM(${monthlyMetricCols.plati_trezor}), 0)`
        : frequency === Frequency.QUARTER
          ? sql`COALESCE(SUM(COALESCE(eli.quarterly_plati_trezor, 0)), 0)`
          : sql`COALESCE(SUM(eli.plati_trezor), 0)`;

    if (filter.aggregate_min_amount !== undefined && filter.aggregate_min_amount !== null) {
      query = query.having(platiTrezorHavingExpr, '>=', filter.aggregate_min_amount);
    }
    if (filter.aggregate_max_amount !== undefined && filter.aggregate_max_amount !== null) {
      query = query.having(platiTrezorHavingExpr, '<=', filter.aggregate_max_amount);
    }

    // Apply fallback report type selection per entity-year using window min(priority).
    const baseCtes = this.db
      .with('aggregated', () => query)
      .with('with_priority', (db) =>
        db
          .selectFrom('aggregated')
          .selectAll()
          .select(
            sql<number>`MIN(priority) OVER (PARTITION BY entity_cui, year)`.as('min_priority')
          )
      );

    let finalQuery = baseCtes
      .selectFrom('with_priority')
      .selectAll()
      .select(sql<string>`COUNT(*) OVER()`.as('total_count'));

    finalQuery =
      reportTypeParam !== null
        ? finalQuery.where('report_type', '=', reportTypeParam)
        : finalQuery.whereRef('priority', '=', 'min_priority');

    const finalRows = await finalQuery
      .orderBy('plati_trezor', 'desc')
      .limit(limit)
      .offset(offset)
      .execute();

    interface SummaryFactMonthlyRow {
      total_count: string;
      year: number;
      month: number;
      entity_cui: string;
      entity_name: string;
      main_creditor_cui: string | null;
      report_type: string;
      population: number | null;
      credite_angajament: string;
      plati_trezor: string;
      plati_non_trezor: string;
      receptii_totale: string;
      receptii_neplatite_change: string;
    }

    interface SummaryFactQuarterlyRow {
      total_count: string;
      year: number;
      quarter: number;
      entity_cui: string;
      entity_name: string;
      main_creditor_cui: string | null;
      report_type: string;
      population: number | null;
      credite_angajament: string;
      limita_credit_angajament: string;
      credite_bugetare: string;
      credite_angajament_initiale: string;
      credite_bugetare_initiale: string;
      credite_angajament_definitive: string;
      credite_bugetare_definitive: string;
      credite_angajament_disponibile: string;
      credite_bugetare_disponibile: string;
      receptii_totale: string;
      plati_trezor: string;
      plati_non_trezor: string;
      receptii_neplatite: string;
    }

    type SummaryFactAnnualRow = Omit<SummaryFactQuarterlyRow, 'quarter'>;

    const firstRow = (finalRows as unknown as { total_count: string }[])[0];
    const totalCount = firstRow !== undefined ? Number.parseInt(firstRow.total_count, 10) : 0;

    let nodes: CommitmentsSummaryResult[] = [];

    if (frequency === Frequency.MONTH) {
      const rows = finalRows as unknown as SummaryFactMonthlyRow[];
      nodes = rows.map((r) => ({
        __typename: 'CommitmentsMonthlySummary',
        year: r.year,
        month: r.month,
        entity_cui: r.entity_cui,
        entity_name: r.entity_name,
        main_creditor_cui: r.main_creditor_cui,
        report_type: r.report_type as DbCommitmentsReportType,
        population: r.population,
        credite_angajament: new Decimal(r.credite_angajament),
        plati_trezor: new Decimal(r.plati_trezor),
        plati_non_trezor: new Decimal(r.plati_non_trezor),
        receptii_totale: new Decimal(r.receptii_totale),
        receptii_neplatite_change: new Decimal(r.receptii_neplatite_change),
        total_plati: new Decimal(r.plati_trezor).add(new Decimal(r.plati_non_trezor)),
      }));
    } else if (frequency === Frequency.QUARTER) {
      const rows = finalRows as unknown as SummaryFactQuarterlyRow[];
      nodes = rows.map((r) => {
        const platiTrezor = new Decimal(r.plati_trezor);
        const crediteBugetareDef = new Decimal(r.credite_bugetare_definitive);
        const crediteAngajamentDef = new Decimal(r.credite_angajament_definitive);

        return {
          __typename: 'CommitmentsQuarterlySummary',
          year: r.year,
          quarter: r.quarter,
          entity_cui: r.entity_cui,
          entity_name: r.entity_name,
          main_creditor_cui: r.main_creditor_cui,
          report_type: r.report_type as DbCommitmentsReportType,
          population: r.population,
          credite_angajament: new Decimal(r.credite_angajament),
          limita_credit_angajament: new Decimal(r.limita_credit_angajament),
          credite_bugetare: new Decimal(r.credite_bugetare),
          credite_angajament_initiale: new Decimal(r.credite_angajament_initiale),
          credite_bugetare_initiale: new Decimal(r.credite_bugetare_initiale),
          credite_angajament_definitive: crediteAngajamentDef,
          credite_bugetare_definitive: crediteBugetareDef,
          credite_angajament_disponibile: new Decimal(r.credite_angajament_disponibile),
          credite_bugetare_disponibile: new Decimal(r.credite_bugetare_disponibile),
          receptii_totale: new Decimal(r.receptii_totale),
          plati_trezor: platiTrezor,
          plati_non_trezor: new Decimal(r.plati_non_trezor),
          receptii_neplatite: new Decimal(r.receptii_neplatite),
          total_plati: platiTrezor.add(new Decimal(r.plati_non_trezor)),
          execution_rate: crediteBugetareDef.isZero()
            ? null
            : platiTrezor.div(crediteBugetareDef).mul(100),
          commitment_rate: crediteAngajamentDef.isZero()
            ? null
            : new Decimal(r.credite_angajament).div(crediteAngajamentDef).mul(100),
        };
      });
    } else {
      const rows = finalRows as unknown as SummaryFactAnnualRow[];
      nodes = rows.map((r) => {
        const platiTrezor = new Decimal(r.plati_trezor);
        const crediteBugetareDef = new Decimal(r.credite_bugetare_definitive);
        const crediteAngajamentDef = new Decimal(r.credite_angajament_definitive);

        return {
          __typename: 'CommitmentsAnnualSummary',
          year: r.year,
          entity_cui: r.entity_cui,
          entity_name: r.entity_name,
          main_creditor_cui: r.main_creditor_cui,
          report_type: r.report_type as DbCommitmentsReportType,
          population: r.population,
          credite_angajament: new Decimal(r.credite_angajament),
          limita_credit_angajament: new Decimal(r.limita_credit_angajament),
          credite_bugetare: new Decimal(r.credite_bugetare),
          credite_angajament_initiale: new Decimal(r.credite_angajament_initiale),
          credite_bugetare_initiale: new Decimal(r.credite_bugetare_initiale),
          credite_angajament_definitive: crediteAngajamentDef,
          credite_bugetare_definitive: crediteBugetareDef,
          credite_angajament_disponibile: new Decimal(r.credite_angajament_disponibile),
          credite_bugetare_disponibile: new Decimal(r.credite_bugetare_disponibile),
          receptii_totale: new Decimal(r.receptii_totale),
          plati_trezor: platiTrezor,
          plati_non_trezor: new Decimal(r.plati_non_trezor),
          receptii_neplatite: new Decimal(r.receptii_neplatite),
          total_plati: platiTrezor.add(new Decimal(r.plati_non_trezor)),
          execution_rate: crediteBugetareDef.isZero()
            ? null
            : platiTrezor.div(crediteBugetareDef).mul(100),
          commitment_rate: crediteAngajamentDef.isZero()
            ? null
            : new Decimal(r.credite_angajament).div(crediteAngajamentDef).mul(100),
        };
      });
    }

    return ok({
      nodes,
      pageInfo: {
        totalCount,
        hasNextPage: offset + limit < totalCount,
        hasPreviousPage: offset > 0,
      },
    });
  }

  // --------------------------------------------------------------------------
  // Line items
  // --------------------------------------------------------------------------

  async listLineItems(
    filter: CommitmentsFilter,
    limit: number,
    offset: number
  ): Promise<Result<CommitmentsLineItemConnection, CommitmentsError>> {
    const frequency = filter.report_period.type;

    if (filter.report_type === undefined) {
      return err(createDatabaseError("commitmentsLineItems requires 'report_type'", null));
    }

    try {
      await setStatementTimeout(this.db, QUERY_TIMEOUT_MS);

      let query = this.db
        .selectFrom('angajamentelineitems as eli')
        .innerJoin('entities as e', 'eli.entity_cui', 'e.cui')
        .leftJoin('uats as u', 'e.uat_id', 'u.id')
        .innerJoin('budgetsectors as bs', 'eli.budget_sector_id', 'bs.sector_id')
        .innerJoin('fundingsources as fs', 'eli.funding_source_id', 'fs.source_id')
        .innerJoin('functionalclassifications as fc', 'eli.functional_code', 'fc.functional_code')
        .leftJoin('economicclassifications as ec', 'eli.economic_code', 'ec.economic_code')
        .select([
          'eli.line_item_id',
          'eli.year',
          'eli.month',
          'eli.report_type',
          'eli.entity_cui',
          sql<string>`e.name`.as('entity_name'),
          'eli.main_creditor_cui',
          sql<number | null>`u.population`.as('population'),
          'eli.budget_sector_id',
          sql<string>`bs.sector_description`.as('budget_sector_name'),
          'eli.funding_source_id',
          sql<string>`fs.source_description`.as('funding_source_name'),
          'eli.functional_code',
          sql<string>`fc.functional_name`.as('functional_name'),
          'eli.economic_code',
          sql<string | null>`ec.economic_name`.as('economic_name'),

          'eli.credite_angajament',
          'eli.limita_credit_angajament',
          'eli.credite_bugetare',
          'eli.credite_angajament_initiale',
          'eli.credite_bugetare_initiale',
          'eli.credite_angajament_definitive',
          'eli.credite_bugetare_definitive',
          'eli.credite_angajament_disponibile',
          'eli.credite_bugetare_disponibile',
          'eli.receptii_totale',
          'eli.plati_trezor',
          'eli.plati_non_trezor',
          'eli.receptii_neplatite',

          'eli.monthly_plati_trezor',
          'eli.monthly_plati_non_trezor',
          'eli.monthly_receptii_totale',
          'eli.monthly_receptii_neplatite_change',
          'eli.monthly_credite_angajament',

          'eli.is_quarterly',
          'eli.quarter',
          'eli.is_yearly',

          'eli.anomaly',
          sql<string>`COUNT(*) OVER()`.as('total_count'),
        ]);

      // Period flags first (index usage)
      if (frequency === Frequency.YEAR) {
        query = query.where('eli.is_yearly', '=', true);
      } else if (frequency === Frequency.QUARTER) {
        query = query.where('eli.is_quarterly', '=', true);
      }

      // Period selection
      const selection = filter.report_period.selection;
      if (selection.interval !== undefined) {
        query = applyIntervalPeriodFilter(
          query,
          frequency,
          selection.interval,
          'eli',
          'year',
          'month',
          'quarter'
        );
      }
      if (selection.dates !== undefined && selection.dates.length > 0) {
        query = applyDatesPeriodFilter(
          query,
          frequency,
          selection.dates,
          'eli',
          'year',
          'month',
          'quarter'
        );
      }

      // Report type required
      query = query.where('eli.report_type', '=', filter.report_type);

      // Dimension filters
      if (filter.entity_cuis !== undefined && filter.entity_cuis.length > 0) {
        query = query.where('eli.entity_cui', 'in', filter.entity_cuis);
      }

      if (filter.main_creditor_cui !== undefined) {
        query = query.where('eli.main_creditor_cui', '=', filter.main_creditor_cui);
      }

      if (filter.funding_source_ids !== undefined && filter.funding_source_ids.length > 0) {
        const ids = toNumericIds(filter.funding_source_ids);
        if (ids.length > 0) {
          query = query.where('eli.funding_source_id', 'in', ids);
        }
      }

      if (filter.budget_sector_ids !== undefined && filter.budget_sector_ids.length > 0) {
        const ids = toNumericIds(filter.budget_sector_ids);
        if (ids.length > 0) {
          query = query.where('eli.budget_sector_id', 'in', ids);
        }
      }

      // Code filters
      if (filter.functional_codes !== undefined && filter.functional_codes.length > 0) {
        query = query.where('eli.functional_code', 'in', filter.functional_codes);
      }
      if (filter.functional_prefixes !== undefined && filter.functional_prefixes.length > 0) {
        const prefixes = filter.functional_prefixes;
        query = query.where((eb) =>
          eb.or(
            prefixes.map((p) => eb('eli.functional_code', 'like', escapeLikeWildcards(p) + '%'))
          )
        );
      }

      if (filter.economic_codes !== undefined && filter.economic_codes.length > 0) {
        query = query.where('eli.economic_code', 'in', filter.economic_codes);
      }
      if (filter.economic_prefixes !== undefined && filter.economic_prefixes.length > 0) {
        const prefixes = filter.economic_prefixes;
        query = query.where((eb) =>
          eb.or(prefixes.map((p) => eb('eli.economic_code', 'like', escapeLikeWildcards(p) + '%')))
        );
      }

      // Entity/geographic filters
      if (filter.entity_types !== undefined && filter.entity_types.length > 0) {
        query = query.where('e.entity_type', 'in', filter.entity_types);
      }
      if (filter.is_uat !== undefined) {
        query = query.where('e.is_uat', '=', filter.is_uat);
      }
      if (filter.uat_ids !== undefined && filter.uat_ids.length > 0) {
        const ids = toNumericIds(filter.uat_ids);
        if (ids.length > 0) query = query.where('e.uat_id', 'in', ids);
      }
      if (filter.search !== undefined && filter.search.trim() !== '') {
        const pattern = '%' + escapeLikeWildcards(filter.search.trim()) + '%';
        query = query.where('e.name', 'ilike', pattern);
      }
      if (filter.county_codes !== undefined && filter.county_codes.length > 0) {
        query = query.where('u.county_code', 'in', filter.county_codes);
      }
      if (filter.regions !== undefined && filter.regions.length > 0) {
        query = query.where('u.region', 'in', filter.regions);
      }
      if (filter.min_population !== undefined && filter.min_population !== null) {
        query = query.where('u.population', '>=', filter.min_population);
      }
      if (filter.max_population !== undefined && filter.max_population !== null) {
        query = query.where('u.population', '<=', filter.max_population);
      }

      // Transfers (NULL-safe)
      if (filter.exclude_transfers) {
        query = query.where((eb) =>
          eb.and([
            eb.or([
              eb('eli.economic_code', 'is', null),
              eb.and([
                eb('eli.economic_code', 'not like', '51.01%'),
                eb('eli.economic_code', 'not like', '51.02%'),
              ]),
            ]),
            eb.and([
              eb('eli.functional_code', 'not like', '36.02.05%'),
              eb('eli.functional_code', 'not like', '37.02.03%'),
              eb('eli.functional_code', 'not like', '37.02.04%'),
              eb('eli.functional_code', 'not like', '47.02.04%'),
            ]),
          ])
        );
      }

      // Exclusions
      const exclude = filter.exclude;

      if (exclude?.report_ids !== undefined && exclude.report_ids.length > 0) {
        query = query.where('eli.report_id', 'not in', exclude.report_ids);
      }
      if (exclude?.entity_cuis !== undefined && exclude.entity_cuis.length > 0) {
        query = query.where('eli.entity_cui', 'not in', exclude.entity_cuis);
      }
      if (exclude?.main_creditor_cui !== undefined) {
        // NOTE: Kysely's `sql` tag parameterizes interpolated values.
        query = query.where(
          sql<boolean>`eli.main_creditor_cui IS DISTINCT FROM ${exclude.main_creditor_cui}`
        );
      }
      if (exclude?.funding_source_ids !== undefined && exclude.funding_source_ids.length > 0) {
        const ids = toNumericIds(exclude.funding_source_ids);
        if (ids.length > 0) query = query.where('eli.funding_source_id', 'not in', ids);
      }
      if (exclude?.budget_sector_ids !== undefined && exclude.budget_sector_ids.length > 0) {
        const ids = toNumericIds(exclude.budget_sector_ids);
        if (ids.length > 0) query = query.where('eli.budget_sector_id', 'not in', ids);
      }
      if (exclude?.functional_codes !== undefined && exclude.functional_codes.length > 0) {
        query = query.where('eli.functional_code', 'not in', exclude.functional_codes);
      }
      if (exclude?.functional_prefixes !== undefined && exclude.functional_prefixes.length > 0) {
        const prefixes = exclude.functional_prefixes;
        query = query.where((eb) =>
          eb.and(
            prefixes.map((p) => eb('eli.functional_code', 'not like', escapeLikeWildcards(p) + '%'))
          )
        );
      }
      if (exclude?.economic_codes !== undefined && exclude.economic_codes.length > 0) {
        const codes = exclude.economic_codes;
        query = query.where((eb) =>
          eb.or([eb('eli.economic_code', 'is', null), eb('eli.economic_code', 'not in', codes)])
        );
      }
      if (exclude?.economic_prefixes !== undefined && exclude.economic_prefixes.length > 0) {
        const prefixes = exclude.economic_prefixes;
        query = query.where((eb) =>
          eb.or([
            eb('eli.economic_code', 'is', null),
            eb.and(
              prefixes.map((p) => eb('eli.economic_code', 'not like', escapeLikeWildcards(p) + '%'))
            ),
          ])
        );
      }
      if (exclude?.entity_types !== undefined && exclude.entity_types.length > 0) {
        const entityTypes = exclude.entity_types;
        query = query.where((eb) =>
          eb.or([eb('e.entity_type', 'is', null), eb('e.entity_type', 'not in', entityTypes)])
        );
      }
      if (exclude?.uat_ids !== undefined && exclude.uat_ids.length > 0) {
        const ids = toNumericIds(exclude.uat_ids);
        if (ids.length > 0) {
          query = query.where((eb) =>
            eb.or([eb('e.uat_id', 'is', null), eb('e.uat_id', 'not in', ids)])
          );
        }
      }
      if (exclude?.county_codes !== undefined && exclude.county_codes.length > 0) {
        const countyCodes = exclude.county_codes;
        query = query.where((eb) =>
          eb.or([eb('u.county_code', 'is', null), eb('u.county_code', 'not in', countyCodes)])
        );
      }
      if (exclude?.regions !== undefined && exclude.regions.length > 0) {
        const regions = exclude.regions;
        query = query.where((eb) =>
          eb.or([eb('u.region', 'is', null), eb('u.region', 'not in', regions)])
        );
      }

      // Per-row thresholds on period-appropriate plati_trezor (forces fact table by routing, but line items always fact)
      if (filter.item_min_amount !== undefined && filter.item_min_amount !== null) {
        const min = filter.item_min_amount;
        if (frequency === Frequency.MONTH)
          query = query.where('eli.monthly_plati_trezor', '>=', toNumericString(min));
        else if (frequency === Frequency.QUARTER)
          query = query.where(sql`COALESCE(eli.quarterly_plati_trezor, 0)`, '>=', min);
        else query = query.where('eli.plati_trezor', '>=', toNumericString(min));
      }
      if (filter.item_max_amount !== undefined && filter.item_max_amount !== null) {
        const max = filter.item_max_amount;
        if (frequency === Frequency.MONTH)
          query = query.where('eli.monthly_plati_trezor', '<=', toNumericString(max));
        else if (frequency === Frequency.QUARTER)
          query = query.where(sql`COALESCE(eli.quarterly_plati_trezor, 0)`, '<=', max);
        else query = query.where('eli.plati_trezor', '<=', toNumericString(max));
      }

      query = query
        .orderBy('eli.year', 'desc')
        .orderBy('eli.month', 'desc')
        .orderBy('eli.plati_trezor', 'desc')
        .orderBy('eli.line_item_id', 'desc')
        .limit(limit)
        .offset(offset);

      const rows = await query.execute();

      const totalCount =
        rows[0]?.total_count !== undefined ? Number.parseInt(rows[0].total_count, 10) : 0;

      const nodes: CommitmentsLineItem[] = rows.map((r) => ({
        line_item_id: r.line_item_id,
        year: r.year,
        month: r.month,
        report_type: r.report_type as DbCommitmentsReportType,
        entity_cui: r.entity_cui,
        entity_name: r.entity_name,
        main_creditor_cui: r.main_creditor_cui,
        population: r.population,
        budget_sector_id: r.budget_sector_id,
        budget_sector_name: r.budget_sector_name,
        funding_source_id: r.funding_source_id,
        funding_source_name: r.funding_source_name,
        functional_code: r.functional_code,
        functional_name: r.functional_name,
        economic_code: r.economic_code,
        economic_name: r.economic_name,
        credite_angajament: new Decimal(r.credite_angajament),
        limita_credit_angajament: new Decimal(r.limita_credit_angajament),
        credite_bugetare: new Decimal(r.credite_bugetare),
        credite_angajament_initiale: new Decimal(r.credite_angajament_initiale),
        credite_bugetare_initiale: new Decimal(r.credite_bugetare_initiale),
        credite_angajament_definitive: new Decimal(r.credite_angajament_definitive),
        credite_bugetare_definitive: new Decimal(r.credite_bugetare_definitive),
        credite_angajament_disponibile: new Decimal(r.credite_angajament_disponibile),
        credite_bugetare_disponibile: new Decimal(r.credite_bugetare_disponibile),
        receptii_totale: new Decimal(r.receptii_totale),
        plati_trezor: new Decimal(r.plati_trezor),
        plati_non_trezor: new Decimal(r.plati_non_trezor),
        receptii_neplatite: new Decimal(r.receptii_neplatite),
        monthly_plati_trezor: new Decimal(r.monthly_plati_trezor),
        monthly_plati_non_trezor: new Decimal(r.monthly_plati_non_trezor),
        monthly_receptii_totale: new Decimal(r.monthly_receptii_totale),
        monthly_receptii_neplatite_change: new Decimal(r.monthly_receptii_neplatite_change),
        monthly_credite_angajament: new Decimal(r.monthly_credite_angajament),
        is_quarterly: r.is_quarterly,
        quarter: r.quarter,
        is_yearly: r.is_yearly,
        anomaly: r.anomaly,
      }));

      return ok({
        nodes,
        pageInfo: {
          totalCount,
          hasNextPage: offset + limit < totalCount,
          hasPreviousPage: offset > 0,
        },
      });
    } catch (error) {
      if (isTimeoutError(error)) {
        return err(createTimeoutError('commitmentsLineItems query timed out', error));
      }
      return err(createDatabaseError('commitmentsLineItems query failed', error));
    }
  }

  // --------------------------------------------------------------------------
  // Analytics
  // --------------------------------------------------------------------------

  async getAnalyticsSeries(
    filter: CommitmentsFilter,
    metric: CommitmentsMetric
  ): Promise<Result<DataSeries, CommitmentsError>> {
    const frequency = filter.report_period.type;
    if (!isMetricAvailableForPeriod(metric, frequency)) {
      return err(createDatabaseError('Invalid metric for period type', { metric, frequency }));
    }

    const useMv = shouldUseMV(
      filter as unknown as import('@/common/types/commitments.js').CommitmentsFilter
    );

    try {
      await setStatementTimeout(this.db, QUERY_TIMEOUT_MS);

      const rows = useMv
        ? await this.getAnalyticsRowsFromMV(filter, metric, frequency)
        : await this.getAnalyticsRowsFromFact(filter, metric, frequency);

      const dataPoints: DataPoint[] = rows.map((r) => ({
        date: formatDateFromRow(r.year, r.period_value, frequency),
        value: new Decimal(r.amount),
      }));

      return ok({ frequency, data: dataPoints });
    } catch (error) {
      if (isTimeoutError(error)) {
        return err(createTimeoutError('commitmentsAnalytics query timed out', error));
      }
      return err(createDatabaseError('commitmentsAnalytics query failed', error));
    }
  }

  private async getAnalyticsRowsFromMV(
    filter: CommitmentsFilter,
    metric: CommitmentsMetric,
    frequency: Frequency
  ): Promise<{ year: number; period_value: number; amount: string }[]> {
    const reportTypeParam = filter.report_type ?? null;

    const metricCol = metricToBaseColumn(metric);

    const selection = filter.report_period.selection;
    const hasEntityJoin = needsEntityJoin(filter);

    const run = async <
      DB,
      TB extends keyof DB & string,
      O extends Record<string, unknown> & {
        min_priority: number;
        priority: number;
        report_type: string;
      },
    >(
      base: SelectQueryBuilder<DB, TB, O>
    ) => {
      let rowsQuery = this.db
        .with('base', () => base)
        .selectFrom('base')
        .select([
          'year',
          'period_value',
          sql<string>`COALESCE(SUM(metric_value::numeric), 0)::text`.as('amount'),
        ])
        .groupBy(['year', 'period_value'])
        .orderBy('year', 'asc')
        .orderBy('period_value', 'asc')
        .limit(MAX_DATA_POINTS);

      rowsQuery =
        reportTypeParam !== null
          ? rowsQuery.where(sql<boolean>`report_type = ${reportTypeParam}`)
          : rowsQuery.whereRef('priority', '=', 'min_priority');

      return rowsQuery.execute();
    };

    if (frequency === Frequency.MONTH) {
      let base = this.db
        .selectFrom('mv_angajamente_summary_monthly as eli')
        .select([
          sql<number>`eli.year`.as('year'),
          sql<number>`eli.month`.as('period_value'),
          sql<string>`COALESCE(${sql.ref(`eli.${metricCol}`)}, 0)::text`.as('metric_value'),
          sql<string>`eli.entity_cui`.as('entity_cui'),
          sql<string>`eli.report_type`.as('report_type'),
          reportTypePriorityExpr(sql.ref('eli.report_type')).as('priority'),
          sql<number>`MIN(${reportTypePriorityExpr(sql.ref('eli.report_type'))}) OVER (PARTITION BY eli.entity_cui, eli.year)`.as(
            'min_priority'
          ),
        ]);

      base = this.applySummaryPeriodFilters(
        base,
        selection,
        frequency,
        'eli',
        'year',
        'month',
        'quarter'
      );

      if (hasEntityJoin) {
        base = base
          .innerJoin('entities as e', 'eli.entity_cui', 'e.cui')
          .leftJoin('uats as u', 'e.uat_id', 'u.id');
        base = this.applySummaryCommonFilters(base, filter, 'eli');
      } else if (filter.entity_cuis !== undefined && filter.entity_cuis.length > 0) {
        base = base.where('eli.entity_cui', 'in', filter.entity_cuis);
      }

      return run(base);
    }

    if (frequency === Frequency.QUARTER) {
      let base = this.db
        .selectFrom('mv_angajamente_summary_quarterly as eli')
        .select([
          sql<number>`eli.year`.as('year'),
          sql<number>`eli.quarter`.as('period_value'),
          sql<string>`COALESCE(${sql.ref(`eli.${metricCol}`)}, 0)::text`.as('metric_value'),
          sql<string>`eli.entity_cui`.as('entity_cui'),
          sql<string>`eli.report_type`.as('report_type'),
          reportTypePriorityExpr(sql.ref('eli.report_type')).as('priority'),
          sql<number>`MIN(${reportTypePriorityExpr(sql.ref('eli.report_type'))}) OVER (PARTITION BY eli.entity_cui, eli.year)`.as(
            'min_priority'
          ),
        ]);

      base = this.applySummaryPeriodFilters(
        base,
        selection,
        frequency,
        'eli',
        'year',
        'month',
        'quarter'
      );

      if (hasEntityJoin) {
        base = base
          .innerJoin('entities as e', 'eli.entity_cui', 'e.cui')
          .leftJoin('uats as u', 'e.uat_id', 'u.id');
        base = this.applySummaryCommonFilters(base, filter, 'eli');
      } else if (filter.entity_cuis !== undefined && filter.entity_cuis.length > 0) {
        base = base.where('eli.entity_cui', 'in', filter.entity_cuis);
      }

      return run(base);
    }

    // YEAR
    let base = this.db
      .selectFrom('mv_angajamente_summary_annual as eli')
      .select([
        sql<number>`eli.year`.as('year'),
        sql<number>`eli.year`.as('period_value'),
        sql<string>`COALESCE(${sql.ref(`eli.${metricCol}`)}, 0)::text`.as('metric_value'),
        sql<string>`eli.entity_cui`.as('entity_cui'),
        sql<string>`eli.report_type`.as('report_type'),
        reportTypePriorityExpr(sql.ref('eli.report_type')).as('priority'),
        sql<number>`MIN(${reportTypePriorityExpr(sql.ref('eli.report_type'))}) OVER (PARTITION BY eli.entity_cui, eli.year)`.as(
          'min_priority'
        ),
      ]);

    base = this.applySummaryPeriodFilters(
      base,
      selection,
      frequency,
      'eli',
      'year',
      'month',
      'quarter'
    );

    if (hasEntityJoin) {
      base = base
        .innerJoin('entities as e', 'eli.entity_cui', 'e.cui')
        .leftJoin('uats as u', 'e.uat_id', 'u.id');
      base = this.applySummaryCommonFilters(base, filter, 'eli');
    } else if (filter.entity_cuis !== undefined && filter.entity_cuis.length > 0) {
      base = base.where('eli.entity_cui', 'in', filter.entity_cuis);
    }

    return run(base);
  }

  private async getAnalyticsRowsFromFact(
    filter: CommitmentsFilter,
    metric: CommitmentsMetric,
    frequency: Frequency
  ): Promise<{ year: number; period_value: number; amount: string }[]> {
    const reportTypeParam = filter.report_type ?? null;
    const selection = filter.report_period.selection;

    const metricCol = metricToFactColumn(metric, frequency);
    const metricRef = sql.ref(`eli.${metricCol}`);

    const periodValueExpr =
      frequency === Frequency.MONTH
        ? sql.ref('eli.month')
        : frequency === Frequency.QUARTER
          ? sql.ref('eli.quarter')
          : sql.ref('eli.year');

    let base = this.db
      .selectFrom('angajamentelineitems as eli')
      .select([
        sql<number>`eli.year`.as('year'),
        sql<number>`${periodValueExpr}`.as('period_value'),
        sql<string>`COALESCE(${metricRef}, 0)::text`.as('metric_value'),
        sql<string>`eli.entity_cui`.as('entity_cui'),
        sql<string>`eli.report_type`.as('report_type'),
        reportTypePriorityExpr(sql.ref('eli.report_type')).as('priority'),
        sql<number>`MIN(${reportTypePriorityExpr(sql.ref('eli.report_type'))}) OVER (PARTITION BY eli.entity_cui, eli.year)`.as(
          'min_priority'
        ),
      ]);

    // Period flags
    if (frequency === Frequency.QUARTER) {
      base = base.where('eli.is_quarterly', '=', true);
    } else if (frequency === Frequency.YEAR) {
      base = base.where('eli.is_yearly', '=', true);
    }

    // Period selection
    base = this.applySummaryPeriodFilters(
      base,
      selection,
      frequency,
      'eli',
      'year',
      'month',
      'quarter'
    );

    // Dimension filters
    if (filter.report_type !== undefined) {
      base = base.where('eli.report_type', '=', filter.report_type);
    }
    if (filter.entity_cuis !== undefined && filter.entity_cuis.length > 0) {
      base = base.where('eli.entity_cui', 'in', filter.entity_cuis);
    }
    if (filter.main_creditor_cui !== undefined) {
      base = base.where('eli.main_creditor_cui', '=', filter.main_creditor_cui);
    }
    if (filter.funding_source_ids !== undefined && filter.funding_source_ids.length > 0) {
      const ids = toNumericIds(filter.funding_source_ids);
      if (ids.length > 0) base = base.where('eli.funding_source_id', 'in', ids);
    }
    if (filter.budget_sector_ids !== undefined && filter.budget_sector_ids.length > 0) {
      const ids = toNumericIds(filter.budget_sector_ids);
      if (ids.length > 0) base = base.where('eli.budget_sector_id', 'in', ids);
    }

    // Code filters
    if (filter.functional_codes !== undefined && filter.functional_codes.length > 0) {
      base = base.where('eli.functional_code', 'in', filter.functional_codes);
    }
    if (filter.functional_prefixes !== undefined && filter.functional_prefixes.length > 0) {
      const prefixes = filter.functional_prefixes;
      base = base.where((eb) =>
        eb.or(prefixes.map((p) => eb('eli.functional_code', 'like', escapeLikeWildcards(p) + '%')))
      );
    }
    if (filter.economic_codes !== undefined && filter.economic_codes.length > 0) {
      base = base.where('eli.economic_code', 'in', filter.economic_codes);
    }
    if (filter.economic_prefixes !== undefined && filter.economic_prefixes.length > 0) {
      const prefixes = filter.economic_prefixes;
      base = base.where((eb) =>
        eb.or(prefixes.map((p) => eb('eli.economic_code', 'like', escapeLikeWildcards(p) + '%')))
      );
    }

    // Transfers
    if (filter.exclude_transfers) {
      base = base.where((eb) =>
        eb.and([
          eb.or([
            eb('eli.economic_code', 'is', null),
            eb.and([
              eb('eli.economic_code', 'not like', '51.01%'),
              eb('eli.economic_code', 'not like', '51.02%'),
            ]),
          ]),
          eb.and([
            eb('eli.functional_code', 'not like', '36.02.05%'),
            eb('eli.functional_code', 'not like', '37.02.03%'),
            eb('eli.functional_code', 'not like', '37.02.04%'),
            eb('eli.functional_code', 'not like', '47.02.04%'),
          ]),
        ])
      );
    }

    // Entity joins for geographic filters
    const hasEntityJoin = needsEntityJoin(filter);
    if (hasEntityJoin) {
      base = base
        .innerJoin('entities as e', 'eli.entity_cui', 'e.cui')
        .leftJoin('uats as u', 'e.uat_id', 'u.id');
      base = this.applySummaryCommonFilters(base, filter, 'eli');
    }

    let rowsQuery = this.db
      .with('base', () => base)
      .selectFrom('base')
      .select([
        'year',
        'period_value',
        sql<string>`COALESCE(SUM(metric_value::numeric), 0)::text`.as('amount'),
      ])
      .groupBy(['year', 'period_value'])
      .orderBy('year', 'asc')
      .orderBy('period_value', 'asc')
      .limit(MAX_DATA_POINTS);

    rowsQuery =
      reportTypeParam !== null
        ? rowsQuery.where('report_type', '=', reportTypeParam)
        : rowsQuery.whereRef('priority', '=', 'min_priority');

    return rowsQuery.execute();
  }

  // --------------------------------------------------------------------------
  // Aggregated
  // --------------------------------------------------------------------------

  async getAggregated(
    filter: CommitmentsFilter,
    metric: CommitmentsMetric,
    factorMap: PeriodFactorMap,
    pagination: PaginationParams,
    aggregateFilters?: AggregateFilters
  ): Promise<Result<CommitmentsAggregatedConnection, CommitmentsError>> {
    const frequency = filter.report_period.type;
    if (!isMetricAvailableForPeriod(metric, frequency)) {
      return err(createDatabaseError('Invalid metric for period type', { metric, frequency }));
    }

    try {
      await setStatementTimeout(this.db, QUERY_TIMEOUT_MS);

      if (factorMap.size === 0) {
        return ok({
          nodes: [],
          pageInfo: { totalCount: 0, hasNextPage: false, hasPreviousPage: false },
        });
      }

      const metricCol = metricToFactColumn(metric, frequency);
      const metricRef = sql.ref(`eli.${metricCol}`);
      const factorValues = emptyFactorsCteValues(factorMap);

      const normalizedSumExpr = sql`COALESCE(SUM(COALESCE(${metricRef}, 0) * f.multiplier), 0)`;

      // Build WHERE conditions for line items
      const conditions: ReturnType<typeof sql>[] = [];

      // Period flags
      if (frequency === Frequency.QUARTER) {
        conditions.push(sql`eli.is_quarterly = TRUE`);
      } else if (frequency === Frequency.YEAR) {
        conditions.push(sql`eli.is_yearly = TRUE`);
      }

      // Period selection
      const sel = filter.report_period.selection;
      if (sel.interval !== undefined) {
        const start = parsePeriodDate(sel.interval.start);
        const end = parsePeriodDate(sel.interval.end);

        if (
          frequency === Frequency.MONTH &&
          start?.month !== undefined &&
          end?.month !== undefined
        ) {
          conditions.push(sql`(eli.year, eli.month) >= (${start.year}, ${start.month})`);
          conditions.push(sql`(eli.year, eli.month) <= (${end.year}, ${end.month})`);
        } else if (
          frequency === Frequency.QUARTER &&
          start?.quarter !== undefined &&
          end?.quarter !== undefined
        ) {
          conditions.push(sql`(eli.year, eli.quarter) >= (${start.year}, ${start.quarter})`);
          conditions.push(sql`(eli.year, eli.quarter) <= (${end.year}, ${end.quarter})`);
        } else {
          const startYear = start?.year ?? extractYear(sel.interval.start);
          const endYear = end?.year ?? extractYear(sel.interval.end);
          if (startYear !== null) conditions.push(sql`eli.year >= ${startYear}`);
          if (endYear !== null) conditions.push(sql`eli.year <= ${endYear}`);
        }
      }

      if (sel.dates !== undefined && sel.dates.length > 0) {
        // Use a simple OR list (similar to execution analytics).
        const dates = sel.dates;
        if (frequency === Frequency.MONTH) {
          const periods = dates
            .map((d) => parsePeriodDate(d))
            .filter((p): p is { year: number; month: number } => p?.month !== undefined);
          if (periods.length > 0) {
            const tuples = periods.map(
              (p) => sql`(eli.year = ${p.year} AND eli.month = ${p.month})`
            );
            conditions.push(sql`(${sql.join(tuples, sql` OR `)})`);
          }
        } else if (frequency === Frequency.QUARTER) {
          const periods = dates
            .map((d) => parsePeriodDate(d))
            .filter((p): p is { year: number; quarter: number } => p?.quarter !== undefined);
          if (periods.length > 0) {
            const tuples = periods.map(
              (p) => sql`(eli.year = ${p.year} AND eli.quarter = ${p.quarter})`
            );
            conditions.push(sql`(${sql.join(tuples, sql` OR `)})`);
          }
        } else {
          const years = dates.map((d) => extractYear(d)).filter((y): y is number => y !== null);
          if (years.length > 0) {
            conditions.push(sql`eli.year IN (${sql.join(years)})`);
          }
        }
      }

      // Dimension filters
      if (filter.report_type !== undefined) {
        conditions.push(sql`eli.report_type = ${filter.report_type}`);
      }
      if (filter.entity_cuis !== undefined && filter.entity_cuis.length > 0) {
        conditions.push(sql`eli.entity_cui IN (${sql.join(filter.entity_cuis)})`);
      }
      if (filter.main_creditor_cui !== undefined) {
        conditions.push(sql`eli.main_creditor_cui = ${filter.main_creditor_cui}`);
      }
      if (filter.funding_source_ids !== undefined && filter.funding_source_ids.length > 0) {
        const ids = toNumericIds(filter.funding_source_ids);
        if (ids.length > 0) conditions.push(sql`eli.funding_source_id IN (${sql.join(ids)})`);
      }
      if (filter.budget_sector_ids !== undefined && filter.budget_sector_ids.length > 0) {
        const ids = toNumericIds(filter.budget_sector_ids);
        if (ids.length > 0) conditions.push(sql`eli.budget_sector_id IN (${sql.join(ids)})`);
      }

      // Code filters
      if (filter.functional_codes !== undefined && filter.functional_codes.length > 0) {
        conditions.push(sql`eli.functional_code IN (${sql.join(filter.functional_codes)})`);
      }
      if (filter.functional_prefixes !== undefined && filter.functional_prefixes.length > 0) {
        const ors = filter.functional_prefixes.map(
          (p) => sql`eli.functional_code LIKE ${escapeLikeWildcards(p) + '%'}`
        );
        conditions.push(sql`(${sql.join(ors, sql` OR `)})`);
      }
      if (filter.economic_codes !== undefined && filter.economic_codes.length > 0) {
        conditions.push(sql`eli.economic_code IN (${sql.join(filter.economic_codes)})`);
      }
      if (filter.economic_prefixes !== undefined && filter.economic_prefixes.length > 0) {
        const ors = filter.economic_prefixes.map(
          (p) => sql`eli.economic_code LIKE ${escapeLikeWildcards(p) + '%'}`
        );
        conditions.push(sql`(${sql.join(ors, sql` OR `)})`);
      }

      // Exclusions (line item grain)
      if (filter.exclude?.report_ids !== undefined && filter.exclude.report_ids.length > 0) {
        conditions.push(sql`eli.report_id NOT IN (${sql.join(filter.exclude.report_ids)})`);
      }
      if (filter.exclude?.entity_cuis !== undefined && filter.exclude.entity_cuis.length > 0) {
        conditions.push(sql`eli.entity_cui NOT IN (${sql.join(filter.exclude.entity_cuis)})`);
      }
      if (
        filter.exclude?.functional_codes !== undefined &&
        filter.exclude.functional_codes.length > 0
      ) {
        conditions.push(
          sql`eli.functional_code NOT IN (${sql.join(filter.exclude.functional_codes)})`
        );
      }
      if (
        filter.exclude?.functional_prefixes !== undefined &&
        filter.exclude.functional_prefixes.length > 0
      ) {
        const ands = filter.exclude.functional_prefixes.map(
          (p) => sql`eli.functional_code NOT LIKE ${escapeLikeWildcards(p) + '%'}`
        );
        conditions.push(sql`(${sql.join(ands, sql` AND `)})`);
      }
      if (
        filter.exclude?.economic_codes !== undefined &&
        filter.exclude.economic_codes.length > 0
      ) {
        conditions.push(
          sql`(eli.economic_code IS NULL OR eli.economic_code NOT IN (${sql.join(filter.exclude.economic_codes)}))`
        );
      }
      if (
        filter.exclude?.economic_prefixes !== undefined &&
        filter.exclude.economic_prefixes.length > 0
      ) {
        const ands = filter.exclude.economic_prefixes.map(
          (p) => sql`eli.economic_code NOT LIKE ${escapeLikeWildcards(p) + '%'}`
        );
        conditions.push(sql`(eli.economic_code IS NULL OR (${sql.join(ands, sql` AND `)}))`);
      }

      // Transfers
      if (filter.exclude_transfers) {
        conditions.push(
          sql`NOT (eli.economic_code IS NOT NULL AND (eli.economic_code LIKE '51.01%' OR eli.economic_code LIKE '51.02%'))`
        );
        conditions.push(
          sql`NOT (eli.functional_code LIKE '36.02.05%' OR eli.functional_code LIKE '37.02.03%' OR eli.functional_code LIKE '37.02.04%' OR eli.functional_code LIKE '47.02.04%')`
        );
      }

      // Per-row thresholds apply to the selected metric for aggregated queries.
      if (filter.item_min_amount !== undefined && filter.item_min_amount !== null) {
        conditions.push(sql`COALESCE(${metricRef}, 0) >= ${filter.item_min_amount}`);
      }
      if (filter.item_max_amount !== undefined && filter.item_max_amount !== null) {
        conditions.push(sql`COALESCE(${metricRef}, 0) <= ${filter.item_max_amount}`);
      }

      // Join entities/uats only when needed for geographic filters.
      const hasEntity = needsEntityJoin(filter);
      const hasUat = needsUatJoin(filter);
      const entityJoin = hasEntity ? sql`INNER JOIN entities e ON eli.entity_cui = e.cui` : sql``;
      const uatJoin = hasUat ? sql`LEFT JOIN uats u ON e.uat_id = u.id` : sql``;

      if (hasEntity) {
        if (filter.entity_types !== undefined && filter.entity_types.length > 0) {
          conditions.push(sql`e.entity_type IN (${sql.join(filter.entity_types)})`);
        }
        if (filter.is_uat !== undefined) {
          conditions.push(sql`e.is_uat = ${filter.is_uat ? sql`TRUE` : sql`FALSE`}`);
        }
        if (filter.uat_ids !== undefined && filter.uat_ids.length > 0) {
          const ids = toNumericIds(filter.uat_ids);
          if (ids.length > 0) conditions.push(sql`e.uat_id IN (${sql.join(ids)})`);
        }
        if (filter.search !== undefined && filter.search.trim() !== '') {
          const pattern = '%' + escapeLikeWildcards(filter.search.trim()) + '%';
          conditions.push(sql`e.name ILIKE ${pattern}`);
        }
      }

      if (hasUat) {
        if (filter.county_codes !== undefined && filter.county_codes.length > 0) {
          conditions.push(sql`u.county_code IN (${sql.join(filter.county_codes)})`);
        }
        if (filter.regions !== undefined && filter.regions.length > 0) {
          conditions.push(sql`u.region IN (${sql.join(filter.regions)})`);
        }
        if (filter.min_population !== undefined && filter.min_population !== null) {
          conditions.push(sql`u.population >= ${filter.min_population}`);
        }
        if (filter.max_population !== undefined && filter.max_population !== null) {
          conditions.push(sql`u.population <= ${filter.max_population}`);
        }
      }

      const where = conditions.length > 0 ? sql`WHERE ${sql.join(conditions, sql` AND `)}` : sql``;

      const havingConditions: ReturnType<typeof sql>[] = [];
      if (aggregateFilters?.minAmount !== undefined) {
        havingConditions.push(
          sql`${normalizedSumExpr} >= ${aggregateFilters.minAmount.toString()}::numeric`
        );
      }
      if (aggregateFilters?.maxAmount !== undefined) {
        havingConditions.push(
          sql`${normalizedSumExpr} <= ${aggregateFilters.maxAmount.toString()}::numeric`
        );
      }
      const having =
        havingConditions.length > 0 ? sql`HAVING ${sql.join(havingConditions, sql` AND `)}` : sql``;

      // Frequency-aware join between factors(period_key, multiplier) and the line items.
      const factorJoin =
        frequency === Frequency.MONTH
          ? sql`INNER JOIN factors f ON (eli.year::text || '-' || LPAD(eli.month::text, 2, '0')) = f.period_key`
          : frequency === Frequency.QUARTER
            ? sql`INNER JOIN factors f ON (eli.year::text || '-Q' || eli.quarter::text) = f.period_key`
            : sql`INNER JOIN factors f ON eli.year::text = f.period_key`;

      const queryText = sql`
        WITH factors(period_key, multiplier) AS (
          VALUES ${factorValues}
        )
        SELECT
          fc.functional_code,
          fc.functional_name,
          eli.economic_code,
          ec.economic_name,
          ${normalizedSumExpr} AS normalized_amount,
          COUNT(*) AS count,
          COUNT(*) OVER() AS total_count
        FROM angajamentelineitems eli
        INNER JOIN functionalclassifications fc ON eli.functional_code = fc.functional_code
        LEFT JOIN economicclassifications ec ON eli.economic_code = ec.economic_code
        ${factorJoin}
        ${entityJoin}
        ${uatJoin}
        ${where}
        GROUP BY
          fc.functional_code,
          fc.functional_name,
          eli.economic_code,
          ec.economic_name
        ${having}
        ORDER BY normalized_amount DESC
        LIMIT ${pagination.limit} OFFSET ${pagination.offset}
      `;

      const result = await queryText.execute(this.db);
      const rows = result.rows as {
        functional_code: string;
        functional_name: string;
        economic_code: string | null;
        economic_name: string | null;
        normalized_amount: string;
        count: string;
        total_count: string;
      }[];

      const totalCount =
        rows[0]?.total_count !== undefined ? Number.parseInt(rows[0].total_count, 10) : 0;

      return ok({
        nodes: rows.map((r) => ({
          functional_code: r.functional_code,
          functional_name: r.functional_name,
          economic_code: r.economic_code,
          economic_name: r.economic_name,
          amount: new Decimal(r.normalized_amount),
          count: Number.parseInt(r.count, 10),
        })),
        pageInfo: {
          totalCount,
          hasNextPage: pagination.offset + pagination.limit < totalCount,
          hasPreviousPage: pagination.offset > 0,
        },
      });
    } catch (error) {
      if (isTimeoutError(error)) {
        return err(createTimeoutError('commitmentsAggregated query timed out', error));
      }
      return err(createDatabaseError('commitmentsAggregated query failed', error));
    }
  }

  // --------------------------------------------------------------------------
  // commitmentVsExecution
  // --------------------------------------------------------------------------

  async getCommitmentVsExecutionMonthData(
    filter: CommitmentsFilter,
    metric: CommitmentsMetric
  ): Promise<Result<CommitmentExecutionMonthData, CommitmentsError>> {
    const frequency = filter.report_period.type;

    if (filter.report_type === undefined) {
      return err(createDatabaseError("commitmentVsExecution requires 'report_type'", null));
    }

    if (!isMetricAvailableForPeriod(metric, frequency)) {
      return err(createDatabaseError('Invalid metric for period type', { metric, frequency }));
    }

    const angMetricCol = metricToFactColumn(metric, frequency);
    const angMetricRef = sql.ref(`ali.${angMetricCol}`);

    const execAmountCol =
      frequency === Frequency.MONTH
        ? 'monthly_amount'
        : frequency === Frequency.QUARTER
          ? 'quarterly_amount'
          : 'ytd_amount';
    const execAmountRef = sql.ref(`eli.${execAmountCol}`);

    const execReportType = EXECUTION_REPORT_TYPE_BY_COMMITMENTS[filter.report_type];

    // Shared selection logic
    const sel = filter.report_period.selection;

    // Build WHERE conditions (parameterized) for both sides.
    const angConditions: ReturnType<typeof sql>[] = [];
    const exeConditions: ReturnType<typeof sql>[] = [];

    // Frequency flags
    if (frequency === Frequency.QUARTER) {
      angConditions.push(sql`ali.is_quarterly = TRUE`);
      exeConditions.push(sql`eli.is_quarterly = TRUE`);
    } else if (frequency === Frequency.YEAR) {
      angConditions.push(sql`ali.is_yearly = TRUE`);
      exeConditions.push(sql`eli.is_yearly = TRUE`);
    }

    // Period selection
    if (sel.interval !== undefined) {
      const start = parsePeriodDate(sel.interval.start);
      const end = parsePeriodDate(sel.interval.end);

      if (frequency === Frequency.MONTH && start?.month !== undefined && end?.month !== undefined) {
        angConditions.push(sql`(ali.year, ali.month) >= (${start.year}, ${start.month})`);
        angConditions.push(sql`(ali.year, ali.month) <= (${end.year}, ${end.month})`);
        exeConditions.push(sql`(eli.year, eli.month) >= (${start.year}, ${start.month})`);
        exeConditions.push(sql`(eli.year, eli.month) <= (${end.year}, ${end.month})`);
      } else if (
        frequency === Frequency.QUARTER &&
        start?.quarter !== undefined &&
        end?.quarter !== undefined
      ) {
        // Quarter selection uses (year, quarter) but we still join at month.
        angConditions.push(sql`(ali.year, ali.quarter) >= (${start.year}, ${start.quarter})`);
        angConditions.push(sql`(ali.year, ali.quarter) <= (${end.year}, ${end.quarter})`);
        exeConditions.push(sql`(eli.year, eli.quarter) >= (${start.year}, ${start.quarter})`);
        exeConditions.push(sql`(eli.year, eli.quarter) <= (${end.year}, ${end.quarter})`);
      } else {
        const startYear = start?.year ?? extractYear(sel.interval.start);
        const endYear = end?.year ?? extractYear(sel.interval.end);
        if (startYear !== null) {
          angConditions.push(sql`ali.year >= ${startYear}`);
          exeConditions.push(sql`eli.year >= ${startYear}`);
        }
        if (endYear !== null) {
          angConditions.push(sql`ali.year <= ${endYear}`);
          exeConditions.push(sql`eli.year <= ${endYear}`);
        }
      }
    }

    if (sel.dates !== undefined && sel.dates.length > 0) {
      const dates = sel.dates;
      if (frequency === Frequency.MONTH) {
        const periods = dates
          .map((d) => parsePeriodDate(d))
          .filter((p): p is { year: number; month: number } => p?.month !== undefined);
        if (periods.length > 0) {
          const tuplesAng = periods.map(
            (p) => sql`(ali.year = ${p.year} AND ali.month = ${p.month})`
          );
          const tuplesExe = periods.map(
            (p) => sql`(eli.year = ${p.year} AND eli.month = ${p.month})`
          );
          angConditions.push(sql`(${sql.join(tuplesAng, sql` OR `)})`);
          exeConditions.push(sql`(${sql.join(tuplesExe, sql` OR `)})`);
        }
      } else if (frequency === Frequency.QUARTER) {
        const periods = dates
          .map((d) => parsePeriodDate(d))
          .filter((p): p is { year: number; quarter: number } => p?.quarter !== undefined);
        if (periods.length > 0) {
          const tuplesAng = periods.map(
            (p) => sql`(ali.year = ${p.year} AND ali.quarter = ${p.quarter})`
          );
          const tuplesExe = periods.map(
            (p) => sql`(eli.year = ${p.year} AND eli.quarter = ${p.quarter})`
          );
          angConditions.push(sql`(${sql.join(tuplesAng, sql` OR `)})`);
          exeConditions.push(sql`(${sql.join(tuplesExe, sql` OR `)})`);
        }
      } else {
        const years = dates.map((d) => extractYear(d)).filter((y): y is number => y !== null);
        if (years.length > 0) {
          angConditions.push(sql`ali.year IN (${sql.join(years)})`);
          exeConditions.push(sql`eli.year IN (${sql.join(years)})`);
        }
      }
    }

    // Report type required (deterministic comparison)
    angConditions.push(sql`ali.report_type = ${filter.report_type}`);
    exeConditions.push(sql`eli.report_type = ${execReportType}`);

    // Execution side is expenses only
    exeConditions.push(sql`eli.account_category = 'ch'`);

    // Shared dimension filters
    if (filter.entity_cuis !== undefined && filter.entity_cuis.length > 0) {
      angConditions.push(sql`ali.entity_cui IN (${sql.join(filter.entity_cuis)})`);
      exeConditions.push(sql`eli.entity_cui IN (${sql.join(filter.entity_cuis)})`);
    }

    if (filter.main_creditor_cui !== undefined) {
      angConditions.push(sql`ali.main_creditor_cui = ${filter.main_creditor_cui}`);
      exeConditions.push(sql`eli.main_creditor_cui = ${filter.main_creditor_cui}`);
    }

    if (filter.funding_source_ids !== undefined && filter.funding_source_ids.length > 0) {
      const ids = toNumericIds(filter.funding_source_ids);
      if (ids.length > 0) {
        angConditions.push(sql`ali.funding_source_id IN (${sql.join(ids)})`);
        exeConditions.push(sql`eli.funding_source_id IN (${sql.join(ids)})`);
      }
    }

    if (filter.budget_sector_ids !== undefined && filter.budget_sector_ids.length > 0) {
      const ids = toNumericIds(filter.budget_sector_ids);
      if (ids.length > 0) {
        angConditions.push(sql`ali.budget_sector_id IN (${sql.join(ids)})`);
        exeConditions.push(sql`eli.budget_sector_id IN (${sql.join(ids)})`);
      }
    }

    // Code filters
    if (filter.functional_codes !== undefined && filter.functional_codes.length > 0) {
      angConditions.push(sql`ali.functional_code IN (${sql.join(filter.functional_codes)})`);
      exeConditions.push(sql`eli.functional_code IN (${sql.join(filter.functional_codes)})`);
    }
    if (filter.functional_prefixes !== undefined && filter.functional_prefixes.length > 0) {
      const orsAng = filter.functional_prefixes.map(
        (p) => sql`ali.functional_code LIKE ${escapeLikeWildcards(p) + '%'}`
      );
      const orsExe = filter.functional_prefixes.map(
        (p) => sql`eli.functional_code LIKE ${escapeLikeWildcards(p) + '%'}`
      );
      angConditions.push(sql`(${sql.join(orsAng, sql` OR `)})`);
      exeConditions.push(sql`(${sql.join(orsExe, sql` OR `)})`);
    }

    if (filter.economic_codes !== undefined && filter.economic_codes.length > 0) {
      angConditions.push(sql`ali.economic_code IN (${sql.join(filter.economic_codes)})`);
      exeConditions.push(sql`eli.economic_code IN (${sql.join(filter.economic_codes)})`);
    }
    if (filter.economic_prefixes !== undefined && filter.economic_prefixes.length > 0) {
      const orsAng = filter.economic_prefixes.map(
        (p) => sql`ali.economic_code LIKE ${escapeLikeWildcards(p) + '%'}`
      );
      const orsExe = filter.economic_prefixes.map(
        (p) => sql`eli.economic_code LIKE ${escapeLikeWildcards(p) + '%'}`
      );
      angConditions.push(sql`(${sql.join(orsAng, sql` OR `)})`);
      exeConditions.push(sql`(${sql.join(orsExe, sql` OR `)})`);
    }

    // Exclusions (apply to both sides)
    if (filter.exclude?.report_ids !== undefined && filter.exclude.report_ids.length > 0) {
      angConditions.push(sql`ali.report_id NOT IN (${sql.join(filter.exclude.report_ids)})`);
      exeConditions.push(sql`eli.report_id NOT IN (${sql.join(filter.exclude.report_ids)})`);
    }
    if (filter.exclude?.entity_cuis !== undefined && filter.exclude.entity_cuis.length > 0) {
      angConditions.push(sql`ali.entity_cui NOT IN (${sql.join(filter.exclude.entity_cuis)})`);
      exeConditions.push(sql`eli.entity_cui NOT IN (${sql.join(filter.exclude.entity_cuis)})`);
    }
    if (filter.exclude?.main_creditor_cui !== undefined) {
      angConditions.push(
        sql`ali.main_creditor_cui IS DISTINCT FROM ${filter.exclude.main_creditor_cui}`
      );
      exeConditions.push(
        sql`eli.main_creditor_cui IS DISTINCT FROM ${filter.exclude.main_creditor_cui}`
      );
    }
    if (
      filter.exclude?.funding_source_ids !== undefined &&
      filter.exclude.funding_source_ids.length > 0
    ) {
      const ids = toNumericIds(filter.exclude.funding_source_ids);
      if (ids.length > 0) {
        angConditions.push(sql`ali.funding_source_id NOT IN (${sql.join(ids)})`);
        exeConditions.push(sql`eli.funding_source_id NOT IN (${sql.join(ids)})`);
      }
    }
    if (
      filter.exclude?.budget_sector_ids !== undefined &&
      filter.exclude.budget_sector_ids.length > 0
    ) {
      const ids = toNumericIds(filter.exclude.budget_sector_ids);
      if (ids.length > 0) {
        angConditions.push(sql`ali.budget_sector_id NOT IN (${sql.join(ids)})`);
        exeConditions.push(sql`eli.budget_sector_id NOT IN (${sql.join(ids)})`);
      }
    }
    if (
      filter.exclude?.functional_codes !== undefined &&
      filter.exclude.functional_codes.length > 0
    ) {
      angConditions.push(
        sql`ali.functional_code NOT IN (${sql.join(filter.exclude.functional_codes)})`
      );
      exeConditions.push(
        sql`eli.functional_code NOT IN (${sql.join(filter.exclude.functional_codes)})`
      );
    }
    if (
      filter.exclude?.functional_prefixes !== undefined &&
      filter.exclude.functional_prefixes.length > 0
    ) {
      const andsAng = filter.exclude.functional_prefixes.map(
        (p) => sql`ali.functional_code NOT LIKE ${escapeLikeWildcards(p) + '%'}`
      );
      const andsExe = filter.exclude.functional_prefixes.map(
        (p) => sql`eli.functional_code NOT LIKE ${escapeLikeWildcards(p) + '%'}`
      );
      angConditions.push(sql`(${sql.join(andsAng, sql` AND `)})`);
      exeConditions.push(sql`(${sql.join(andsExe, sql` AND `)})`);
    }
    if (filter.exclude?.economic_codes !== undefined && filter.exclude.economic_codes.length > 0) {
      angConditions.push(
        sql`(ali.economic_code IS NULL OR ali.economic_code NOT IN (${sql.join(filter.exclude.economic_codes)}))`
      );
      exeConditions.push(
        sql`(eli.economic_code IS NULL OR eli.economic_code NOT IN (${sql.join(filter.exclude.economic_codes)}))`
      );
    }
    if (
      filter.exclude?.economic_prefixes !== undefined &&
      filter.exclude.economic_prefixes.length > 0
    ) {
      const andsAng = filter.exclude.economic_prefixes.map(
        (p) => sql`ali.economic_code NOT LIKE ${escapeLikeWildcards(p) + '%'}`
      );
      const andsExe = filter.exclude.economic_prefixes.map(
        (p) => sql`eli.economic_code NOT LIKE ${escapeLikeWildcards(p) + '%'}`
      );
      angConditions.push(sql`(ali.economic_code IS NULL OR (${sql.join(andsAng, sql` AND `)}))`);
      exeConditions.push(sql`(eli.economic_code IS NULL OR (${sql.join(andsExe, sql` AND `)}))`);
    }

    // Transfers (apply to both sides)
    if (filter.exclude_transfers) {
      angConditions.push(
        sql`NOT (ali.economic_code IS NOT NULL AND (ali.economic_code LIKE '51.01%' OR ali.economic_code LIKE '51.02%'))`
      );
      exeConditions.push(
        sql`NOT (eli.economic_code IS NOT NULL AND (eli.economic_code LIKE '51.01%' OR eli.economic_code LIKE '51.02%'))`
      );

      angConditions.push(
        sql`NOT (ali.functional_code LIKE '36.02.05%' OR ali.functional_code LIKE '37.02.03%' OR ali.functional_code LIKE '37.02.04%' OR ali.functional_code LIKE '47.02.04%')`
      );
      exeConditions.push(
        sql`NOT (eli.functional_code LIKE '36.02.05%' OR eli.functional_code LIKE '37.02.03%' OR eli.functional_code LIKE '37.02.04%' OR eli.functional_code LIKE '47.02.04%')`
      );
    }

    // Entity / geographic filters (apply to both)
    const hasEntity = needsEntityJoin(filter);
    const hasUat = needsUatJoin(filter);
    const angEntityJoin = hasEntity
      ? sql`INNER JOIN entities ae ON ali.entity_cui = ae.cui`
      : sql``;
    const exeEntityJoin = hasEntity
      ? sql`INNER JOIN entities ee ON eli.entity_cui = ee.cui`
      : sql``;
    const angUatJoin = hasUat ? sql`LEFT JOIN uats au ON ae.uat_id = au.id` : sql``;
    const exeUatJoin = hasUat ? sql`LEFT JOIN uats eu ON ee.uat_id = eu.id` : sql``;

    if (hasEntity) {
      if (filter.entity_types !== undefined && filter.entity_types.length > 0) {
        angConditions.push(sql`ae.entity_type IN (${sql.join(filter.entity_types)})`);
        exeConditions.push(sql`ee.entity_type IN (${sql.join(filter.entity_types)})`);
      }
      if (filter.is_uat !== undefined) {
        angConditions.push(sql`ae.is_uat = ${filter.is_uat ? sql`TRUE` : sql`FALSE`}`);
        exeConditions.push(sql`ee.is_uat = ${filter.is_uat ? sql`TRUE` : sql`FALSE`}`);
      }
      if (filter.uat_ids !== undefined && filter.uat_ids.length > 0) {
        const ids = toNumericIds(filter.uat_ids);
        if (ids.length > 0) {
          angConditions.push(sql`ae.uat_id IN (${sql.join(ids)})`);
          exeConditions.push(sql`ee.uat_id IN (${sql.join(ids)})`);
        }
      }
      if (filter.search !== undefined && filter.search.trim() !== '') {
        const pattern = '%' + escapeLikeWildcards(filter.search.trim()) + '%';
        angConditions.push(sql`ae.name ILIKE ${pattern}`);
        exeConditions.push(sql`ee.name ILIKE ${pattern}`);
      }
    }

    if (hasUat) {
      if (filter.county_codes !== undefined && filter.county_codes.length > 0) {
        angConditions.push(sql`au.county_code IN (${sql.join(filter.county_codes)})`);
        exeConditions.push(sql`eu.county_code IN (${sql.join(filter.county_codes)})`);
      }
      if (filter.regions !== undefined && filter.regions.length > 0) {
        angConditions.push(sql`au.region IN (${sql.join(filter.regions)})`);
        exeConditions.push(sql`eu.region IN (${sql.join(filter.regions)})`);
      }
      if (filter.min_population !== undefined && filter.min_population !== null) {
        angConditions.push(sql`au.population >= ${filter.min_population}`);
        exeConditions.push(sql`eu.population >= ${filter.min_population}`);
      }
      if (filter.max_population !== undefined && filter.max_population !== null) {
        angConditions.push(sql`au.population <= ${filter.max_population}`);
        exeConditions.push(sql`eu.population <= ${filter.max_population}`);
      }
    }

    // Per-row thresholds apply to period-appropriate plati_trezor.
    // NOTE: still apply (even though report_type is required) for deterministic behavior.
    if (filter.item_min_amount !== undefined && filter.item_min_amount !== null) {
      const min = filter.item_min_amount;
      if (frequency === Frequency.MONTH) {
        angConditions.push(sql`ali.monthly_plati_trezor >= ${min}`);
      } else if (frequency === Frequency.QUARTER) {
        angConditions.push(sql`COALESCE(ali.quarterly_plati_trezor, 0) >= ${min}`);
      } else {
        angConditions.push(sql`ali.plati_trezor >= ${min}`);
      }
    }
    if (filter.item_max_amount !== undefined && filter.item_max_amount !== null) {
      const max = filter.item_max_amount;
      if (frequency === Frequency.MONTH) {
        angConditions.push(sql`ali.monthly_plati_trezor <= ${max}`);
      } else if (frequency === Frequency.QUARTER) {
        angConditions.push(sql`COALESCE(ali.quarterly_plati_trezor, 0) <= ${max}`);
      } else {
        angConditions.push(sql`ali.plati_trezor <= ${max}`);
      }
    }

    const angWhere =
      angConditions.length > 0 ? sql`WHERE ${sql.join(angConditions, sql` AND `)}` : sql``;
    const exeWhere =
      exeConditions.length > 0 ? sql`WHERE ${sql.join(exeConditions, sql` AND `)}` : sql``;

    try {
      await setStatementTimeout(this.db, QUERY_TIMEOUT_MS);

      // 1) Month totals
      const monthTotalsQuery = sql`
        WITH
          ang AS (
            SELECT
              ali.year,
              ali.month,
              ali.entity_cui,
              ali.main_creditor_cui,
              ali.budget_sector_id,
              ali.funding_source_id,
              ali.functional_code,
              ali.economic_code,
              COALESCE(SUM(COALESCE(${angMetricRef}, 0)), 0) AS commitment_value
            FROM angajamentelineitems ali
            ${angEntityJoin}
            ${angUatJoin}
            ${angWhere}
            GROUP BY
              ali.year,
              ali.month,
              ali.entity_cui,
              ali.main_creditor_cui,
              ali.budget_sector_id,
              ali.funding_source_id,
              ali.functional_code,
              ali.economic_code
          ),
          exe AS (
            SELECT
              eli.year,
              eli.month,
              eli.entity_cui,
              eli.main_creditor_cui,
              eli.budget_sector_id,
              eli.funding_source_id,
              eli.functional_code,
              eli.economic_code,
              COALESCE(SUM(COALESCE(${execAmountRef}, 0)), 0) AS execution_value
            FROM executionlineitems eli
            ${exeEntityJoin}
            ${exeUatJoin}
            ${exeWhere}
            GROUP BY
              eli.year,
              eli.month,
              eli.entity_cui,
              eli.main_creditor_cui,
              eli.budget_sector_id,
              eli.funding_source_id,
              eli.functional_code,
              eli.economic_code
          ),
          joined AS (
            SELECT
              COALESCE(ang.year, exe.year) AS year,
              COALESCE(ang.month, exe.month) AS month,
              ang.commitment_value,
              exe.execution_value,
              ang.entity_cui AS ang_entity_cui,
              exe.entity_cui AS exe_entity_cui
            FROM ang
            FULL OUTER JOIN exe
              ON ang.year = exe.year
              AND ang.month = exe.month
              AND ang.entity_cui = exe.entity_cui
              AND ang.budget_sector_id = exe.budget_sector_id
              AND ang.funding_source_id = exe.funding_source_id
              AND ang.functional_code = exe.functional_code
              AND ang.main_creditor_cui IS NOT DISTINCT FROM exe.main_creditor_cui
              AND ang.economic_code IS NOT DISTINCT FROM exe.economic_code
          )
        SELECT
          year,
          month,
          COALESCE(SUM(COALESCE(commitment_value, 0)), 0)::text AS commitment_value,
          COALESCE(SUM(COALESCE(execution_value, 0)), 0)::text AS execution_value
        FROM joined
        GROUP BY year, month
        ORDER BY year ASC, month ASC
      `;

      const monthTotalsResult = await monthTotalsQuery.execute(this.db);
      const monthRows = monthTotalsResult.rows as {
        year: number;
        month: number;
        commitment_value: string;
        execution_value: string;
      }[];

      // 2) Match counts (at join-key granularity)
      const countsQuery = sql`
        WITH
          ang AS (
            SELECT
              ali.year,
              ali.month,
              ali.entity_cui,
              ali.main_creditor_cui,
              ali.budget_sector_id,
              ali.funding_source_id,
              ali.functional_code,
              ali.economic_code,
              COALESCE(SUM(COALESCE(${angMetricRef}, 0)), 0) AS commitment_value
            FROM angajamentelineitems ali
            ${angEntityJoin}
            ${angUatJoin}
            ${angWhere}
            GROUP BY
              ali.year,
              ali.month,
              ali.entity_cui,
              ali.main_creditor_cui,
              ali.budget_sector_id,
              ali.funding_source_id,
              ali.functional_code,
              ali.economic_code
          ),
          exe AS (
            SELECT
              eli.year,
              eli.month,
              eli.entity_cui,
              eli.main_creditor_cui,
              eli.budget_sector_id,
              eli.funding_source_id,
              eli.functional_code,
              eli.economic_code,
              COALESCE(SUM(COALESCE(${execAmountRef}, 0)), 0) AS execution_value
            FROM executionlineitems eli
            ${exeEntityJoin}
            ${exeUatJoin}
            ${exeWhere}
            GROUP BY
              eli.year,
              eli.month,
              eli.entity_cui,
              eli.main_creditor_cui,
              eli.budget_sector_id,
              eli.funding_source_id,
              eli.functional_code,
              eli.economic_code
          ),
          joined AS (
            SELECT
              ang.entity_cui AS ang_entity_cui,
              exe.entity_cui AS exe_entity_cui
            FROM ang
            FULL OUTER JOIN exe
              ON ang.year = exe.year
              AND ang.month = exe.month
              AND ang.entity_cui = exe.entity_cui
              AND ang.budget_sector_id = exe.budget_sector_id
              AND ang.funding_source_id = exe.funding_source_id
              AND ang.functional_code = exe.functional_code
              AND ang.main_creditor_cui IS NOT DISTINCT FROM exe.main_creditor_cui
              AND ang.economic_code IS NOT DISTINCT FROM exe.economic_code
          )
        SELECT
          COUNT(*) FILTER (WHERE ang_entity_cui IS NOT NULL AND exe_entity_cui IS NOT NULL) AS matched_count,
          COUNT(*) FILTER (WHERE ang_entity_cui IS NOT NULL AND exe_entity_cui IS NULL) AS unmatched_commitment_count,
          COUNT(*) FILTER (WHERE ang_entity_cui IS NULL AND exe_entity_cui IS NOT NULL) AS unmatched_execution_count
        FROM joined
      `;

      const countsResult = await countsQuery.execute(this.db);
      const countsRows = countsResult.rows as {
        matched_count: string;
        unmatched_commitment_count: string;
        unmatched_execution_count: string;
      }[];
      const countsRow = countsRows[0] ?? {
        matched_count: '0',
        unmatched_commitment_count: '0',
        unmatched_execution_count: '0',
      };

      return ok({
        rows: monthRows.map((r) => ({
          year: r.year,
          month: r.month,
          commitment_value: new Decimal(r.commitment_value),
          execution_value: new Decimal(r.execution_value),
        })),
        counts: {
          matched_count: Number.parseInt(countsRow.matched_count, 10),
          unmatched_commitment_count: Number.parseInt(countsRow.unmatched_commitment_count, 10),
          unmatched_execution_count: Number.parseInt(countsRow.unmatched_execution_count, 10),
        },
      });
    } catch (error) {
      if (isTimeoutError(error)) {
        return err(createTimeoutError('commitmentVsExecution query timed out', error));
      }
      return err(createDatabaseError('commitmentVsExecution query failed', error));
    }
  }
}

export const makeCommitmentsRepo = (db: BudgetDbClient): CommitmentsRepository =>
  new KyselyCommitmentsRepo(db);
