/**
 * Companies analytics — ACTIVITY on a REAL ClickHouse (schema
 * `companies-analytics-ch-v3`). WRITTEN FOR THE PRIMARY'S DISPOSABLE PROOF;
 * skipped in the default runs.
 *
 * Prerequisites (all explicit; nothing is inferred):
 *  - `COMPANIES_ANALYTICS_CH_TEST_URL`: bare http(s) origin of a FRESH,
 *    DISPOSABLE ClickHouse server (`_USER` / `_PASSWORD`, default `default` /
 *    empty). The suite refuses any server that holds a single non-system
 *    table or database, so a live analytics server (it always holds release
 *    tables) is never written to. Never point it at a shared server.
 *  - `COMPANIES_ANALYTICS_CH_TEST_DISPOSABLE=1`: the operator's statement
 *    that the server is disposable.
 *  - `COMPANIES_ANALYTICS_CH_TEST_DDL`: the publisher's EXACT table DDL for
 *    release 9, printed by the scrapper:
 *    `pnpm exec tsx scripts/print-companies-analytics-clickhouse-ddl.ts 9 > ddl.json`.
 *
 * The suite creates `companies_analytics` with those two tables, loads the
 * hand-declared `ACTIVITY_DATASET` (plus one three-digit ANAF company, 1011)
 * as TabSeparated rows, and runs the REAL reader, engine and use cases. Each
 * answer must equal the in-memory engine's (an oracle pinned by hand in
 * `tests/unit/companies/analytics/activity.test.ts`) and the hand-written
 * values below. afterAll drops only the database this run created.
 */

import { readFile } from 'node:fs/promises';

import { fromThrowable } from 'neverthrow';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  COMPANY_ANALYSIS_METRICS,
  METRIC_COLUMN,
  type CompanyAnalysisBucket,
} from '@/modules/companies/core/analytics-types.js';
import {
  companyAnalysisBreakdown,
  companyAnalysisRecords,
  companyAnalysisStats,
  type CompanyAnalysisDeps,
} from '@/modules/companies/core/analytics-usecases.js';
import { makeClickhouseAnalyticsEngine } from '@/modules/companies/shell/analytics/clickhouse-engine.js';
import {
  makeClickhouseReader,
  type ClickhouseReader,
  type CompaniesClickhouseConfig,
} from '@/modules/companies/shell/analytics/clickhouse-reader.js';

import {
  ACTIVITY_DATASET,
  HUGE_TURNOVER,
  activity,
  analyticsDeps,
  company,
  fakeLabels,
  fakeReleases,
  makeInMemoryEngine,
  reported,
  statement,
  v3ReleaseRow,
  type FakeCompany,
  type FakeStatement,
} from '../../unit/companies/analytics/analytics-fixtures.js';

const URL_ENV = process.env['COMPANIES_ANALYTICS_CH_TEST_URL'] ?? '';
const DISPOSABLE = process.env['COMPANIES_ANALYTICS_CH_TEST_DISPOSABLE'] === '1';
const DDL_FILE = process.env['COMPANIES_ANALYTICS_CH_TEST_DDL'] ?? '';
const d = URL_ENV.length > 0 && DISPOSABLE && DDL_FILE.length > 0 ? describe : describe.skip;

const safeJsonParse = fromThrowable(JSON.parse);
const DATABASE = 'companies_analytics';
const RELEASE = 9;

const CATALOG = {
  'rev2:6201': 'Software (rev2)',
  'rev3:6201': 'Software (rev3)',
  'rev2:4711': 'Comerț cu amănuntul',
};

/**
 * The shared dataset plus 1011: a THREE-DIGIT ANAF source token without an
 * ONRC class. Policy v1 admits four digits only, so it is
 * `no_qualified_selection`, never an ANAF code bucket.
 */
