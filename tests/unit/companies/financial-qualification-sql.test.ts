/**
 * CD-14 / decision D1 — the API side of the common financial qualification
 * (evaluator sql-v1, scraper migration 20261003T170000).
 *
 * A financial read is ONE statement (one snapshot): the public statements,
 * their MFP resource URL and their qualification under the ACTIVE published
 * policy, each optional leg LEFT JOINed with its own public gate in ON. The
 * original source strings are never changed. A runtime that cannot read the
 * view (not migrated, not granted, lost after the probe) still serves every
 * statement, as `not_assessed / qualification_unavailable` — never as
 * reported. A scripted driver stands in for PostgreSQL; nothing is executed.
 */

import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type DatabaseConnection,
} from 'kysely';
import { describe, expect, it, vi } from 'vitest';

import {
  COMPANY_FINANCIAL_METRICS,
  type CompanyFinancialYear,
} from '@/modules/companies/core/types.js';
import { makeCompaniesRepo } from '@/modules/companies/shell/repo/companies-repo.js';
import {
  mapQualification,
  mapStatementSource,
  type FinancialRow,
} from '@/modules/companies/shell/repo/mappers.js';

import { UNAVAILABLE_SCOPE } from './registry-fixtures.js';

import type { ProdDatabase } from '@/modules/shared/index.js';

interface Statement {
  readonly sql: string;
  readonly parameters: readonly unknown[];
}

type Answer = readonly unknown[] | Error;

class ScriptedDriver extends DummyDriver {
  constructor(private readonly answer: (sql: string) => Answer) {
    super();
  }

  override acquireConnection(): Promise<DatabaseConnection> {
    const answer = this.answer;
    return Promise.resolve({
      executeQuery: (query) => {
        const result = answer(query.sql);
        return result instanceof Error
          ? Promise.reject(result)
          : Promise.resolve({ rows: [...result] as never[] });
      },
      streamQuery: async function* () {
        // never streamed by the companies repo
      },
    });
  }
}

const scriptedDb = (
  answer: (sql: string) => Answer
): { db: Kysely<ProdDatabase>; statements: Statement[] } => {
  const statements: Statement[] = [];
  const db = new Kysely<ProdDatabase>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new ScriptedDriver(answer),
      createIntrospector: (d) => new PostgresIntrospector(d),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
    log: (event) => {
      if (event.level === 'query') {
        statements.push({
          sql: event.query.sql.replace(/\s+/gu, ' '),
          parameters: event.query.parameters,
        });
      }
    },
  });
  return { db, statements };
};

const pgError = (code: string): Error => Object.assign(new Error(`pg ${code}`), { code });

const STATEMENT_READ = 'from "companies_v2"."financials" as "fin"';
const VIEW = '"companies_v2"."financial_qualification_active"';
const RESOURCES = '"companies_v2"."financial_source_resources"';
const SELECTION = 'from "companies_v2"."financial_source_selection" as "s"';
const INDICATORS = '"companies_v2"."financial_indicators" as "i"';

/** The q1-style statuses of a reviewed held observation (42443305 FY2020 shape). */
const HELD_STATUSES = COMPANY_FINANCIAL_METRICS.map((metric) =>
  ['turnover', 'total_revenue', 'net_profit'].includes(metric)
    ? 'held_observation'
    : metric === 'net_result'
      ? 'held_component'
      : metric === 'employees'
        ? 'reported'
        : 'missing'
);

const metricsNull = Object.fromEntries(
  [
    'total_expenses',
    'gross_profit',
    'gross_loss',
    'receivables',
    'current_assets',
    'fixed_assets',
    'cash_and_bank',
    'prepaid_expenses',
    'deferred_income',
    'subscribed_capital',
    'inventories',
    'debts',
    'provisions',
    'total_equity',
    'patrimony_regie',
  ].map((metric) => [metric, null])
);

/**
 * A synthetic statement row with an assessed, held qualification, as the
 * driver returns it (an untyped row: the `cui` the slice read selects included).
 */
const finRow = (overrides: Record<string, unknown> = {}): FinancialRow =>
  ({
    cui: '42443305',
    year: 2020,
    source_system: 'anaf',
    source_snapshot_id: 'anaf:bilant:2020',
    statement_profile_hash: 'a1'.repeat(32),
    metric_rule_version: 'anaf-bilant-metric-v1',
    source_url: 'https://webservicesp.anaf.ro/bilant?an=2020&cui=42443305',
    resource_url: null,
    turnover: '300000000000000',
    net_profit: '291000000000000',
    net_loss: null,
    employees: '3',
    total_revenue: '300000000000000',
    ...metricsNull,
    lines: null,
    q_release_id: '2',
    q_policy_sha256: 'e5'.repeat(32),
    q_policy_version: 'companies-analytics-admission-2026-10-02-q1',
    q_policy_approved_on: '2026-10-02',
    q_evaluator_version: 'sql-v1',
    q_assessment: 'assessed',
    q_assessment_reason: null,
    q_statuses: HELD_STATUSES,
    q_net_result_value: null,
    q_hold_reason: 'reviewed: turnover keyed 1,000,000x',
    q_hold_drift: [] as string[],
    ...overrides,
  }) as unknown as FinancialRow;

