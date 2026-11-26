/**
 * PRIV-ZVPV: the API side of the IFRS-form series (scrapper migration
 * 20261125T190000, two read-only views).
 *
 * Each view is read in its OWN one-company statement, never folded into the
 * typed statements read: `ifrs_form_financials` behind the public gate, the
 * public-indicator witness and the parent rule of the long-format list, with
 * the file URL from the server's own gated join; `statement_reporting_form`
 * behind the public gate. Values are the view's exact text. A runtime that
 * cannot read the views answers unknown (null), never "none" and never an
 * error. A scripted driver stands in for PostgreSQL; nothing is executed.
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

import { makeCompaniesRepo } from '@/modules/companies/shell/repo/companies-repo.js';
import { mapIfrsFormYear, mapReportingFormMark } from '@/modules/companies/shell/repo/mappers.js';

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

/** Successful statements only: a rejected one is not in the log. */
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

const CUI = '1590082';
const IFRS_VIEW = '"companies_v2"."ifrs_form_financials" as "v"';
const FORM_VIEW = '"companies_v2"."statement_reporting_form" as "rf"';
const RESOURCES = '"companies_v2"."financial_source_resources"';
const TYPED_READ = 'from "companies_v2"."financials" as "fin"';
const ANAF_IFRS_LAYOUT = '464d1c40cac85eca14212758a48a73c3ba5b272d6fdc76e7943a6a8febbabd58';
const MFP_LAYOUT = 'b1'.repeat(32);
const FILE_2015 = 'https://data.gov.ro/dataset/s/resource/r2015/download/web_ir_an2015.txt';

/** A probe is the same builder with `limit 1`; a served read has none. */
const served = (statements: readonly Statement[], view: string): Statement[] =>
  statements.filter((s) => s.sql.includes(view) && !s.sql.includes('limit'));

/** OMV Petrom FY2015 as the view states it: a loss year, whole lei, no decimals. */
const ifrsRow = (over: Record<string, unknown> = {}) => ({
  year: 2015,
  source_system: 'mfp',
  reporting_form: 'ifrs',
  form_evidence: 'mfp_filer_class_ir',
  statement_profile_hash: MFP_LAYOUT,
  metric_rule_version: 'anaf-bilant-metric-v1',
  turnover: '13687616179',
  net_profit: '0',
  net_loss: '630646624',
  net_result: '-630646624',
  employees: '15581',
  source_snapshot_id: 'mfp:situatii_financiare_2015:2015:r2015',
  source_row_number: '412',
  resource_url: FILE_2015,
  ...over,
});

const markRow = (over: Record<string, unknown> = {}) => ({
  year: 2024,
  source_system: 'anaf',
  statement_profile_hash: ANAF_IFRS_LAYOUT,
  reporting_form: 'ifrs',
  form_evidence: 'anaf_statement_layout',
  ...over,
});

/** A typed statement row with only what the mark needs; every metric blank. */
const typedRow = (over: Record<string, unknown> = {}) => ({
  cui: CUI,
  year: 2024,
  source_system: 'anaf',
  source_snapshot_id: 'anaf:bilant:2024',
  statement_profile_hash: ANAF_IFRS_LAYOUT,
  metric_rule_version: 'anaf-bilant-metric-v1',
  source_url: `https://webservicesp.anaf.ro/bilant?an=2024&cui=${CUI}`,
  turnover: '100.00',
  net_profit: null,
  net_loss: null,
  employees: '5',
  lines: null,
  ...over,
});

/** Views answer `ifrs` and `marks`; typed statements `typed`; every probe and other read is empty. */
const views =
  (ifrs: readonly unknown[], marks: readonly unknown[], typed: readonly unknown[] = []) =>
  (sql: string): Answer => {
    if (sql.includes('limit')) return [];
    if (sql.includes(IFRS_VIEW)) return ifrs;
    if (sql.includes(FORM_VIEW)) return marks;
    return sql.includes(TYPED_READ) ? typed : [];
  };

const seriesOf = async (db: Kysely<ProdDatabase>) =>
  (await makeCompaniesRepo(db).getIfrsFormSeries(CUI))._unsafeUnwrap();