const COMPANIES: readonly FakeCompany[] = [
  ...ACTIVITY_DATASET.companies,
  company('1011', {
    caenCoverage: 'complete_empty',
    activity: activity({
      basis: 'no_qualified_selection',
      rev: null,
      code: null,
      classKeys: 0,
      unqualifiedRows: 0,
      form: 'three_digit',
      agreement: 'anaf_not_usable',
      anafDate: '2026-09-30',
    }),
  }),
];
const STATEMENTS: readonly FakeStatement[] = [
  ...ACTIVITY_DATASET.statements,
  statement(2024, '1011', { TURNOVER: reported('0.07') }),
];

// ── TabSeparated encoding of the publisher's column types ───────────────────

const NULL = '\\N';
const tsvEscape = (text: string): string =>
  text.replace(/\\/gu, '\\\\').replace(/\t/gu, '\\t').replace(/\n/gu, '\\n');
const quoted = (text: string): string => `'${text.replace(/\\/gu, '\\\\').replace(/'/gu, "\\'")}'`;
const stringArray = (values: readonly string[]): string => `[${values.map(quoted).join(',')}]`;
const text = (value: string | null): string => (value === null ? NULL : tsvEscape(value));
const flag = (value: boolean | null): string => (value === null ? NULL : String(value));

/** The company keys, copied verbatim into both grains (as the export does). */
const companyFields = (c: FakeCompany): Record<string, string> => {
  const a = c.activity;
  if (a === undefined) throw new Error(`company ${c.cui} has no v3 activity`);
  return {
    cui: c.cui,
    legal_form: c.legalForm,
    legal_form_basis: c.legalFormBasis,
    onrc_status_code: text(c.status),
    onrc_status_basis: c.statusBasis,
    onrc_status_coverage: c.statusCoverage,
    onrc_caen_coverage: c.caenCoverage,
    onrc_recorded_year: c.recordedDate === null ? NULL : String(Number(c.recordedDate.slice(0, 4))),
    onrc_recorded_date_basis: c.recordedDateBasis,
    county_code: text(c.county),
    county_basis: c.countyBasis,
    uat_siruta: text(c.uat),
    uat_basis: c.uatBasis,
    onrc_identifiers: tsvEscape(
      `[${c.identifiers
        .map(
          (i) =>
            `(${quoted(i.key)},${stringArray(i.status)},${stringArray(i.county)},${stringArray(i.caen)},${stringArray(i.keys)})`
        )
        .join(',')}]`
    ),
    anaf_record: 'true',
    anaf_vat_payer: flag(c.vat),
    anaf_inactive: flag(c.inactive),
    anaf_main_caen_code: text(c.caenCode),
    anaf_main_caen_rev: text(c.caenRev),
    anaf_main_caen_basis: c.caenBasis,
    activity_basis: a.basis,
    activity_rev: text(a.rev),
    activity_code: text(a.code),
    onrc_class_key_count: String(a.classKeys),
    onrc_unqualified_row_count: String(a.unqualifiedRows),
    anaf_caen_form: a.form,
    anaf_onrc_agreement: a.agreement,
    anaf_status_date: text(a.anafDate),
  };
};

const companyRow = (c: FakeCompany): Record<string, string> => ({
  ...companyFields(c),
  onrc_recorded_date: text(c.recordedDate),
});

const companyYearRow = (s: FakeStatement, c: FakeCompany): Record<string, string> => {
  const metrics: Record<string, string> = {};
  let reportedCount = 0;
  for (const metric of COMPANY_ANALYSIS_METRICS) {
    const cell = s.cells[metric] ?? { status: 'missing', value: null };
    if (cell.status === 'reported') reportedCount++;
    metrics[METRIC_COLUMN[metric]] = text(cell.value);
    metrics[`${METRIC_COLUMN[metric]}_status`] = cell.status;
  }
  return {
    fiscal_year: String(s.year),
    ...companyFields(c),
    source_system: 'anaf',
    statement_profile_hash: NULL,
    metric_rule_version: 'fixture-rules',
    selected_metric_count: String(reportedCount),
    applicable_metric_count: NULL,
    metric_issue_count: '0',
    employee_size_band: s.band,
    ...metrics,
  };
};

