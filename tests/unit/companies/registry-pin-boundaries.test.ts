/**
 * Companies unit tests — the ONRC registry pin / recheck / retry / refuse
 * boundary end to end (no DB): port fakes for the usecase orchestration, and a
 * scripted Kysely driver under the REAL repository SQL path for the capture,
 * the recheck and the reads.
 *
 *  - The eager snapshot rechecks ONCE, after every eager read (flows and diff
 *    included): a parent restricted or a publication withdrawn while a flows
 *    read is pending never lets the earlier payload escape, through the
 *    usecase or the MCP handler.
 *  - The mandatory parent-privacy recheck fails closed, also under an
 *    `unavailable` scope (the repository's own catch, through `runPinned`).
 *  - Registry criteria under a non-published scope are refused before every
 *    empty-list shortcut, on the one usecase every transport calls.
 *  - The two-edition diff never compares incomplete value sets.
 *  - A partial registry footprint pins `unavailable` at capture; a capability
 *    lost after the capture discards the attempt and re-pins, keeping the
 *    fiscal/financial content and the parent-privacy recheck.
 */

import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type DatabaseConnection,
} from 'kysely';
import { err, ok } from 'neverthrow';
import { describe, expect, it, vi } from 'vitest';

import {
  COMPANY_ACCESS_UNREADABLE_MESSAGE,
  REGISTRY_MOVED_MESSAGE,
  noRegistryEvidence,
  registryCapabilityLost,
  registryScopeKey,
  runPinned,
  scopeFromKey,
  unavailableRegistry,
  type CompanyRegistryEnvelope,
} from '@/modules/companies/core/registry.js';
import {
  diffRegistryEditions,
  makeCompanyList,
  makeCompanyProfile,
  makeCompanyProfileData,
  makeCompanyRegistrationDiff,
} from '@/modules/companies/core/usecases.js';
import { makeCompaniesContributor } from '@/modules/companies/shell/contributor.js';
import { makeCompaniesResolvers } from '@/modules/companies/shell/graphql/resolvers.js';
import { makeCompaniesMcpTools } from '@/modules/companies/shell/mcp/tools.js';
import { makeCompaniesRepo } from '@/modules/companies/shell/repo/companies-repo.js';
import { DIFF_VALUE_BOUND } from '@/modules/companies/shell/repo/registry-sql.js';

import {
  NEXT_EDITION_SCOPE,
  PUBLISHED_SCOPE,
  UNAVAILABLE_SCOPE,
  UNPUBLISHED_SCOPE,
  WITHDRAWN_SCOPE,
  recheckOf,
} from './registry-fixtures.js';
import { stubFlows, stubRepo } from './repo-fixtures.js';

import type { CompaniesRepository, CompanyProfileData } from '@/modules/companies/core/ports.js';
import type {
  CompanyRegistrationDiffData,
  CompanyRegistrationEditionSide,
} from '@/modules/companies/core/types.js';
import type {
  ContributorRegistry,
  FilterInput,
  FlowsRepo,
  McpToolOutput,
  ProdDatabase,
} from '@/modules/shared/index.js';

const CUI = '2816464';
const WITHHELD_11 = '99999999999';
const PAGE = { page: 1, pageSize: 20 };

// ── port fakes (usecase orchestration) ────────────────────────────────────────

/** A profile as the repo assembles it under `scope`: edition values only when published. */
const profileUnder = (scope: CompanyRegistryEnvelope): CompanyProfileData => {
  const published = scope.state === 'published';
  return {
    cui: CUI,
    orgId: '1517396',
    name: published ? 'ONRC NAME SRL' : 'CORE NAME',
    nameSource: published ? 'onrc_edition' : 'core_organization',
    legalForm: published ? 'SRL' : null,
    codInmatriculare: null,
    registrationDate: null,
    registrationDatePresent: false,
    headlineStatus: null,
    statusFlags: [],
    territory: null,
    address: { display: '', county: null, locality: null },
    registry: noRegistryEvidence(scope),
    fiscal: {
      vatPayer: true,
      declaredFiscallyInactive: false,
      mainCaenCode: null,
      mainCaenRev: null,
      registeredName: null,
      asOf: '2026-06-15',
    },
    caenActivities: [],
    representatives: [],
    financials: [],
    euBranches: [],
    asOf: { onrc: published ? scope.sourcePublishedAt : null, anaf: '2026-06-15' },
  };
};

const latch = (): { promise: Promise<void>; release: () => void } => {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
};

/**
 * Flows whose FIRST summary read stays pending until `release()`: the window
 * in which the test restricts the parent or withdraws the publication.
 */
const gatedFlows = (events: string[]) => {
  const gate = latch();
  const entered = latch();
  let calls = 0;
  const flows: FlowsRepo = {
    ...stubFlows(),
    getFlowSummary: vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        entered.release();
        await gate.promise;
      }
      events.push('flows-read');
      return ok({
        direction: 'in' as const,
        count: 2,
        totalAmountRon: '1500.00',
        minYear: 2024,
        maxYear: 2024,
        byFlowType: [],
        byYear: [],
      });
    }),
  };
  return { flows, started: entered.promise, release: gate.release };
};

const mcpTool = (deps: Parameters<typeof makeCompaniesMcpTools>[0], name: string) => {
  const tool = makeCompaniesMcpTools(deps).find((t) => t.name === name);
  if (tool === undefined) throw new Error(`no MCP tool ${name}`);
  return tool;
};

const mcpDeps = (repo: CompaniesRepository, flowsRepo: FlowsRepo = stubFlows()) => ({
  repo,
  flowsRepo,
  meili: null,
  clientBaseUrl: 'https://transparenta.test',
  hubStats: { get: vi.fn() },
});

// ── scripted driver (the real repository SQL path) ────────────────────────────

/** What a statement is, by the relation and shape the repository gives it. */
const kindOf = (text: string): string => {
  if (text.includes('from companies_v2.onrc_current_publication c')) {
    return text.includes('as private_cuis') ? 'recheck' : 'capture';
  }
  if (text.includes('as private_cuis')) return 'privacy';
  if (text.includes('select distinct o.edition_id, x.field, x.key')) return 'diff-values';
  if (text.includes('select p.edition_id::text as edition_id')) return 'diff-presence';
  if (text.includes('from companies_v2.onrc_published_editions e')) return 'editions';
  if (text.includes('from "core"."organizations"')) return 'org';
  if (text.includes('"companies_v2"."fiscal_status" as "f"')) return 'fiscal';
  if (text.includes('from "companies_v2"."financials" as "fin"')) return 'financials';
  if (text.includes('from companies_v2.onrc_published_profiles p')) return 'profile';
  if (text.includes('from companies_v2.onrc_published_identifier_profiles i')) return 'identifiers';
  if (text.includes('from companies_v2.onrc_published_identity_observations o')) return 'identity';
  if (text.includes('from companies_v2.onrc_published_caen_observations c')) return 'caen';
  if (text.includes('from companies_v2.onrc_published_status_observations s')) return 'status';
  return 'other';
};

