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
import { describe, expect, it } from 'vitest';

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
    expect(probes).toHaveLength(2);
    const viewProbe = probes.find((s) => s.sql.includes(VIEW));
    expect(viewProbe?.sql).toMatch(/"q"\."privacy_class" = \$\d+/u);
    expect(viewProbe?.sql).toContain('as "q_statuses"');
    expect(probes.find((s) => s.sql.includes(RESOURCES))?.sql).toMatch(
      /"res"\."privacy_class" = \$\d+/u
    );
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
