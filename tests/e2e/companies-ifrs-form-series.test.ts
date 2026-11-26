/**
 * PRIV-ZVPV on a throwaway PostgreSQL 18 with the data repo's REAL DDL: the
 * companies_v2 chain the two IFRS-form views stand on, then the views
 * themselves (scrapper migration 20261125T190000), every file pinned by its
 * SHA-256. Synthetic rows only (CUIs 3001-3008); nothing is read from, or
 * written to, a shared database.
 *
 * Proven against a real server, through the real repo, usecase and GraphQL:
 *  - the IFRS-file years leave as the view's exact text: a blank cell is null,
 *    an explicit zero is 0, a one-leg year has no net result, a loss year a
 *    negative one, decimals and a rounded headcount as stored;
 *  - nothing of a restricted or personal_moderate line, a non-public
 *    selection, a statement without a public line, or a CUI under a
 *    non-public organization is served, in the list or as a mark;
 *  - a CUI without any core organization is served (source observations);
 *  - a typed year is marked only on ANAF's IFRS layout, the typed history,
 *    its latest year and its trajectory never contain an IFRS-file year, and
 *    a trajectory across a change of form is refused;
 *  - every IFRS-file year is also a long-format-only statement;
 *  - with the views dropped the series reads unknown and the typed
 *    statements are still served.
 *
 * The scrapper checkout is `SCRAPPER_REPO_ROOT` or a sibling directory. With
 * no checkout that has the views' migration, or no container runtime, the
 * suite SKIPS, or fails when `TEST_E2E_REQUIRED=1`.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import fastifyLib, { type FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it as vitestIt, vi } from 'vitest';

import { makeGraphQLPlugin } from '@/infra/graphql/index.js';
import { makeCompanyFinancials } from '@/modules/companies/core/usecases.js';
import { makeCompaniesResolvers } from '@/modules/companies/shell/graphql/resolvers.js';
import { companiesTypeDefs } from '@/modules/companies/shell/graphql/typedefs.js';
import { makeCompaniesRepo } from '@/modules/companies/shell/repo/companies-repo.js';
import { baseTypeDefs, mergeGraphqlSlices, scalarResolvers } from '@/modules/shared/index.js';
import { createProdDb, type ProdDb } from '@/modules/shared/shell/db/pool.js';

import { dockerCliUp, teardownDisposablePostgres } from './disposable-postgres.js';
import { UNAVAILABLE_SCOPE } from '../unit/companies/registry-fixtures.js';
import { stubFlows } from '../unit/companies/repo-fixtures.js';

import type { CompaniesRepository } from '@/modules/companies/core/ports.js';
import type { Kysely } from 'kysely';

/** The companies_v2 chain of data main `ecb3671` (2026-11-26), in apply order. */
const MIGRATION_SHA256: Readonly<Record<string, string>> = {
  '20260611T220000__companies_domain.ts':
    '0c84c277726d05d3ed8f0b959cd0c023e86f01b3d7bd3dbcf278223098022f97',
  '20260630T140000__companies_v2_core_privacy.ts':
    '150c579c9fd8cbd0cb4bafad4351c0383772710a36e1d2ef8b453ceacdfa2b40',
  '20260630T140500__companies_v2_schema.ts':
    '39f97d4d7b1b20e43a39bb725154e5a9c94ed43f0bdcc410b984e6f873d5ba44',
  '20260811T160000__companies_v2_financial_source_system.ts':
    'c0e87e8d9a2d3c30a5cff29223d142a3c88e91e10d0902b4d3ed9d19017dc250',
  '20260812T161000__financial_statement_profiles_immutable_core.ts':
    '8dc2e4fa5aa3e0cd73314c45f8d6daaefcaf7574f8aa4784b5683dc37984f245',
  '20260812T162000__financial_source_selection_tables.ts':
    'd35146325dc3d183b51c5650aa14322600c4834bfc701a6543f6700f8b4020b1',
  '20260812T163000__companies_v2_source_system_drop_default.ts':
    '698b7acdab5e579ed00f00a7871fad032a01f8b2d92986e27b47ecdef2df78e4',
  '20260815T090000__fi_year_floor_not_valid.ts':
    '20306801804c1c2813eda1f24cbf9d15b90cce3c0f2c2725358ebc0f336035e9',
  '20260815T091000__fi_year_floor_validate.ts':
    'a6e6e6fc45eec6e6b5a4ec6398776b5e4e33a07284979bd44ba8b9bb6428bfb3',
  '20260815T092000__fi_partition_convert.ts':
    '1c5b978081ae4ca44985983d3c6c8d1b6418b89b9b8ff7a34b72954b43ed3d56',
  '20260816T110000__financial_source_selection_cross_copy_union.ts':
    '4f565dcac7a50d93acb1f6df4b7bbf042b163cab8a8abe5a3bd5fd8371fc4d8b',
  '20260818T160000__financials_source_url_nullable.ts':
    '5457a075f666609116c2319dd2ff59292c8525a90ab20385fdcbb97076501f80',
  '20260819T090000__financials_applicable_metric_count.ts':
    'bb7bbf04939d98e99b36f4d27803d3c0324af2d4ee9b2eb8e4dfb0dba491ffd8',
  '20260825T180000__companies_v2_source_snapshots.ts':
    'f0b9b05791db8631df29f75250b3fecdacd766e698a039a8845d7a2f2cfe32f7',
  '20261125T190000__companies_ifrs_form_series.ts':
    '371af2af9283a916f096d77020374a6dc5c0f2690f63a0bd3fd526dd2aed0e55',
};
const VIEWS_MIGRATION = '20261125T190000__companies_ifrs_form_series.ts';