/** The ONRC data statements of a profile (the capture/recheck probe is not one). */
const ONRC_DATA_KINDS = ['profile', 'identifiers', 'identity', 'caen', 'status'];

const STATUS_VIEW = 'companies_v2.onrc_published_status_observations';

/** A capability SQLSTATE as node-postgres raises it. */
const denied = (code: string): Error =>
  Object.assign(new Error(`capability ${code} (test)`), { code });

const CAPTURE_ROW = {
  publication_state: 'published',
  edition_id: '7',
  publication_epoch: '3',
  source_snapshot_id: 'onrc:2026-07-08',
  source_published_at: '2026-07-08',
  interpretation_version: 'onrc-interpretation-v1',
  dimension_policy_version: 'onrc-dimension-v1',
  eligibility_policy_version: 'public-legal-person-v1',
  access_epoch: '11',
};

const PROFILE_ROW = {
  p_cui: CUI,
  p_identity_observations: 1,
  p_identifier_count: 1,
  p_unresolved_identifier_count: 0,
  p_unidentified_observations: 0,
  p_name: 'ONRC NAME SRL',
  p_name_basis: 'single_observation',
  p_legal_form: 'SRL',
  p_legal_form_basis: 'single_observation',
  p_recorded_date: '1992-11-05',
  p_recorded_date_basis: 'single_observation',
  p_county_code: 'BC',
  p_county_basis: 'single_observation',
  p_county_name: 'BACĂU',
  p_uat_siruta_code: null,
  p_uat_basis: 'missing',
  p_uat_name: null,
  p_status_code: '1048',
  p_status_basis: 'single_observation',
  p_caen_coverage: 'complete',
  p_status_coverage: 'complete',
  p_legal_person_eligibility: 'eligible',
  p_eligibility_reason: null,
  p_eligibility_policy_version: 'public-legal-person-v1',
};

const STATUS_ROW = {
  identifier_key: 'J04/2621/1992',
  status_parse_state: 'code',
  status_code: '1048',
  status_label: null,
  status_label_source: null,
  source_row_number: 1,
  resource_key: 'OD_STARE_FIRMA',
  source_row_sha256: 'e'.repeat(64),
  source_url: 'https://data.gov.ro/stare.csv',
  source_file_sha256: 'f'.repeat(64),
  source_published_at: '2026-07-08',
};

const FINANCIAL_ROW = {
  year: 2024,
  source_system: 'anaf',
  statement_profile_hash: null,
  metric_rule_version: 'v1',
  source_url: 'https://webservicesp.anaf.ro/bilant?an=2024&cui=2816464',
  turnover: '100.00',
  net_profit: null,
  net_loss: null,
  employees: '5',
  total_revenue: null,
  total_expenses: null,
  gross_profit: null,
  gross_loss: null,
  receivables: null,
  current_assets: null,
  fixed_assets: null,
  cash_and_bank: null,
  prepaid_expenses: null,
  deferred_income: null,
  subscribed_capital: null,
  inventories: null,
  debts: null,
  provisions: null,
  total_equity: null,
  patrimony_regie: null,
  lines: null,
};

/** A healthy published registry answering one public company. */
const defaultRows = (kind: string): readonly unknown[] => {
  switch (kind) {
    case 'capture':
      return [CAPTURE_ROW];
    case 'recheck':
      return [
        {
          publication_state: 'published',
          edition_id: '7',
          publication_epoch: '3',
          access_epoch: '11',
          private_cuis: [],
        },
      ];
    case 'privacy':
      return [{ private_cuis: [] }];
    case 'org':
      return [{ org_id: '1517396', cui: CUI, name: 'CORE NAME' }];
    case 'fiscal':
      return [
        {
          is_vat_payer: true,
          is_inactive: false,
          main_caen_code: '4752',
          main_caen_rev: '',
          main_caen_label: null,
          registered_name: null,
          status_date: '2026-06-15',
        },
      ];
    case 'financials':
      return [FINANCIAL_ROW];
    case 'profile':
      return [PROFILE_ROW];
    case 'status':
      return [STATUS_ROW];
    default:
      return [];
  }
};

class ScriptedDriver extends DummyDriver {
  constructor(private readonly respond: (text: string) => readonly unknown[]) {
    super();
  }

  override acquireConnection(): Promise<DatabaseConnection> {
    const respond = this.respond;
    return Promise.resolve({
      executeQuery: async (query) => ({ rows: [...respond(query.sql)] as never[] }),
      streamQuery: async function* () {
        // never streamed by the companies repo
      },
    });
  }
}

/**
 * A repository over a scripted driver. `respond(kind, sql)` answers (or throws
 * for) each statement; `kinds` records them in execution order.
 */
const scriptedRepo = (
  respond: (kind: string, text: string) => readonly unknown[] = defaultRows
): { repo: CompaniesRepository; kinds: string[] } => {
  const kinds: string[] = [];
  const db = new Kysely<ProdDatabase>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () =>
        new ScriptedDriver((text) => {
          const kind = kindOf(text);
          kinds.push(kind);
          return respond(kind, text);
        }),
      createIntrospector: (d) => new PostgresIntrospector(d),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  return { repo: makeCompaniesRepo(db), kinds };
};

// ── the eager snapshot: one pin, one recheck after every eager read ───────────