/** Probes succeed (no row), the statement read answers `rows`. */
const serving =
  (rows: readonly unknown[]) =>
  (sql: string): Answer =>
    sql.includes(STATEMENT_READ) ? rows : [];

const statementReads = (statements: readonly Statement[]): Statement[] =>
  statements.filter((s) => s.sql.includes(STATEMENT_READ));

const yearsOf = async (db: Kysely<ProdDatabase>): Promise<readonly CompanyFinancialYear[]> =>
  (await makeCompaniesRepo(db).getFinancials('42443305'))._unsafeUnwrap();

describe('one statement per financial read, every optional leg gated in ON', () => {
  it('joins the active qualification and the MFP resource in the same statement', async () => {
    const { db, statements } = scriptedDb(serving([finRow()]));
    await yearsOf(db);
    const reads = statementReads(statements);
    expect(reads).toHaveLength(1);
    const read = reads[0];
    const view =
      /left join "companies_v2"\."financial_qualification_active" as "q" on "q"\."cui" = "fin"\."cui" and "q"\."year" = "fin"\."year" and "q"\."privacy_class" = \$(\d+)/u.exec(
        read?.sql ?? ''
      );
    expect(view, read?.sql).not.toBeNull();
    expect(read?.parameters[Number(view?.[1]) - 1]).toBe('public');
    const resources =
      /left join "companies_v2"\."financial_source_resources" as "res" on "res"\."source_system" = "fin"\."source_system" and "res"\."source_snapshot_id" = "fin"\."source_snapshot_id" and "res"\."privacy_class" = \$(\d+)/u.exec(
        read?.sql ?? ''
      );
    expect(resources, read?.sql).not.toBeNull();
    expect(read?.parameters[Number(resources?.[1]) - 1]).toBe('public');
    // Never the stored generated net_result (it coalesces both sides to 0).
    expect(read?.sql).not.toMatch(/"fin"\."net_result"|fin\.net_result\b/u);
    // All 21 statuses travel as one array, in contract order.
    expect(read?.sql).toContain(
      `array[${COMPANY_FINANCIAL_METRICS.map((metric) => `"q"."${metric}_status"`).join(', ')}]::text[]`
    );
  });

  it('probes each capability once, gated, with the exact columns the read selects', async () => {
    const { db, statements } = scriptedDb(serving([finRow()]));
    const repo = makeCompaniesRepo(db);
    await repo.getFinancials('42443305');
    await repo.getFinancials('42443305');
    const probes = statements.filter((s) => !s.sql.includes(STATEMENT_READ));
    expect(probes).toHaveLength(3);
    const viewProbe = probes.find((s) => s.sql.includes(VIEW));
    expect(viewProbe?.sql).toMatch(/"q"\."privacy_class" = \$\d+/u);
    expect(viewProbe?.sql).toContain('as "q_statuses"');
    expect(
      probes.find((s) => s.sql.includes(RESOURCES) && !s.sql.includes(SELECTION))?.sql
    ).toMatch(/"res"\."privacy_class" = \$\d+/u);
    // The long-format probe is the exact read (ledger + witness + parent), without the URL.
    const selectionProbe = probes.find((s) => s.sql.includes(SELECTION));
    expect(selectionProbe?.sql).toContain(INDICATORS);
    expect(selectionProbe?.sql).not.toContain(RESOURCES);
  });

  it("selects the statement's own identity (CUI and snapshot) for its source link", async () => {
    const { db, statements } = scriptedDb(serving([finRow()]));
    await yearsOf(db);
    const read = statementReads(statements)[0]?.sql ?? '';
    expect(read).toContain('"fin"."cui"');
    expect(read).toContain('"fin"."source_snapshot_id"');
  });
});

