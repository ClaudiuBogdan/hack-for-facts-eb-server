/**
 * Companies analytics — the ClickHouse engine over one immutable release.
 *
 * Tables: `companies_analytics.company_r<N>` (one row per eligible company,
 * ORDER BY cui) and `company_year_r<N>` (one selected statement per company
 * and fiscal year, ORDER BY (fiscal_year, cui), company keys copied).
 *
 * Query rules (contract §3):
 *  - the population is counted on `company_r`; a selected-year constraint
 *    (filing, financial range, size band) is a `cui IN (statements)`
 *    semi-join and NOT_FILED is `cui NOT IN (the year's statements)`, so no
 *    company is ever multiplied across years;
 *  - filers are `company_year_r` rows of the fiscal year;
 *  - contributors are `countIf(<m>_status = 'reported')`; sums accumulate in
 *    Decimal128 (money) / Int128 (employees) and are NULL without a
 *    contributor; every number leaves ClickHouse through `toString`;
 *  - identifiers come only from the whitelists below and the validated release
 *    number; every request value is a bound parameter;
 *  - no output alias reuses a column name: ClickHouse substitutes aliases
 *    into WHERE/GROUP BY, so `toString(x) AS x` would silently change a filter.
 */

import { Type } from '@sinclair/typebox';
import { err, ok } from 'neverthrow';

import { databaseError } from '@/modules/shared/index.js';

import { makeQueryParams, type ClickhouseReader, type QueryParams } from './clickhouse-reader.js';
import { companyTableName, companyYearTableName } from '../../core/analytics-release.js';
import {
  CAEN_BASIS_VALUE,
  COMPANY_ANALYSIS_STATUSES,
  METRIC_COLUMN,
  SIZE_BAND_VALUE,
  STATUS_VALUE,
  metricUnit,
  requiresStatement,
  type CompanyAnalysisDimension,
  type CompanyAnalysisFlagValue,
  type CompanyAnalysisKeyFilter,
  type CompanyAnalysisMetric,
  type CompanyAnalysisScope,
  type CompanyAnalysisStatus,
} from '../../core/analytics-types.js';

import type {
  BreakdownRows,
  CompanyAnalysisEngine,
  FilerAggregateRow,
  MetricAggregateRow,
  RecordRow,
  RecordValueRow,
  SeriesRows,
} from '../../core/analytics-ports.js';

/** Grouped answers never legitimately approach this (UAT ≈ 3.2k, CAEN ≈ 1k). */
export const MAX_BREAKDOWN_GROUPS = 20_000;
const TABLES_TTL_MS = 60_000;

const NullableString = Type.Union([Type.String(), Type.Null()]);
const CountString = Type.String({ pattern: '^[0-9]+$' });

interface Tables {
  readonly company: string;
  readonly companyYear: string;
}

const col = (alias: string, name: string): string => (alias === '' ? name : `${alias}.${name}`);

// ── company-key conditions (identical on both grains: keys are copied) ──────

const keyCondition = (p: QueryParams, column: string, filter: CompanyAnalysisKeyFilter): string => {
  const parts: string[] = [];
  if (filter.values.length > 0)
    parts.push(
      `(${column} IS NOT NULL AND has(${p.bind('Array(String)', filter.values)}, assumeNotNull(${column})))`
    );
  if (filter.includeUnknown) parts.push(`${column} IS NULL`);
  return `(${parts.join(' OR ')})`;
};

/** An ANAF observation: NULL is UNKNOWN and never satisfies YES or NO. */
const flagSql = (value: CompanyAnalysisFlagValue, column: string): string => {
  switch (value) {
    case 'YES':
      return `(${column} IS NOT NULL AND ${column} = true)`;
    case 'NO':
      return `(${column} IS NOT NULL AND ${column} = false)`;
    default:
      return `${column} IS NULL`;
  }
};

const flagCondition = (column: string, values: readonly CompanyAnalysisFlagValue[]): string =>
  `(${values.map((value) => flagSql(value, column)).join(' OR ')})`;