describe('the eager snapshot rechecks after EVERY eager read (flows and diff included)', () => {
  it('a parent restricted while the flows read is pending refuses the snapshot: the recheck runs after it', async () => {
    let restricted = false;
    const events: string[] = [];
    const gated = gatedFlows(events);
    const confirmRegistryScope = vi.fn(
      async (scope: CompanyRegistryEnvelope, cuis: readonly string[]) => {
        events.push('recheck');
        return ok(recheckOf(scope, restricted ? cuis : []));
      }
    );
    const repo = stubRepo({
      confirmRegistryScope,
      getProfileData: vi.fn(async (_c: string, s: CompanyRegistryEnvelope) => ok(profileUnder(s))),
    });
    const pending = makeCompanyProfile({ repo, flowsRepo: gated.flows, meili: null }, CUI);
    await gated.started;
    restricted = true; // the parent organization turns non-public mid-read
    gated.release();
    const res = await pending;
    expect(res.isErr() && res.error).toEqual({
      type: 'ServiceUnavailable',
      message: REGISTRY_MOVED_MESSAGE,
    });
    // Each recheck follows its attempt's flows read; none precedes it.
    expect(events).toEqual(['flows-read', 'recheck', 'flows-read', 'recheck']);
    expect(confirmRegistryScope).toHaveBeenCalledWith(PUBLISHED_SCOPE, [CUI]);
  });

  it('a publication withdrawn while the flows read is pending re-pins the WHOLE snapshot: nothing of the published read escapes', async () => {
    let current: CompanyRegistryEnvelope = PUBLISHED_SCOPE;
    const gated = gatedFlows([]);
    const captureRegistryScope = vi.fn(async () => ok(current));
    const getRegistrationDiffData = vi.fn(async (_c: string, s: CompanyRegistryEnvelope) =>
      ok({ registry: s, later: null, earlier: null })
    );
    const repo = stubRepo({
      captureRegistryScope,
      confirmRegistryScope: vi.fn(async () => ok(recheckOf(current))),
      getProfileData: vi.fn(async (_c: string, s: CompanyRegistryEnvelope) => ok(profileUnder(s))),
      getRegistrationDiffData,
    });
    const pending = makeCompanyProfile({ repo, flowsRepo: gated.flows, meili: null }, CUI);
    await gated.started;
    current = WITHDRAWN_SCOPE;
    gated.release();
    const snapshot = (await pending)._unsafeUnwrap();
    expect(snapshot?.registry.registry).toBe(WITHDRAWN_SCOPE);
    expect(snapshot?.name).toBe('CORE NAME');
    expect(snapshot?.legalForm).toBeNull();
    expect(snapshot?.publicMoney?.totalRon).toBe('1500.00');
    expect(snapshot?.registrationDiff).toMatchObject({
      status: 'not_comparable',
      reason: 'registry_withdrawn',
    });
    // The diff was read inside each attempt's pin, under that attempt's scope.
    expect(getRegistrationDiffData.mock.calls.map(([, s]) => s.state)).toEqual([
      'published',
      'withdrawn',
    ]);
    expect(captureRegistryScope).toHaveBeenCalledTimes(2);
  });

  it('get_company_snapshot (MCP): a parent restricted mid-flows never returns the earlier payload', async () => {
    // The real repo's organization seek stops finding a non-public parent.
    let restricted = false;
    const events: string[] = [];
    const gated = gatedFlows(events);
    const repo = stubRepo({
      confirmRegistryScope: vi.fn(async (s: CompanyRegistryEnvelope, cuis: readonly string[]) =>
        ok(recheckOf(s, restricted ? cuis : []))
      ),
      getProfileData: vi.fn(async (_c: string, s: CompanyRegistryEnvelope) =>
        ok(restricted ? null : profileUnder(s))
      ),
    });
    const handler = mcpTool(mcpDeps(repo, gated.flows), 'get_company_snapshot');
    const pending = handler.handler({ cui: CUI });
    await gated.started;
    restricted = true;
    gated.release();
    const out: McpToolOutput = await pending;
    expect(out).toEqual({
      ok: true,
      kind: 'company',
      query: { cui: CUI },
      summary: `No company for CUI ${CUI}.`,
    });
    const text = JSON.stringify(out);
    for (const earlier of ['ONRC NAME SRL', 'CORE NAME', '1500.00', 'registrationDiff']) {
      expect(text).not.toContain(earlier);
    }
  });

  it('get_company_snapshot (MCP): a refusal is an error output, never ok with a null diff', async () => {
    let restricted = false;
    const gated = gatedFlows([]);
    const repo = stubRepo({
      confirmRegistryScope: vi.fn(async (s: CompanyRegistryEnvelope, cuis: readonly string[]) =>
        ok(recheckOf(s, restricted ? cuis : []))
      ),
      getProfileData: vi.fn(async (_c: string, s: CompanyRegistryEnvelope) => ok(profileUnder(s))),
    });
    const handler = mcpTool(mcpDeps(repo, gated.flows), 'get_company_snapshot');
    const pending = handler.handler({ cui: CUI });
    await gated.started;
    restricted = true;
    gated.release();
    const out = await pending;
    expect(out).toEqual({ ok: false, kind: 'company', error: REGISTRY_MOVED_MESSAGE });
  });

  it('an ordinary diff-read failure is advisory (null), and never hides the access recheck', async () => {
    const failingDiff = vi.fn(async () => err({ type: 'Database' as const, message: 'boom' }));
    const holding = stubRepo({
      getProfileData: vi.fn(async (_c: string, s: CompanyRegistryEnvelope) => ok(profileUnder(s))),
      getRegistrationDiffData: failingDiff,
    });
    const snapshot = (
      await makeCompanyProfile({ repo: holding, flowsRepo: stubFlows(), meili: null }, CUI)
    )._unsafeUnwrap();
    expect(snapshot?.name).toBe('ONRC NAME SRL');
    expect(snapshot?.registrationDiff).toBeNull();

    const restricted = stubRepo({
      confirmRegistryScope: vi.fn(async (s: CompanyRegistryEnvelope, cuis: readonly string[]) =>
        ok(recheckOf(s, cuis))
      ),
      getProfileData: vi.fn(async (_c: string, s: CompanyRegistryEnvelope) => ok(profileUnder(s))),
      getRegistrationDiffData: failingDiff,
    });
    const refused = await makeCompanyProfile(
      { repo: restricted, flowsRepo: stubFlows(), meili: null },
      CUI
    );
    expect(refused.isErr() && refused.error.type).toBe('ServiceUnavailable');
  });

  it('a registry capability lost by the diff read re-pins the whole snapshot (not an advisory null)', async () => {
    let diffCalls = 0;
    const captureRegistryScope = vi.fn(async () => ok(PUBLISHED_SCOPE));
    const repo = stubRepo({
      captureRegistryScope,
      getProfileData: vi.fn(async (_c: string, s: CompanyRegistryEnvelope) => ok(profileUnder(s))),
      getRegistrationDiffData: vi.fn(async (_c: string, s: CompanyRegistryEnvelope) => {
        diffCalls += 1;
        return diffCalls === 1
          ? err(registryCapabilityLost())
          : ok({ registry: s, later: null, earlier: null });
      }),
    });
    const snapshot = (
      await makeCompanyProfile({ repo, flowsRepo: stubFlows(), meili: null }, CUI)
    )._unsafeUnwrap();
    expect(captureRegistryScope).toHaveBeenCalledTimes(2);
    expect(snapshot?.registrationDiff).toMatchObject({ status: 'not_comparable' });
  });
});

// ── the mandatory parent-privacy recheck ──────────────────────────────────────