describe('statement qualification served beside the untouched originals', () => {
  it('serves the 300-trillion held observation as its exact original, held, with the reviewed reason', async () => {
    const { db } = scriptedDb(serving([finRow()]));
    const [year] = await yearsOf(db);
    expect(year?.turnover).toBe('300000000000000');
    expect(year?.summary.totalRevenue).toBe('300000000000000');
    expect(year?.qualification).toMatchObject({
      assessment: 'assessed',
      evaluatorVersion: 'sql-v1',
      holdDrift: [],
      holdReason: 'reviewed: turnover keyed 1,000,000x',
      netResult: null,
      netResultStatus: 'held_component',
      policyApprovedOn: '2026-10-02',
      policySha256: 'e5'.repeat(32),
      policyVersion: 'companies-analytics-admission-2026-10-02-q1',
      reason: null,
      releaseId: '2',
    });
    expect(year?.qualification.metrics).toHaveLength(21);
    expect(year?.qualification.metrics.find((m) => m.metric === 'turnover')?.status).toBe(
      'held_observation'
    );
  });

  it('serves the evaluator net, and a genuine 0/0 as a reported zero', async () => {
    const statuses = COMPANY_FINANCIAL_METRICS.map(() => 'reported');
    const { db } = scriptedDb(
      serving([
        finRow({
          net_loss: '0.00',
          net_profit: '0.00',
          q_hold_reason: null,
          q_net_result_value: '0.00',
          q_statuses: statuses,
        }),
      ])
    );
    const [year] = await yearsOf(db);
    expect(year?.netProfit).toBe('0.00');
    expect(year?.qualification).toMatchObject({
      assessment: 'assessed',
      netResult: '0.00',
      netResultStatus: 'reported',
    });
  });

  it('nothing published: no_active_policy, no statuses, originals intact', async () => {
    const empty = Object.fromEntries(
      Object.keys(finRow())
        .filter((key) => key.startsWith('q_'))
        .map((key) => [key, null])
    );
    const { db } = scriptedDb(serving([finRow(empty)]));
    const [year] = await yearsOf(db);
    expect(year?.turnover).toBe('300000000000000');
    expect(year?.qualification).toMatchObject({
      assessment: 'not_assessed',
      metrics: [],
      netResult: null,
      reason: 'no_active_policy',
    });
  });

  it('carries the evaluator reason of a statement it did not assess', async () => {
    const { db } = scriptedDb(
      serving([
        finRow({
          q_assessment: 'not_assessed',
          q_assessment_reason: 'unrepresentable_reported_value',
          q_statuses: null,
        }),
      ])
    );
    const [year] = await yearsOf(db);
    expect(year?.qualification).toMatchObject({
      assessment: 'not_assessed',
      metrics: [],
      policyVersion: 'companies-analytics-admission-2026-10-02-q1',
      reason: 'unrepresentable_reported_value',
    });
  });
});

describe('a runtime that cannot read the evaluator still serves every statement', () => {
  it('missing or ungranted view: no join, originals + qualification_unavailable', async () => {
    for (const code of ['42P01', '42501']) {
      const { db, statements } = scriptedDb((sql) =>
        sql.includes(STATEMENT_READ) ? [finRow()] : sql.includes(VIEW) ? pgError(code) : []
      );
      const [year] = await yearsOf(db);
      expect(statementReads(statements)[0]?.sql).not.toContain(VIEW);
      expect(year?.turnover).toBe('300000000000000');
      expect(year?.qualification).toMatchObject({
        assessment: 'not_assessed',
        reason: 'qualification_unavailable',
      });
    }
  });

  it('a capability lost after the probe: the read is retried once without the optional joins', async () => {
    let failed = 0;
    const { db, statements } = scriptedDb((sql) => {
      if (sql.includes(STATEMENT_READ) && sql.includes(VIEW)) {
        failed += 1;
        return pgError('42501');
      }
      return sql.includes(STATEMENT_READ) ? [finRow()] : [];
    });
    const repo = makeCompaniesRepo(db);
    const [year] = (await repo.getFinancials('42443305'))._unsafeUnwrap();
    expect(failed).toBe(1);
    expect(year?.qualification.reason).toBe('qualification_unavailable');
    // The next read does not retry the lost join within the retry window.
    await repo.getFinancials('42443305');
    expect(failed).toBe(1);
    // Every read that succeeded (the log records only those) ran without it.
    const reads = statementReads(statements);
    expect(reads).toHaveLength(2);
    expect(reads.every((s) => !s.sql.includes(VIEW))).toBe(true);
  });

  it('a real database error is never masked by the fallback', async () => {
    const { db } = scriptedDb((sql) => (sql.includes(STATEMENT_READ) ? pgError('57014') : []));
    const result = await makeCompaniesRepo(db).getFinancials('42443305');
    expect(result.isErr()).toBe(true);
  });

  it('a probe failing for another reason fails the read and is not cached as unavailable', async () => {
    let probeFailed = false;
    const { db, statements } = scriptedDb((sql) => {
      if (!sql.includes(STATEMENT_READ) && sql.includes(VIEW) && !probeFailed) {
        probeFailed = true;
        return pgError('57014');
      }
      return sql.includes(STATEMENT_READ) ? [finRow()] : [];
    });
    const repo = makeCompaniesRepo(db);
    expect((await repo.getFinancials('42443305')).isErr()).toBe(true);
    // The next read probes again and serves the qualification.
    const [year] = (await repo.getFinancials('42443305'))._unsafeUnwrap();
    expect(year?.qualification.assessment).toBe('assessed');
    expect(statementReads(statements)).toHaveLength(1);
    expect(statementReads(statements)[0]?.sql).toContain(VIEW);
  });

  it('profile slices carry the same contract (latestFinancial)', async () => {
    // The spine row of the slice read (no registry edition: profile columns NULL).
    const slice = {
      cui: '42443305',
      org_id: '1',
      core_name: 'X',
      p_cui: null,
      is_vat_payer: null,
      is_inactive: null,
      anaf_as_of: null,
    };
    const { db } = scriptedDb((sql) =>
      sql.includes(STATEMENT_READ)
        ? [finRow()]
        : sql.includes('from core.organizations o')
          ? [slice]
          : []
    );
    const slices = (
      await makeCompaniesRepo(db).profileSlicesForCuis(['42443305'], UNAVAILABLE_SCOPE)
    )._unsafeUnwrap();
    const result = slices.get('42443305');
    expect(result?.latestFinancial?.turnover).toBe('300000000000000');
    expect(result?.latestFinancial?.qualification.metrics).toHaveLength(21);
  });
});