/** Column names in DDL order, read from the publisher's CREATE TABLE text. */
const ddlColumns = (ddl: string): string[] =>
  ddl
    .split('\n')
    .map((line) => /^ {2}([a-z_0-9]+) /u.exec(line)?.[1])
    .filter((name): name is string => name !== undefined);

// ── the disposable server ───────────────────────────────────────────────────

d('companies analytics ACTIVITY on a real ClickHouse (publisher DDL, release 9)', () => {
  const config: CompaniesClickhouseConfig = {
    url: URL_ENV,
    database: DATABASE,
    user: process.env['COMPANIES_ANALYTICS_CH_TEST_USER'] ?? 'default',
    password: process.env['COMPANIES_ANALYTICS_CH_TEST_PASSWORD'] ?? '',
  };
  let reader: ClickhouseReader | undefined;
  let created = false;
  let ddl: { company: string; companyYear: string; releaseNumber: number; schemaVersion: string };

  /** Operator statements (DDL, inserts, guards); never the code under test. */
  const admin = async (query: string, body?: string): Promise<string> => {
    const url = new URL(config.url);
    if (body !== undefined) url.searchParams.set('query', query);
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'X-ClickHouse-User': config.user, 'X-ClickHouse-Key': config.password },
      body: body ?? query,
      redirect: 'error',
    });
    const answer = await response.text();
    if (!response.ok) throw new Error(`ClickHouse refused ${query.slice(0, 80)}: ${answer}`);
    return answer.trim();
  };

  const insert = async (table: string, columns: string[], rows: Record<string, string>[]) => {
    for (const row of rows) expect(Object.keys(row).sort()).toEqual([...columns].sort());
    await admin(
      `INSERT INTO ${DATABASE}.${table} (${columns.join(', ')}) FORMAT TabSeparated`,
      `${rows.map((row) => columns.map((name) => row[name]).join('\t')).join('\n')}\n`
    );
  };

  beforeAll(async () => {
    ddl = safeJsonParse(await readFile(DDL_FILE, 'utf8'))._unsafeUnwrap() as typeof ddl;
    expect(ddl.schemaVersion).toBe('companies-analytics-ch-v3');
    expect(ddl.releaseNumber).toBe(RELEASE);
    // Disposable means EMPTY: not one user table or database anywhere.
    const tables = await admin(
      `SELECT count() FROM system.tables WHERE database NOT IN ('system', 'INFORMATION_SCHEMA', 'information_schema')`
    );
    const databases = await admin(
      `SELECT count() FROM system.databases WHERE name NOT IN ('system', 'default', 'INFORMATION_SCHEMA', 'information_schema')`
    );
    if (tables !== '0' || databases !== '0')
      throw new Error(
        `refusing a ClickHouse server that is not empty (${tables} tables, ${databases} databases)`
      );
    await admin(`CREATE DATABASE ${DATABASE}`);
    created = true;
    await admin(ddl.company);
    await admin(ddl.companyYear);
    const byCui = new Map(COMPANIES.map((c) => [c.cui, c]));
    await insert(`company_r${String(RELEASE)}`, ddlColumns(ddl.company), COMPANIES.map(companyRow));
    await insert(
      `company_year_r${String(RELEASE)}`,
      ddlColumns(ddl.companyYear),
      STATEMENTS.map((s) => companyYearRow(s, byCui.get(s.cui)!))
    );
    reader = makeClickhouseReader(config);
  }, 60_000);

  afterAll(async () => {
    reader?.close();
    if (created) await admin(`DROP DATABASE ${DATABASE} SYNC`);
  }, 60_000);

  const release = v3ReleaseRow(RELEASE, COMPANIES, STATEMENTS);
  const labels = fakeLabels({}, CATALOG);
  const real = (): CompanyAnalysisDeps =>
    analyticsDeps(makeClickhouseAnalyticsEngine(reader!, DATABASE), fakeReleases(release), labels);
  const oracle = (): CompanyAnalysisDeps =>
    analyticsDeps(
      makeInMemoryEngine(COMPANIES, STATEMENTS, [RELEASE]),
      fakeReleases(release),
      labels
    );

  const both = async <T>(
    run: (deps: CompanyAnalysisDeps) => Promise<{ _unsafeUnwrap: () => T }>
  ): Promise<T> => {
    const [onClickhouse, inMemory] = await Promise.all([run(real()), run(oracle())]);
    const value = onClickhouse._unsafeUnwrap();
    expect(value).toEqual(inMemory._unsafeUnwrap());
    return value;
  };

  it('loads the publisher tables with their exact v3 column types', async () => {
    const types = await admin(
      `SELECT name, type FROM system.columns WHERE database = '${DATABASE}' AND table = 'company_r${String(RELEASE)}' AND name IN ('activity_basis', 'activity_rev', 'activity_code', 'anaf_status_date', 'onrc_class_key_count', 'onrc_unqualified_row_count') ORDER BY name FORMAT TabSeparated`
    );
    expect(types.split('\n')).toEqual([
      'activity_basis\tLowCardinality(String)',
      'activity_code\tLowCardinality(Nullable(String))',
      'activity_rev\tLowCardinality(Nullable(String))',
      'anaf_status_date\tNullable(Date32)',
      'onrc_class_key_count\tUInt16',
      'onrc_unqualified_row_count\tUInt32',
    ]);
    const turnover = await admin(
      `SELECT type FROM system.columns WHERE database = '${DATABASE}' AND table = 'company_year_r${String(RELEASE)}' AND name = 'turnover' FORMAT TabSeparated`
    );
    expect(turnover).toBe('Nullable(Decimal(18, 2))');
    expect(
      (
        await makeClickhouseAnalyticsEngine(reader!, DATABASE).tablesAvailable(RELEASE)
      )._unsafeUnwrap()
    ).toBe(true);
  });

  it('groups ONRC keys by exact revision, ANAF codes apart, all six bases, money conserved', async () => {
    const b = await both((deps) =>
      companyAnalysisBreakdown(deps, { dimension: 'ACTIVITY', topN: 100 })
    );
    const byKey = new Map(
      [...b.groups, ...b.unclassified].map((g) => [
        g.key,
        [g.companies, g.filers, g.metric?.sum ?? null, g.activityQuality],
      ])
    );
    const quality = (
      numericMatchSelected: string,
      incompleteCoverage: string,
      withUnqualifiedRows: string,
      anafObservedFrom: string | null,
      anafObservedTo: string | null
    ) => ({
      numericMatchSelected,
      incompleteCoverage,
      withUnqualifiedRows,
      anafObservedFrom,
      anafObservedTo,
    });
    expect(Object.fromEntries(byKey)).toEqual({
      // Same digits in two revisions and in ANAF: three buckets, never one.
      'onrc:rev2:6201': ['2', '2', '300.30', quality('1', '0', '1', '2026-09-01', '2026-09-28')],
      'onrc:rev3:6201': ['1', '1', '300.30', quality('0', '0', '0', '2026-09-28', '2026-09-28')],
      'onrc:rev2:4711': ['2', '2', '1000.00', quality('1', '1', '0', '2026-09-28', '2026-09-28')],
      'anaf:6201': ['1', '1', '400.40', quality('0', '0', '0', '2026-08-15', '2026-08-15')],
      '(onrc_multiple_classes)': [
        '1',
        '1',
        '500.50',
        quality('0', '0', '0', '2026-09-28', '2026-09-28'),
      ],
      '(anaf_fiscal_uncatalogued)': [
        '2',
        '2',
        HUGE_TURNOVER,
        quality('0', '0', '0', '2026-07-01', '2026-09-28'),
      ],
      // 1008 (short, no date) and 1011 (three-digit): never an ANAF bucket.
      '(no_qualified_selection)': [
        '2',
        '1',
        '0.07',
        quality('0', '1', '1', '2026-09-30', '2026-09-30'),
      ],
    });
    expect(b.totals).toMatchObject({ companies: '11', filers: '10' });
    // 2^53 + 1 RON and its bani survive the Decimal128 sum exactly.
    expect(b.totals.metric?.sum).toBe('9007199254743494.64');
    expect(b.totals.activityQuality).toEqual(quality('2', '2', '2', '2026-07-01', '2026-09-30'));
    for (const bucket of [...b.groups, ...b.unclassified])
      if (bucket.activity?.source === 'ANAF') expect(bucket.activity.revision).toBeNull();
    // Ranked: the unclassified buckets are never folded into `other`.
    const ranked = await both((deps) =>
      companyAnalysisBreakdown(deps, { dimension: 'ACTIVITY', topN: 2 })
    );
    expect(ranked.unclassified).toHaveLength(3);
    const parts = [...ranked.groups, ranked.other, ranked.unknown, ...ranked.unclassified];
    const cents = (buckets: readonly CompanyAnalysisBucket[]) =>
      buckets.reduce((acc, g) => {
        const sum = g.metric?.sum ?? null;
        return sum === null ? acc : acc + BigInt(sum.replace('.', ''));
      }, 0n);
    expect(cents(parts)).toBe(900719925474349464n);
  });

  it('reads NULL Nullable(Date32) bounds for an all-NULL group and for an empty scope', async () => {
    // 1008 alone: no fiscal status date at all.
    const undated = await both((deps) =>
      companyAnalysisBreakdown(deps, {
        dimension: 'ACTIVITY',
        scope: { filing: 'NOT_FILED', activityBasis: ['NO_QUALIFIED_SELECTION'] },
      })
    );
    expect(undated.unclassified.map((g) => [g.key, g.companies, g.activityQuality])).toEqual([
      [
        '(no_qualified_selection)',
        '1',
        {
          numericMatchSelected: '0',
          incompleteCoverage: '1',
          withUnqualifiedRows: '1',
          anafObservedFrom: null,
          anafObservedTo: null,
        },
      ],
    ]);
    // A key no company carries: zero rows, NULL bounds, NULL sum.
    const empty = await both((deps) =>
      companyAnalysisBreakdown(deps, {
        dimension: 'ACTIVITY',
        scope: { activity: [{ source: 'ONRC', code: '0111', revision: 'rev0' }] },
      })
    );
    expect(empty.groups).toEqual([]);
    expect(empty.unclassified).toEqual([]);
    expect(empty.totals).toMatchObject({ companies: '0', filers: '0' });
    expect(empty.totals.metric?.sum ?? null).toBeNull();
    expect(empty.totals.activityQuality?.anafObservedFrom ?? null).toBeNull();
    expect(empty.totals.activityQuality?.anafObservedTo ?? null).toBeNull();
    const stats = await both((deps) =>
      companyAnalysisStats(deps, {
        scope: { activity: [{ source: 'ONRC', code: '0111', revision: 'rev0' }] },
      })
    );
    expect([stats.companies, stats.filers, stats.metrics[0]?.sum ?? null]).toEqual([
      '0',
      '0',
      null,
    ]);
  });

  it('drills every bucket by source and exact revision to the same companies, filers and money', async () => {
    const b = await both((deps) =>
      companyAnalysisBreakdown(deps, { dimension: 'ACTIVITY', topN: 100 })
    );
    for (const bucket of [...b.groups, ...b.unclassified]) {
      const a = bucket.activity!;
      const scope =
        a.code === null
          ? { activityBasis: [a.basis!] }
          : {
              activity: [
                a.source === 'ONRC'
                  ? { source: 'ONRC', code: a.code, revision: a.revision! }
                  : { source: 'ANAF', code: a.code },
              ],
            };
      const drilled = await both((deps) => companyAnalysisStats(deps, { scope }));
      expect({
        key: bucket.key,
        at: [drilled.companies, drilled.filers, drilled.metrics[0]?.sum ?? null],
      }).toEqual({
        key: bucket.key,
        at: [bucket.companies, bucket.filers, bucket.metric?.sum ?? null],
      });
    }
  });

  it('filters records by source, exact revision and basis exactly as the oracle', async () => {
    const cuis = async (scope: Record<string, unknown>) =>
      (
        await both((deps) => companyAnalysisRecords(deps, { scope, sort: 'CUI', first: 100 }))
      ).edges.map((e) => e.node.cui);
    expect(await cuis({ activity: [{ source: 'ONRC', code: '6201', revision: 'rev2' }] })).toEqual([
      '1001',
      '1002',
    ]);
    expect(await cuis({ activity: [{ source: 'ONRC', code: '6201', revision: 'rev3' }] })).toEqual([
      '1003',
    ]);
    // The same digits from ANAF match only the ANAF_FISCAL_CODE company.
    expect(await cuis({ activity: [{ source: 'ANAF', code: '6201' }] })).toEqual(['1004']);
    // An uncatalogued code is never an ANAF_FISCAL_CODE selection.
    expect(await cuis({ activity: [{ source: 'ANAF', code: '1234' }] })).toEqual([]);
    expect(await cuis({ activityBasis: ['NO_QUALIFIED_SELECTION'] })).toEqual(['1008', '1011']);
    expect(await cuis({ activityBasis: ['ONRC_CLASS_ANAF_NUMERIC_MATCH'] })).toEqual([
      '1002',
      '1010',
    ]);
    expect(await cuis({ activityBasis: ['ONRC_SINGLE_CLASS'] })).toEqual(['1001', '1003', '1009']);
    expect(await cuis({ activityBasis: ['ONRC_MULTIPLE_CLASSES'] })).toEqual(['1005']);
    expect(await cuis({ activityBasis: ['ANAF_FISCAL_CODE'] })).toEqual(['1004']);
    expect(await cuis({ activityBasis: ['ANAF_FISCAL_UNCATALOGUED'] })).toEqual(['1006', '1007']);
    expect(
      await cuis({
        activityBasis: ['ONRC_SINGLE_CLASS'],
        activity: [{ source: 'ONRC', code: '4711', revision: 'rev2' }],
      })
    ).toEqual(['1009']);
  });

  it('returns every record field, the activity evidence and its dates as the oracle does', async () => {
    const page = await both((deps) =>
      companyAnalysisRecords(deps, { sort: 'CUI', first: 100, metrics: ['TURNOVER'] })
    );
    const byCui = new Map(page.edges.map((e) => [e.node.cui, e.node]));
    expect(byCui.get('1011')).toMatchObject({
      activity: { basis: 'NO_QUALIFIED_SELECTION', source: null, code: null, revision: null },
      anafCaenForm: 'three_digit',
      anafStatusDate: '2026-09-30',
    });
    expect(byCui.get('1008')).toMatchObject({ anafCaenForm: 'short', anafStatusDate: null });
    expect(byCui.get('1004')?.activity).toMatchObject({
      source: 'ANAF',
      revision: null,
      code: '6201',
    });
    // Sorted by the Decimal value, NULLs last, across a page boundary.
    const first = await both((deps) =>
      companyAnalysisRecords(deps, {
        sort: 'METRIC',
        sortMetric: 'TURNOVER',
        direction: 'DESC',
        first: 3,
      })
    );
    expect(first.edges.map((e) => e.node.cui)).toEqual(['1006', '1010', '1005']);
    const next = await both((deps) =>
      companyAnalysisRecords(deps, {
        sort: 'METRIC',
        sortMetric: 'TURNOVER',
        direction: 'DESC',
        first: 100,
        after: first.pageInfo.endCursor,
      })
    );
    expect(next.edges.map((e) => e.node.cui)).toEqual([
      '1004',
      '1003',
      '1002',
      '1001',
      '1011',
      '1007',
      '1008',
      '1009',
    ]);
  });
});