describe('the mandatory parent-privacy recheck fails closed (repository catch)', () => {
  it.each(['42501', '42P01'])(
    '%s on core.organizations under an UNAVAILABLE scope is refused, never {privateCuis: []}',
    async (code) => {
      const { repo, kinds } = scriptedRepo((kind) => {
        if (kind === 'privacy') throw denied(code);
        return defaultRows(kind);
      });
      const recheck = await repo.confirmRegistryScope(UNAVAILABLE_SCOPE, [CUI]);
      expect(recheck._unsafeUnwrapErr()).toEqual({
        type: 'ServiceUnavailable',
        message: COMPANY_ACCESS_UNREADABLE_MESSAGE,
      });
      expect(kinds).toEqual(['privacy']);
    }
  );

  it('runPinned: ONRC unreadable at capture AND organizations unreadable refuses the read', async () => {
    const { repo, kinds } = scriptedRepo((kind) => {
      if (kind === 'capture' || kind === 'privacy') throw denied('42501');
      return defaultRows(kind);
    });
    const read = vi.fn(async () => ok([CUI]));
    const res = await runPinned(repo, read, (cuis) => cuis);
    expect(read).toHaveBeenCalledWith(unavailableRegistry());
    expect(res.isErr() && res.error).toEqual({
      type: 'ServiceUnavailable',
      message: COMPANY_ACCESS_UNREADABLE_MESSAGE,
    });
    expect(kinds).toEqual(['capture', 'privacy']);
  });

  it('a published recheck losing the publication reads the privacy half on its own: readable → moved, unreadable → refused', async () => {
    const moved = scriptedRepo((kind) => {
      if (kind === 'recheck') throw denied('42501');
      if (kind === 'privacy') return [{ private_cuis: [CUI] }];
      return defaultRows(kind);
    });
    expect((await moved.repo.confirmRegistryScope(PUBLISHED_SCOPE, [CUI]))._unsafeUnwrap()).toEqual(
      { current: null, privateCuis: [CUI] }
    );
    expect(moved.kinds).toEqual(['recheck', 'privacy']);

    const refused = scriptedRepo((kind) => {
      if (kind === 'recheck' || kind === 'privacy') throw denied('42P01');
      return defaultRows(kind);
    });
    expect(
      (await refused.repo.confirmRegistryScope(PUBLISHED_SCOPE, [CUI]))._unsafeUnwrapErr()
    ).toEqual({ type: 'ServiceUnavailable', message: COMPANY_ACCESS_UNREADABLE_MESSAGE });
  });

  it('a non-capability privacy failure is a Database error (never an empty set)', async () => {
    const { repo } = scriptedRepo((kind) => {
      if (kind === 'privacy') throw Object.assign(new Error('timeout'), { code: '57014' });
      return defaultRows(kind);
    });
    const recheck = await repo.confirmRegistryScope(UNAVAILABLE_SCOPE, [CUI]);
    expect(recheck._unsafeUnwrapErr().type).toBe('Database');
  });

  it('no returned CUI: no parent privacy to establish, and no organizations read is made', async () => {
    const { repo, kinds } = scriptedRepo((kind) => {
      if (kind === 'privacy') throw denied('42501');
      return defaultRows(kind);
    });
    expect((await repo.confirmRegistryScope(UNAVAILABLE_SCOPE, []))._unsafeUnwrap()).toEqual({
      current: null,
      privateCuis: [],
    });
    expect(kinds).toEqual([]);
  });
});

// ── registry criteria are refused before every empty shortcut ─────────────────

const NON_PUBLISHED = [UNPUBLISHED_SCOPE, WITHDRAWN_SCOPE, UNAVAILABLE_SCOPE];

const nameHit = (cui: string) => ({
  dim: 'name' as const,
  value: cui,
  label: 'ACME',
  cui,
  confidence: 1,
  labelSource: 'core_organization' as const,
});

/** The three empty-list shortcuts of `makeCompanyList`. */
const SHORTCUTS: readonly {
  readonly name: string;
  readonly filter: FilterInput;
  readonly q?: string;
  readonly hits: readonly string[];
}[] = [
  { name: 'every requested CUI withheld', filter: { cui: { in: [WITHHELD_11] } }, hits: [] },
  { name: 'no name candidate', filter: {}, q: 'zzzz', hits: [] },
  {
    name: 'name candidates disjoint from cui',
    filter: { cui: { eq: '222' } },
    q: 'acme',
    hits: ['111'],
  },
];

/** Registry criteria: an edition-bound filter (inclusion or exclude) or the recorded-date sort. */
const CRITERIA: readonly {
  readonly name: string;
  readonly filter: FilterInput;
  readonly sort: 'name' | 'registrationDate';
}[] = [
  { name: 'status filter', filter: { status: { eq: '1048' } }, sort: 'name' },
  { name: 'exclude.county filter', filter: { exclude: { county: { eq: 'CJ' } } }, sort: 'name' },
  { name: 'recorded-date sort', filter: {}, sort: 'registrationDate' },
];

const listRepo = (scope: CompanyRegistryEnvelope, hits: readonly string[]) => {
  const resolveByName = vi.fn(async () => ok({ hits: hits.map(nameHit), degraded: false }));
  const listCompanies = vi.fn(async () => ok({ rows: [], total: 0, estimated: false }));
  return { repo: stubRepo({ resolveByName, listCompanies }, scope), resolveByName, listCompanies };
};

describe('registry criteria under a non-published scope are refused before every empty shortcut', () => {
  const cases = NON_PUBLISHED.flatMap((scope) =>
    SHORTCUTS.flatMap((shortcut) =>
      CRITERIA.map((criterion) => ({
        title: `${scope.state} · ${shortcut.name} · ${criterion.name}`,
        scope,
        shortcut,
        criterion,
      }))
    )
  );

  it.each(cases)('$title → ServiceUnavailable, the same as the repository', async (c) => {
    const { repo, resolveByName, listCompanies } = listRepo(c.scope, c.shortcut.hits);
    const filter = { ...c.shortcut.filter, ...c.criterion.filter };
    const res = await makeCompanyList(
      { repo, flowsRepo: stubFlows(), meili: null },
      {
        filter,
        ...(c.shortcut.q !== undefined && { q: c.shortcut.q }),
        sort: c.criterion.sort,
        page: PAGE,
      }
    );
    // The repository's own refusal for the same criteria and scope (no SQL runs).
    const direct = await scriptedRepo().repo.listCompanies(
      c.criterion.filter,
      c.criterion.sort,
      PAGE,
      c.scope
    );
    expect(res._unsafeUnwrapErr()).toEqual(direct._unsafeUnwrapErr());
    expect(res._unsafeUnwrapErr().type).toBe('ServiceUnavailable');
    expect(resolveByName).not.toHaveBeenCalled();
    expect(listCompanies).not.toHaveBeenCalled();
  });

  it.each(NON_PUBLISHED.flatMap((scope) => SHORTCUTS.map((shortcut) => ({ scope, shortcut }))))(
    'without registry criteria the $shortcut.name shortcut stays a safe empty page ($scope.state)',
    async ({ scope, shortcut }) => {
      const { repo, listCompanies } = listRepo(scope, shortcut.hits);
      const res = (
        await makeCompanyList(
          { repo, flowsRepo: stubFlows(), meili: null },
          {
            filter: shortcut.filter,
            ...(shortcut.q !== undefined && { q: shortcut.q }),
            sort: 'name',
            page: PAGE,
          }
        )
      )._unsafeUnwrap();
      expect(res.rows).toEqual([]);
      expect(res.total).toBe(0);
      expect(res.registry).toBe(scope);
      expect(res.scopeKey).toBe(registryScopeKey(scope));
      expect(listCompanies).not.toHaveBeenCalled();
    }
  );

  it.each(SHORTCUTS)(
    'a PUBLISHED scope answers registry criteria with the $name shortcut as an empty page',
    async (shortcut) => {
      const { repo } = listRepo(PUBLISHED_SCOPE, shortcut.hits);
      const res = (
        await makeCompanyList(
          { repo, flowsRepo: stubFlows(), meili: null },
          {
            filter: { ...shortcut.filter, status: { eq: '1048' } },
            ...(shortcut.q !== undefined && { q: shortcut.q }),
            sort: 'registrationDate',
            page: PAGE,
          }
        )
      )._unsafeUnwrap();
      expect(res.total).toBe(0);
      expect(res.registry).toBe(PUBLISHED_SCOPE);
    }
  );

  it('input validation and the categorical withheld refusals still come first (no pin)', async () => {
    for (const filter of [
      { cui: { eq: '9999999999999' }, status: { eq: '1048' } },
      { exclude: { cui: { in: [WITHHELD_11] } }, status: { eq: '1048' } },
      { cui: { eq: 'xx' }, county: { eq: 'CJ' } },
      { status: { in: [] } },
    ] as FilterInput[]) {
      const captureRegistryScope = vi.fn(async () => ok(UNPUBLISHED_SCOPE));
      const repo = stubRepo({ captureRegistryScope }, UNPUBLISHED_SCOPE);
      const res = await makeCompanyList(
        { repo, flowsRepo: stubFlows(), meili: null },
        { filter, sort: 'registrationDate', page: PAGE }
      );
      expect(res._unsafeUnwrapErr().type).toBe('InvalidInput');
      expect(captureRegistryScope).not.toHaveBeenCalled();
    }
  });

  it('both transports carry the refusal of a no-hit name list (GraphQL error, MCP error output)', async () => {
    const { repo } = listRepo(UNPUBLISHED_SCOPE, []);
    const resolvers = makeCompaniesResolvers({
      repo,
      flowsRepo: stubFlows(),
      meili: null,
      registry: {} as ContributorRegistry,
      hubStats: { get: vi.fn() },
    }) as { Query: Record<string, (r: unknown, a: Record<string, unknown>) => Promise<unknown>> };
    await expect(
      resolvers.Query['companies']?.(null, { filter: { status: { eq: '1048' } }, q: 'zzzz' })
    ).rejects.toMatchObject({ extensions: { code: 'SERVICE_UNAVAILABLE' } });

    const out = await mcpTool(mcpDeps(repo), 'list_companies').handler({
      filter: { status: { eq: '1048' } },
      q: 'zzzz',
    });
    expect(out).toMatchObject({ ok: false, kind: 'list' });
    expect(out.items).toBeUndefined();
  });
});