/** Conditions on the company keys; valid on `company_r` and `company_year_r` alike. */
export const companyConditions = (
  scope: CompanyAnalysisScope,
  p: QueryParams,
  alias = ''
): string[] => {
  const c = (name: string): string => col(alias, name);
  const conds: string[] = [];
  if (scope.cuis !== undefined)
    conds.push(`has(${p.bind('Array(String)', scope.cuis)}, ${c('cui')})`);
  if (scope.county !== undefined) conds.push(keyCondition(p, c('county_code'), scope.county));
  if (scope.uat !== undefined) conds.push(keyCondition(p, c('uat_siruta'), scope.uat));
  if (scope.legalForms !== undefined)
    conds.push(`has(${p.bind('Array(String)', scope.legalForms)}, ${c('legal_form')})`);
  if (scope.observedStatus !== undefined)
    conds.push(keyCondition(p, c('onrc_status_code'), scope.observedStatus));
  if (scope.vatPayer !== undefined) conds.push(flagCondition(c('anaf_vat_payer'), scope.vatPayer));
  if (scope.fiscallyInactive !== undefined)
    conds.push(flagCondition(c('anaf_inactive'), scope.fiscallyInactive));
  if (scope.mainCaen !== undefined) {
    const selectors = scope.mainCaen.map((selector) =>
      selector.revision === null
        ? // An unknown revision matches only rows whose revision is unknown.
          `(${c('anaf_main_caen_basis')} = '${CAEN_BASIS_VALUE.REVISION_UNKNOWN}' AND ${c('anaf_main_caen_code')} = ${p.bind('String', selector.code)})`
        : `(${c('anaf_main_caen_basis')} = '${CAEN_BASIS_VALUE.REVISION_KNOWN}' AND ${c('anaf_main_caen_rev')} = ${p.bind('String', selector.revision)} AND ${c('anaf_main_caen_code')} = ${p.bind('String', selector.code)})`
    );
    conds.push(`(${selectors.join(' OR ')})`);
  }
  if (scope.mainCaenBasis !== undefined)
    conds.push(
      `has(${p.bind(
        'Array(String)',
        scope.mainCaenBasis.map((basis) => CAEN_BASIS_VALUE[basis])
      )}, ${c('anaf_main_caen_basis')})`
    );
  return conds;
};

const statusColumn = (metric: CompanyAnalysisMetric, alias = ''): string =>
  col(alias, `${METRIC_COLUMN[metric]}_status`);
const valueColumn = (metric: CompanyAnalysisMetric, alias = ''): string =>
  col(alias, METRIC_COLUMN[metric]);
const REPORTED = `'${STATUS_VALUE.REPORTED}'`;
const paramTypeOf = (metric: CompanyAnalysisMetric): 'Int64' | 'Decimal(18,2)' =>
  metricUnit(metric) === 'HEADCOUNT' ? 'Int64' : 'Decimal(18,2)';

/** Selected-year statement conditions: financial ranges act on REPORTED values only. */
export const statementConditions = (
  scope: CompanyAnalysisScope,
  p: QueryParams,
  alias = ''
): string[] => {
  const conds: string[] = [];
  for (const range of scope.financialRanges ?? []) {
    conds.push(`${statusColumn(range.metric, alias)} = ${REPORTED}`);
    if (range.min !== null)
      conds.push(
        `${valueColumn(range.metric, alias)} >= ${p.bind(paramTypeOf(range.metric), range.min)}`
      );
    if (range.max !== null)
      conds.push(
        `${valueColumn(range.metric, alias)} <= ${p.bind(paramTypeOf(range.metric), range.max)}`
      );
  }
  if (scope.employeeSizeBands !== undefined)
    conds.push(
      `has(${p.bind(
        'Array(String)',
        scope.employeeSizeBands.map((band) => SIZE_BAND_VALUE[band])
      )}, ${col(alias, 'employee_size_band')})`
    );
  return conds;
};

const where = (conds: readonly string[]): string =>
  conds.length === 0 ? '1' : conds.join(' AND ');

