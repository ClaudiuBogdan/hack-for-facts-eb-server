/**
 * E2E — the legacy `executionAnalytics` root on the kernel over the REAL
 * scrapper DDL (PostgreSQL 18), docs/server-redesign/13 §4 row 1.
 *
 * Schema: the scrapper's own prod migrations are imported by absolute path and
 * applied in order — `core_reference` (core.territories / core.public_entities),
 * `budget_facts` (the partitioned facts + dimensions), `budget_summary_mvs`
 * (WITH NO DATA), `budget_funding_source_compat` (the phoenix-ordinal view).
 * `entity_geography` is NOT applied (it also alters companies_v2.* which is not
 * part of this slice); it only adds audit columns this slice never reads.
 *
 * Connection: `E2E_BUDGET_PG_URL` (an external throwaway Postgres — e.g. a
 * `pgvector/pgvector:pg18` container on a Docker host reached through an SSH
 * tunnel), else a local testcontainer. Scrapper checkout: `SCRAPPER_REPO_ROOT`,
 * else the sibling checkout (`../hack-for-facts-eb-scrapper` from the repo or
 * its worktree), whose four imported prod migrations MUST match the content
 * hashes in `MIGRATION_SHA256` (a drift fails the suite: the schema this
 * suite proves against is pinned, not whatever the sibling happens to hold).
 *
 * Skip vs fail (codex 2026-09-02 finding 7): with neither a database nor a
 * checkout the suite SKIPS locally — but under `CI` or `TEST_E2E_REQUIRED=1`
 * every missing prerequisite is a FAILURE, so a gate can never stay green
 * without having run.
 *
 * Gates that reach OUTSIDE the implementation: every filter family is asserted
 * against an INDEPENDENT hand-written SQL over the same seed (computed by this
 * test, not by the repo), the normalized numbers against a decimal.js hand
 * computation, and EXPLAIN proves partition pruning to the expected leaves.
 */

import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Decimal } from 'decimal.js';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { ok } from 'neverthrow';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it as vitestIt } from 'vitest';

import { cleanFilter } from '@/modules/budget/core/legacy-analytics/clean.js';
import { legacyDecimal } from '@/modules/budget/core/legacy-analytics/decimal.js';
import { legacyExecutionSeries } from '@/modules/budget/core/legacy-analytics/usecase.js';
import { chainLinkCpiLevels } from '@/modules/budget/shell/factors/cpi-level.js';
import { makeFundingSourceMap } from '@/modules/budget/shell/repo/funding-source-map.js';
import {
  makeLegacyAnalyticsRepo,
  legacyAggregateSql,
} from '@/modules/budget/shell/repo/legacy-analytics-repo.js';
import { makeLegacyPopulationRepo } from '@/modules/budget/shell/repo/legacy-population-repo.js';
import { makeTerritoryQueryRepo } from '@/modules/reference/shell/repo/territory-query-repo.js';
import { makeIdentityRepo } from '@/modules/shared/shell/repo/identity-repo.js';
import { makeTerritoryRepo } from '@/modules/shared/shell/repo/territory-repo.js';

import type { FactorKind, FactorSource } from '@/modules/budget/core/legacy-analytics/ports.js';
import type { LegacyAnalyticsFilter } from '@/modules/budget/core/legacy-analytics/types.js';
import type { ProdDatabase } from '@/modules/shared/index.js';

// ── environment ───────────────────────────────────────────────────────────────