/**
 * The one piece of production state the chain does not carry (the data repo's
 * `src/db/apply-prod-chain.ts`): two CHECKs added NOT VALID were validated by
 * hand in production before the partition conversion, which refuses a child
 * whose CHECK is still NOT VALID. A fresh database validates them at the same
 * point.
 */
const VALIDATE_AFTER = '20260815T091000__fi_year_floor_validate.ts';
const PROD_VALIDATED_CONSTRAINTS = [
  'financial_indicators_source_system_check',
  'financial_indicators_source_year_fence_check',
] as const;

const IFRS_FILE_LAYOUT = 'b1'.repeat(32);
const ORDINARY_LAYOUT = 'a0'.repeat(32);
const ANAF_IFRS_LAYOUT = '464d1c40cac85eca14212758a48a73c3ba5b272d6fdc76e7943a6a8febbabd58';
const RULE_VERSION = 'anaf-bilant-metric-v1';
const SHA = 'c3'.repeat(32);
const CODES = { turnover: 'I13', net_profit: 'I18', net_loss: 'I19', employees: 'I20' } as const;
type Metric = keyof typeof CODES;

const snapshotOf = (year: number): string =>
  `mfp:fixture_package:${String(year)}:res-${String(year)}`;
const urlOf = (year: number): string =>
  `https://data.gov.ro/fixture/res-${String(year)}/web_ir_an${String(year)}.txt`;

interface IfrsStatement {
  readonly cui: string;
  readonly year: number;
  /** The statement's line in its year's file. */
  readonly line: number;
  /** Absent or null = a blank source cell: no indicator row. */
  readonly cells: Partial<Record<Metric, string | null>>;
  readonly indicatorPrivacy?: Partial<Record<Metric, 'personal_moderate' | 'restricted'>>;
  readonly selectionPrivacy?: 'personal_moderate' | 'restricted';
  readonly deleted?: boolean;
}