// ── the two-edition diff never compares incomplete sets ───────────────────────

const side = (
  editionId: string,
  inEdition: boolean,
  valuesComplete: boolean,
  names: readonly string[] = []
): CompanyRegistrationEditionSide => ({
  editionId,
  sourcePublishedAt: editionId === '6' ? '2026-05-06' : '2026-07-08',
  inEdition,
  values: {
    legalName: names.map((n) => ({ key: n, display: n })),
    legalForm: [],
    county: [],
    locality: [],
  },
  valuesComplete,
});

const diffData = (
  earlier: CompanyRegistrationEditionSide | null,
  later: CompanyRegistrationEditionSide
): CompanyRegistrationDiffData => ({ registry: PUBLISHED_SCOPE, earlier, later });

/** A repo whose edition-6/7 diff statements answer `values` for the distinct-values read. */
const diffRepo = (values: readonly { edition_id: string; field: string; key: string }[]) =>
  scriptedRepo((kind) => {
    if (kind === 'editions') return [{ edition_id: '6', source_published_at: '2026-05-06' }];
    if (kind === 'diff-presence') return [{ edition_id: '7' }, { edition_id: '6' }];
    if (kind === 'diff-values') return values.map((v) => ({ ...v, display: null }));
    return defaultRows(kind);
  });

describe('the two-edition diff never compares incomplete value sets', () => {
  it('an incomplete side is NOT_COMPARABLE (evidence_bound_exceeded); presence outcomes stay presence-only', () => {
    for (const [earlier, later] of [
      [side('6', true, false, ['A']), side('7', true, true, ['A'])],
      [side('6', true, true, ['A']), side('7', true, false, [])],
    ] as const) {
      expect(diffRegistryEditions(diffData(earlier, later))).toMatchObject({
        status: 'not_comparable',
        reason: 'evidence_bound_exceeded',
        changes: [],
      });
    }
    expect(
      diffRegistryEditions(diffData(side('6', false, false), side('7', true, false))).status
    ).toBe('appeared');
    expect(
      diffRegistryEditions(diffData(side('6', true, false), side('7', false, false))).status
    ).toBe('disappeared');
    expect(diffRegistryEditions(diffData(null, side('7', true, false)))).toMatchObject({
      status: 'not_comparable',
      reason: 'first_edition',
    });
  });

  it('past DIFF_VALUE_BOUND distinct values (sentinel row) both sides carry no values and are incomplete', async () => {
    const values = Array.from({ length: DIFF_VALUE_BOUND + 1 }, (_, i) => ({
      edition_id: '6',
      field: 'legalName',
      key: `NAME ${String(i)}`,
    }));
    const { repo } = diffRepo(values);
    const data = (await repo.getRegistrationDiffData(CUI, PUBLISHED_SCOPE))._unsafeUnwrap();
    for (const s of [data.earlier, data.later]) {
      expect(s?.valuesComplete).toBe(false);
      expect(s?.values.legalName).toEqual([]);
    }
    expect(diffRegistryEditions(data)).toMatchObject({
      status: 'not_comparable',
      reason: 'evidence_bound_exceeded',
    });
  });

  it('exactly DIFF_VALUE_BOUND distinct values are complete and stay with their own edition', async () => {
    const earlier = Array.from({ length: DIFF_VALUE_BOUND - 1 }, (_, i) => ({
      edition_id: '6',
      field: 'legalName',
      key: `NAME ${String(i)}`,
    }));
    const { repo } = diffRepo([...earlier, { edition_id: '7', field: 'legalName', key: 'NAME 0' }]);
    const data = (await repo.getRegistrationDiffData(CUI, PUBLISHED_SCOPE))._unsafeUnwrap();
    expect(data.earlier?.valuesComplete).toBe(true);
    expect(data.earlier?.values.legalName).toHaveLength(DIFF_VALUE_BOUND - 1);
    expect(data.later?.values.legalName).toEqual([{ key: 'NAME 0', display: 'NAME 0' }]);
    expect(diffRegistryEditions(data).status).toBe('ambiguous');
  });

  it('the values read deduplicates in SQL and bounds DISTINCT values, never raw observation rows', async () => {
    const statements: { sql: string; parameters: readonly unknown[] }[] = [];
    const db = new Kysely<ProdDatabase>({
      dialect: {
        createAdapter: () => new PostgresAdapter(),
        createDriver: () =>
          new ScriptedDriver((text) =>
            kindOf(text) === 'editions'
              ? [{ edition_id: '6', source_published_at: '2026-05-06' }]
              : []
          ),
        createIntrospector: (d) => new PostgresIntrospector(d),
        createQueryCompiler: () => new PostgresQueryCompiler(),
      },
      log: (event) => {
        if (event.level === 'query') {
          statements.push({ sql: event.query.sql, parameters: event.query.parameters });
        }
      },
    });
    (await makeCompaniesRepo(db).getRegistrationDiffData(CUI, PUBLISHED_SCOPE))._unsafeUnwrap();
    const values = statements.find((s) => kindOf(s.sql) === 'diff-values');
    expect(values?.sql).not.toMatch(/source_row_number/u);
    expect(values?.parameters.at(-1)).toBe(DIFF_VALUE_BOUND + 1);
    expect(values?.parameters).toEqual(expect.arrayContaining(['7', '6', CUI]));
  });
});

