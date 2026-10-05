import { ok } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import { makeClickhouseAnalyticsEngine } from '@/modules/companies/shell/analytics/clickhouse-engine.js';

import type { CompanyAnalysisScope } from '@/modules/companies/core/analytics-types.js';
import type {
  ClickhouseReader,
  QueryParams,
} from '@/modules/companies/shell/analytics/clickhouse-reader.js';

interface Captured {
  readonly sql: string;
  readonly params: readonly (readonly [string, string])[];
  readonly columns: readonly string[];
}

/** Records every statement and answers with canned rows keyed by a SQL fragment. */
const capturingReader = (
  answers: readonly (readonly [string, readonly Record<string, unknown>[]])[] = []
) => {
  const captured: Captured[] = [];
  const reader: ClickhouseReader = {
    query: (sql, params: QueryParams, schema) => {
      captured.push({ sql, params: params.entries(), columns: Object.keys(schema.properties) });
      const rows = answers.find(([fragment]) => sql.includes(fragment))?.[1] ?? [];
      return Promise.resolve(ok(rows as never));
    },
    close: () => undefined,
  };
  return { reader, captured };
};

const SCOPE: CompanyAnalysisScope = { fiscalYear: 2024 };
const HOSTILE = "CJ') OR 1=1 --";

describe('companies analytics ClickHouse statements', () => {
  it('builds table names only from the validated release number and database', async () => {
    const { reader, captured } = capturingReader([['count()', [{ companies: '3' }]]]);
    const engine = makeClickhouseAnalyticsEngine(reader, 'companies_analytics');
    await engine.countPopulation(7, SCOPE);
    expect(captured[0]?.sql).toBe(
      'SELECT toString(count()) AS companies FROM companies_analytics.company_r7 WHERE 1'
    );
  });

  it('binds every request value as a typed parameter (never in the SQL text)', async () => {
    const { reader, captured } = capturingReader([['count()', [{ companies: '0' }]]]);
    const engine = makeClickhouseAnalyticsEngine(reader, 'companies_analytics');
    // The engine trusts nothing: even a key the core would refuse stays a parameter.
    await engine.countPopulation(7, {
      fiscalYear: 2024,
      cuis: ['100'],
      county: { values: [HOSTILE], bases: [], includeUnknown: true },
      legalForms: ['SRL'],
      mainCaen: [
        { code: '6201', revision: null },
        { code: '6201', revision: 'rev2' },
      ],
      financialRanges: [{ metric: 'TURNOVER', min: '10.00', max: null }],
    });
    const { sql, params } = captured[0] ?? { sql: '', params: [] };
    expect(sql).not.toContain(HOSTILE);
    expect(sql).not.toContain('10.00');
    expect(sql).not.toContain("'100'");
    expect(sql).toContain('{p0:Array(String)}');
    expect(sql).toContain('{p1:Array(String)}');
    expect(sql).toMatch(/turnover >= \{p\d+:Decimal\(18,2\)\}/u);
    expect(params).toContainEqual(['p1', "['CJ\\') OR 1=1 --']"]);
    expect(params.map(([, value]) => value)).toContain('10.00');
  });

  it('counts a selected-year population with a semi-join and NOT_FILED with NOT IN', async () => {
    const { reader, captured } = capturingReader([['count()', [{ companies: '0' }]]]);
    const engine = makeClickhouseAnalyticsEngine(reader, 'companies_analytics');
    await engine.countPopulation(7, {
      fiscalYear: 2024,
      financialRanges: [{ metric: 'EMPLOYEES', min: '10', max: '49' }],
    });
    await engine.countPopulation(7, { fiscalYear: 2024, filing: 'NOT_FILED' });
    expect(captured[0]?.sql).toContain(
      'FROM companies_analytics.company_r7 WHERE cui IN (SELECT cui FROM companies_analytics.company_year_r7 WHERE fiscal_year = {p0:UInt16}'
    );
    expect(captured[0]?.sql).toContain("employees_status = 'reported'");
    expect(captured[0]?.sql).toMatch(/employees >= \{p\d+:Int64\}/u);
    expect(captured[1]?.sql).toContain(
      'cui NOT IN (SELECT cui FROM companies_analytics.company_year_r7 WHERE fiscal_year = {p0:UInt16})'
    );
  });

  it('sums money in Decimal128 and headcounts in Int128, NULL without contributors', async () => {
    const { reader, captured } = capturingReader();
    const engine = makeClickhouseAnalyticsEngine(reader, 'companies_analytics');
    await engine.aggregateFilers(7, SCOPE, ['TURNOVER', 'EMPLOYEES']);
    const sql = captured[0]?.sql ?? '';
    expect(sql).toContain(
      "if(countIf(turnover_status = 'reported') = 0, NULL, toString(sumIf(toDecimal128(turnover, 2), turnover_status = 'reported'))) AS m0_sum"
    );
    expect(sql).toContain('sumIf(toInt128(employees), employees_status =');
    expect(sql).toContain(
      "toString(countIf(turnover_status = 'held_observation')) AS m0_held_observation"
    );
    expect(sql).toContain(
      'FROM companies_analytics.company_year_r7 WHERE fiscal_year = {p0:UInt16}'
    );
  });

  it('answers NOT_FILED filers without a query', async () => {
    const { reader, captured } = capturingReader();
    const engine = makeClickhouseAnalyticsEngine(reader, 'companies_analytics');
    const result = await engine.aggregateFilers(7, { fiscalYear: 2024, filing: 'NOT_FILED' }, [
      'TURNOVER',
    ]);
    expect(result._unsafeUnwrap().filers).toBe('0');
    expect(captured).toHaveLength(0);
  });

  it('matches an unknown CAEN revision only on revision-unknown rows', async () => {
    const { reader, captured } = capturingReader([['count()', [{ companies: '0' }]]]);
    const engine = makeClickhouseAnalyticsEngine(reader, 'companies_analytics');
    await engine.countPopulation(7, {
      fiscalYear: 2024,
      mainCaen: [{ code: '6201', revision: null }],
    });
    expect(captured[0]?.sql).toContain(
      "(anaf_main_caen_basis = 'revision_unknown' AND anaf_main_caen_code = {p0:String})"
    );
    expect(captured[0]?.sql).not.toContain('anaf_main_caen_rev');
  });

  it('treats a NULL ANAF observation as UNKNOWN, never as NO', async () => {
    const { reader, captured } = capturingReader([['count()', [{ companies: '0' }]]]);
    const engine = makeClickhouseAnalyticsEngine(reader, 'companies_analytics');
    await engine.countPopulation(7, { fiscalYear: 2024, vatPayer: ['NO', 'UNKNOWN'] });
    expect(captured[0]?.sql).toContain(
      '((anaf_vat_payer IS NOT NULL AND anaf_vat_payer = false) OR anaf_vat_payer IS NULL)'
    );
  });

  it('breaks down every group (no SQL top-N) on both grains, without alias shadowing', async () => {
    const { reader, captured } = capturingReader();
    const engine = makeClickhouseAnalyticsEngine(reader, 'companies_analytics');
    await engine.breakdown(7, SCOPE, 'MAIN_CAEN', 'TURNOVER');
    await engine.breakdown(7, SCOPE, 'EMPLOYEE_SIZE', null);
    const [population, filers, sizePopulation] = captured;
    expect(population?.sql).toContain(
      'SELECT anaf_main_caen_basis AS k0, anaf_main_caen_rev AS k1, anaf_main_caen_code AS k2, toString(count()) AS companies FROM companies_analytics.company_r7'
    );
    expect(population?.sql).toContain('GROUP BY k0, k1, k2 LIMIT 20001');
    expect(filers?.sql).toContain('FROM companies_analytics.company_year_r7');
    expect(filers?.sql).toContain('m0_sum');
    expect(sizePopulation?.sql).toContain(
      'FROM companies_analytics.company_r7 AS c ANY LEFT JOIN (SELECT cui, employee_size_band FROM companies_analytics.company_year_r7'
    );
    for (const { sql } of captured) {
      for (const column of ['cui', 'fiscal_year', 'county_code', 'legal_form', 'turnover']) {
        expect(sql).not.toMatch(new RegExp(` AS ${column}[ ,]`, 'u'));
      }
    }
  });

  it('series: EACH_YEAR re-applies filters per year; REFERENCE_YEAR fixes the cohort', async () => {
    const { reader, captured } = capturingReader();
    const engine = makeClickhouseAnalyticsEngine(reader, 'companies_analytics');
    const scope: CompanyAnalysisScope = {
      fiscalYear: 2024,
      financialRanges: [{ metric: 'TURNOVER', min: '1000.00', max: null }],
    };
    await engine.series(7, scope, 'TURNOVER', 2019, 2024, 'EACH_YEAR');
    await engine.series(7, scope, 'TURNOVER', 2019, 2024, 'REFERENCE_YEAR');
    const each = captured.find(
      (c) => c.sql.includes('GROUP BY fiscal_year') && !c.sql.includes('cui IN')
    );
    expect(each?.sql).toContain("turnover_status = 'reported'");
    expect(each?.sql).not.toContain('fiscal_year = {');
    const reference = captured.filter((c) => c.sql.includes('cui IN'));
    expect(reference).toHaveLength(1);
    expect(reference[0]?.sql).toContain(
      'cui IN (SELECT cui FROM companies_analytics.company_year_r7 WHERE fiscal_year = {'
    );
    // The year text alias never shadows the filtered fiscal_year column.
    expect(each?.sql).toContain('toString(fiscal_year) AS year_text');
  });

  it('records: keyset after (value, cui) with NULLS LAST, LEFT join keeps non-filers', async () => {
    const { reader, captured } = capturingReader();
    const engine = makeClickhouseAnalyticsEngine(reader, 'companies_analytics');
    await engine.records(7, SCOPE, {
      sort: 'METRIC',
      sortMetric: 'TURNOVER',
      direction: 'DESC',
      after: { value: '1000.50', cui: '400' },
      limit: 26,
      metrics: ['TURNOVER', 'EMPLOYEES'],
    });
    await engine.records(
      7,
      { ...SCOPE, filing: 'FILED' },
      {
        sort: 'METRIC',
        sortMetric: 'TURNOVER',
        direction: 'ASC',
        after: { value: null, cui: '300' },
        limit: 26,
        metrics: ['TURNOVER'],
      }
    );
    const [left, inner] = captured;
    expect(left?.sql).toContain('FROM companies_analytics.company_r7 AS c ANY LEFT JOIN (');
    expect(left?.sql).toMatch(
      /\(f\.v0 < \{p\d+:Decimal\(18,2\)\} OR \(f\.v0 = \{p\d+:Decimal\(18,2\)\} AND c\.cui > \{p\d+:String\}\) OR f\.v0 IS NULL\)/u
    );
    expect(left?.sql).toContain('ORDER BY f.v0 DESC NULLS LAST, c.cui ASC LIMIT 26');
    // A non-matched statement reads as not filed whatever join_use_nulls says.
    expect(left?.sql).toContain('toString(ifNull(f.filed, 0)) AS o_filed');
    expect(left?.params.map(([, v]) => v)).toEqual(expect.arrayContaining(['1000.50', '400']));
    expect(inner?.sql).toContain('ANY INNER JOIN');
    expect(inner?.sql).toMatch(/\(f\.v0 IS NULL AND c\.cui > \{p\d+:String\}\)/u);
    expect(inner?.sql).toContain('ORDER BY f.v0 ASC NULLS LAST, c.cui ASC');
  });

  it('records sorted by CUI page on the key alone', async () => {
    const { reader, captured } = capturingReader();
    const engine = makeClickhouseAnalyticsEngine(reader, 'companies_analytics');
    await engine.records(7, SCOPE, {
      sort: 'CUI',
      sortMetric: null,
      direction: 'DESC',
      after: { value: null, cui: '500' },
      limit: 11,
      metrics: [],
    });
    expect(captured[0]?.sql).toMatch(/c\.cui < \{p\d+:String\}/u);
    expect(captured[0]?.sql).toContain('ORDER BY c.cui DESC LIMIT 11');
  });

  it('ONRC observations: ONE arrayExists conjunction per question, every value bound', async () => {
    const { reader, captured } = capturingReader([['count()', [{ companies: '0' }]]]);
    const engine = makeClickhouseAnalyticsEngine(reader, 'companies_analytics');
    await engine.countPopulation(7, {
      fiscalYear: 2024,
      onrc: {
        status: ['1048'],
        county: [HOSTILE],
        caenCode: ['6201'],
        onrcCaen: ['rev0:0111'],
      },
    });
    const { sql, params } = captured[0] ?? { sql: '', params: [] };
    expect(sql).toBe(
      'SELECT toString(count()) AS companies FROM companies_analytics.company_r7 WHERE arrayExists(i -> hasAny(i.status_codes, {p0:Array(String)}) AND hasAny(i.county_codes, {p1:Array(String)}) AND hasAny(i.caen_codes, {p2:Array(String)}) AND hasAny(i.caen_keys, {p3:Array(String)}), onrc_identifiers)'
    );
    expect(sql.match(/arrayExists/gu)).toHaveLength(1);
    expect(sql).not.toContain(HOSTILE);
    expect(params).toEqual([
      ['p0', "['1048']"],
      ['p1', "['CJ\\') OR 1=1 --']"],
      ['p2', "['6201']"],
      ['p3', "['rev0:0111']"],
    ]);
  });

  it('ONRC exclusions need complete coverage or a known consensus value', async () => {
    const { reader, captured } = capturingReader([['count()', [{ companies: '0' }]]]);
    const engine = makeClickhouseAnalyticsEngine(reader, 'companies_analytics');
    await engine.countPopulation(7, {
      fiscalYear: 2024,
      onrc: {
        exclude: { status: ['1070'], caenCode: ['0111'], county: ['CJ'], legalForm: ['SRL'] },
      },
    });
    const sql = captured[0]?.sql ?? '';
    expect(sql).toContain(
      "(onrc_status_coverage IN ('complete', 'complete_empty') AND NOT arrayExists(i -> hasAny(i.status_codes, {p0:Array(String)}), onrc_identifiers))"
    );
    expect(sql).toContain(
      "(onrc_caen_coverage IN ('complete', 'complete_empty') AND NOT arrayExists(i -> hasAny(i.caen_codes, {p1:Array(String)}), onrc_identifiers))"
    );
    expect(sql).toContain(
      "(county_basis IN ('single_observation', 'consistent_observations') AND county_code IS NOT NULL AND NOT has({p2:Array(String)}, assumeNotNull(county_code)))"
    );
    expect(sql).toContain(
      "(legal_form_basis IN ('single_observation', 'consistent_observations') AND NOT has({p3:Array(String)}, legal_form))"
    );
  });

  it('a basis bucket key selects a NULL consensus value on that basis; includeUnknown every NULL', async () => {
    const { reader, captured } = capturingReader([['count()', [{ companies: '0' }]]]);
    const engine = makeClickhouseAnalyticsEngine(reader, 'companies_analytics');
    await engine.countPopulation(7, {
      fiscalYear: 2024,
      observedStatus: { values: ['1048'], bases: ['MULTIPLE_VALUES'], includeUnknown: false },
      uat: { values: [], bases: [], includeUnknown: true },
    });
    const { sql, params } = captured[0] ?? { sql: '', params: [] };
    expect(sql).toContain('(uat_siruta IS NULL)');
    expect(sql).toContain(
      '((onrc_status_code IS NOT NULL AND has({p0:Array(String)}, assumeNotNull(onrc_status_code))) OR (onrc_status_code IS NULL AND has({p1:Array(String)}, onrc_status_basis)))'
    );
    expect(params).toEqual([
      ['p0', "['1048']"],
      ['p1', "['multiple_values']"],
    ]);
  });

  it('groups the consensus dimensions by value and basis, and never expands an array', async () => {
    const { reader, captured } = capturingReader();
    const engine = makeClickhouseAnalyticsEngine(reader, 'companies_analytics');
    const onrc = { status: ['1048'], county: ['CJ'] };
    await engine.breakdown(7, { fiscalYear: 2024, onrc }, 'COUNTY', 'TURNOVER');
    await engine.breakdown(7, { fiscalYear: 2024 }, 'OBSERVED_STATUS', null);
    await engine.records(
      7,
      { fiscalYear: 2024, onrc },
      {
        sort: 'CUI',
        sortMetric: null,
        direction: 'ASC',
        after: null,
        limit: 2,
        metrics: [],
      }
    );
    await engine.series(7, { fiscalYear: 2024, onrc }, 'TURNOVER', 2021, 2024, 'REFERENCE_YEAR');
    const [population, filers, statusPopulation] = captured;
    expect(population?.sql).toContain(
      'SELECT county_code AS k0, county_basis AS k1, toString(count()) AS companies FROM companies_analytics.company_r7'
    );
    expect(population?.sql).toContain('GROUP BY k0, k1 LIMIT 20001');
    expect(filers?.sql).toContain('county_code AS k0, county_basis AS k1');
    expect(statusPopulation?.sql).toContain('onrc_status_code AS k0, onrc_status_basis AS k1');
    for (const { sql } of captured) {
      expect(sql).not.toMatch(/arrayJoin|ARRAY JOIN|unnest/iu);
      for (const column of ['county_basis', 'onrc_identifiers', 'onrc_recorded_date']) {
        expect(sql).not.toMatch(new RegExp(` AS ${column}[ ,]`, 'u'));
      }
    }
  });

  it('records read the v2 bases, coverage and the exact recorded date (no registration year)', async () => {
    const { reader, captured } = capturingReader();
    const engine = makeClickhouseAnalyticsEngine(reader, 'companies_analytics');
    await engine.records(
      7,
      { fiscalYear: 2024, onrc: { status: ['1048'] } },
      { sort: 'CUI', sortMetric: null, direction: 'ASC', after: null, limit: 2, metrics: [] }
    );
    const { sql, columns } = captured[0] ?? { sql: '', columns: [] };
    for (const select of [
      'toString(c.legal_form_basis) AS o_legal_form_basis',
      'toString(c.onrc_status_basis) AS o_status_basis',
      'toString(c.onrc_status_coverage) AS o_status_coverage',
      'toString(c.onrc_caen_coverage) AS o_caen_coverage',
      'toString(c.county_basis) AS o_county_basis',
      'toString(c.uat_basis) AS o_uat_basis',
      'toString(c.onrc_recorded_year) AS o_recorded_year',
      'c.onrc_recorded_date AS o_recorded_date',
      'toString(c.onrc_recorded_date_basis) AS o_recorded_date_basis',
    ])
      expect(sql).toContain(select);
    expect(sql).not.toMatch(/registration_year|registration_date|territory_match/u);
    // The company table is aliased: the observation filter reads c.onrc_identifiers.
    expect(sql).toContain('arrayExists(i -> hasAny(i.status_codes, {p');
    expect(sql).toContain(', c.onrc_identifiers)');
    expect(columns).toContain('o_recorded_date');
    expect(columns).not.toContain('o_registration_year');
  });

  it('checks both release tables and caches only a positive answer', async () => {
    let present = [{ name: 'company_r7' }];
    const captured: string[] = [];
    const reader: ClickhouseReader = {
      query: (_sql, params) => {
        captured.push(JSON.stringify(params.entries()));
        return Promise.resolve(ok(present as never));
      },
      close: () => undefined,
    };
    let now = 0;
    const engine = makeClickhouseAnalyticsEngine(reader, 'companies_analytics', () => now);
    expect((await engine.tablesAvailable(7))._unsafeUnwrap()).toBe(false);
    present = [{ name: 'company_r7' }, { name: 'company_year_r7' }];
    expect((await engine.tablesAvailable(7))._unsafeUnwrap()).toBe(true);
    expect((await engine.tablesAvailable(7))._unsafeUnwrap()).toBe(true);
    expect(captured).toHaveLength(2);
    expect(captured[0]).toContain("['company_r7','company_year_r7']");
    now = 61_000;
    await engine.tablesAvailable(7);
    expect(captured).toHaveLength(3);
  });
});