/** The `company_r` population predicate for the scope's fiscal year. */
export const populationConditions = (
  scope: CompanyAnalysisScope,
  p: QueryParams,
  t: Tables,
  alias = ''
): string[] => {
  const conds = companyConditions(scope, p, alias);
  if (requiresStatement(scope)) {
    const inner = [
      `fiscal_year = ${p.bind('UInt16', String(scope.fiscalYear))}`,
      ...companyConditions(scope, p),
      ...statementConditions(scope, p),
    ];
    conds.push(`${col(alias, 'cui')} IN (SELECT cui FROM ${t.companyYear} WHERE ${where(inner)})`);
  } else if (scope.filing === 'NOT_FILED') {
    conds.push(
      `${col(alias, 'cui')} NOT IN (SELECT cui FROM ${t.companyYear} WHERE fiscal_year = ${p.bind('UInt16', String(scope.fiscalYear))})`
    );
  }
  return conds;
};

/** The selected-year statement predicate on `company_year_r` (filers). */
const filerConditions = (scope: CompanyAnalysisScope, p: QueryParams, alias = ''): string[] => [
  `${col(alias, 'fiscal_year')} = ${p.bind('UInt16', String(scope.fiscalYear))}`,
  ...companyConditions(scope, p, alias),
  ...statementConditions(scope, p, alias),
];

// ── metric aggregates ────────────────────────────────────────────────────────

const STATUS_ALIAS: Readonly<Record<CompanyAnalysisStatus, string>> = {
  REPORTED: 'reported',
  MISSING: 'missing',
  NOT_ADMITTED: 'not_admitted',
  HELD_PROFILE: 'held_profile',
  HELD_OBSERVATION: 'held_observation',
  HELD_QUALITY: 'held_quality',
  HELD_COMPONENT: 'held_component',
};

/** Money sums accumulate in Decimal128; headcounts in Int128 (`sum(Int64)` wraps). */
const accumulator = (metric: CompanyAnalysisMetric): string =>
  metricUnit(metric) === 'HEADCOUNT'
    ? `toInt128(${valueColumn(metric)})`
    : `toDecimal128(${valueColumn(metric)}, 2)`;

const metricSelect = (metric: CompanyAnalysisMetric, index: number): string[] => {
  const status = statusColumn(metric);
  return [
    `if(countIf(${status} = ${REPORTED}) = 0, NULL, toString(sumIf(${accumulator(metric)}, ${status} = ${REPORTED}))) AS m${String(index)}_sum`,
    ...COMPANY_ANALYSIS_STATUSES.map(
      (s) =>
        `toString(countIf(${status} = '${STATUS_VALUE[s]}')) AS m${String(index)}_${STATUS_ALIAS[s]}`
    ),
  ];
};

const metricSchemaFields = (index: number) => ({
  [`m${String(index)}_sum`]: NullableString,
  ...Object.fromEntries(
    COMPANY_ANALYSIS_STATUSES.map((s) => [`m${String(index)}_${STATUS_ALIAS[s]}`, CountString])
  ),
});

const readAggregate = (
  row: Readonly<Record<string, unknown>>,
  index: number
): MetricAggregateRow => ({
  sum: row[`m${String(index)}_sum`] as string | null,
  statuses: Object.fromEntries(
    COMPANY_ANALYSIS_STATUSES.map((s) => [s, row[`m${String(index)}_${STATUS_ALIAS[s]}`] as string])
  ) as Record<CompanyAnalysisStatus, string>,
});

// ── breakdown dimensions (whitelisted expressions) ──────────────────────────

const flagExpression = (column: string): string =>
  `multiIf(${column} IS NULL, NULL, ${column}, 'YES', 'NO')`;