const STATEMENTS: readonly IfrsStatement[] = [
  // 3001: a public company with a full IFRS-file history.
  {
    cui: '3001',
    year: 2017,
    line: 41,
    cells: { turnover: '14764836448', net_profit: '2399947986', net_loss: '0', employees: '13322' },
  },
  // Blank turnover and profit, an explicit zero headcount: a one-leg year.
  {
    cui: '3001',
    year: 2016,
    line: 42,
    cells: { turnover: null, net_profit: null, net_loss: '5000', employees: '0' },
  },
  // A loss year: zero profit as filed, a negative net result.
  {
    cui: '3001',
    year: 2015,
    line: 43,
    cells: { turnover: '13687616179', net_profit: '0', net_loss: '630646624', employees: '15581' },
  },
  // Stored decimals stay; a fractional headcount is whole people.
  {
    cui: '3001',
    year: 2014,
    line: 44,
    cells: { turnover: '100.50', net_profit: '10', net_loss: '0', employees: '12.5' },
  },
  // A deleted selection is no statement.
  { cui: '3001', year: 2018, line: 45, cells: { turnover: '1' }, deleted: true },
  // 3002: one personal_moderate line makes the company-year personal_moderate.
  {
    cui: '3002',
    year: 2015,
    line: 46,
    cells: { turnover: '7', net_profit: '1', net_loss: '0', employees: '2' },
    indicatorPrivacy: { employees: 'personal_moderate' },
  },
  // 3003: one restricted line makes it restricted.
  {
    cui: '3003',
    year: 2015,
    line: 47,
    cells: { turnover: '8', net_profit: '1', net_loss: '0', employees: '3' },
    indicatorPrivacy: { turnover: 'restricted' },
  },
  // 3004: public lines under a NON-PUBLIC core organization.
  {
    cui: '3004',
    year: 2015,
    line: 48,
    cells: { turnover: '9', net_profit: '1', net_loss: '0', employees: '4' },
  },
  // 3005: public lines, no core organization at all.
  {
    cui: '3005',
    year: 2015,
    line: 49,
    cells: { turnover: '10', net_profit: '2', net_loss: '0', employees: '5' },
  },
  // 3007: public lines under a personal_moderate selection row.
  {
    cui: '3007',
    year: 2015,
    line: 50,
    cells: { turnover: '11', net_profit: '2', net_loss: '0', employees: '6' },
    selectionPrivacy: 'personal_moderate',
  },
  // 3008: a public selection with no retained line: nothing witnesses it.
  { cui: '3008', year: 2015, line: 51, cells: {} },
];

/** Typed statements: [cui, year, layout, net profit, net loss]. */
const TYPED: readonly (readonly [string, number, string, string | null, string | null])[] = [
  ['3001', 2010, ORDINARY_LAYOUT, '5', '0'],
  ['3001', 2011, ORDINARY_LAYOUT, '6', '0'],
  // Profit only: the stored generated net_result reads 10, a guess the API never serves.
  ['3001', 2019, ANAF_IFRS_LAYOUT, '10', null],
  ['3001', 2020, ANAF_IFRS_LAYOUT, '12', '0'],
  ['3004', 2019, ANAF_IFRS_LAYOUT, '1', '0'],
  ['3006', 2019, ANAF_IFRS_LAYOUT, '1', '0'],
  ['3006', 2020, ANAF_IFRS_LAYOUT, '1', '0'],
  ['3006', 2021, ORDINARY_LAYOUT, '1', '0'],
];

let container: StartedPostgreSqlContainer | undefined;
let admin: pg.Client | undefined;
let prod: ProdDb | undefined;
let app: FastifyInstance | undefined;
let repo: CompaniesRepository | undefined;
let scrapperRoot: string | undefined;
let ready = false;

const unavailable = (reason: string): void => {
  if (process.env['TEST_E2E_REQUIRED'] === '1') {
    throw new Error(`IFRS-form series e2e required but unavailable: ${reason}`);
  }
  console.warn(`IFRS-form series e2e skipped: ${reason}`);
};

const it = (name: string, test: () => Promise<void>): void => {
  vitestIt(name, async ({ skip }) => {
    if (!ready) skip();
    await test();
  });
};

/** A checkout that has the views' migration: an older one is not usable here. */
const resolveScrapperRoot = (): string | undefined => {
  const explicit = process.env['SCRAPPER_REPO_ROOT'];
  const candidates = [
    ...(explicit !== undefined && explicit !== '' ? [explicit] : []),
    path.resolve(process.cwd(), '..', 'hack-for-facts-eb-scrapper'),
    path.resolve(process.cwd(), '..', '..', '..', '..', 'hack-for-facts-eb-scrapper'),
  ];
  return candidates.find((c) =>
    fs.existsSync(path.join(c, 'src', 'db', 'prod-migrations', VIEWS_MIGRATION))
  );
};

const migrationPath = (root: string, file: string): string =>
  path.join(root, 'src', 'db', 'prod-migrations', file);