// ── a partial registry footprint, or a capability lost after the capture ──────

describe('a partial registry footprint degrades to UNAVAILABLE; a lost capability re-pins', () => {
  it.each(['42501', '42P01'])(
    '%s on an observation view at capture pins UNAVAILABLE; the profile keeps fiscal, financial and the privacy recheck',
    async (code) => {
      const { repo, kinds } = scriptedRepo((kind, text) => {
        if (text.includes(STATUS_VIEW)) throw denied(code);
        return defaultRows(kind);
      });
      expect((await repo.captureRegistryScope())._unsafeUnwrap()).toEqual(unavailableRegistry());
      kinds.length = 0;
      const profile = (await makeCompanyProfileData({ repo }, CUI))._unsafeUnwrap();
      expect(profile?.registry.registry).toEqual(unavailableRegistry());
      expect(registryScopeKey(profile?.registry.registry ?? PUBLISHED_SCOPE)).toBe(
        'onrc:unavailable:-:-:-'
      );
      expect(profile?.registry.cuiState).toBe('unavailable');
      expect(profile?.name).toBe('CORE NAME');
      expect(profile?.nameSource).toBe('core_organization');
      expect(profile?.fiscal?.vatPayer).toBe(true);
      expect(profile?.financials.map((f) => [f.year, f.turnover])).toEqual([[2024, '100.00']]);
      expect(kinds.filter((k) => ONRC_DATA_KINDS.includes(k))).toEqual([]);
      // The mandatory parent-privacy recheck still ran for the returned CUI.
      expect(kinds).toContain('privacy');
    }
  );

  it.each(['42501', '42P01'])(
    '%s on the status view AFTER a published capture discards the attempt and re-pins UNAVAILABLE (snapshot + MCP)',
    async (code) => {
      const lostAfterFirstCapture = () => {
        let captures = 0;
        return scriptedRepo((kind, text) => {
          if (kind === 'capture') {
            captures += 1;
            if (captures === 1) return [CAPTURE_ROW];
          }
          if (captures > 0 && text.includes(STATUS_VIEW)) throw denied(code);
          return defaultRows(kind);
        });
      };

      const usecase = lostAfterFirstCapture();
      const snapshot = (
        await makeCompanyProfile({ repo: usecase.repo, flowsRepo: stubFlows(), meili: null }, CUI)
      )._unsafeUnwrap();
      expect(usecase.kinds.filter((k) => k === 'capture')).toHaveLength(2);
      expect(snapshot?.registry.registry).toEqual(unavailableRegistry());
      expect(snapshot?.registry.identifiers).toEqual([]);
      expect(snapshot?.registry.statusObservations).toEqual([]);
      expect(snapshot?.name).toBe('CORE NAME');
      expect(snapshot?.fiscal?.vatPayer).toBe(true);
      expect(snapshot?.financials.map((f) => f.turnover)).toEqual(['100.00']);
      expect(snapshot?.registrationDiff).toMatchObject({
        status: 'not_comparable',
        reason: 'registry_unavailable',
      });
      // Nothing of the published attempt (its profile row was read) survives.
      expect(JSON.stringify(snapshot)).not.toContain('ONRC NAME SRL');

      const mcp = lostAfterFirstCapture();
      const out = await mcpTool(mcpDeps(mcp.repo), 'get_company_snapshot').handler({ cui: CUI });
      expect(out).toMatchObject({
        ok: true,
        item: {
          name: 'CORE NAME',
          fiscal: { vatPayer: true },
          latestFinancial: { year: 2024, turnover: '100.00' },
          registry: {
            registry: { state: 'UNAVAILABLE', scopeKey: 'onrc:unavailable:-:-:-' },
            cuiState: 'UNAVAILABLE',
          },
          registrationDiff: { status: 'NOT_COMPARABLE', reason: 'registry_unavailable' },
        },
      });
    }
  );

  it('a capability lost between the evidence read and the recheck moves the scope (the recheck carries the footprint)', async () => {
    let lost = false;
    let captures = 0;
    const { repo, kinds } = scriptedRepo((kind, text) => {
      if (kind === 'capture') captures += 1;
      if (lost && text.includes(STATUS_VIEW)) throw denied('42501');
      const rows = defaultRows(kind);
      if (kind === 'status') lost = true; // the grant goes right after the evidence read
      return rows;
    });
    const profile = (await makeCompanyProfileData({ repo }, CUI))._unsafeUnwrap();
    expect(captures).toBe(2);
    expect(kinds).toContain('recheck');
    expect(profile?.registry.registry).toEqual(unavailableRegistry());
    expect(profile?.name).toBe('CORE NAME');
    expect(profile?.financials).toHaveLength(1);
  });

  it('a capability back on the retry serves the PUBLISHED re-read, never the lost attempt', async () => {
    let statusReads = 0;
    const { repo, kinds } = scriptedRepo((kind) => {
      if (kind === 'status') {
        statusReads += 1;
        if (statusReads === 1) throw denied('42501');
      }
      return defaultRows(kind);
    });
    const profile = (await makeCompanyProfileData({ repo }, CUI))._unsafeUnwrap();
    expect(kinds.filter((k) => k === 'capture')).toHaveLength(2);
    expect(profile?.registry.registry).toEqual(PUBLISHED_SCOPE);
    expect(profile?.registry.cuiState).toBe('in_edition');
    expect(profile?.name).toBe('ONRC NAME SRL');
    expect(profile?.registry.statusObservations).toHaveLength(1);
  });

  it('a capability lost on both attempts is refused (no partial PUBLISHED evidence, no fallback)', async () => {
    const { repo, kinds } = scriptedRepo((kind) => {
      if (kind === 'status') throw denied('42501');
      return defaultRows(kind);
    });
    const res = await makeCompanyProfileData({ repo }, CUI);
    expect(res.isErr() && res.error).toEqual({
      type: 'ServiceUnavailable',
      message: REGISTRY_MOVED_MESSAGE,
    });
    expect(kinds.filter((k) => k === 'capture')).toHaveLength(2);
    expect(kinds).not.toContain('recheck');
  });

  it('a lazy diff whose handed-in scope lost the capability is refused, never re-pinned', async () => {
    const { repo, kinds } = scriptedRepo((kind) => {
      if (kind === 'diff-values') throw denied('42P01');
      return defaultRows(kind);
    });
    const res = await makeCompanyRegistrationDiff({ repo }, CUI, PUBLISHED_SCOPE);
    expect(res.isErr() && res.error.type).toBe('ServiceUnavailable');
    expect(kinds).not.toContain('capture');
  });

  it('a partial footprint never relaxes the mandatory parent privacy: unreadable organizations still refuse', async () => {
    const { repo } = scriptedRepo((kind, text) => {
      if (text.includes(STATUS_VIEW) || kind === 'privacy') throw denied('42501');
      return defaultRows(kind);
    });
    const res = await makeCompanyProfileData({ repo }, CUI);
    expect(res.isErr() && res.error).toEqual({
      type: 'ServiceUnavailable',
      message: COMPANY_ACCESS_UNREADABLE_MESSAGE,
    });
  });
});