const DIMENSION_PARTS: Readonly<Record<CompanyAnalysisDimension, readonly string[]>> = {
  COUNTY: ['county_code'],
  UAT: ['uat_siruta'],
  MAIN_CAEN: ['anaf_main_caen_basis', 'anaf_main_caen_rev', 'anaf_main_caen_code'],
  LEGAL_FORM: ['legal_form'],
  OBSERVED_STATUS: ['onrc_status_code'],
  VAT_PAYER: [flagExpression('anaf_vat_payer')],
  FISCALLY_INACTIVE: [flagExpression('anaf_inactive')],
  EMPLOYEE_SIZE: ['employee_size_band'],
};

const partsSchema = (count: number) =>
  Object.fromEntries(Array.from({ length: count }, (_, i) => [`k${String(i)}`, NullableString]));

const readParts = (row: Readonly<Record<string, unknown>>, count: number): (string | null)[] =>
  Array.from({ length: count }, (_, i) => row[`k${String(i)}`] as string | null);

// ── the engine ───────────────────────────────────────────────────────────────

export const makeClickhouseAnalyticsEngine = (
  reader: ClickhouseReader,
  database: string,
  now: () => number = Date.now
): CompanyAnalysisEngine => {
  const tablesOf = (releaseNumber: number): Tables => ({
    company: `${database}.${companyTableName(releaseNumber)}`,
    companyYear: `${database}.${companyYearTableName(releaseNumber)}`,
  });
  const available = new Map<number, number>();

  const tablesAvailable: CompanyAnalysisEngine['tablesAvailable'] = async (releaseNumber) => {
    const expires = available.get(releaseNumber);
    if (expires !== undefined && expires > now()) return ok(true);
    const p = makeQueryParams();
    const names = [companyTableName(releaseNumber), companyYearTableName(releaseNumber)];
    const rows = await reader.query(
      `SELECT name FROM system.tables WHERE database = ${p.bind('String', database)} AND has(${p.bind('Array(String)', names)}, name)`,
      p,
      Type.Object({ name: Type.String() }),
      { cache: false }
    );
    if (rows.isErr()) return err(rows.error);
    const present = new Set(rows.value.map((row) => row.name));
    const both = names.every((name) => present.has(name));
    // Only a positive answer is cached: a dropped table is noticed within the TTL.
    if (both) available.set(releaseNumber, now() + TABLES_TTL_MS);
    else available.delete(releaseNumber);
    return ok(both);
  };

  const countPopulation: CompanyAnalysisEngine['countPopulation'] = async (
    releaseNumber,
    scope
  ) => {
    const t = tablesOf(releaseNumber);
    const p = makeQueryParams();
    const rows = await reader.query(
      `SELECT toString(count()) AS companies FROM ${t.company} WHERE ${where(populationConditions(scope, p, t))}`,
      p,
      Type.Object({ companies: CountString })
    );
    if (rows.isErr()) return err(rows.error);
    const row = rows.value[0];
    return row === undefined
      ? err(databaseError('population count returned no row'))
      : ok(row.companies);
  };

  const aggregateFilers: CompanyAnalysisEngine['aggregateFilers'] = async (
    releaseNumber,
    scope,
    metrics
  ) => {
    if (scope.filing === 'NOT_FILED') return ok({ filers: '0', metrics: new Map() });
    const t = tablesOf(releaseNumber);
    const p = makeQueryParams();
    const select = ['toString(count()) AS filers', ...metrics.flatMap(metricSelect)];
    const rows = await reader.query(
      `SELECT ${select.join(', ')} FROM ${t.companyYear} WHERE ${where(filerConditions(scope, p))}`,
      p,
      Type.Object({
        filers: CountString,
        ...Object.assign({}, ...metrics.map((_, i) => metricSchemaFields(i))),
      })
    );
    if (rows.isErr()) return err(rows.error);
    const row = rows.value[0] as Readonly<Record<string, unknown>> | undefined;
    if (row === undefined) return err(databaseError('filer aggregate returned no row'));
    const result: FilerAggregateRow = {
      filers: row['filers'] as string,
      metrics: new Map(metrics.map((metric, i) => [metric, readAggregate(row, i)])),
    };
    return ok(result);
  };

  const breakdown: CompanyAnalysisEngine['breakdown'] = async (
    releaseNumber,
    scope,
    dimension,
    metric
  ) => {
    const t = tablesOf(releaseNumber);
    const parts = DIMENSION_PARTS[dimension];
    const keys = parts.map((_, i) => `k${String(i)}`);
    const keySelect = parts.map((expr, i) => `${expr} AS k${String(i)}`);

    // Population per group, counted on company_r. The size band is a
    // statement attribute: it comes from the year's statement (none → '').
    const pp = makeQueryParams();
    const populationSql =
      dimension === 'EMPLOYEE_SIZE'
        ? `SELECT nullIf(toString(f.employee_size_band), '') AS k0, toString(count()) AS companies FROM ${t.company} AS c ANY LEFT JOIN (SELECT cui, employee_size_band FROM ${t.companyYear} WHERE fiscal_year = ${pp.bind('UInt16', String(scope.fiscalYear))}) AS f ON f.cui = c.cui WHERE ${where(populationConditions(scope, pp, t, 'c'))} GROUP BY k0 LIMIT ${String(MAX_BREAKDOWN_GROUPS + 1)}`
        : `SELECT ${keySelect.join(', ')}, toString(count()) AS companies FROM ${t.company} WHERE ${where(populationConditions(scope, pp, t))} GROUP BY ${keys.join(', ')} LIMIT ${String(MAX_BREAKDOWN_GROUPS + 1)}`;

    const population = reader.query(
      populationSql,
      pp,
      Type.Object({ ...partsSchema(parts.length), companies: CountString })
    );

    const filers =
      scope.filing === 'NOT_FILED'
        ? Promise.resolve(ok([] as readonly Readonly<Record<string, unknown>>[]))
        : (() => {
            const fp = makeQueryParams();
            const select = [
              ...keySelect,
              'toString(count()) AS filers',
              ...(metric === null ? [] : metricSelect(metric, 0)),
            ];
            return reader.query(
              `SELECT ${select.join(', ')} FROM ${t.companyYear} WHERE ${where(filerConditions(scope, fp))} GROUP BY ${keys.join(', ')} LIMIT ${String(MAX_BREAKDOWN_GROUPS + 1)}`,
              fp,
              Type.Object({
                ...partsSchema(parts.length),
                filers: CountString,
                ...(metric === null ? {} : metricSchemaFields(0)),
              })
            );
          })();

    const [populationRows, filerRows] = await Promise.all([population, filers]);
    if (populationRows.isErr()) return err(populationRows.error);
    if (filerRows.isErr()) return err(filerRows.error);
    if (
      populationRows.value.length > MAX_BREAKDOWN_GROUPS ||
      filerRows.value.length > MAX_BREAKDOWN_GROUPS
    )
      return err(databaseError('breakdown dimension has too many groups'));
    const result: BreakdownRows = {
      population: populationRows.value.map((row) => ({
        parts: readParts(row, parts.length),
        companies: (row as Readonly<Record<string, unknown>>)['companies'] as string,
      })),
      filers: filerRows.value.map((row) => {
        const record = row as Readonly<Record<string, unknown>>;
        return {
          parts: readParts(record, parts.length),
          filers: record['filers'] as string,
          metric: metric === null ? null : readAggregate(record, 0),
        };
      }),
    };
    return ok(result);
  };

  const series: CompanyAnalysisEngine['series'] = async (
    releaseNumber,
    scope,
    metric,
    fromYear,
    toYear,
    mode
  ) => {
    const t = tablesOf(releaseNumber);
    const yearsSchema = Type.Object({
      year_text: Type.String({ pattern: '^[0-9]{4}$' }),
      statements: CountString,
      ...metricSchemaFields(0),
    });
    const select = [
      'toString(fiscal_year) AS year_text',
      'toString(count()) AS statements',
      ...metricSelect(metric, 0),
    ];

    const bp = makeQueryParams();
    const yp = makeQueryParams();
    const between = `fiscal_year BETWEEN ${yp.bind('UInt16', String(fromYear))} AND ${yp.bind('UInt16', String(toYear))}`;
    let baseSql: string | null;
    let yearsWhere: string[];
    if (mode === 'REFERENCE_YEAR') {
      // The cohort: companies that filed in the reference year and satisfied
      // every filter there (contract §3 "Cohort of reference year R").
      baseSql = `SELECT toString(count()) AS companies FROM ${t.companyYear} WHERE ${where(filerConditions(scope, bp))}`;
      yearsWhere = [
        between,
        `cui IN (SELECT cui FROM ${t.companyYear} WHERE ${where(filerConditions(scope, yp))})`,
      ];
    } else {
      baseSql = requiresStatement(scope)
        ? null
        : `SELECT toString(count()) AS companies FROM ${t.company} WHERE ${where(companyConditions(scope, bp))}`;
      // "Matching reporters each year": the selected-year filters re-applied per year.
      yearsWhere = [between, ...companyConditions(scope, yp), ...statementConditions(scope, yp)];
    }

    const [base, years] = await Promise.all([
      baseSql === null
        ? Promise.resolve(ok([] as readonly { companies: string }[]))
        : reader.query(baseSql, bp, Type.Object({ companies: CountString })),
      reader.query(
        `SELECT ${select.join(', ')} FROM ${t.companyYear} WHERE ${where(yearsWhere)} GROUP BY fiscal_year ORDER BY fiscal_year`,
        yp,
        yearsSchema
      ),
    ]);
    if (base.isErr()) return err(base.error);
    if (years.isErr()) return err(years.error);
    const result: SeriesRows = {
      base: baseSql === null ? null : (base.value[0]?.companies ?? null),
      years: years.value.map((row) => ({
        fiscalYear: Number(row.year_text),
        statements: row.statements,
        metric: readAggregate(row, 0),
      })),
    };
    return ok(result);
  };

  const records: CompanyAnalysisEngine['records'] = async (releaseNumber, scope, request) => {
    const t = tablesOf(releaseNumber);
    const p = makeQueryParams();
    const sortMetric = request.sort === 'METRIC' ? request.sortMetric : null;
    const sortIndex = sortMetric === null ? -1 : request.metrics.indexOf(sortMetric);
    if (request.sort === 'METRIC' && sortIndex < 0)
      return err(databaseError('records sort metric is not selected'));

    // The year's statements: the whole selected-year predicate when the scope
    // needs a statement (INNER join), else the copied company keys only (LEFT
    // join keeps non-filers). Either way the joined side stays small.
    const statementWhere = requiresStatement(scope)
      ? filerConditions(scope, p)
      : [
          `fiscal_year = ${p.bind('UInt16', String(scope.fiscalYear))}`,
          ...companyConditions(scope, p),
        ];
    const statementSelect = [
      'cui',
      '1 AS filed',
      'employee_size_band',
      ...request.metrics.flatMap((metric, i) => [
        `${valueColumn(metric)} AS v${String(i)}`,
        `${statusColumn(metric)} AS s${String(i)}`,
      ]),
    ];
    const join = requiresStatement(scope) ? 'ANY INNER JOIN' : 'ANY LEFT JOIN';

    // `filed` is 1 on joined statements; a missing match reads 0 (or NULL under
    // join_use_nulls=1, hence ifNull) — never trusted to be either.
    const filed = 'ifNull(f.filed, 0)';
    const conds = companyConditions(scope, p, 'c');
    if (scope.filing === 'NOT_FILED') conds.push(`${filed} = 0`);
    const sortValue = `f.v${String(sortIndex)}`;
    const after = request.after;
    if (after !== null) {
      const cui = p.bind('String', after.cui);
      if (sortMetric === null) {
        conds.push(request.direction === 'ASC' ? `c.cui > ${cui}` : `c.cui < ${cui}`);
      } else if (after.value === null) {
        // Already in the NULLS LAST tail: only further NULLs, by cui.
        conds.push(`(${sortValue} IS NULL AND c.cui > ${cui})`);
      } else {
        const value = p.bind(paramTypeOf(sortMetric), after.value);
        const beyond = request.direction === 'DESC' ? '<' : '>';
        conds.push(
          `(${sortValue} ${beyond} ${value} OR (${sortValue} = ${value} AND c.cui > ${cui}) OR ${sortValue} IS NULL)`
        );
      }
    }
    const orderBy =
      sortMetric === null
        ? `c.cui ${request.direction}`
        : `${sortValue} ${request.direction} NULLS LAST, c.cui ASC`;

    // `o_` aliases never collide with a column name (see the header note).
    const select = [
      'c.cui AS o_cui',
      'toString(c.legal_form) AS o_legal_form',
      'c.onrc_status_code AS o_status_code',
      'c.county_code AS o_county_code',
      'c.uat_siruta AS o_uat_siruta',
      `${flagExpression('c.anaf_vat_payer')} AS o_vat_payer`,
      `${flagExpression('c.anaf_inactive')} AS o_fiscally_inactive`,
      'toString(c.anaf_main_caen_basis) AS o_caen_basis',
      'c.anaf_main_caen_rev AS o_caen_revision',
      'c.anaf_main_caen_code AS o_caen_code',
      'toString(c.registration_year) AS o_registration_year',
      `toString(${filed}) AS o_filed`,
      `if(${filed} = 1, toString(f.employee_size_band), NULL) AS o_size_band`,
      ...request.metrics.flatMap((_, i) => [
        `if(${filed} = 1, toString(f.v${String(i)}), NULL) AS o_v${String(i)}`,
        `if(${filed} = 1, toString(f.s${String(i)}), NULL) AS o_s${String(i)}`,
      ]),
    ];
    const rowSchema = Type.Object({
      o_cui: Type.String({ pattern: '^[0-9]{1,10}$' }),
      o_legal_form: Type.String(),
      o_status_code: NullableString,
      o_county_code: NullableString,
      o_uat_siruta: NullableString,
      o_vat_payer: NullableString,
      o_fiscally_inactive: NullableString,
      o_caen_basis: Type.String(),
      o_caen_revision: NullableString,
      o_caen_code: NullableString,
      o_registration_year: NullableString,
      o_filed: Type.Union([Type.Literal('0'), Type.Literal('1')]),
      o_size_band: NullableString,
      ...Object.fromEntries(
        request.metrics.flatMap((_, i) => [
          [`o_v${String(i)}`, NullableString],
          [`o_s${String(i)}`, NullableString],
        ])
      ),
    });
    const rows = await reader.query(
      `SELECT ${select.join(', ')} FROM ${t.company} AS c ${join} (SELECT ${statementSelect.join(', ')} FROM ${t.companyYear} WHERE ${where(statementWhere)}) AS f ON f.cui = c.cui WHERE ${where(conds)} ORDER BY ${orderBy} LIMIT ${String(request.limit)}`,
      p,
      rowSchema
    );
    if (rows.isErr()) return err(rows.error);
    return ok(
      rows.value.map((raw): RecordRow => {
        const row = raw as Readonly<Record<string, unknown>>;
        const values = new Map<CompanyAnalysisMetric, RecordValueRow>(
          request.metrics.map((metric, i) => [
            metric,
            {
              value: row[`o_v${String(i)}`] as string | null,
              status: row[`o_s${String(i)}`] as string | null,
            },
          ])
        );
        return {
          cui: raw.o_cui,
          legalForm: raw.o_legal_form,
          statusCode: raw.o_status_code,
          countyCode: raw.o_county_code,
          uatSiruta: raw.o_uat_siruta,
          vatPayer: raw.o_vat_payer,
          fiscallyInactive: raw.o_fiscally_inactive,
          caenBasis: raw.o_caen_basis,
          caenRevision: raw.o_caen_revision,
          caenCode: raw.o_caen_code,
          registrationYear: raw.o_registration_year,
          filed: raw.o_filed === '1',
          sizeBand: raw.o_size_band,
          values,
        };
      })
    );
  };

  return { tablesAvailable, countPopulation, aggregateFilers, breakdown, series, records };
};