const loadMigration = async (
  root: string,
  file: string
): Promise<Record<'up' | 'down', (db: Kysely<unknown>) => Promise<void>>> =>
  (await import(pathToFileURL(migrationPath(root, file)).href)) as Record<
    'up' | 'down',
    (db: Kysely<unknown>) => Promise<void>
  >;

const insertRow = async (
  client: pg.Client,
  table: string,
  values: Record<string, unknown>
): Promise<void> => {
  const names = Object.keys(values);
  await client.query(
    `insert into ${table} (${names.join(', ')}) values (${names.map((_, i) => `$${String(i + 1)}`).join(', ')})`,
    names.map((key) => {
      const value = values[key];
      // Objects and arrays of objects are jsonb; arrays of text stay arrays.
      const json =
        value !== null &&
        typeof value === 'object' &&
        (!Array.isArray(value) || value.some((item) => typeof item === 'object'));
      return json ? JSON.stringify(value) : value;
    })
  );
};

const seed = async (client: pg.Client): Promise<void> => {
  await client.query(`
    create table companies_v2.financial_indicators_2008_2018
      partition of companies_v2.financial_indicators
      for values from (minvalue) to (2019)`);
  for (const hash of [IFRS_FILE_LAYOUT, ORDINARY_LAYOUT, ANAF_IFRS_LAYOUT]) {
    await insertRow(client, 'companies_v2.financial_statement_profiles', {
      code_name_signature: { fixture: hash.slice(0, 8) },
      indicator_count: 20,
      statement_profile_hash: hash,
    });
  }
  for (const [metric, code] of Object.entries(CODES)) {
    await insertRow(client, 'companies_v2.financial_metric_rules', {
      active: true,
      indicator_code: code,
      metric_name: metric,
      normalized_indicator_name: metric.toUpperCase(),
      rule_version: RULE_VERSION,
      statement_profile_hash: IFRS_FILE_LAYOUT,
    });
  }
  for (const year of [2014, 2015, 2016, 2017, 2018]) {
    await insertRow(client, 'companies_v2.financial_source_resources', {
      captured_source_url: urlOf(year),
      source_snapshot_id: snapshotOf(year),
      source_system: 'mfp',
      url_mode: 'fixed_resource_url',
    });
  }
  for (const [cui, name, privacy] of [
    ['3001', 'IFRS FIXTURE SA', 'public'],
    ['3004', 'WITHHELD FIXTURE SA', 'restricted'],
    ['3006', 'ANAF LAYOUT FIXTURE SA', 'public'],
  ] as const) {
    await insertRow(client, 'core.organizations', {
      cui,
      first_seen_source: 'fixture',
      kind: 'company',
      name,
      privacy_class: privacy,
    });
  }
  for (const statement of STATEMENTS) {
    const locator = `mfp:res-${String(statement.year)}:${String(statement.line)}`;
    await insertRow(client, 'companies_v2.financial_source_selection', {
      candidate_count: 1,
      candidates: [{ source_system: 'mfp', statement_locator: locator }],
      cui: statement.cui,
      deleted_at: statement.deleted === true ? '2026-09-01T00:00:00Z' : null,
      equivalent_statement_locators: [locator],
      fiscal_year: statement.year,
      policy_version: 'mfp-selection-v1',
      privacy_class: statement.selectionPrivacy ?? 'public',
      reporting_basis: 'ifrs',
      selected_statement_locator: locator,
      selection_basis: 'sole_candidate',
      selection_evidence: { filer_class: 'ir' },
      selection_status: 'selected_long_only',
      source_capture_digest: SHA,
      source_locator_kind: 'mfp_resource_row',
      source_snapshot_id: snapshotOf(statement.year),
      source_system: 'mfp',
      statement_profile_hash: IFRS_FILE_LAYOUT,
    });
    for (const [metric, value] of Object.entries(statement.cells) as [Metric, string | null][]) {
      if (value === null) continue;
      await insertRow(client, 'companies_v2.financial_indicators', {
        currency: 'RON',
        cui: statement.cui,
        indicator_code: CODES[metric],
        indicator_name: CODES[metric],
        normalized_indicator_name: CODES[metric],
        privacy_class: statement.indicatorPrivacy?.[metric] ?? 'public',
        raw_row_sha256: SHA,
        request_key: `${statement.cui}:${String(statement.year)}`,
        retrieved_at: '2026-08-17T00:00:00Z',
        source_row_number: statement.line,
        source_snapshot_id: snapshotOf(statement.year),
        source_system: 'mfp',
        source_url: urlOf(statement.year),
        statement_profile_hash: IFRS_FILE_LAYOUT,
        value_numeric: value,
        year: statement.year,
      });
    }
  }
  for (const [cui, year, layout, netProfit, netLoss] of TYPED) {
    const anaf = year >= 2019;
    await insertRow(client, 'companies_v2.financials', {
      cui,
      employees: String(year - 2000),
      metric_rule_version: RULE_VERSION,
      net_loss: netLoss,
      net_profit: netProfit,
      raw_row_sha256: SHA,
      selected_metric_count: 1,
      source_snapshot_id: anaf
        ? `anaf:bilant:${String(year)}`
        : `mfp:fixture_package:${String(year)}:typed`,
      source_system: anaf ? 'anaf' : 'mfp',
      source_url: anaf ? `https://webservicesp.anaf.ro/bilant?an=${String(year)}&cui=${cui}` : null,
      statement_profile_hash: layout,
      turnover: String(year * 10),
      year,
    });
  }
};