describe('the IFRS-form series: two one-company statements, each behind its own gates', () => {
  it('reads the IFRS-file years public, witnessed and parent-gated, with its own gated file URL', async () => {
    const { db, statements } = scriptedDb(views([ifrsRow()], []));
    await seriesOf(db);
    const reads = served(statements, IFRS_VIEW);
    expect(reads).toHaveLength(1);
    const text = reads[0]?.sql ?? '';
    const param = (re: RegExp) => reads[0]?.parameters[Number(re.exec(text)?.[1]) - 1];
    expect(param(/"v"\."cui" = \$(\d+)/u)).toBe(CUI);
    expect(param(/"v"\."privacy_class" = \$(\d+)/u)).toBe('public');
    // The long-format list's witness: a public line of the same CUI, year,
    // publisher, capture and layout.
    for (const pair of [
      '"i"."cui" = "v"."cui"',
      '"i"."year" = "v"."year"',
      '"i"."source_system" = "v"."source_system"',
      '"i"."source_snapshot_id" = "v"."source_snapshot_id"',
      '"i"."statement_profile_hash" = "v"."statement_profile_hash"',
    ]) {
      expect(text).toContain(pair);
    }
    expect(param(/"i"\."privacy_class" = \$(\d+)/u)).toBe('public');
    // The standalone parent rule.
    expect(text).toMatch(
      /not exists \(select "parent"\."org_id" from "core"\."organizations" as "parent" where "parent"\."cui" = "v"\."cui"/u
    );
    expect(param(/"parent"\."privacy_class" is distinct from \$(\d+)/u)).toBe('public');
    // The file URL: the server's own join with its public gate in ON, never
    // the view's ungated column; no selected-row locator leaves the view.
    expect(text).toMatch(
      /left join "companies_v2"\."financial_source_resources" as "res" on "res"\."source_system" = "v"\."source_system" and "res"\."source_snapshot_id" = "v"\."source_snapshot_id" and "res"\."privacy_class" = \$\d+/u
    );
    expect(param(/"res"\."privacy_class" = \$(\d+)/u)).toBe('public');
    expect(text).not.toMatch(
      /"v"\."source_url"|\bv\.source_url|source_statement_locator|selection_evidence/u
    );
    expect(text).toContain('order by "v"."year" desc');
    // Exact text for every figure: numeric and bigint never reach a JS number.
    for (const column of ['turnover', 'net_profit', 'net_loss', 'net_result', 'employees']) {
      expect(text).toContain(`v.${column}::text`);
    }
  });

  it('reads the form marks public and parent-gated, in a second statement', async () => {
    const { db, statements } = scriptedDb(views([], [markRow()]));
    await seriesOf(db);
    const reads = served(statements, FORM_VIEW);
    expect(reads).toHaveLength(1);
    const text = reads[0]?.sql ?? '';
    const param = (re: RegExp) => reads[0]?.parameters[Number(re.exec(text)?.[1]) - 1];
    expect(param(/"rf"\."cui" = \$(\d+)/u)).toBe(CUI);
    expect(param(/"rf"\."privacy_class" = \$(\d+)/u)).toBe('public');
    expect(param(/"parent"\."privacy_class" is distinct from \$(\d+)/u)).toBe('public');
    expect(text).not.toContain(IFRS_VIEW);
    expect(served(statements, IFRS_VIEW)[0]?.sql).not.toContain(FORM_VIEW);
  });

  it('never folds a view into the typed statements read, and never reads the stored net result', async () => {
    const { db, statements } = scriptedDb(views([], [markRow()], [typedRow()]));
    const repo = makeCompaniesRepo(db);
    const [year] = (await repo.getFinancials(CUI))._unsafeUnwrap();
    const typed = statements.filter((s) => s.sql.includes(TYPED_READ));
    expect(typed).toHaveLength(1);
    expect(typed[0]?.sql).not.toMatch(/ifrs_form_financials|statement_reporting_form/u);
    expect(typed[0]?.sql).not.toMatch(/"fin"\."net_result"|fin\.net_result\b/u);
    // The standalone typed read does not read the marks: the usecase adds them.
    expect(served(statements, FORM_VIEW)).toHaveLength(0);
    expect(year).toMatchObject({ reportingForm: null, formEvidence: null });
  });
});

describe('the IFRS-file years: the exact source text, never coalesced', () => {
  it('serves a loss year as filed: zero profit, the loss, a negative net result', async () => {
    const { db } = scriptedDb(views([ifrsRow()], []));
    expect((await seriesOf(db))?.years).toEqual([
      {
        year: 2015,
        sourceSystem: 'mfp',
        reportingForm: 'ifrs',
        formEvidence: 'mfp_filer_class_ir',
        turnover: '13687616179',
        netProfit: '0',
        netLoss: '630646624',
        netResult: '-630646624',
        employees: '15581',
        sourceUrl: FILE_2015,
        sourceSnapshotId: 'mfp:situatii_financiare_2015:2015:r2015',
        sourceRowNumber: '412',
        statementProfileHash: MFP_LAYOUT,
        metricRuleVersion: 'anaf-bilant-metric-v1',
      },
    ]);
  });

  it('keeps a blank null and a zero 0; a one-leg year has no net result', () => {
    const [year] = mapIfrsFormYear(
      ifrsRow({
        turnover: null,
        net_profit: null,
        net_loss: '5',
        net_result: null,
        employees: '0',
        source_row_number: null,
        resource_url: null,
      })
    );
    expect(year).toMatchObject({
      turnover: null,
      netProfit: null,
      netLoss: '5',
      netResult: null,
      employees: '0',
      sourceRowNumber: null,
      sourceUrl: null,
    });
  });

  it('drops a row whose form it does not know or whose identity is missing (never relabelled)', () => {
    expect(mapIfrsFormYear(ifrsRow({ reporting_form: 'us_gaap' }))).toEqual([]);
    expect(mapIfrsFormYear(ifrsRow({ reporting_form: 'IFRS' }))).toEqual([]);
    expect(mapIfrsFormYear(ifrsRow({ statement_profile_hash: null }))).toEqual([]);
    expect(mapIfrsFormYear(ifrsRow({ source_snapshot_id: null }))).toEqual([]);
    expect(mapIfrsFormYear(ifrsRow({ source_system: null }))).toEqual([]);
    expect(mapReportingFormMark(markRow({ reporting_form: 'ordinary' }))).toEqual([]);
    expect(mapReportingFormMark(markRow({ source_system: null }))).toEqual([]);
    expect(mapReportingFormMark(markRow())).toEqual([
      {
        year: 2024,
        sourceSystem: 'anaf',
        statementProfileHash: ANAF_IFRS_LAYOUT,
        reportingForm: 'ifrs',
        formEvidence: 'anaf_statement_layout',
      },
    ]);
  });

  it('serves newest first with the marks beside them; known none is two empty lists', async () => {
    const some = scriptedDb(views([ifrsRow({ year: 2018 }), ifrsRow({ year: 2017 })], [markRow()]));
    const series = await seriesOf(some.db);
    expect(series?.years.map((y) => y.year)).toEqual([2018, 2017]);
    expect(series?.marks).toHaveLength(1);
    const none = scriptedDb(views([], []));
    expect(await seriesOf(none.db)).toEqual({ years: [], marks: [] });
  });
});

describe('a runtime that cannot read the views answers unknown, never none', () => {
  it('no resources capability: no URL join and no URL, the figures stay', async () => {
    const { db, statements } = scriptedDb((sql) =>
      sql.includes(RESOURCES) && !sql.includes(IFRS_VIEW) && sql.includes('limit')
        ? pgError('42501')
        : views([ifrsRow({ resource_url: undefined })], [])(sql)
    );
    const series = await seriesOf(db);
    expect(served(statements, IFRS_VIEW)[0]?.sql).not.toContain(RESOURCES);
    expect(series?.years[0]).toMatchObject({ turnover: '13687616179', sourceUrl: null });
  });

  it('missing or ungranted views: null, probed with the exact reads, typed reads unaffected', async () => {
    for (const code of ['42P01', '42703', '42501']) {
      for (const missing of [IFRS_VIEW, FORM_VIEW]) {
        const { db, statements } = scriptedDb((sql) =>
          sql.includes(missing) ? pgError(code) : views([ifrsRow()], [markRow()], [typedRow()])(sql)
        );
        const repo = makeCompaniesRepo(db);
        expect((await repo.getIfrsFormSeries(CUI))._unsafeUnwrap()).toBeNull();
        // One capability for both views: neither is read once one is unreadable.
        expect(served(statements, IFRS_VIEW)).toHaveLength(0);
        expect(served(statements, FORM_VIEW)).toHaveLength(0);
        expect((await repo.getFinancials(CUI))._unsafeUnwrap()).toHaveLength(1);
      }
    }
  });

  it('the probe is the exact read of each view, without the optional URL join', async () => {
    const { db, statements } = scriptedDb(views([], []));
    await seriesOf(db);
    const probes = statements.filter((s) => s.sql.includes('limit'));
    const ifrsProbe = probes.find((s) => s.sql.includes(IFRS_VIEW));
    expect(ifrsProbe?.sql).toContain('v.net_result::text');
    expect(ifrsProbe?.sql).toContain('"companies_v2"."financial_indicators" as "i"');
    expect(ifrsProbe?.sql).not.toContain(RESOURCES);
    expect(ifrsProbe?.parameters).toContain('0');
    const formProbe = probes.find((s) => s.sql.includes(FORM_VIEW));
    expect(formProbe?.sql).toContain('"rf"."form_evidence"');
    expect(formProbe?.parameters).toContain('0');
  });

  it('unreadable views are re-probed after the retry window (a later migration is seen)', async () => {
    let migrated = false;
    const { db } = scriptedDb((sql) =>
      (sql.includes(IFRS_VIEW) || sql.includes(FORM_VIEW)) && !migrated
        ? pgError('42P01')
        : views([ifrsRow()], [])(sql)
    );
    const repo = makeCompaniesRepo(db);
    const now = vi.spyOn(Date, 'now');
    try {
      now.mockReturnValue(1_000_000);
      expect((await repo.getIfrsFormSeries(CUI))._unsafeUnwrap()).toBeNull();
      migrated = true;
      now.mockReturnValue(1_000_000 + 9 * 60 * 1000);
      expect((await repo.getIfrsFormSeries(CUI))._unsafeUnwrap()).toBeNull();
      now.mockReturnValue(1_000_000 + 11 * 60 * 1000);
      expect((await repo.getIfrsFormSeries(CUI))._unsafeUnwrap()?.years).toHaveLength(1);
    } finally {
      now.mockRestore();
    }
  });

  it('a capability lost after the probe drops the URL first, then reads unknown', async () => {
    const lostUrl = scriptedDb((sql) =>
      sql.includes(IFRS_VIEW) && !sql.includes('limit') && sql.includes(RESOURCES)
        ? pgError('42501')
        : views([ifrsRow({ resource_url: undefined })], [])(sql)
    );
    expect((await seriesOf(lostUrl.db))?.years[0]).toMatchObject({ year: 2015, sourceUrl: null });

    let viewReads = 0;
    const lostView = scriptedDb((sql) => {
      if (sql.includes(FORM_VIEW) && !sql.includes('limit')) {
        viewReads += 1;
        return pgError('42501');
      }
      return views([ifrsRow()], [])(sql);
    });
    const repo = makeCompaniesRepo(lostView.db);
    expect((await repo.getIfrsFormSeries(CUI))._unsafeUnwrap()).toBeNull();
    // With the URL join, then without it; not read again inside the retry window.
    expect(viewReads).toBe(2);
    expect((await repo.getIfrsFormSeries(CUI))._unsafeUnwrap()).toBeNull();
    expect(viewReads).toBe(2);
  });

  it('lost views do not take the file URLs of the other reads with them', async () => {
    const SELECTION = 'from "companies_v2"."financial_source_selection" as "s"';
    const { db, statements } = scriptedDb((sql) =>
      sql.includes(FORM_VIEW) && !sql.includes('limit') ? pgError('42501') : views([], [])(sql)
    );
    const repo = makeCompaniesRepo(db);
    expect((await repo.getIfrsFormSeries(CUI))._unsafeUnwrap()).toBeNull();
    // The retry without the URL join failed too: the resource join was not the cause.
    await repo.getLongFormOnlyStatements(CUI);
    const longForm = statements.filter(
      (s) => s.sql.includes(SELECTION) && !s.sql.includes('limit')
    );
    expect(longForm).toHaveLength(1);
    expect(longForm[0]?.sql).toContain(RESOURCES);
  });

  it('a typed read that loses another capability does not make the views unknown', async () => {
    // The qualification view passes its probe, then loses its grant: the typed
    // read falls back to the statements alone. The IFRS-form views were not part
    // of that statement and stay readable.
    const QUALIFICATION = '"companies_v2"."financial_qualification_active"';
    const { db } = scriptedDb((sql) =>
      sql.includes(QUALIFICATION) && !sql.includes('limit')
        ? pgError('42501')
        : views([ifrsRow()], [markRow()], [typedRow()])(sql)
    );
    const repo = makeCompaniesRepo(db);
    const [year] = (await repo.getFinancials(CUI))._unsafeUnwrap();
    expect(year?.qualification.reason).toBe('qualification_unavailable');
    expect((await repo.getIfrsFormSeries(CUI))._unsafeUnwrap()?.years).toHaveLength(1);
  });

  it('a real error on one view is never masked by a capability error on the other', async () => {
    for (const [denied, failing] of [
      [IFRS_VIEW, FORM_VIEW],
      [FORM_VIEW, IFRS_VIEW],
    ] as const) {
      // At the read: one view denied, the other timing out.
      const atRead = scriptedDb((sql) => {
        if (sql.includes('limit')) return [];
        if (sql.includes(denied)) return pgError('42501');
        return sql.includes(failing) ? pgError('57014') : [];
      });
      expect((await makeCompaniesRepo(atRead.db).getIfrsFormSeries(CUI)).isErr()).toBe(true);
      // At the probe: the read fails, and nothing is cached as unreadable.
      let broken = true;
      const atProbe = scriptedDb((sql) => {
        if (!broken) return views([ifrsRow()], [])(sql);
        if (sql.includes(denied)) return pgError('42501');
        return sql.includes(failing) ? pgError('57014') : [];
      });
      const repo = makeCompaniesRepo(atProbe.db);
      expect((await repo.getIfrsFormSeries(CUI)).isErr()).toBe(true);
      broken = false;
      expect((await repo.getIfrsFormSeries(CUI))._unsafeUnwrap()?.years).toHaveLength(1);
    }
  });

  it('concurrent reads after the retry window share one probe', async () => {
    let probes = 0;
    const { db } = scriptedDb((sql) => {
      if (sql.includes('limit')) probes += 1;
      // The views stay missing, so the capability set is never complete.
      return sql.includes(IFRS_VIEW) || sql.includes(FORM_VIEW)
        ? pgError('42P01')
        : views([], [], [typedRow()])(sql);
    });
    const repo = makeCompaniesRepo(db);
    const now = vi.spyOn(Date, 'now');
    try {
      now.mockReturnValue(1_000_000);
      await repo.getIfrsFormSeries(CUI);
      expect(probes).toBe(5);
      now.mockReturnValue(1_000_000 + 11 * 60 * 1000);
      await Promise.all([
        repo.getFinancials(CUI),
        repo.getLongFormOnlyStatements(CUI),
        repo.getIfrsFormSeries(CUI),
      ]);
      expect(probes).toBe(10);
    } finally {
      now.mockRestore();
    }
  });

  it('a real database error stays an error, never an empty or unknown answer', async () => {
    for (const code of ['57014', '08006']) {
      for (const failing of [IFRS_VIEW, FORM_VIEW]) {
        const { db } = scriptedDb((sql) =>
          sql.includes(failing) && !sql.includes('limit') ? pgError(code) : views([], [])(sql)
        );
        expect((await makeCompaniesRepo(db).getIfrsFormSeries(CUI)).isErr()).toBe(true);
      }
    }
  });

  it('refuses a malformed CUI before any statement', async () => {
    const { db, statements } = scriptedDb(views([], []));
    expect((await makeCompaniesRepo(db).getIfrsFormSeries('abc')).isErr()).toBe(true);
    expect(statements).toHaveLength(0);
  });
});

describe('the company profile marks its own typed years', () => {
  const profile =
    (marks: (sql: string) => Answer) =>
    (sql: string): Answer => {
      if (sql.includes('"core"."organizations"') && !sql.includes('"parent"')) {
        return [{ org_id: '1', cui: CUI, name: 'OMV PETROM SA' }];
      }
      if (sql.includes(FORM_VIEW) && !sql.includes('limit')) return marks(sql);
      return views([], [], [typedRow(), typedRow({ year: 2011, source_system: 'mfp' })])(sql);
    };
  const WITH_MARKS = { formMarks: true } as const;
  const financialsOf = async (db: Kysely<ProdDatabase>) =>
    (await makeCompaniesRepo(db).getProfileData(CUI, UNAVAILABLE_SCOPE, WITH_MARKS))._unsafeUnwrap()
      ?.financials ?? [];

  it('a profile that does not ask for the marks issues no statement for them', async () => {
    const { db, statements } = scriptedDb(profile(() => [markRow()]));
    const repo = makeCompaniesRepo(db);
    const plain = (await repo.getProfileData(CUI, UNAVAILABLE_SCOPE))._unsafeUnwrap();
    expect(plain?.financials.map((y) => y.reportingForm)).toEqual([null, null]);
    expect(served(statements, FORM_VIEW)).toHaveLength(0);
    expect(served(statements, IFRS_VIEW)).toHaveLength(0);
  });

  it('one extra one-company statement; the year of the same publisher and layout is marked', async () => {
    const { db, statements } = scriptedDb(profile(() => [markRow()]));
    const years = await financialsOf(db);
    expect(years.map((y) => [y.year, y.reportingForm, y.formEvidence])).toEqual([
      [2024, 'ifrs', 'anaf_statement_layout'],
      [2011, null, null],
    ]);
    expect(served(statements, FORM_VIEW)).toHaveLength(1);
    // The figures list is not part of the profile read.
    expect(served(statements, IFRS_VIEW)).toHaveLength(0);
    expect(statements.filter((s) => s.sql.includes(TYPED_READ))).toHaveLength(1);
  });

  it('a view lost after the probe leaves the years unmarked and the profile served', async () => {
    let attempts = 0;
    const { db } = scriptedDb(
      profile(() => {
        attempts += 1;
        return pgError('42501');
      })
    );
    const repo = makeCompaniesRepo(db);
    const first = (await repo.getProfileData(CUI, UNAVAILABLE_SCOPE, WITH_MARKS))._unsafeUnwrap();
    expect(first?.financials.map((y) => y.reportingForm)).toEqual([null, null]);
    expect(first?.financials).toHaveLength(2);
    // Not read again inside the retry window.
    await repo.getProfileData(CUI, UNAVAILABLE_SCOPE, WITH_MARKS);
    expect(attempts).toBe(1);
  });

  it('a real database error on the marks fails the profile that asked for them, and no other', async () => {
    const { db } = scriptedDb(profile(() => pgError('57014')));
    const repo = makeCompaniesRepo(db);
    expect((await repo.getProfileData(CUI, UNAVAILABLE_SCOPE, WITH_MARKS)).isErr()).toBe(true);
    expect((await repo.getProfileData(CUI, UNAVAILABLE_SCOPE)).isOk()).toBe(true);
  });

  it('two capabilities lost in one profile read are both remembered', async () => {
    const QUALIFICATION = '"companies_v2"."financial_qualification_active"';
    let markAttempts = 0;
    let qualifiedAttempts = 0;
    const { db } = scriptedDb((sql) => {
      if (sql.includes('"core"."organizations"') && !sql.includes('"parent"')) {
        return [{ org_id: '1', cui: CUI, name: 'OMV PETROM SA' }];
      }
      if (sql.includes('limit')) return [];
      if (sql.includes(FORM_VIEW)) {
        markAttempts += 1;
        return pgError('42501');
      }
      if (sql.includes(TYPED_READ) && sql.includes(QUALIFICATION)) {
        qualifiedAttempts += 1;
        return pgError('42501');
      }
      return sql.includes(TYPED_READ) ? [typedRow()] : [];
    });
    const repo = makeCompaniesRepo(db);
    for (let request = 0; request < 3; request += 1) {
      const data = (await repo.getProfileData(CUI, UNAVAILABLE_SCOPE, WITH_MARKS))._unsafeUnwrap();
      expect(data?.financials).toHaveLength(1);
    }
    // Neither fallback restores what the other one learned.
    expect(markAttempts).toBe(1);
    expect(qualifiedAttempts).toBe(1);
  });
});