describe('statement source: the publisher URL, never guessed', () => {
  const source = (row: Partial<FinancialRow>) => mapStatementSource(finRow(row));

  it('ANAF: the stored bilanț endpoint; MFP: the exact data.gov.ro resource', () => {
    expect(source({})).toMatchObject({
      url: 'https://webservicesp.anaf.ro/bilant?an=2020&cui=42443305',
      urlKind: 'anaf_statement',
    });
    expect(
      source({
        resource_url: 'https://data.gov.ro/dataset/x/resource/y.txt',
        source_system: 'mfp',
        source_url: null,
        year: 2014,
      })
    ).toMatchObject({
      metricRuleVersion: 'anaf-bilant-metric-v1',
      sourceSystem: 'mfp',
      url: 'https://data.gov.ro/dataset/x/resource/y.txt',
      urlKind: 'mfp_resource',
    });
  });

  it('no recorded resource, or an arm of the other publisher, is no URL', () => {
    expect(source({ resource_url: null, source_system: 'mfp', source_url: null })).toMatchObject({
      url: null,
      urlKind: null,
    });
    expect(
      source({ resource_url: 'https://data.gov.ro/x', source_system: 'anaf', source_url: null })
    ).toMatchObject({ url: null, urlKind: null });
    expect(
      source({ resource_url: null, source_system: 'mfp', source_url: 'https://anaf.ro/x' })
    ).toMatchObject({ url: null, urlKind: null });
  });

  const BARE = 'https://webservicesp.anaf.ro/bilant';
  const ford2024 = {
    cui: '6488696',
    year: 2024,
    source_snapshot_id: 'anaf:bilant:2024',
    source_url: BARE,
  };

  it("ANAF bare endpoint (400): the statement's OWN year/CUI query, kind unchanged", () => {
    expect(source(ford2024)).toMatchObject({
      url: 'https://webservicesp.anaf.ro/bilant?an=2024&cui=6488696',
      urlKind: 'anaf_statement',
      statementProfileHash: 'a1'.repeat(32),
    });
  });

  it('a batch maps each row to its own CUI, never a shared one', () => {
    const urls = [finRow(ford2024), finRow({ ...ford2024, cui: '1590082' })].map(
      (row) => mapStatementSource(row).url
    );
    expect(urls).toEqual([
      'https://webservicesp.anaf.ro/bilant?an=2024&cui=6488696',
      'https://webservicesp.anaf.ro/bilant?an=2024&cui=1590082',
    ]);
  });

  it("a stored query of THIS statement yields the canonical query; another statement's is never advertised", () => {
    const canonical = 'https://webservicesp.anaf.ro/bilant?an=2020&cui=42443305';
    for (const own of [
      canonical,
      'https://webservicesp.anaf.ro/bilant?cui=42443305&an=2020',
      // Stored userinfo, fragment or default port is never passed on.
      'https://user:secret@webservicesp.anaf.ro/bilant?an=2020&cui=42443305',
      'https://webservicesp.anaf.ro/bilant?an=2020&cui=42443305#frag',
      'https://webservicesp.anaf.ro:443/bilant?cui=42443305&an=2020#x',
    ]) {
      expect(source({ source_url: own }), own).toMatchObject({
        url: canonical,
        urlKind: 'anaf_statement',
      });
    }
    for (const foreign of [
      'https://webservicesp.anaf.ro/bilant?an=2020&cui=6488696',
      'https://webservicesp.anaf.ro/bilant?an=2019&cui=42443305',
      'https://webservicesp.anaf.ro/bilant?an=2020&cui=42443305&x=1',
      'https://evil.example/bilant?an=2020&cui=42443305',
      'not a url',
    ]) {
      expect(source({ source_url: foreign }), foreign).toMatchObject({ url: null, urlKind: null });
    }
  });

  it('a malformed identity or a snapshot of another year binds no query', () => {
    for (const bad of [
      { source_snapshot_id: 'anaf:bilant:2023' },
      { source_snapshot_id: 'anaf:bilant' },
      { cui: 'RO6488696' },
      { cui: '06488696' },
      { cui: '12345678901' },
      { year: 0, source_snapshot_id: 'anaf:bilant:0' },
    ]) {
      expect(source({ ...ford2024, ...bad }), JSON.stringify(bad)).toMatchObject({
        url: null,
        urlKind: null,
      });
    }
  });

  it('values and the MFP arm are untouched by the ANAF binding', () => {
    const anaf = mapStatementSource(finRow(ford2024));
    const mfp = source({
      resource_url: 'https://data.gov.ro/x.txt',
      source_system: 'mfp',
      source_snapshot_id: 'mfp:situatii_financiare_2021:2013:13dec119',
      source_url: null,
    });
    expect(mfp).toMatchObject({ url: 'https://data.gov.ro/x.txt', urlKind: 'mfp_resource' });
    expect(anaf.metricRuleVersion).toBe('anaf-bilant-metric-v1');
  });
});