beforeAll(async () => {
  scrapperRoot = resolveScrapperRoot();
  if (scrapperRoot === undefined) {
    unavailable(`no scrapper checkout with ${VIEWS_MIGRATION} (SCRAPPER_REPO_ROOT)`);
    return;
  }
  if (!dockerCliUp()) {
    unavailable('no container runtime');
    return;
  }
  for (const [file, digest] of Object.entries(MIGRATION_SHA256)) {
    const actual = createHash('sha256')
      .update(fs.readFileSync(migrationPath(scrapperRoot, file)))
      .digest('hex');
    expect(actual, `${file} changed in the scrapper checkout`).toBe(digest);
  }
  container = await new PostgreSqlContainer('postgres:18-alpine')
    .withDatabase('companies_ifrs_form')
    .start();
  const connectionString = container.getConnectionUri();
  admin = new pg.Client({ connectionString });
  await admin.connect();
  // The kernel pool: numeric and bigint come back as wire strings, as in production.
  prod = createProdDb({ connectionString, max: 4, jit: 'off' });
  for (const file of Object.keys(MIGRATION_SHA256)) {
    const migration = await loadMigration(scrapperRoot, file);
    await prod.db.transaction().execute((trx) => migration.up(trx as unknown as Kysely<unknown>));
    if (file === VALIDATE_AFTER) {
      for (const constraint of PROD_VALIDATED_CONSTRAINTS) {
        await admin.query(
          `alter table companies_v2.financial_indicators validate constraint ${constraint}`
        );
      }
    }
  }
  await seed(admin);

  repo = makeCompaniesRepo(prod.db);
  const { typeDefs } = mergeGraphqlSlices(baseTypeDefs, [
    { source: 'companies', typeDefs: companiesTypeDefs },
  ]);
  app = fastifyLib({ logger: false });
  await app.register(
    makeGraphQLPlugin({
      schema: [typeDefs],
      resolvers: [{ ...scalarResolvers, ...makeCompaniesResolvers(deps(repo)) }],
      isProduction: false,
      enableGraphiQL: false,
    })
  );
  await app.ready();
  ready = true;
  // Longer than Testcontainers' own 120 s readiness limit.
}, 180_000);

afterAll(async () => {
  await teardownDisposablePostgres(
    container,
    () => app?.close(),
    () => prod?.pool.end(),
    () => admin?.end()
  );
});

const deps = (companies: CompaniesRepository) => ({
  repo: companies,
  flowsRepo: stubFlows(),
  meili: null,
  registry: { register: () => undefined, list: () => [], get: () => undefined },
  hubStats: { get: vi.fn() },
});

const r = (): CompaniesRepository => {
  if (repo === undefined) throw new Error('repo not ready');
  return repo;
};

const seriesOf = async (cui: string) => (await r().getIfrsFormSeries(cui))._unsafeUnwrap();