// ── scope keys: only the shapes this API emits ────────────────────────────────

describe('scopeFromKey accepts exactly the keys the capture and the unavailable envelope emit', () => {
  it.each([
    [
      'onrc:published:7:3:11',
      { state: 'published', editionId: '7', publicationEpoch: '3', accessEpoch: '11' },
    ],
    [
      'onrc:published:1:0:0',
      { state: 'published', editionId: '1', publicationEpoch: '0', accessEpoch: '0' },
    ],
    [
      'onrc:published:9223372036854775807:9223372036854775807:9223372036854775807',
      {
        state: 'published',
        editionId: '9223372036854775807',
        publicationEpoch: '9223372036854775807',
        accessEpoch: '9223372036854775807',
      },
    ],
    [
      'onrc:unpublished:-:0:0',
      { state: 'unpublished', editionId: null, publicationEpoch: '0', accessEpoch: '0' },
    ],
    [
      'onrc:unpublished:-:0:11',
      { state: 'unpublished', editionId: null, publicationEpoch: '0', accessEpoch: '11' },
    ],
    [
      'onrc:withdrawn:-:4:11',
      { state: 'withdrawn', editionId: null, publicationEpoch: '4', accessEpoch: '11' },
    ],
    [
      'onrc:unavailable:-:-:-',
      { state: 'unavailable', editionId: null, publicationEpoch: null, accessEpoch: null },
    ],
  ])('valid %s', (key, expected) => {
    const scope = scopeFromKey(key);
    expect(scope).toMatchObject({ source: 'onrc', ...expected });
    expect(registryScopeKey(scope ?? unavailableRegistry())).toBe(key);
  });

  it('every key the fixtures and factories emit round-trips', () => {
    for (const scope of [
      PUBLISHED_SCOPE,
      NEXT_EDITION_SCOPE,
      UNPUBLISHED_SCOPE,
      WITHDRAWN_SCOPE,
      UNAVAILABLE_SCOPE,
      unavailableRegistry('the company access (privacy) epoch is not readable'),
    ]) {
      const key = registryScopeKey(scope);
      expect(registryScopeKey(scopeFromKey(key) ?? unavailableRegistry('x'))).toBe(key);
      expect(scopeFromKey(key)).toMatchObject({
        state: scope.state,
        editionId: scope.editionId,
        publicationEpoch: scope.publicationEpoch,
        accessEpoch: scope.accessEpoch,
      });
    }
  });

  it.each([
    // empty, missing or extra components
    '',
    'onrc',
    'onrc:published:7:3',
    'onrc:published:7:3:11:9',
    'onrc:published:7:3:11:',
    ':onrc:published:7:3:11',
    // source / state
    'ONRC:published:7:3:11',
    'x:published:7:3:11',
    'onrc:Published:7:3:11',
    'onrc:current:7:3:11',
    'onrc::-:-:-',
    // UNAVAILABLE carries nothing: only -:-:-
    'onrc:unavailable:7:3:11',
    'onrc:unavailable:::',
    'onrc:unavailable:-:-:0',
    'onrc:unavailable:-:0:-',
    'onrc:unavailable:7:-:-',
    // PUBLISHED needs a positive edition and both epochs
    'onrc:published:-:3:11',
    'onrc:published:0:3:11',
    'onrc:published:7:-:11',
    'onrc:published:7:3:-',
    'onrc:published::3:11',
    // unpublished / withdrawn carry no edition, both epochs
    'onrc:unpublished:7:0:0',
    'onrc:withdrawn:0:4:11',
    'onrc:withdrawn:-:-:11',
    'onrc:unpublished:-:0:-',
    // non-canonical or unsafe decimal text
    'onrc:published:07:3:11',
    'onrc:published:7:03:11',
    'onrc:published:7:3:011',
    'onrc:published:-7:3:11',
    'onrc:published:7:-1:11',
    'onrc:published:+7:3:11',
    'onrc:published:7:3:1e3',
    'onrc:published:7.0:3:11',
    'onrc:published:7:3: 11',
    'onrc:published:7:3:11 ',
    'onrc:published:7:3:0x1',
    'onrc:published:9223372036854775808:3:11',
    'onrc:published:7:3:99999999999999999999',
    'onrc:published:7:3:１１',
  ])('invalid %j → null', (key) => {
    expect(scopeFromKey(key)).toBeNull();
  });

  it('a malformed unavailable fact is refused before any recheck (no successful final decision)', async () => {
    const confirmRegistryScope = vi.fn(async (scope: CompanyRegistryEnvelope) =>
      ok(recheckOf(scope))
    );
    const contributor = makeCompaniesContributor(stubRepo({ confirmRegistryScope }));
    for (const served of [
      {
        source: 'companies',
        present: true,
        attrs: { registryScopeKey: 'onrc:unavailable:7:3:11' },
      },
      { source: 'companies', present: true, attrs: { registryScopeKey: 'onrc:unavailable:::' } },
      {
        source: 'companies',
        kind: 'company_profile',
        data: { cui: CUI, registry: { ...UNAVAILABLE_SCOPE, editionId: '7' } },
      },
      {
        source: 'companies',
        kind: 'company_profile',
        data: { cui: CUI, registry: { ...PUBLISHED_SCOPE, accessEpoch: '011' } },
      },
    ]) {
      const res = await contributor.confirmServed?.(CUI, served);
      expect(res?._unsafeUnwrapErr()).toMatchObject({
        type: 'ServiceUnavailable',
        accessRefusal: true,
      });
    }
    expect(confirmRegistryScope).not.toHaveBeenCalled();
  });
});

// ── the contributor's final decision for served facts ─────────────────────────

