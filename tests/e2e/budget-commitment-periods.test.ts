/** Real scrapper DDL, independent hand-computed amounts; synthetic data only.
 * E2E_BUDGET_PG_URL may name only a loopback disposable PostgreSQL. All writes
 * occur in a fresh named test database, which this suite alone removes.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  listCommitmentPeriods,
  COMMITMENT_PERIOD_METRICS,
  type CommitmentPeriodQuery,
} from '@/modules/budget/core/commitment-periods.js';
import { makeBudgetPeriodRepo } from '@/modules/budget/shell/repo/commitment-periods-repo.js';

import type { ProdDatabase } from '@/modules/shared/index.js';

const migrationHashes: Record<string, string> = {
  '20260611T220000__companies_domain.ts':
    '0c84c277726d05d3ed8f0b959cd0c023e86f01b3d7bd3dbcf278223098022f97',
  '20260630T140000__companies_v2_core_privacy.ts':
    '150c579c9fd8cbd0cb4bafad4351c0383772710a36e1d2ef8b453ceacdfa2b40',
  '20260612T110200__budget_facts.ts':
    '05cefa428b161119b41723205ed877fd6d03b85ea3fd57c3c0913da3adde5406',
  '20260908T180000__commitment_candidates.ts':
    '3bf1dd2be4bb7da73a4f319a32c4b1bff6444c32d20910bb17eddadd423c6e2d',
  '20260909T010000__budget_period_expansion.ts':
    '77a97dce1160e33bc10706fa595a3f688711c46d31a7ff5c5bcc6aa84db66513',
  '20260909T011000__budget_source_periods.ts':
    'fb22c282eeea8e4e406176cb8e8a73d98c33f8f3cc7cbae26468d395a84c8038',
  '20260910T010000__budget_period_predecessors.ts':
    '1cfcad527da6aaa58151420c245119e74ccc1552c40cdc4ff5a49a75ea613597',
};
const rt = 'Executie - Angajamente bugetare detaliat';
const hash = 'a'.repeat(64);
const query: CommitmentPeriodQuery = {
  cui: '4505359',
  year: 2025,
  reportType: 'COMMITMENT_DETAILED',
  startMonth: 1,
  endMonth: 12,
  page: 1,
  pageSize: 25,
};
let db: Kysely<ProdDatabase>;
let admin: pg.Client;
let container: StartedPostgreSqlContainer | undefined;
let created = false;
const name = `budget_periods_test_${String(process.pid)}`;

beforeAll(async () => {
  let url = process.env['E2E_BUDGET_PG_URL'];
  if (url === undefined || url === '') {
    container = await new PostgreSqlContainer('postgres:18.4').start();
    url = container.getConnectionUri();
  }
  const target = new URL(url);
  if (
    (container === undefined && !['localhost', '127.0.0.1', '[::1]'].includes(target.hostname)) ||
    target.pathname === '/transparenta_prod'
  )
    throw new Error('Disposable loopback database required');
  admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query(`create database ${name}`);
  created = true;
  target.pathname = `/${name}`;
  db = new Kysely<ProdDatabase>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: target.href }) }),
  });
  const root = process.env['SCRAPPER_REPO_ROOT'] ?? path.resolve('../hack-for-facts-eb-scrapper');
  for (const [file, digest] of Object.entries(migrationHashes)) {
    const filePath = path.join(root, 'src/db/prod-migrations', file);
    expect(createHash('sha256').update(readFileSync(filePath)).digest('hex')).toBe(digest);
    const migration = (await import(pathToFileURL(filePath).href)) as {
      up(db: Kysely<unknown>): Promise<void>;
    };
    await db.transaction().execute((tx) => migration.up(tx as unknown as Kysely<unknown>));
  }
  await sql`create table budget.scope_periods_angajamente_y2025
    partition of budget.scope_periods_angajamente for values from (2025) to (2026);
    insert into etl.load_runs(source_id,target_table) values ('fixture','budget.scope_periods');
    insert into core.organizations(cui,name,first_seen_source,privacy_class)
      values ('999','Restricted creditor','fixture','restricted');`.execute(db);
  await sql`insert into budget.reporting_calendar(calendar_version,stream,report_type,report_family,reporting_year,months,valid_from,listing_sha256,source_url)
    values (${hash},'angajamente',${rt},'detailed',2025,array[1,2,3,4,5,6,7,8,9,10,11,12],now(),${hash},'https://example.com/listing')`.execute(
    db
  );
  await period('quarter', 3, 1, 2, 'values', false);
  await period('gap', 8, 4, 2, 'values', true);
  await period('empty', 12, null, 2, 'source-empty-no-amounts', false);
  await period('zero', 12, 1, 3, 'declared-zero', true);
  await fact('quarter', 3, 2, '100.00', '100.00');
  await fact('gap', 8, 2, '25.00', '125.00');
  // Distinct source metrics detect crossed columns, exact cents exceed float precision.
  await fact('gap', 8, 2, '90071992547409.91', '90071992547509.91', 'large');
  await fact('gap', 8, 2, '999.00', '999.00', 'transfer', '51.01.01');
}, 180000);

afterAll(async () => {
  try {
    await db?.destroy();
  } finally {
    try {
      if (created) await admin.query(`drop database ${name} with (force)`);
    } finally {
      await admin?.end();
      await container?.stop();
    }
  }
});

async function period(
  id: string,
  month: number,
  start: number | null,
  sector: number,
  observation: string,
  latest: boolean
) {
  const candidate = createHash('sha256').update(id).digest('hex');
  await sql`insert into budget_staging.commitment_candidates
    (candidate_id,report_id,xml_sha256,parser_version,configuration_version,content_sha256,source,metadata,row_count,control_count)
    values (${candidate},${candidate},${hash},'fixture','fixture',${hash},'{}','{}',0,0)`.execute(
    db
  );
  const admitted = start !== null;
  const previous = start !== null && start > 1 ? start - 1 : null;
  const predecessor =
    previous === null ? null : createHash('sha256').update('quarter').digest('hex');
  await sql`insert into budget.scope_periods(
    stream,reporting_year,report_id,report_type,report_family,entity_cui,main_creditor_cui,budget_sector_id,reporting_month,
    calendar_version,candidate_id,source_url,xml_sha256,parser_version,configuration_version,membership_sha256,admission_sha256,build_run_id,
    report_status,observation,financially_admitted,continuity,is_latest_present,previous_present_month,expected_previous_month,
    previous_available_month,previous_base_candidate_id,previous_base_report_id,interval_start_month,months_covered,
    is_monthly,is_interval,is_quarterly,is_latest_ytd,is_year_end,quarter_span_months)
    values ('angajamente',2025,${id},${rt},'detailed','4505359','999',${sector},${month},
      ${hash},${candidate},${`https://example.com/${id}`},${hash},'fixture','fixture',${hash},${hash},1,
      'final',${observation},${admitted},'first',false,null,null,
      ${previous},${predecessor},${previous === null ? null : 'quarter'},${start},${start === null ? null : month - start + 1},
      ${start === month},${start !== null && month - start + 1 > 1},${admitted && month === 3},${latest},${admitted && month === 12},${admitted && month % 3 === 0 ? month : null})`.execute(
    db
  );
}

async function fact(
  id: string,
  month: number,
  sector: number,
  delta: string,
  ytd: string,
  key = 'line',
  economic = '10'
) {
  await sql`insert into budget.commitment_line_items(report_id,line_key,line_order,reporting_year,reporting_month,entity_cui,report_type,budget_sector_id,functional_code,economic_code,
    ${sql.join(COMMITMENT_PERIOD_METRICS.flatMap((m) => [sql.id(`monthly_${m}`), sql.id(`ytd_${m}`)]))},is_monthly,is_quarterly,is_yearly)
    values (${id},${key},1,2025,${month},'4505359',${rt},${sector},'65',${economic},
    ${sql.join(COMMITMENT_PERIOD_METRICS.flatMap((_, i) => [sql`${delta}::numeric+${i}`, sql`${ytd}::numeric+${i}`]))},true,false,false)`.execute(
    db
  );
  await sql`update budget.commitment_line_items f set
    main_creditor_cui=p.main_creditor_cui, interval_start_month=p.interval_start_month,
    months_covered=p.months_covered,previous_available_month=p.previous_available_month,
    is_monthly=p.is_monthly,is_interval=p.is_interval,is_quarterly=p.is_quarterly,
    is_latest_ytd=p.is_latest_ytd,is_year_end=p.is_year_end,is_yearly=p.is_latest_ytd,
    previous_boundary_month=p.previous_boundary_month,quarter_span_months=p.quarter_span_months,
    continuity=p.continuity,quarter=case when p.is_quarterly then p.reporting_month/3 end
    from budget.scope_periods p where p.stream='angajamente' and p.reporting_year=2025
      and p.report_id=f.report_id and f.report_id=${id} and f.reporting_year=2025
      and f.report_type=${rt}`.execute(db);
}

const read = async (changes: Partial<CommitmentPeriodQuery> = {}) =>
  (await listCommitmentPeriods(makeBudgetPeriodRepo(db), { ...query, ...changes }))._unsafeUnwrap();

describe('commitment period reader on real DDL', () => {
  it('keeps regular quarters and irregular intervals, exact metrics and protected creditor identity', async () => {
    const result = await read();
    expect(result.metadataAvailable).toBe(true);
    expect(result.total).toBe(4);
    const gap = result.items.find((row) => row.reportId === 'gap')!;
    expect(gap).toMatchObject({
      startMonth: 4,
      endMonth: 8,
      monthsCovered: 5,
      creditorCui: null,
      isLatestYtd: true,
    });
    expect(gap.amounts[0]).toEqual({
      metric: 'credite_angajament',
      interval: '90071992547434.91',
      ytd: '90071992547634.91',
    });
    expect(gap.amounts[12]).toEqual({
      metric: 'receptii_neplatite',
      interval: '90071992547458.91',
      ytd: '90071992547658.91',
    });
    expect(result.items[0]).toMatchObject({ reportId: 'quarter', isQuarterly: true });
  });
  it('preserves empty presence with unavailable amounts and admitted zero with zero amounts', async () => {
    const rows = (await read()).items;
    expect(
      rows
        .find((r) => r.reportId === 'empty')!
        .amounts.every((a) => a.interval === null && a.ytd === null)
    ).toBe(true);
    expect(
      rows
        .find((r) => r.reportId === 'zero')!
        .amounts.every((a) => a.interval === '0' && a.ytd === '0')
    ).toBe(true);
  });
  it('keeps whole-year mixed terminal coverage across endpoint filters and pages', async () => {
    const result = await read({ startMonth: 8, endMonth: 8, pageSize: 1 });
    expect(result).toMatchObject({ total: 1, earliestTerminalMonth: 8, latestTerminalMonth: 12 });
    expect(result.items[0]).toMatchObject({ startMonth: 4, endMonth: 8 });
    const beyond = await read({ page: 100 });
    expect(beyond).toMatchObject({
      total: 4,
      earliestTerminalMonth: 8,
      latestTerminalMonth: 12,
      items: [],
    });
  });
  it('returns unavailable for unprojected years and protects private entity results', async () => {
    expect(await read({ year: 2024 })).toMatchObject({
      metadataAvailable: false,
      total: 0,
      items: [],
    });
    await sql`insert into core.organizations(cui,name,first_seen_source,privacy_class) values ('4505359','private fixture','fixture','restricted')`.execute(
      db
    );
    try {
      expect(await read()).toEqual({
        metadataAvailable: false,
        total: 0,
        earliestTerminalMonth: null,
        latestTerminalMonth: null,
        items: [],
      });
    } finally {
      await sql`delete from core.organizations where cui='4505359'`.execute(db);
    }
  });
  it('refuses same-report legacy metadata and missing values facts', async () => {
    await sql`update budget.commitment_line_items set continuity=null where report_id='gap' and reporting_year=2025 and report_type=${rt}`.execute(
      db
    );
    try {
      expect(
        (await listCommitmentPeriods(makeBudgetPeriodRepo(db), query))._unsafeUnwrapErr().type
      ).toBe('ServiceUnavailable');
    } finally {
      await sql`update budget.commitment_line_items set continuity='first' where report_id='gap' and reporting_year=2025 and report_type=${rt}`.execute(
        db
      );
    }
    await period('missing-values', 10, 1, 4, 'values', true);
    try {
      expect(
        (await listCommitmentPeriods(makeBudgetPeriodRepo(db), query))._unsafeUnwrapErr().type
      ).toBe('ServiceUnavailable');
    } finally {
      await sql`delete from budget.scope_periods where stream='angajamente' and reporting_year=2025 and report_id='missing-values'`.execute(
        db
      );
    }
  });
  it('rejects invalid scope before SQL', async () => {
    for (const changes of [
      { startMonth: 9, endMonth: 8 },
      { pageSize: 101 },
      { cui: '1 OR true' },
      { year: 2025.1 },
    ]) {
      const result = await listCommitmentPeriods(makeBudgetPeriodRepo(db), {
        ...query,
        ...changes,
      });
      expect(result.isErr()).toBe(true);
    }
  });
  it('reads the same intervals after the actual strict-role activation migration', async () => {
    const root = process.env['SCRAPPER_REPO_ROOT'] ?? path.resolve('../hack-for-facts-eb-scrapper');
    const filePath = path.join(
      root,
      'src/db/prod-migrations',
      '20260910T012000__budget_period_roles_activation.ts'
    );
    expect(createHash('sha256').update(readFileSync(filePath)).digest('hex')).toBe(
      '0b4bb9912332989d7c5598d9f4e05ee7f8b9fb044065d9103437cf0379273ad2'
    );
    const migration = (await import(pathToFileURL(filePath).href)) as {
      up(db: Kysely<unknown>): Promise<void>;
    };
    await db.transaction().execute((tx) => migration.up(tx as unknown as Kysely<unknown>));
    expect((await read()).items.find((row) => row.reportId === 'gap')).toMatchObject({
      startMonth: 4,
      endMonth: 8,
      monthsCovered: 5,
    });
  });
});