const financialsOf = async (cui: string) =>
  (await makeCompanyFinancials(deps(r()), cui))._unsafeUnwrap();

const gql = async (
  query: string
): Promise<{ data?: Record<string, unknown>; errors?: unknown }> => {
  if (app === undefined) throw new Error('app not ready');
  const res = await app.inject({
    method: 'POST',
    url: '/graphql',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ query }),
  });
  return res.json<{ data?: Record<string, unknown>; errors?: unknown }>();
};

const ifrsYear = (year: number, line: number, figures: Record<string, string | null>) => ({
  year,
  sourceSystem: 'mfp',
  reportingForm: 'IFRS',
  formEvidence: 'mfp_filer_class_ir',
  ...figures,
  sourceUrl: urlOf(year),
  sourceSnapshotId: snapshotOf(year),
  sourceRowNumber: String(line),
  statementProfileHash: IFRS_FILE_LAYOUT,
  metricRuleVersion: RULE_VERSION,
});

describe('the IFRS-form series over the real views', () => {
  it('GraphQL serves the IFRS-file years as the view states them, newest first', async () => {
    const body = await gql(`query { companyFinancials(cui: "3001") { ifrsFormYears {
      year sourceSystem reportingForm formEvidence turnover netProfit netLoss netResult employees
      sourceUrl sourceSnapshotId sourceRowNumber statementProfileHash metricRuleVersion
    } } }`);
    expect(body.errors).toBeUndefined();
    expect(body.data?.['companyFinancials']).toEqual({
      ifrsFormYears: [
        ifrsYear(2017, 41, {
          turnover: '14764836448',
          netProfit: '2399947986',
          netLoss: '0',
          netResult: '2399947986',
          employees: '13322',
        }),
        // Blank cells are null, the zero headcount is 0, one leg gives no net result.
        ifrsYear(2016, 42, {
          turnover: null,
          netProfit: null,
          netLoss: '5000',
          netResult: null,
          employees: '0',
        }),
        ifrsYear(2015, 43, {
          turnover: '13687616179',
          netProfit: '0',
          netLoss: '630646624',
          netResult: '-630646624',
          employees: '15581',
        }),
        ifrsYear(2014, 44, {
          turnover: '100.50',
          netProfit: '10',
          netLoss: '0',
          netResult: '10',
          employees: '13',
        }),
      ],
    });
  });

  it('serves nothing of a non-public line, selection or parent, and nothing unwitnessed', async () => {
    for (const cui of ['3002', '3003', '3004', '3007']) {
      expect(await seriesOf(cui), `CUI ${cui}`).toEqual({ years: [], marks: [] });
    }
    // 3008: a public selection without a retained public line is not served as a year.
    expect((await seriesOf('3008'))?.years).toEqual([]);
    // The non-public parent also withholds the typed statement it would have marked.
    expect(await financialsOf('3004')).toBeNull();
    // Each of these rows does exist in the view: it is the server's gates that withhold them.
    const inView = await admin?.query<{ cui: string; privacy_class: string }>(
      `select cui, privacy_class from companies_v2.ifrs_form_financials
        where cui in ('3002','3003','3004','3007','3008') order by cui`
    );
    expect(inView?.rows).toEqual([
      { cui: '3002', privacy_class: 'personal_moderate' },
      { cui: '3003', privacy_class: 'restricted' },
      { cui: '3004', privacy_class: 'public' },
      { cui: '3007', privacy_class: 'personal_moderate' },
      { cui: '3008', privacy_class: 'public' },
    ]);
  });

  it('serves a CUI without any core organization (source observations by CUI)', async () => {
    const series = await seriesOf('3005');
    expect(series?.years).toHaveLength(1);
    expect(series?.years[0]).toMatchObject({ year: 2015, turnover: '10', netResult: '2' });
  });

  it('keeps the IFRS-file years out of the typed history, its latest year and its trajectory', async () => {
    const f = await financialsOf('3001');
    expect(f?.years.map((y) => [y.year, y.sourceSystem, y.reportingForm, y.formEvidence])).toEqual([
      [2020, 'anaf', 'ifrs', 'anaf_statement_layout'],
      [2019, 'anaf', 'ifrs', 'anaf_statement_layout'],
      [2011, 'mfp', null, null],
      [2010, 'mfp', null, null],
    ]);
    expect(f?.latest?.year).toBe(2020);
    expect(f?.trajectory).toMatchObject({ fromYear: 2019, toYear: 2020 });
    expect(f?.ifrsFormYears?.map((y) => y.year)).toEqual([2017, 2016, 2015, 2014]);
    // Every IFRS-file year is also a long-format-only statement, the deleted one neither.
    expect(f?.longFormOnly?.map((s) => s.year)).toEqual([2017, 2016, 2015, 2014]);
    // FY2019 filed a profit and no loss: the stored net_result (10) is never served.
    const fy2019 = f?.years.find((y) => y.year === 2019);
    expect(fy2019).toMatchObject({ netProfit: '10', netLoss: null });
    expect(fy2019?.qualification.netResult).toBeNull();
    expect(JSON.stringify(fy2019)).not.toMatch(/net_result|"netResult":"/u);
  });

  it('marks a typed year only on the IFRS layout and refuses a trajectory across the change', async () => {
    const f = await financialsOf('3006');
    expect(f?.years.map((y) => [y.year, y.reportingForm])).toEqual([
      [2021, null],
      [2020, 'ifrs'],
      [2019, 'ifrs'],
    ]);
    expect(f?.ifrsFormYears).toEqual([]);
    expect(f?.trajectory).toEqual({
      fromYear: 2020,
      toYear: 2021,
      turnoverDelta: null,
      netResultDelta: null,
      employeesDelta: null,
      turnoverDeltaReason: 'reporting_form_changed',
      netResultDeltaReason: 'reporting_form_changed',
      employeesDeltaReason: 'reporting_form_changed',
    });
  });

  it('GraphQL serves the marks in its own case on the typed years', async () => {
    const body = await gql(
      `query { companyFinancials(cui: "3006") { years { year reportingForm formEvidence } latest { reportingForm } } }`
    );
    expect(body.errors).toBeUndefined();
    expect(body.data?.['companyFinancials']).toEqual({
      years: [
        { year: 2021, reportingForm: null, formEvidence: null },
        { year: 2020, reportingForm: 'IFRS', formEvidence: 'anaf_statement_layout' },
        { year: 2019, reportingForm: 'IFRS', formEvidence: 'anaf_statement_layout' },
      ],
      latest: { reportingForm: null },
    });
  });

  it('the company profile marks its own typed years from the same view', async () => {
    const profile = (await r().getProfileData('3006', UNAVAILABLE_SCOPE))._unsafeUnwrap();
    expect(profile?.financials.map((y) => [y.year, y.reportingForm])).toEqual([
      [2021, null],
      [2020, 'ifrs'],
      [2019, 'ifrs'],
    ]);
  });

  it('with the views dropped the series is unknown and the typed statements are still served', async () => {
    if (prod === undefined || scrapperRoot === undefined) throw new Error('fixture not ready');
    const views = await loadMigration(scrapperRoot, VIEWS_MIGRATION);
    await prod.db.transaction().execute((trx) => views.down(trx as unknown as Kysely<unknown>));
    try {
      // A repo that starts on a database without the views.
      const before = makeCompaniesRepo(prod.db);
      expect((await before.getIfrsFormSeries('3001'))._unsafeUnwrap()).toBeNull();
      const f = (await makeCompanyFinancials(deps(before), '3001'))._unsafeUnwrap();
      expect(f?.ifrsFormYears).toBeNull();
      expect(f?.years.map((y) => [y.year, y.reportingForm])).toEqual([
        [2020, null],
        [2019, null],
        [2011, null],
        [2010, null],
      ]);
      expect(f?.longFormOnly).toHaveLength(4);
      // The repo that had probed them: the loss is found by the read, not an error.
      expect((await r().getIfrsFormSeries('3001'))._unsafeUnwrap()).toBeNull();
      const profile = (await r().getProfileData('3006', UNAVAILABLE_SCOPE))._unsafeUnwrap();
      expect(profile?.financials.map((y) => y.reportingForm)).toEqual([null, null, null]);
    } finally {
      await prod.db.transaction().execute((trx) => views.up(trx as unknown as Kysely<unknown>));
    }
  });
});