describe('the companies contributor final decision (confirmServed)', () => {
  it('rechecks the scope a served fact names for the NORMALIZED CUI; anything unverifiable is an access refusal', async () => {
    const confirmRegistryScope = vi.fn(async (scope: CompanyRegistryEnvelope) =>
      ok(recheckOf(scope))
    );
    const contributor = makeCompaniesContributor(stubRepo({ confirmRegistryScope }));
    const presence = {
      source: 'companies',
      present: true,
      attrs: { registryScopeKey: 'onrc:published:7:3:11' },
    };
    expect((await contributor.confirmServed?.('RO 2816464', presence))?.isOk()).toBe(true);
    expect(confirmRegistryScope).toHaveBeenCalledWith(
      expect.objectContaining({
        state: 'published',
        editionId: '7',
        publicationEpoch: '3',
        accessEpoch: '11',
      }),
      ['2816464']
    );
    const slice = {
      source: 'companies',
      kind: 'company_profile',
      data: { cui: CUI, registry: WITHDRAWN_SCOPE },
    };
    expect((await contributor.confirmServed?.(CUI, slice))?.isOk()).toBe(true);
    for (const [cui, served] of [
      [CUI, { source: 'companies', present: true, attrs: {} }],
      [
        CUI,
        { source: 'companies', present: true, attrs: { registryScopeKey: 'onrc:published:7:3' } },
      ],
      [CUI, { source: 'companies', kind: 'company_profile', data: {} }],
      ['RO', presence],
    ] as const) {
      const res = await contributor.confirmServed?.(cui, served);
      expect(res?._unsafeUnwrapErr()).toMatchObject({
        type: 'ServiceUnavailable',
        accessRefusal: true,
      });
    }
  });

  it('a moved scope or a private parent at the final decision is an access refusal', async () => {
    const moved = makeCompaniesContributor(
      stubRepo({ confirmRegistryScope: vi.fn(async () => ok(recheckOf(NEXT_EDITION_SCOPE))) })
    );
    const privateParent = makeCompaniesContributor(
      stubRepo({
        confirmRegistryScope: vi.fn(async (scope: CompanyRegistryEnvelope) =>
          ok(recheckOf(scope, [CUI]))
        ),
      })
    );
    const presence = {
      source: 'companies',
      present: true,
      attrs: { registryScopeKey: 'onrc:published:7:3:11' },
    };
    for (const contributor of [moved, privateParent]) {
      expect((await contributor.confirmServed?.(CUI, presence))?._unsafeUnwrapErr()).toEqual({
        type: 'ServiceUnavailable',
        message: REGISTRY_MOVED_MESSAGE,
        accessRefusal: true,
      });
    }
  });
});

// ── the CAEN catalog: part of the registry footprint, optional for ANAF facts ─

const CATALOG = 'core.classification_codes';

/** ANAF's main activity under a KNOWN revision; the label only from the catalog join. */
const catalogRows =
  (catalogDenied: string | null) =>
  (kind: string, text: string): readonly unknown[] => {
    if (catalogDenied !== null && text.includes(CATALOG)) throw denied(catalogDenied);
    // The presence path: its spine row and its statement count.
    if (text.includes('as anaf_as_of')) {
      return [
        {
          cui: CUI,
          org_id: '1517396',
          core_name: 'CORE NAME',
          p_cui: null,
          is_vat_payer: true,
          is_inactive: false,
          anaf_as_of: '2026-06-15',
        },
      ];
    }
    if (text.includes('from "companies_v2"."financials"') && text.includes('count(*)')) {
      return [{ cnt: '1' }];
    }
    if (kind === 'fiscal') {
      return [
        {
          is_vat_payer: true,
          is_inactive: false,
          main_caen_code: '4752',
          main_caen_rev: 'rev2',
          main_caen_label: text.includes(CATALOG) ? 'Comerț cu amănuntul (rev2 4752)' : null,
          registered_name: null,
          status_date: '2026-06-15',
        },
      ];
    }
    return defaultRows(kind);
  };

describe('an unreadable CAEN catalog: UNAVAILABLE registry, fiscal and financial facts kept', () => {
  it.each(['42501', '42P01'])(
    '%s on the catalog: UNAVAILABLE envelope; fiscal row, financials and the ANAF code/revision stay; no label; the parent check still runs',
    async (code) => {
      const { repo, kinds } = scriptedRepo(catalogRows(code));
      const profile = (await makeCompanyProfileData({ repo }, CUI))._unsafeUnwrap();
      expect(profile?.registry.registry).toEqual(unavailableRegistry());
      expect(profile?.name).toBe('CORE NAME');
      expect(profile?.fiscal).toEqual({
        vatPayer: true,
        declaredFiscallyInactive: false,
        mainCaenCode: '4752',
        mainCaenRev: 'rev2',
        registeredName: null,
        asOf: '2026-06-15',
      });
      expect(profile?.financials.map((f) => [f.year, f.turnover])).toEqual([[2024, '100.00']]);
      // The ANAF activity keeps its own code and revision; its label is unavailable, never borrowed.
      expect(profile?.caenActivities).toEqual([
        { code: '4752', rev: 'rev2', source: 'anaf', label: null, labelSource: null },
      ]);
      expect(kinds.filter((k) => ONRC_DATA_KINDS.includes(k))).toEqual([]);
      expect(kinds).toContain('privacy');

      // The eager snapshot and the entity presence keep the same independent content.
      const snapshot = (
        await makeCompanyProfile({ repo, flowsRepo: stubFlows(), meili: null }, CUI)
      )._unsafeUnwrap();
      expect(snapshot?.fiscal?.mainCaenCode).toBe('4752');
      expect(snapshot?.financials).toHaveLength(1);
      expect(snapshot?.registrationDiff).toMatchObject({ reason: 'registry_unavailable' });
      const presence = (await makeCompaniesContributor(repo).presenceFor(CUI))._unsafeUnwrap();
      expect(presence?.attrs).toMatchObject({
        registryState: 'unavailable',
        registryScopeKey: 'onrc:unavailable:-:-:-',
        financials: 1,
        caenActivities: 1,
      });
    }
  );

  it('a readable catalog labels the ANAF activity by its OWN revision only', async () => {
    const { repo } = scriptedRepo(catalogRows(null));
    const profile = (await makeCompanyProfileData({ repo }, CUI))._unsafeUnwrap();
    expect(profile?.registry.registry).toEqual(PUBLISHED_SCOPE);
    expect(profile?.caenActivities.find((a) => a.source === 'anaf')).toEqual({
      code: '4752',
      rev: 'rev2',
      source: 'anaf',
      label: 'Comerț cu amănuntul (rev2 4752)',
      labelSource: 'current_db_catalog',
    });
  });

  it('the fiscal relation itself stays mandatory: unreadable fiscal rows fail the profile, never an empty fiscal section', async () => {
    const { repo } = scriptedRepo((kind, text) => {
      if (text.includes('"companies_v2"."fiscal_status"')) throw denied('42501');
      return catalogRows(null)(kind, text);
    });
    const res = await makeCompanyProfileData({ repo }, CUI);
    expect(res.isErr() && res.error.type).toBe('Database');
  });

  it('a non-capability catalog failure is not masked as a missing label', async () => {
    const { repo } = scriptedRepo((kind, text) => {
      if (kind === 'fiscal' && text.includes(CATALOG)) {
        throw Object.assign(new Error('timeout'), { code: '57014' });
      }
      return catalogRows(null)(kind, text);
    });
    const res = await makeCompanyProfileData({ repo }, CUI);
    expect(res.isErr() && res.error.type).toBe('Database');
  });
});