describe('long-format-only statements: witnessed ledger metadata, never figures', () => {
  const LONG_CUI = '1590082';
  const OMV_2013_URL =
    'https://data.gov.ro/dataset/f8353c0e-fee9-4aa3-b26d-be0e96c328a7/resource/13dec119-4013-4689-90e0-52da4c69d3ea/download/web_ir_an2013.txt';
  /** An OMV-shaped `selected_long_only` row (FY2013 lives in the 2021 package). */
  const longRow = (year: number, over: Record<string, unknown> = {}) => ({
    year,
    source_system: 'mfp',
    filer_class: 'ir',
    source_snapshot_id:
      year === 2013
        ? 'mfp:situatii_financiare_2021:2013:13dec119-4013-4689-90e0-52da4c69d3ea'
        : `mfp:situatii_financiare_${String(year)}:${String(year)}:r${String(year)}`,
    // FY2013: the real captured file (2021 package, `web_ir_an2013.txt`), passed verbatim.
    resource_url: year === 2013 ? OMV_2013_URL : `https://data.gov.ro/x/r${String(year)}.txt`,
    ...over,
  });
  const LONG_ROWS = [2018, 2017, 2016, 2015, 2014, 2013, 2012].map((year) => longRow(year));
  const isLongRead = (sql: string) => sql.includes(SELECTION) && sql.includes('order by');
  /** The served reads (the probe is the same builder with `limit 1`). */
  const longReads = (statements: readonly Statement[]) =>
    statements.filter((s) => isLongRead(s.sql) && !s.sql.includes('limit'));
  const ledger =
    (rows: readonly unknown[]) =>
    (sql: string): Answer =>
      isLongRead(sql) ? rows : [];

  it('one PK-bounded statement: public, live, long-only, mfp, witnessed, parent-gated, URL gated in ON', async () => {
    const { db, statements } = scriptedDb(ledger(LONG_ROWS));
    await makeCompaniesRepo(db).getLongFormOnlyStatements(LONG_CUI);
    const [read] = longReads(statements);
    const text = read?.sql ?? '';
    const param = (re: RegExp) => read?.parameters[Number(re.exec(text)?.[1]) - 1];
    expect(param(/"s"\."cui" = \$(\d+)/u)).toBe(LONG_CUI);
    expect(param(/"s"\."privacy_class" = \$(\d+)/u)).toBe('public');
    expect(text).toContain('"s"."deleted_at" is null');
    expect(param(/"s"\."selection_status" = \$(\d+)/u)).toBe('selected_long_only');
    expect(param(/"s"\."source_system" = \$(\d+)/u)).toBe('mfp');
    // The same-identity public witness: CUI, year, publisher, snapshot, layout
    // (the predicate proven on the seven OMV rows; no digest/row legs).
    expect(text).toContain(INDICATORS);
    for (const pair of [
      '"i"."cui" = "s"."cui"',
      '"i"."year" = "s"."fiscal_year"',
      '"i"."source_system" = "s"."source_system"',
      '"i"."source_snapshot_id" = "s"."source_snapshot_id"',
      '"i"."statement_profile_hash" = "s"."statement_profile_hash"',
    ]) {
      expect(text).toContain(pair);
    }
    expect(param(/"i"\."privacy_class" = \$(\d+)/u)).toBe('public');
    // File-level only: no digest/row leg, and no physical row locator is projected.
    expect(text).not.toMatch(
      /response_hash|source_capture_digest|source_row_number|selected_statement_locator/u
    );
    // The standalone parent rule of getFinancials.
    expect(text).toMatch(
      /not exists \(select "parent"\."org_id" from "core"\."organizations" as "parent"/u
    );
    expect(param(/"parent"\."privacy_class" is distinct from \$(\d+)/u)).toBe('public');
    // A non-string evidence value is never stringified into a class.
    expect(text).toContain("jsonb_typeof(s.selection_evidence -> 'filer_class') = 'string'");
    expect(param(/"res"\."privacy_class" = \$(\d+)/u)).toBe('public');
    expect(text).toContain('order by "s"."fiscal_year" desc');
    // Metadata only: no value, evidence blob or storage key leaves the ledger.
    expect(text).not.toMatch(/value_numeric|"s"\."candidates"|object_key|object_bucket/u);
  });

  it('OMV shape: seven attributed years, the exact anchor snapshot and file, IFRS class verbatim', async () => {
    const { db } = scriptedDb(ledger(LONG_ROWS));
    const out = (await makeCompaniesRepo(db).getLongFormOnlyStatements(LONG_CUI))._unsafeUnwrap();
    expect(out?.map((s) => s.year)).toEqual([2018, 2017, 2016, 2015, 2014, 2013, 2012]);
    expect(out?.find((s) => s.year === 2013)).toEqual({
      year: 2013,
      sourceSystem: 'mfp',
      filerClass: 'ir',
      sourceSnapshotId: 'mfp:situatii_financiare_2021:2013:13dec119-4013-4689-90e0-52da4c69d3ea',
      resourceUrl: OMV_2013_URL,
    });
  });

  it('a missing URL or class stays null without hiding the observation', async () => {
    const { db } = scriptedDb(ledger([longRow(2012, { resource_url: null, filer_class: null })]));
    const [only] =
      (await makeCompaniesRepo(db).getLongFormOnlyStatements(LONG_CUI))._unsafeUnwrap() ?? [];
    expect(only).toMatchObject({ year: 2012, filerClass: null, resourceUrl: null });
  });

  it('known none is [], an unreadable ledger or witness is null (unknown), typed reads unaffected', async () => {
    const none = scriptedDb(ledger([]));
    expect(
      (await makeCompaniesRepo(none.db).getLongFormOnlyStatements(LONG_CUI))._unsafeUnwrap()
    ).toEqual([]);
    for (const code of ['42P01', '42703', '42501']) {
      const { db, statements } = scriptedDb((sql) =>
        sql.includes(SELECTION) ? pgError(code) : sql.includes(STATEMENT_READ) ? [finRow()] : []
      );
      const repo = makeCompaniesRepo(db);
      expect((await repo.getLongFormOnlyStatements(LONG_CUI))._unsafeUnwrap()).toBeNull();
      const [year] = (await repo.getFinancials('42443305'))._unsafeUnwrap();
      expect(year?.qualification.assessment).toBe('assessed');
      expect(longReads(statements)).toHaveLength(0);
    }
  });

  it('a capability lost after the probe drops the URL first, then reads unknown', async () => {
    // Resources lost: retried once without the URL join.
    const lostUrl = scriptedDb((sql) =>
      isLongRead(sql)
        ? sql.includes(RESOURCES)
          ? pgError('42501')
          : [longRow(2012, { resource_url: undefined })]
        : []
    );
    const repoA = makeCompaniesRepo(lostUrl.db);
    const [a] = (await repoA.getLongFormOnlyStatements(LONG_CUI))._unsafeUnwrap() ?? [];
    expect(a).toMatchObject({ year: 2012, resourceUrl: null });
    // The ledger itself lost: unknown, and not re-read inside the retry window.
    let ledgerReads = 0;
    const lostLedger = scriptedDb((sql) => {
      // The probe (same builder, `limit 1`) passes; the grant is gone by the read.
      if (isLongRead(sql) && !sql.includes('limit')) {
        ledgerReads += 1;
        return pgError('42501');
      }
      return [];
    });
    const repoB = makeCompaniesRepo(lostLedger.db);
    expect((await repoB.getLongFormOnlyStatements(LONG_CUI))._unsafeUnwrap()).toBeNull();
    expect(ledgerReads).toBe(2);
    expect((await repoB.getLongFormOnlyStatements(LONG_CUI))._unsafeUnwrap()).toBeNull();
    expect(ledgerReads).toBe(2);
  });

  it('an unreadable ledger is re-probed after the retry window (a later grant is seen)', async () => {
    let granted = false;
    const { db } = scriptedDb((sql) =>
      sql.includes(SELECTION) && !granted ? pgError('42501') : ledger(LONG_ROWS)(sql)
    );
    const repo = makeCompaniesRepo(db);
    const now = vi.spyOn(Date, 'now');
    try {
      now.mockReturnValue(1_000_000);
      expect((await repo.getLongFormOnlyStatements(LONG_CUI))._unsafeUnwrap()).toBeNull();
      granted = true;
      now.mockReturnValue(1_000_000 + 9 * 60 * 1000);
      expect((await repo.getLongFormOnlyStatements(LONG_CUI))._unsafeUnwrap()).toBeNull();
      now.mockReturnValue(1_000_000 + 11 * 60 * 1000);
      expect((await repo.getLongFormOnlyStatements(LONG_CUI))._unsafeUnwrap()).toHaveLength(7);
    } finally {
      now.mockRestore();
    }
  });

  it('a real database error stays an error, never an empty or unknown answer', async () => {
    for (const code of ['57014', '08006']) {
      const { db } = scriptedDb((sql) => (isLongRead(sql) ? pgError(code) : []));
      expect((await makeCompaniesRepo(db).getLongFormOnlyStatements(LONG_CUI)).isErr()).toBe(true);
    }
  });
});

describe('the qualification contract fails closed', () => {
  const assessed = finRow({
    q_net_result_value: '5.00',
    q_statuses: COMPANY_FINANCIAL_METRICS.map(() => 'reported'),
  });

  it('accepts exactly the 21 known statuses of the known evaluator', () => {
    expect(mapQualification(assessed, true).assessment).toBe('assessed');
  });

  it.each([
    ['an unknown evaluator', { q_evaluator_version: 'sql-v2' }],
    ['an unknown assessment', { q_assessment: 'maybe' }],
    ['an incomplete status list', { q_statuses: ['reported'] }],
    ['an unknown status', { q_statuses: COMPANY_FINANCIAL_METRICS.map(() => 'admitted') }],
    [
      'a NULL status',
      { q_statuses: COMPANY_FINANCIAL_METRICS.map((m) => (m === 'debts' ? null : 'reported')) },
    ],
    ['a reported net without value', { q_net_result_value: null }],
    ['a net that is not a plain decimal', { q_net_result_value: 'NaN' }],
  ])('%s is qualification_malformed, never reported', (_name, overrides) => {
    const out = mapQualification({ ...assessed, ...overrides }, true);
    expect(out).toMatchObject({
      assessment: 'not_assessed',
      metrics: [],
      reason: 'qualification_malformed',
    });
  });

  it('a value for a net that is not reported is malformed too', () => {
    const statuses = COMPANY_FINANCIAL_METRICS.map((m) =>
      m === 'net_result' ? 'held_profile' : 'reported'
    );
    expect(
      mapQualification({ ...assessed, q_net_result_value: '1.00', q_statuses: statuses }, true)
        .reason
    ).toBe('qualification_malformed');
  });
});

describe('MFP statement provenance: every contributing file line (CQA-14)', () => {
  const PROVENANCE = 'from companies_v2.financial_indicators i';
  const LEDGER = 'from companies_v2.financial_source_selection s';
  const named = (codes: readonly string[]) =>
    codes.map((code) => ({ code, name: `name of ${code}` }));
  /** The CUI21195169 FY2009 cross-copy union as the provenance read aggregates it. */
  const UNION = [
    {
      sourceSnapshotId: 'mfp:situatii_financiare_2009:2009:99a5b745-f230-4b1d-b263-f7c86733e383',
      rowNumber: '76930',
      url: 'https://data.gov.ro/dataset/x/resource/99a5b745/download/webblbsslan2009.txt',
      indicators: named([
        'I1',
        'I2',
        'I4',
        'I5',
        'I7',
        'I10',
        'I11',
        'I14',
        'I15',
        'I16',
        'I17',
        'I19',
        'I21',
      ]),
    },
    {
      sourceSnapshotId: 'mfp:situatii_financiare_2009:2009:9a037f07-56f7-4620-89d3-f6f957edf706',
      rowNumber: '609557',
      url: 'https://data.gov.ro/dataset/x/resource/9a037f07/download/web2009.txt',
      indicators: named(['I3', 'I6', 'I8', 'I9', 'I12', 'I13', 'I18', 'I20']),
    },
  ];
  const mfpUnion = (contributions: unknown = UNION) =>
    finRow({
      cui: '21195169',
      year: 2009,
      source_system: 'mfp',
      source_snapshot_id: UNION[0]?.sourceSnapshotId,
      source_url: null,
      resource_url: UNION[0]?.url,
      selection_basis: 'cross_copy_union',
      contributions,
    });

  it('the single-company reads select the ledger basis and the public contributing lines', async () => {
    const { db, statements } = scriptedDb(serving([mfpUnion()]));
    const years = (await makeCompaniesRepo(db).getFinancials('21195169'))._unsafeUnwrap();
    const read = statementReads(statements)[0]?.sql ?? '';
    expect(read).toContain(LEDGER);
    expect(read).toContain(PROVENANCE);
    // Each provenance relation keeps its own public gate and the statement's own identity.
    for (const gate of [
      "s.privacy_class = 'public'",
      "i.privacy_class = 'public'",
      "res.privacy_class = 'public'",
    ]) {
      expect(read).toContain(gate);
    }
    expect(read).toContain("s.selection_status = 'selected_typed'");
    expect(read).toContain(
      'i.statement_profile_hash is not distinct from fin.statement_profile_hash'
    );
    expect(read).toContain('order by g.anchor desc');
    expect(years[0]?.source).toMatchObject({
      url: UNION[0]?.url,
      urlKind: 'mfp_resource',
      selectionBasis: 'cross_copy_union',
      contributingSources: UNION,
    });
  });

  it('the list slices never pay for provenance', async () => {
    const { db, statements } = scriptedDb(serving([]));
    await makeCompaniesRepo(db).profileSlicesForCuis(['21195169'], UNAVAILABLE_SCOPE);
    const reads = statementReads(statements);
    expect(reads.length).toBeGreaterThan(0);
    for (const read of reads) expect(read.sql).not.toContain(PROVENANCE);
  });

  it('a runtime that cannot read the ledger serves the statement without provenance', async () => {
    const { db, statements } = scriptedDb((sql) =>
      sql.includes(SELECTION) ? pgError('42501') : sql.includes(STATEMENT_READ) ? [finRow()] : []
    );
    const years = (await makeCompaniesRepo(db).getFinancials('42443305'))._unsafeUnwrap();
    expect(statementReads(statements)[0]?.sql).not.toContain(PROVENANCE);
    expect(years[0]?.source).toMatchObject({ selectionBasis: null, contributingSources: null });
  });

  it('a ledger lost after the probe, with no other capability: one retry without provenance', async () => {
    // Qualification and resources are unreadable from the start; the ledger
    // probe passes, then the provenance read loses its grant (a failed query
    // is not in the statement log, so attempts are counted here).
    for (const read of [
      (repo: ReturnType<typeof makeCompaniesRepo>) =>
        repo.getFinancials('21195169').then((r) => r._unsafeUnwrap()),
      (repo: ReturnType<typeof makeCompaniesRepo>) =>
        repo
          .getProfileData('21195169', UNAVAILABLE_SCOPE)
          .then((r) => r._unsafeUnwrap()?.financials ?? []),
    ]) {
      let provenanceAttempts = 0;
      const answer = (sql: string): Answer => {
        if (!sql.includes(STATEMENT_READ)) {
          return sql.includes(VIEW) || (sql.includes(RESOURCES) && !sql.includes(SELECTION))
            ? pgError('42501')
            : sql.includes('"core"."organizations"') && !sql.includes('"parent"')
              ? [{ org_id: '1', cui: '21195169', name: 'X SRL' }]
              : [];
        }
        if (sql.includes(PROVENANCE)) {
          provenanceAttempts += 1;
          return pgError('42501');
        }
        // The retried read selects no provenance column, so its row carries none.
        const plain: Record<string, unknown> = { ...mfpUnion() };
        delete plain['selection_basis'];
        delete plain['contributions'];
        return [plain];
      };
      const { db, statements } = scriptedDb(answer);
      const years = await read(makeCompaniesRepo(db));
      expect(provenanceAttempts).toBe(1);
      expect(years).toHaveLength(1);
      expect(years[0]?.source).toMatchObject({ selectionBasis: null, contributingSources: null });
      const reads = statementReads(statements);
      expect(reads).toHaveLength(1);
      expect(reads[0]?.sql).not.toContain(PROVENANCE);
    }
  });

  it('a readable ledger without the resource capability keeps the contributors, URLs null', async () => {
    const lines = UNION.map((line) => ({ ...line, url: null }));
    const { db, statements } = scriptedDb((sql) =>
      sql.includes(STATEMENT_READ)
        ? [mfpUnion(lines)]
        : sql.includes(RESOURCES) && !sql.includes(SELECTION)
          ? pgError('42501')
          : []
    );
    const years = (await makeCompaniesRepo(db).getFinancials('21195169'))._unsafeUnwrap();
    const read = statementReads(statements)[0]?.sql ?? '';
    expect(read).toContain(PROVENANCE);
    expect(read).toContain('null::text as url');
    expect(read).not.toContain('max(res.captured_source_url)');
    expect(years[0]?.source.contributingSources).toEqual(lines);
  });

  it('maps MFP lines strictly; ANAF and unread provenance are null', () => {
    const mapped = mapStatementSource(
      finRow({
        source_system: 'mfp',
        source_url: null,
        contributions: [
          UNION[1],
          { rowNumber: '1' },
          'x',
          { sourceSnapshotId: 'mfp:a', indicators: [{ code: 'I1' }, { name: 'no code' }, 7] },
        ],
      })
    );
    expect(mapped.contributingSources).toEqual([
      UNION[1],
      {
        sourceSnapshotId: 'mfp:a',
        rowNumber: null,
        url: null,
        indicators: [{ code: 'I1', name: null }],
      },
    ]);
    expect(mapStatementSource(finRow({ contributions: UNION })).contributingSources).toBeNull();
    expect(
      mapStatementSource(finRow({ source_system: 'mfp', source_url: null })).contributingSources
    ).toBeNull();
    expect(
      mapStatementSource(finRow({ source_system: 'mfp', source_url: null, contributions: [] }))
        .contributingSources
    ).toEqual([]);
    expect(mapStatementSource(finRow({})).selectionBasis).toBeNull();
  });
});