const dockerCliUp = (): boolean => {
  try {
    execSync('docker info', { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
};

const resolveScrapperRoot = (): string | undefined => {
  const explicit = process.env['SCRAPPER_REPO_ROOT'];
  const candidates = [
    ...(explicit !== undefined && explicit !== '' ? [explicit] : []),
    path.resolve(process.cwd(), '..', 'hack-for-facts-eb-scrapper'),
    path.resolve(process.cwd(), '..', '..', '..', '..', 'hack-for-facts-eb-scrapper'),
  ];
  return candidates.find((c) => fs.existsSync(path.join(c, 'src', 'db', 'prod-migrations')));
};

/**
 * The five scrapper prod migrations this suite imports, pinned by the sha256 of
 * their CONTENT (sibling `main` @ 82b88cd7, 2026-09-02). A content pin detects a
 * changed migration under the same filename and is indifferent to unrelated
 * later migrations (the lexically-latest "head" pin did the opposite). Bump a
 * hash deliberately — after re-reading the changed migration for anything
 * touching `core.territories`, `core.public_entities`,
 * `budget.execution_line_items` or the compat view — never because the
 * assertion went red.
 */
const MIGRATION_SHA256: Readonly<Record<string, string>> = {
  // S1 reads the additive native anchor and level fields; verified 2026-09-05.

  '20260612T110000__core_reference.ts':
    'fe5b584b1f98d2eeb7e549b854b9b5268e7a90f16c914cb090cb8dab5976aef4',
  '20260612T110200__budget_facts.ts':
    '05cefa428b161119b41723205ed877fd6d03b85ea3fd57c3c0913da3adde5406',
  '20260612T110400__budget_summary_mvs.ts':
    'cbfecd2b626597cc65c83a8bbcf0f1bdf233551cd4ab20f4fc5da511b6ad1373',
  '20260709T170000__budget_funding_source_compat.ts':
    '0a8f6c0c85543f4ac4651b18a8951615ffdaea02e960472fc3b1d6f717e7602d',
  '20260902T100000__core_territory_hierarchy.ts':
    '504717852207bab89c352ce9326c900c25263eed8d823aafb53e3200d2c062a7',
};
const MIGRATIONS = Object.keys(MIGRATION_SHA256);

/** Under CI / TEST_E2E_REQUIRED=1 a missing prerequisite FAILS instead of skipping. */
const REQUIRED =
  (process.env['CI'] !== undefined && process.env['CI'] !== '' && process.env['CI'] !== 'false') ||
  process.env['TEST_E2E_REQUIRED'] === '1';

let container: StartedPostgreSqlContainer | undefined;
let pgClient: pg.Client | undefined;
let db: Kysely<ProdDatabase> | undefined;
let ready = false;
let unavailableReason: string | undefined;

const unavailable = (reason: string): void => {
  unavailableReason = reason;
  if (REQUIRED) {
    throw new Error(
      `legacy analytics e2e is REQUIRED (CI / TEST_E2E_REQUIRED=1) but cannot run: ${reason}`
    );
  }
  console.warn(`${reason} — legacy analytics e2e SKIPPED.`);
};

const it = (name: string, test: () => unknown): void => {
  vitestIt(name, async ({ skip }) => {
    if (!ready) {
      if (REQUIRED) {
        throw new Error(
          `legacy analytics e2e did not run (${unavailableReason ?? 'setup failed'}) and is REQUIRED`
        );
      }
      skip();
    }
    await test();
  });
};

const resolveConnection = async (): Promise<string | undefined> => {
  const external = process.env['E2E_BUDGET_PG_URL'];
  if (external !== undefined && external !== '') return external;
  if (!dockerCliUp()) {
    unavailable('Docker CLI unavailable and no E2E_BUDGET_PG_URL');
    return undefined;
  }
  try {
    container = await new PostgreSqlContainer('pgvector/pgvector:pg18').start();
    return container.getConnectionUri();
  } catch (error) {
    unavailable(
      `Testcontainers runtime unavailable: ${error instanceof Error ? error.message : String(error)}`
    );
    return undefined;
  }
};

/** Every imported migration must match its pinned content hash (fail on drift). */
const assertScrapperMigrations = (scrapperRoot: string): void => {
  const dir = path.join(scrapperRoot, 'src', 'db', 'prod-migrations');
  for (const [file, expected] of Object.entries(MIGRATION_SHA256)) {
    const actual = createHash('sha256')
      .update(fs.readFileSync(path.join(dir, file)))
      .digest('hex');
    if (actual !== expected) {
      throw new Error(
        `scrapper migration content drift: ${file} sha256 ${actual} != pinned ${expected} in ${dir} — re-validate this suite against the changed migration and bump the pin`
      );
    }
  }
};

// ── the seed world ────────────────────────────────────────────────────────────
//
// 2 counties (CJ, IS) each with a county-level territory row + one UAT, plus
// Bucharest: the municipality row 179132 and its six sectors (the Chronos
// populations — the sectors sum to exactly the municipality);
// fact entities: E1 (UAT hall in CJ), E2 (school in IS), E3 (no territory);
// denominator-only entities (no facts): the CJ county council on the county
// row, a UAT hall for the municipality and for every sector;
// years 2023 + 2024; vn + ch; two report types (rt1 detailed, rt2 principal)
// plus ONE row of an unexpected report type (lands in the year's `_default`
// leaf); monthly rows m1..m3 (Q1) + m12 (Q4, yearly); a program code; a 51.01
// transfer.

const RT1 = 'Executie bugetara detaliata';
const RT2 = 'Executie bugetara agregata la nivel de ordonator principal';
const RT_UNEXPECTED = 'Executie bugetara de tip nou';

/** Chronos 2026-09-02: Bucharest municipality + sectors (`core.territories`). */
const BUCHAREST_ROWS = [
  ['179132', 'MUNICIPIUL BUCUREȘTI', 1716983],
  ['179141', 'SECTORUL 1', 224764],
  ['179150', 'SECTORUL 2', 290507],
  ['179169', 'SECTORUL 3', 373566],
  ['179178', 'SECTORUL 4', 262780],
  ['179187', 'SECTORUL 5', 239607],
  ['179196', 'SECTORUL 6', 325759],
] as const;
const SECTORS_POPULATION = BUCHAREST_ROWS.slice(1).reduce((acc, r) => acc + r[2], 0);

interface SeedRow {
  entity: string;
  creditor: string | null;
  year: number;
  month: number;
  rt: string;
  cat: 'vn' | 'ch';
  functional: string;
  economic: string | null;
  program: string | null;
  fundingCode: 'A' | 'B' | 'D';
  sector: number;
  expense: 'dezvoltare' | 'functionare' | null;
  amount: number; // monthly amount, integer RON
}

const seedRows: SeedRow[] = [];
let nextAmount = 3;
const primes = [
  3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 53, 59, 61, 67, 71, 73, 79, 83, 89, 97,
];
let primeIx = 0;
const amount = (): number => {
  nextAmount = primes[primeIx % primes.length]! * 1000 + primeIx;
  primeIx += 1;
  return nextAmount;
};

for (const [entity, creditor, functional, economic, program, fundingCode, sector, expense] of [
  ['111', '111', '65.02.04', '10.01.01', 'P1', 'A', 2, 'functionare'],
  ['111', '111', '51.01.03', '51.01.01', null, 'B', 2, 'functionare'], // the 51.01 transfer row
  ['222', '111', '65.02.04', '20.01.30', 'P1', 'D', 5, 'dezvoltare'],
  ['333', null, '68.02.05', null, null, 'A', 2, null],
] as const) {
  for (const year of [2023, 2024]) {
    for (const rt of [RT1, RT2]) {
      for (const cat of ['vn', 'ch'] as const) {
        for (const month of [1, 2, 3, 12]) {
          seedRows.push({
            entity,
            creditor,
            year,
            month,
            rt,
            cat,
            functional,
            economic: cat === 'vn' ? null : economic,
            program,
            fundingCode,
            sector,
            expense: cat === 'vn' ? null : expense,
            amount: amount(),
          });
        }
      }
    }
  }
}

/** Row-level flags/columns the loader would write for a monthly row. */
const flagsFor = (
  r: SeedRow,
  sameGroup: SeedRow[]
): {
  monthly: number;
  quarterly: number | null;
  ytd: number;
  isMonthly: boolean;
  isQuarterly: boolean;
  isYearly: boolean;
  quarter: number | null;
} => {
  const upTo = (m: number): number =>
    sameGroup.filter((s) => s.month <= m).reduce((acc, s) => acc + s.amount, 0);
  const quarter = Math.ceil(r.month / 3);
  const isQuarterEnd = r.month % 3 === 0;
  const quarterly = isQuarterEnd
    ? sameGroup
        .filter((s) => s.month > (quarter - 1) * 3 && s.month <= r.month)
        .reduce((a, s) => a + s.amount, 0)
    : null;
  return {
    monthly: r.amount,
    quarterly,
    ytd: upTo(r.month),
    isMonthly: true,
    isQuarterly: isQuarterEnd,
    isYearly: r.month === 12,
    quarter: isQuarterEnd ? quarter : null,
  };
};

const seed = async (client: pg.Client): Promise<void> => {
  // Funding sources inserted NON-alphabetically so stored id ≠ phoenix ordinal:
  // D → stored 1, A → stored 2, B → stored 3; compat: A=1(2), B=2(3), D=3(1).
  await client.query(
    `insert into budget.funding_sources (source_code, source_description) values ('D','Fonduri externe nerambursabile'),('A','Buget local'),('B','Credite externe')`
  );
  await client.query(
    `insert into budget.budget_sectors (sector_id, sector_description) values (2,'Bugetul local'),(5,'Bugetul institutiilor finantate din venituri proprii')`
  );
  await client.query(`
    insert into core.territories (territorial_siruta_code, siruta_code, county_siruta_code, uat_code, name, county_code, county_name, region, population) values
      ('12','CJ','12','CJ0','Cluj','CJ','Cluj','Nord-Vest',700000),
      ('22','IS','22','IS0','Iasi','IS','Iasi','Nord-Est',760000),
      ('54975','54975','12','54975','Cluj-Napoca','CJ','Cluj','Nord-Vest',290000),
      ('95060','95060','22','95060','Iasi (municipiu)','IS','Iasi','Nord-Est',270000)
  `);
  for (const [siruta, name, population] of BUCHAREST_ROWS) {
    await client.query(
      `insert into core.territories (territorial_siruta_code, siruta_code, county_siruta_code, uat_code, name, county_code, county_name, region, population)
       values ($1, $1, '403', 'B' || $1, $2, 'B', 'Bucuresti', 'Bucuresti-Ilfov', $3)`,
      [siruta, name, population]
    );
  }
  await client.query(`
    insert into core.public_entities (cui, name, entity_type, is_uat, territorial_siruta_code, tags) values
      ('111','Municipiul Cluj-Napoca','uat',true,'54975','[{"tag":"kind::uat","ruleId":"R","confidence":9},{"tag":"coverage::local","ruleId":"R","confidence":9}]'),
      ('222','Scoala Gimnaziala Iasi','education',false,'95060','[{"tag":"kind::school","ruleId":"R","confidence":9},{"tag":"kind::school::gymnasium","ruleId":"R","confidence":9},{"tag":"coverage::local","ruleId":"R","confidence":8}]'),
      ('333','Agentia Fara Teritoriu','health',false,null,'[{"tag":"kind::hospital","ruleId":"R","confidence":9},{"tag":"coverage::national","ruleId":"R","confidence":9}]'),
      ('444','Consiliul Judetean Cluj','admin_county_council',true,'12','[{"tag":"kind::county_council","ruleId":"R","confidence":9}]')
  `);
  // Denominator-only UAT halls: the municipality and every sector (as on Chronos).
  for (const [siruta, name] of BUCHAREST_ROWS) {
    await client.query(
      `insert into core.public_entities (cui, name, entity_type, is_uat, territorial_siruta_code, tags)
       values ($1, $2, 'uat', true, $3, '[{"tag":"kind::uat","ruleId":"R","confidence":9}]')`,
      [`4${siruta}`, `Primaria ${name}`, siruta]
    );
  }
  const storedFunding = new Map<string, number>();
  const fs = await client.query<{ source_id: number; source_code: string }>(
    `select source_id, source_code from budget.funding_sources`
  );
  for (const r of fs.rows) storedFunding.set(r.source_code, r.source_id);

  let lineOrder = 0;
  for (const r of seedRows) {
    const group = seedRows.filter(
      (s) =>
        s.entity === r.entity &&
        s.year === r.year &&
        s.rt === r.rt &&
        s.cat === r.cat &&
        s.functional === r.functional
    );
    const f = flagsFor(r, group);
    lineOrder += 1;
    await client.query(
      `insert into budget.execution_line_items
         (report_id, line_key, line_order, reporting_year, reporting_month, entity_cui, report_type, main_creditor_cui,
          budget_sector_id, account_category, expense_type, functional_code, functional_name, economic_code, economic_name,
          funding_source, funding_source_id, program_code, ytd_amount, monthly_amount, quarterly_amount,
          is_monthly, is_quarterly, is_yearly, quarter)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)`,
      [
        `rep-${r.entity}-${String(r.year)}-${String(r.month)}-${r.rt === RT1 ? 'rt1' : 'rt2'}`,
        `${r.cat}|${r.functional}|${r.economic ?? ''}|${r.program ?? ''}`,
        lineOrder,
        r.year,
        r.month,
        r.entity,
        r.rt,
        r.creditor,
        r.sector,
        r.cat,
        r.expense,
        r.functional,
        null,
        r.economic,
        null,
        r.fundingCode,
        storedFunding.get(r.fundingCode),
        r.program,
        f.ytd,
        f.monthly,
        f.quarterly,
        f.isMonthly,
        f.isQuarterly,
        f.isYearly,
        f.quarter,
      ]
    );
  }
  // ONE row of an unexpected report type: routed to `_y2024_default` by the
  // DDL. It must never be summed into an omitted-report_type series.
  await client.query(
    `insert into budget.execution_line_items
       (report_id, line_key, line_order, reporting_year, reporting_month, entity_cui, report_type, main_creditor_cui,
        budget_sector_id, account_category, expense_type, functional_code, economic_code, funding_source, funding_source_id,
        ytd_amount, monthly_amount, quarterly_amount, is_monthly, is_quarterly, is_yearly, quarter)
     values ('rep-111-2024-12-rtx', 'ch|65.02.04|10.01.01|', 1, 2024, 12, '111', $1, '111',
             2, 'ch', 'functionare', '65.02.04', '10.01.01', 'A', $2,
             1000000, 1000000, 1000000, true, true, true, 4)`,
    [RT_UNEXPECTED, storedFunding.get('A')]
  );
};

const UNEXPECTED_AMOUNT = legacyDecimal('1000000');

// ── independent oracle SQL (hand-written; never through the repo) ─────────────

interface OracleRow {
  year: number;
  period_value: number;
  amount: string;
}

/**
 * Hand-written aggregate over the seed for a filter family. The world it
 * describes is the SUPPORTED execution report types (the two the seed uses,
 * spelled out here, not taken from the repo's constant): an omitted
 * `report_type` means those, never the unexpected literal parked in the
 * `_default` leaf. `allReportTypes: true` lifts that for the one assertion
 * that proves the unexpected row is in the table.
 */
const oracle = async (
  where: string,
  params: unknown[],
  freq: 'MONTH' | 'QUARTER' | 'YEAR',
  options: { readonly allReportTypes?: boolean } = {}
): Promise<OracleRow[]> => {
  const col =
    freq === 'MONTH' ? 'monthly_amount' : freq === 'QUARTER' ? 'quarterly_amount' : 'ytd_amount';
  const flag = freq === 'MONTH' ? 'is_monthly' : freq === 'QUARTER' ? 'is_quarterly' : 'is_yearly';
  const period =
    freq === 'MONTH' ? 'reporting_month' : freq === 'QUARTER' ? 'quarter' : 'reporting_year';
  const supported =
    options.allReportTypes === true
      ? ''
      : `and x.report_type in ('Executie bugetara detaliata', 'Executie bugetara agregata la nivel de ordonator principal')`;
  const res = await pgClient!.query<OracleRow>(
    `select x.reporting_year as year, x.${period} as period_value, sum(x.${col})::text as amount
       from budget.execution_line_items x
       left join core.public_entities pe on pe.cui = x.entity_cui
       left join core.territories tt on tt.territorial_siruta_code = pe.territorial_siruta_code
      where x.${flag} ${supported} and ${where}
      group by 1, 2 order by 1, 2`,
    params
  );
  return res.rows.map((r) => ({ year: r.year, period_value: r.period_value, amount: r.amount }));
};

const noFactors: FactorSource = { yearly: () => Promise.resolve(ok(null)) };

const baseFilter = (over: Partial<LegacyAnalyticsFilter> = {}): LegacyAnalyticsFilter => ({
  account_category: 'ch',
  report_period: { type: 'YEAR', selection: { interval: { start: '2023', end: '2024' } } },
  ...over,
});

const runSeries = async (
  filter: LegacyAnalyticsFilter,
  factors: FactorSource = noFactors
): Promise<{ x: string; y: Decimal }[]> => {
  const repo = makeLegacyAnalyticsRepo(db!);
  const res = await legacyExecutionSeries(
    { aggregate: repo, factors, population: makeLegacyPopulationRepo(db!) },
    [{ filter }]
  );
  const series = res._unsafeUnwrap()[0]!;
  return series.data.map((p) => ({ x: p.x, y: p.y }));
};

const aggregate = async (filter: LegacyAnalyticsFilter): Promise<OracleRow[]> => {
  const repo = makeLegacyAnalyticsRepo(db!);
  const res = await repo.legacyExecutionAggregate(cleanFilter(filter)._unsafeUnwrap());
  return res
    ._unsafeUnwrap()
    .rows.map((r) => ({ year: r.year, period_value: r.periodValue, amount: r.amount }));
};

/** Compare repo rows with oracle rows (numeric equality, same order). */
const expectSameRows = (actual: OracleRow[], expected: OracleRow[]): void => {
  expect(actual.length, 'row count').toBe(expected.length);
  for (let i = 0; i < expected.length; i += 1) {
    expect(actual[i]?.year).toBe(expected[i]?.year);
    expect(actual[i]?.period_value).toBe(expected[i]?.period_value);
    expect(
      legacyDecimal(actual[i]!.amount).eq(legacyDecimal(expected[i]!.amount)),
      `row ${String(i)} amount`
    ).toBe(true);
  }
  expect(
    expected.length,
    'the oracle must select something (a vacuous gate proves nothing)'
  ).toBeGreaterThan(0);
};

// ── lifecycle ─────────────────────────────────────────────────────────────────

beforeAll(async () => {
  const scrapperRoot = resolveScrapperRoot();
  if (scrapperRoot === undefined) {
    unavailable('scrapper checkout not found (SCRAPPER_REPO_ROOT)');
    return;
  }
  assertScrapperMigrations(scrapperRoot);
  const connectionString = await resolveConnection();
  if (connectionString === undefined) return;

  // DESTRUCTIVE-STATEMENT GUARD: this suite drops schemas. Only a loopback host
  // (a local container or an SSH tunnel to one) and never the production
  // database name are admitted — a typo'd E2E_BUDGET_PG_URL must not reach prod.
  const target = new URL(connectionString);
  const loopback = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
  if (
    !loopback.has(target.hostname) ||
    target.pathname.replace(/^\//u, '') === 'transparenta_prod'
  ) {
    throw new Error(
      `refusing to run destructive e2e DDL against ${target.hostname}${target.pathname} — loopback hosts only, never transparenta_prod`
    );
  }

  pgClient = new pg.Client({ connectionString });
  await pgClient.connect();
  await pgClient.query('drop schema if exists budget cascade; drop schema if exists core cascade;');

  const pool = new pg.Pool({ connectionString });
  db = new Kysely<ProdDatabase>({ dialect: new PostgresDialect({ pool }) });

  for (const file of MIGRATIONS) {
    const mod = (await import(
      pathToFileURL(path.join(scrapperRoot, 'src', 'db', 'prod-migrations', file)).href
    )) as { up: (db: Kysely<unknown>) => Promise<void> };
    await db.transaction().execute((trx) => mod.up(trx as unknown as Kysely<unknown>));
  }
  await seed(pgClient);
  // Explicit test-world L1 projection over the real additive migration DDL.
  await pgClient.query(`
    update core.territories set
      level = case when siruta_code in ('CJ','IS') then 'county'
                   when county_code='B' and siruta_code<>'179132' then 'locality'
                   else 'uat' end,
      kind = case when siruta_code in ('CJ','IS') then 'county'
                  when county_code='B' and siruta_code<>'179132' then 'sector'
                  else 'municipality' end,
      territory_key = 'siruta:' || territorial_siruta_code;
    update core.public_entities e set territory_id=t.id,territorial_level=t.level,
      is_territorial_executive=e.is_uat
    from core.territories t where t.territorial_siruta_code=e.territorial_siruta_code;
  `);
  ready = true;
}, 240_000);

afterAll(async () => {
  if (db !== undefined) await db.destroy();
  if (pgClient !== undefined) await pgClient.end();
  if (container !== undefined) await container.stop();
});

// ── the gates ─────────────────────────────────────────────────────────────────

describe('legacy executionAnalytics over the real scrapper DDL (e2e)', () => {
  it('seeds consistently: flags satisfy the DDL checks and the compat view reproduces the phoenix ordinals', async () => {
    const compat = await pgClient!.query<{
      source_id: number;
      source_code: string | null;
      internal_source_id: number;
    }>(
      'select source_id, source_code, internal_source_id from budget.v_funding_sources_compat order by source_id'
    );
    expect(compat.rows).toEqual([
      { source_id: 0, source_code: null, internal_source_id: 0 },
      { source_id: 1, source_code: 'A', internal_source_id: 2 },
      { source_id: 2, source_code: 'B', internal_source_id: 3 },
      { source_id: 3, source_code: 'D', internal_source_id: 1 },
    ]);
    const map = await makeFundingSourceMap(db!).load();
    expect(map.toStoredId(2)).toBe(3);
    const n = await pgClient!.query<{ n: string }>(
      'select count(*)::text as n from budget.execution_line_items'
    );
    expect(Number(n.rows[0]?.n)).toBe(seedRows.length + 1);
    // The unexpected report type landed in the year's `_default` leaf.
    const leaf = await pgClient!.query<{ n: string }>(
      'select count(*)::text as n from budget.execution_line_items_y2024_default'
    );
    expect(Number(leaf.rows[0]?.n)).toBe(1);
    // The Bucharest fixture: the six sectors sum to exactly the municipality.
    expect(SECTORS_POPULATION).toBe(1716983);
  });

  it('YEAR / omitted report_type sums ALL SUPPORTED report types (kept legacy semantic), never the `_default` leaf', async () => {
    const actual = await aggregate(baseFilter());
    const expected = await oracle(
      `x.account_category = 'ch' and x.reporting_year between 2023 and 2024 and x.report_type in ($1, $2)`,
      [RT1, RT2],
      'YEAR',
      { allReportTypes: true }
    );
    expectSameRows(actual, expected);
    // And it is strictly more than one report type alone.
    const rt1 = await oracle(
      `x.account_category = 'ch' and x.report_type = $1 and x.reporting_year between 2023 and 2024`,
      [RT1],
      'YEAR'
    );
    expect(legacyDecimal(actual[0]!.amount).gt(legacyDecimal(rt1[0]!.amount))).toBe(true);
    // The unexpected report type IS in the table (an unfiltered oracle sees it)
    // but NOT in the series (the IN over the supported literals excludes it).
    const unfiltered = await oracle(
      `x.account_category = 'ch' and x.reporting_year = 2024`,
      [],
      'YEAR',
      { allReportTypes: true }
    );
    const y2024 = actual.find((r) => r.year === 2024)!;
    expect(legacyDecimal(unfiltered[0]!.amount).minus(y2024.amount).eq(UNEXPECTED_AMOUNT)).toBe(
      true
    );
  });

  it('report_type literal + account_category vn prune and select the right rows', async () => {
    const actual = await aggregate(baseFilter({ account_category: 'vn', report_type: RT2 }));
    const expected = await oracle(
      `x.account_category = 'vn' and x.report_type = $1 and x.reporting_year between 2023 and 2024`,
      [RT2],
      'YEAR'
    );
    expectSameRows(actual, expected);
  });

  it('MONTH interval → (year, month) tuple bounds; sparse output, no zero-fill', async () => {
    const actual = await aggregate(
      baseFilter({
        report_period: {
          type: 'MONTH',
          selection: { interval: { start: '2023-12', end: '2024-02' } },
        },
      })
    );
    const expected = await oracle(
      `x.account_category = 'ch' and (x.reporting_year, x.reporting_month) >= (2023, 12) and (x.reporting_year, x.reporting_month) <= (2024, 2)`,
      [],
      'MONTH'
    );
    expectSameRows(actual, expected);
    expect(actual.map((r) => `${String(r.year)}-${String(r.period_value)}`)).toEqual([
      '2023-12',
      '2024-1',
      '2024-2',
    ]);
  });

  it('QUARTER dates → quarterly_amount over is_quarterly rows for the listed (year, quarter)s', async () => {
    const actual = await aggregate(
      baseFilter({
        report_period: { type: 'QUARTER', selection: { dates: ['2023-Q4', '2024-Q1'] } },
      })
    );
    const expected = await oracle(
      `x.account_category = 'ch' and ((x.reporting_year = 2023 and x.quarter = 4) or (x.reporting_year = 2024 and x.quarter = 1))`,
      [],
      'QUARTER'
    );
    expectSameRows(actual, expected);
  });

  it('dimension filters: main_creditor_cui, entity_cuis, budget_sector_ids, expense_types, program_codes', async () => {
    const actual = await aggregate(
      baseFilter({
        main_creditor_cui: '111',
        entity_cuis: ['111', '222'],
        budget_sector_ids: ['5'],
        expense_types: ['dezvoltare'],
        program_codes: ['P1'],
      })
    );
    const expected = await oracle(
      `x.account_category = 'ch' and x.reporting_year between 2023 and 2024 and x.main_creditor_cui = '111'
       and x.entity_cui in ('111','222') and x.budget_sector_id = 5 and x.expense_type = 'dezvoltare' and x.program_code = 'P1'`,
      [],
      'YEAR'
    );
    expectSameRows(actual, expected);
  });

  it('funding_source_ids: phoenix ordinal 2 (B) selects the STORED id 3 rows', async () => {
    const actual = await aggregate(baseFilter({ funding_source_ids: ['2'] }));
    const expected = await oracle(
      `x.account_category = 'ch' and x.reporting_year between 2023 and 2024 and x.funding_source_id = 3`,
      [],
      'YEAR'
    );
    expectSameRows(actual, expected);
    // An unknown public id selects nothing (empty-set semantics, not an error).
    expect(await aggregate(baseFilter({ funding_source_ids: ['9'] }))).toEqual([]);
  });

  it('classification codes and prefixes', async () => {
    const actual = await aggregate(
      baseFilter({
        functional_prefixes: ['65'],
        economic_codes: ['10.01.01', '20.01.30'],
        economic_prefixes: ['10'],
      })
    );
    const expected = await oracle(
      `x.account_category = 'ch' and x.reporting_year between 2023 and 2024 and x.functional_code like '65%'
       and x.economic_code in ('10.01.01','20.01.30') and x.economic_code like '10%'`,
      [],
      'YEAR'
    );
    expectSameRows(actual, expected);
  });

  it('entity scope: entity_types, is_uat, search (ILIKE), faceted tags (OR within, AND across)', async () => {
    const actual = await aggregate(
      baseFilter({
        tags: ['kind::school', 'kind::uat', 'coverage::local'],
        search: 'iasi',
        is_uat: false,
        entity_types: ['education'],
      })
    );
    const expected = await oracle(
      `x.account_category = 'ch' and x.reporting_year between 2023 and 2024
       and (pe.tags @> '[{"tag":"kind::school"}]' or pe.tags @> '[{"tag":"kind::uat"}]') and pe.tags @> '[{"tag":"coverage::local"}]'
       and pe.name ilike '%iasi%' and pe.is_uat = false and pe.entity_type = 'education'`,
      [],
      'YEAR'
    );
    expectSameRows(actual, expected);
  });

  it('territory scope: uat_ids (= core.territories.id), county_codes, regions, min/max_population', async () => {
    const cluj = await pgClient!.query<{ id: number }>(
      `select id from core.territories where territorial_siruta_code = '54975'`
    );
    const clujId = cluj.rows[0]!.id;
    const actual = await aggregate(
      baseFilter({
        uat_ids: [String(clujId)],
        county_codes: ['CJ'],
        regions: ['Nord-Vest'],
        min_population: 100000,
        max_population: 300000,
      })
    );
    const expected = await oracle(
      `x.account_category = 'ch' and x.reporting_year between 2023 and 2024 and tt.id = $1 and tt.county_code = 'CJ'
       and tt.region = 'Nord-Vest' and tt.population >= 100000 and tt.population <= 300000`,
      [clujId],
      'YEAR'
    );
    expectSameRows(actual, expected);
  });

  it('row thresholds (item_min/max) and HAVING thresholds (aggregate_min/max — legacy ignored these)', async () => {
    const rows = await oracle(
      `x.account_category = 'ch' and x.reporting_year between 2023 and 2024`,
      [],
      'YEAR'
    );
    const y2023 = legacyDecimal(rows.find((r) => r.year === 2023)!.amount);
    const y2024 = legacyDecimal(rows.find((r) => r.year === 2024)!.amount);
    const lo = Decimal.min(y2023, y2024);
    const hi = Decimal.max(y2023, y2024);
    const onlyHigh = await aggregate(baseFilter({ aggregate_min_amount: lo.plus(1).toNumber() }));
    expect(onlyHigh).toHaveLength(1);
    expect(legacyDecimal(onlyHigh[0]!.amount).eq(hi)).toBe(true);
    const onlyLow = await aggregate(baseFilter({ aggregate_max_amount: hi.minus(1).toNumber() }));
    expect(onlyLow).toHaveLength(1);
    expect(legacyDecimal(onlyLow[0]!.amount).eq(lo)).toBe(true);

    // Row thresholds strictly inside the seeded ytd range, so they remove rows
    // on both ends (a vacuous threshold would prove nothing).
    const bounds = await pgClient!.query<{ lo: string; hi: string }>(
      `select min(ytd_amount)::text as lo, max(ytd_amount)::text as hi
         from budget.execution_line_items where is_yearly and account_category = 'ch'`
    );
    const itemMin = legacyDecimal(bounds.rows[0]!.lo).plus(1).toNumber();
    const itemMax = legacyDecimal(bounds.rows[0]!.hi).minus(1).toNumber();
    const thresholded = await aggregate(
      baseFilter({ item_min_amount: itemMin, item_max_amount: itemMax })
    );
    const expected = await oracle(
      `x.account_category = 'ch' and x.reporting_year between 2023 and 2024 and x.ytd_amount >= $1 and x.ytd_amount <= $2`,
      [String(itemMin), String(itemMax)],
      'YEAR'
    );
    expectSameRows(thresholded, expected);
    expect(legacyDecimal(thresholded[0]!.amount).lt(y2023)).toBe(true);
  });

  it('exclusions: all 16 fields, NULL-safe — a territory-less entity survives entity/territory exclusions', async () => {
    const isi = await pgClient!.query<{ id: number }>(
      `select id from core.territories where territorial_siruta_code = '95060'`
    );
    const iasiId = isi.rows[0]!.id;
    const actual = await aggregate(
      baseFilter({
        exclude: {
          report_ids: ['rep-111-2023-12-rt1'],
          entity_cuis: ['999'],
          main_creditor_cui: '999',
          functional_codes: ['00.00.00'],
          functional_prefixes: ['51.01'], // removes the transfer row
          economic_codes: ['00.00.00'],
          economic_prefixes: ['51'],
          funding_source_ids: ['3', '9'], // phoenix 3 = D = stored 1; 9 unknown → ignored
          budget_sector_ids: ['9'],
          expense_types: ['dezvoltare'],
          program_codes: ['P9'],
          county_codes: ['IS'],
          regions: ['Sud'],
          uat_ids: [String(iasiId)],
          entity_types: ['education'],
          tags: ['kind::school'],
        },
      })
    );
    const expected = await oracle(
      `x.account_category = 'ch' and x.reporting_year between 2023 and 2024
       and x.report_id <> 'rep-111-2023-12-rt1' and x.entity_cui <> '999'
       and (x.main_creditor_cui is null or x.main_creditor_cui <> '999')
       and x.functional_code <> '00.00.00' and x.functional_code not like '51.01%'
       and (x.economic_code is null or x.economic_code <> '00.00.00')
       and (x.economic_code is null or x.economic_code not like '51%')
       and x.funding_source_id <> 1 and x.budget_sector_id <> 9
       and (x.expense_type is null or x.expense_type <> 'dezvoltare')
       and (x.program_code is null or x.program_code <> 'P9')
       and (tt.county_code is null or tt.county_code <> 'IS') and (tt.region is null or tt.region <> 'Sud')
       and (tt.id is null or tt.id <> $1) and (pe.entity_type is null or pe.entity_type <> 'education')
       and (pe.tags is null or not (pe.tags @> '[{"tag":"kind::school"}]'))`,
      [iasiId],
      'YEAR'
    );
    expectSameRows(actual, expected);
    // Entity 333 (no territory, type health, funding A) must still be counted.
    const only333 = await oracle(
      `x.account_category = 'ch' and x.reporting_year between 2023 and 2024 and x.entity_cui = '333'`,
      [],
      'YEAR'
    );
    expect(legacyDecimal(actual[0]!.amount).gte(legacyDecimal(only333[0]!.amount))).toBe(true);
  });

  it('economic exclusions do not apply on the income side (legacy)', async () => {
    const actual = await aggregate(
      baseFilter({ account_category: 'vn', exclude: { economic_prefixes: ['1', '2', '5', '9'] } })
    );
    const expected = await oracle(
      `x.account_category = 'vn' and x.reporting_year between 2023 and 2024`,
      [],
      'YEAR'
    );
    expectSameRows(actual, expected);
  });

  it('`[]` is a no-op filter (never false)', async () => {
    const withEmpties = await aggregate(
      baseFilter({ entity_cuis: [], uat_ids: [], tags: [], exclude: { regions: [], tags: [] } })
    );
    const plain = await aggregate(baseFilter());
    expect(withEmpties).toEqual(plain);
  });

  it('normalization on real rows: total_euro, inflation (base = latest CPI year), per_capita by territory population, growth', async () => {
    // The port carries the D2 CPI LEVEL: chain-link the YoY tail as the adapter does.
    const cpiLevels = Object.fromEntries(
      chainLinkCpiLevels(
        new Map([
          [2022, legacyDecimal('113.80')],
          [2023, legacyDecimal('110.40')],
          [2024, legacyDecimal('105.59')],
        ])
      )
    );
    const factors: FactorSource = {
      yearly: (kind: FactorKind) => {
        const series: Partial<Record<FactorKind, Record<number, string>>> = {
          cpi_index: cpiLevels,
          ron_per_eur: { 2023: '4.9465', 2024: '4.9746' },
          population_ro: { 2022: '19050000', 2023: '19000000' },
        };
        const s = series[kind];
        return Promise.resolve(
          ok(
            s === undefined
              ? null
              : new Map(Object.entries(s).map(([y, v]) => [Number(y), legacyDecimal(v)]))
          )
        );
      },
    };
    const nominal = await oracle(
      `x.account_category = 'ch' and x.reporting_year between 2023 and 2024`,
      [],
      'YEAR'
    );
    const n2023 = legacyDecimal(nominal.find((r) => r.year === 2023)!.amount);
    const n2024 = legacyDecimal(nominal.find((r) => r.year === 2024)!.amount);

    // total_euro: divide by the year's rate.
    const euro = await runSeries(baseFilter({ normalization: 'total_euro' }), factors);
    expect(euro[0]!.y.eq(n2023.div('4.9465'))).toBe(true);
    expect(euro[1]!.y.eq(n2024.div('4.9746'))).toBe(true);

    // inflation_adjusted: base 2024 (latest) → 2024 factor 1; 2023 factor = 1.0559.
    const real = await runSeries(baseFilter({ inflation_adjusted: true }), factors);
    expect(real[0]!.y.eq(n2023.mul(legacyDecimal('1.0559')))).toBe(true);
    expect(real[1]!.y.eq(n2024)).toBe(true);

    // per_capita with county_codes CJ → the county-level row population (700000).
    const perCapita = await runSeries(
      baseFilter({ normalization: 'per_capita', county_codes: ['CJ'] }),
      factors
    );
    const cj = await oracle(
      `x.account_category = 'ch' and x.reporting_year between 2023 and 2024 and tt.county_code = 'CJ'`,
      [],
      'YEAR'
    );
    expect(perCapita[0]!.y.eq(legacyDecimal(cj[0]!.amount).div(700000))).toBe(true);

    // per_capita with entity_cuis 111 + 222 → distinct territories 290000 + 270000.
    const perCapitaEntities = await runSeries(
      baseFilter({ normalization: 'per_capita', entity_cuis: ['111', '222'] }),
      factors
    );
    const both = await oracle(
      `x.account_category = 'ch' and x.reporting_year between 2023 and 2024 and x.entity_cui in ('111','222')`,
      [],
      'YEAR'
    );
    expect(perCapitaEntities[0]!.y.eq(legacyDecimal(both[0]!.amount).div(560000))).toBe(true);

    // per_capita with uat_ids → the territories scope (Iasi municipiu 270000).
    const iasi = await pgClient!.query<{ id: number }>(
      `select id from core.territories where territorial_siruta_code = '95060'`
    );
    const perCapitaUat = await runSeries(
      baseFilter({ normalization: 'per_capita', uat_ids: [String(iasi.rows[0]!.id)] }),
      factors
    );
    const uat = await oracle(
      `x.account_category = 'ch' and x.reporting_year between 2023 and 2024 and tt.id = $1`,
      [iasi.rows[0]!.id],
      'YEAR'
    );
    expect(perCapitaUat[0]!.y.eq(legacyDecimal(uat[0]!.amount).div(270000))).toBe(true);

    // per_capita with entity_types → those entities' distinct territories (education → 270000).
    const perCapitaTypes = await runSeries(
      baseFilter({ normalization: 'per_capita', entity_types: ['education'] }),
      factors
    );
    const edu = await oracle(
      `x.account_category = 'ch' and x.reporting_year between 2023 and 2024 and pe.entity_type = 'education'`,
      [],
      'YEAR'
    );
    expect(perCapitaTypes[0]!.y.eq(legacyDecimal(edu[0]!.amount).div(270000))).toBe(true);

    // per_capita with is_uat: true alone → the UAT-LEVEL universe of every UAT
    // entity's territory: Cluj-Napoca 290000 + the six sectors; the CJ county
    // row (county council, 700000) and Bucharest municipality 179132 (1716983,
    // its sectors are in the set) are EXCLUDED. Legacy would have summed
    // DISTINCT values over all nine rows.
    const perCapitaAllUats = await runSeries(
      baseFilter({ normalization: 'per_capita', is_uat: true }),
      factors
    );
    const uats = await oracle(
      `x.account_category = 'ch' and x.reporting_year between 2023 and 2024 and pe.is_uat`,
      [],
      'YEAR'
    );
    const uatLevel = 290000 + SECTORS_POPULATION;
    expect(perCapitaAllUats[0]!.y.eq(legacyDecimal(uats[0]!.amount).div(uatLevel))).toBe(true);
    // The legacy rule on the same seed, for the record (both wrong):
    const legacyDistinctValue = await pgClient!.query<{ total: string }>(
      `select sum(distinct t.population)::text as total from core.public_entities e
        join core.territories t on t.territorial_siruta_code = e.territorial_siruta_code where e.is_uat`
    );
    expect(Number(legacyDistinctValue.rows[0]!.total)).toBe(uatLevel + 700000 + 1716983);

    // per_capita with entity_types ['uat'] → the same UAT-level universe.
    const perCapitaUatType = await runSeries(
      baseFilter({ normalization: 'per_capita', entity_types: ['uat'] }),
      factors
    );
    const uatType = await oracle(
      `x.account_category = 'ch' and x.reporting_year between 2023 and 2024 and pe.entity_type = 'uat'`,
      [],
      'YEAR'
    );
    expect(perCapitaUatType[0]!.y.eq(legacyDecimal(uatType[0]!.amount).div(uatLevel))).toBe(true);

    // per_capita with entity_types ['admin_county_council'] → the county path
    // (kept): the counties those councils sit in → CJ county row 700000.
    // (There are no facts for 444, so the series is the CJ-council numerator = 0 rows.)
    const councilRepo = makeLegacyPopulationRepo(db!);
    const council = await councilRepo.scopedPopulation({
      kind: 'entityTypes',
      types: ['admin_county_council'],
    });
    expect(council._unsafeUnwrap()?.toString()).toBe('700000');

    // The municipality alone (no sector in the set) is NOT excluded: the
    // level-safe rule removes 179132 only when its sectors are present.
    const pmbOnly = await councilRepo.scopedPopulation({
      kind: 'entityTypes',
      types: ['uat'],
      isUat: true,
    });
    expect(pmbOnly._unsafeUnwrap()?.toString()).toBe(String(uatLevel));
    await pgClient!.query(
      `delete from core.public_entities where cui like '4179%' and cui <> '4179132'`
    );
    try {
      const withoutSectors = await councilRepo.scopedPopulation({ kind: 'allUats' });
      expect(withoutSectors._unsafeUnwrap()?.toString()).toBe(String(290000 + 1716983));
    } finally {
      for (const [siruta, name] of BUCHAREST_ROWS.slice(1)) {
        await pgClient!.query(
          `insert into core.public_entities (cui, name, entity_type, is_uat, territorial_siruta_code, territory_id, territorial_level, is_territorial_executive, tags)
           select $1, $2, 'uat', true, $3, t.id, t.level, true, '[{"tag":"kind::uat","ruleId":"R","confidence":9}]'
           from core.territories t where t.territorial_siruta_code=$3`,
          [`4${siruta}`, `Primaria ${name}`, siruta]
        );
      }
    }

    // entity_cuis naming a container AND its parts is NOT level-restricted
    // (the caller named them; documented double-count risk).
    const mixed = await councilRepo.scopedPopulation({
      kind: 'entities',
      cuis: ['4179132', '4179141', '444'],
    });
    expect(mixed._unsafeUnwrap()?.toString()).toBe(String(1716983 + 224764 + 700000));

    // per_capita with no entity filter → the LATEST country population (2023: 19,000,000).
    const perCapitaCountry = await runSeries(baseFilter({ normalization: 'per_capita' }), factors);
    expect(perCapitaCountry[0]!.y.eq(n2023.div(19000000))).toBe(true);

    // growth after normalization (EUR): 2023 → 0 (first), 2024 = (b-a)/a*100.
    const growth = await runSeries(
      baseFilter({ normalization: 'total_euro', show_period_growth: true }),
      factors
    );
    const a = n2023.div('4.9465');
    const b = n2024.div('4.9746');
    expect(growth[0]!.y.isZero()).toBe(true);
    expect(growth[1]!.y.eq(b.minus(a).div(a).mul(100))).toBe(true);
  });

  it('EXPLAIN: the aggregate prunes to the expected leaves', async () => {
    const compiled = legacyAggregateSql(
      cleanFilter(
        baseFilter({
          report_type: RT1,
          report_period: { type: 'YEAR', selection: { dates: ['2024'] } },
        })
      )._unsafeUnwrap(),
      () => undefined
    ).compile(db!);
    const plan = await pgClient!.query<Record<string, unknown>>(
      `explain (format json) ${compiled.sql}`,
      [...compiled.parameters]
    );
    const json = JSON.stringify(plan.rows[0]?.['QUERY PLAN']);
    const relations = [...json.matchAll(/"Relation Name":"([^"]+)"/gu)].map((m) => m[1]);
    console.log('[e2e] EXPLAIN relations (single-year, rt1, ch):', relations.join(', '));
    expect(relations).toEqual(['execution_line_items_y2024_rt1_ch']);

    const multi = legacyAggregateSql(
      cleanFilter(baseFilter())._unsafeUnwrap(),
      () => undefined
    ).compile(db!);
    const plan2 = await pgClient!.query<Record<string, unknown>>(
      `explain (format json) ${multi.sql}`,
      [...multi.parameters]
    );
    const rel2 = [
      ...JSON.stringify(plan2.rows[0]?.['QUERY PLAN']).matchAll(/"Relation Name":"([^"]+)"/gu),
    ].map((m) => m[1]);
    console.log('[e2e] EXPLAIN relations (2023..2024, omitted report_type, ch):', rel2.join(', '));
    // Omitted report_type = the parameterized IN over the three supported
    // literals: exactly the three `_rtN_ch` leaves per year. The year `_default`
    // leaves (where an unexpected report type lands), the `_rtN_vn` and the
    // `_rtN_default` leaves are all pruned.
    expect(new Set(rel2)).toEqual(
      new Set([
        'execution_line_items_y2023_rt1_ch',
        'execution_line_items_y2023_rt2_ch',
        'execution_line_items_y2023_rt3_ch',
        'execution_line_items_y2024_rt1_ch',
        'execution_line_items_y2024_rt2_ch',
        'execution_line_items_y2024_rt3_ch',
      ])
    );
    expect(rel2.some((r) => r?.endsWith('_default') === true)).toBe(false);
  });
});

describe('S1 native territory anchors and county presentation', () => {
  it('uses the canonical FK even when legacy SIRUTA is absent or disagrees', async () => {
    await db!.transaction().execute(async (trx) => {
      const repo = makeIdentityRepo(trx);
      const expected = await repo.territoryForCui('111');
      expect(expected.isOk() && expected.value?.name).toBe('Cluj-Napoca');
      await sql`update core.public_entities set territorial_siruta_code=null where cui='111'`.execute(
        trx
      );
      const missingLegacy = await repo.territoryForCui('111');
      expect(missingLegacy).toEqual(expected);
      await sql`update core.public_entities set territorial_siruta_code='12' where cui='111'`.execute(
        trx
      );
      const conflictingLegacy = await repo.territoryForCui('111');
      expect(conflictingLegacy).toEqual(expected);
      await sql`update core.public_entities set territorial_siruta_code='54975' where cui='111'`.execute(
        trx
      );
    });
  });

  it('selects the Bucharest county node once and preserves its missing population', async () => {
    await db!.transaction().execute(async (trx) => {
      const repo = makeTerritoryQueryRepo(trx);
      const before = await repo.listCountyRollups();
      const presentationBefore = await makeTerritoryRepo(trx).byCounty('B');
      expect(presentationBefore.isOk() && presentationBefore.value.length).toBe(7);
      expect(before.isOk() && before.value.find((r) => r.countyCode === 'B')).toMatchObject({
        population: 1716983,
        uatCount: 1,
      });
      const inserted = await sql<{ id: number }>`
        insert into core.territories (territorial_siruta_code,siruta_code,county_siruta_code,name,county_code,county_name,region,population,level,kind,territory_key)
        values ('403','403','403','Bucuresti county','B','Bucuresti','Bucuresti-Ilfov',2000000,'county','county','siruta:403') returning id
      `.execute(trx);
      const after = await repo.listCountyRollups();
      expect(await makeTerritoryRepo(trx).byCounty('B')).toEqual(presentationBefore);
      const population = await makeLegacyPopulationRepo(trx).scopedPopulation({
        kind: 'counties',
        codes: ['B', 'CJ'],
      });
      expect(population.isOk() && population.value?.toString()).toBe('2700000');
      expect(after.isOk() && after.value.find((r) => r.countyCode === 'B')).toMatchObject({
        population: 2000000,
        uatCount: 1,
      });
      await sql`update core.territories set population=null where id=${inserted.rows[0]!.id}`.execute(
        trx
      );
      const missing = await repo.listCountyRollups();
      expect(
        missing.isOk() && missing.value.find((r) => r.countyCode === 'B')?.population
      ).toBeNull();
      const unavailable = await legacyExecutionSeries(
        {
          aggregate: makeLegacyAnalyticsRepo(db!),
          factors: noFactors,
          population: makeLegacyPopulationRepo(trx),
        },
        [{ filter: baseFilter({ normalization: 'per_capita', county_codes: ['B', 'CJ'] }) }]
      );
      expect(unavailable._unsafeUnwrapErr().type).toBe('ServiceUnavailable');
      await sql`delete from core.territories where id=${inserted.rows[0]!.id}`.execute(trx);
    });
  });

  it('rejects a partial county scope instead of serving nominal values per capita', async () => {
    const result = await legacyExecutionSeries(
      {
        aggregate: makeLegacyAnalyticsRepo(db!),
        factors: noFactors,
        population: makeLegacyPopulationRepo(db!),
      },
      [{ filter: baseFilter({ normalization: 'per_capita', county_codes: ['CJ', 'XX'] }) }]
    );
    expect(result._unsafeUnwrapErr()).toMatchObject({ type: 'ServiceUnavailable' });
  });

  it('duplicate county nodes cannot mask a missing requested county', async () => {
    await db!.transaction().execute(async (trx) => {
      const inserted = await sql<{ id: number }>`
        insert into core.territories (territorial_siruta_code,siruta_code,county_siruta_code,name,county_code,county_name,region,population,level,kind,territory_key)
        values ('111111','CJ','12','Duplicate Cluj','CJ','Cluj','Nord-Vest',700000,'county','county','siruta:111111') returning id
      `.execute(trx);
      const result = await makeLegacyPopulationRepo(trx).scopedPopulation({
        kind: 'counties',
        codes: ['CJ', 'AB'],
      });
      expect(result.isOk() && result.value).toBeNull();
      await sql`delete from core.territories where id=${inserted.rows[0]!.id}`.execute(trx);
    });
  });

  it('virtual territory categories partition unknown and native rows consistently', async () => {
    await db!.transaction().execute(async (trx) => {
      const inserted = await sql<{ id: number }>`
        insert into core.territories (territorial_siruta_code,siruta_code,county_siruta_code,county_code,county_name,region,name,level,kind)
        values ('999001','999001','12','CJ','Cluj','Nord-Vest','Unknown level',null,null),
          ('999002','999002','12','CJ','Cluj','Nord-Vest','Unknown locality kind','locality',null),
          ('999003','999003','12','CJ','Cluj','Nord-Vest','Other locality','locality','commune') returning id
      `.execute(trx);
      const repo = makeTerritoryQueryRepo(trx);
      const all = (await repo.list({}, { first: 100 }))._unsafeUnwrap();
      for (const field of ['isUat', 'isCounty']) {
        const yes = (await repo.list({ [field]: { eq: true } }, { first: 100 }))._unsafeUnwrap();
        const no = (await repo.list({ [field]: { eq: false } }, { first: 100 }))._unsafeUnwrap();
        expect(yes.totalCount).toBe(field === 'isUat' ? 9 : 3);
        expect(yes.totalCount + no.totalCount).toBe(all.totalCount);
        const ids = [...yes.items, ...no.items].map((r) => r.id);
        expect(new Set(ids).size).toBe(all.totalCount);
        expect(no.items.map((r) => r.id)).toEqual(
          expect.arrayContaining(inserted.rows.map((r) => r.id))
        );
      }
      await sql`delete from core.territories where id in (${sql.join(inserted.rows.map((r) => r.id))})`.execute(
        trx
      );
    });
  });

  it('UAT search excludes the county before limiting and includes sector presentation', async () => {
    const repo = makeTerritoryRepo(db!);
    const clujCounty = await repo.byCounty('CJ');
    expect(clujCounty.isOk() && clujCounty.value.map((r) => r.name)).toEqual(['Cluj-Napoca']);
    const cluj = await repo.searchUat('Cluj', 100);
    expect(cluj.isOk() && cluj.value.map((r) => r.name)).toEqual(['Cluj-Napoca']);
    const sectors = await repo.searchUat('SECTORUL', 100);
    expect(sectors.isOk() && sectors.value.length).toBe(6);
  });
});
