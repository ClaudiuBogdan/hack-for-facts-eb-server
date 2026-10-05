/**
 * Companies — the OWNING response under a registry or parent-access change,
 * through the REGISTERED production composition: `buildRedesignApp` (kernel
 * schema + the companies GraphQL slice and resolvers + Mercurius with the
 * shared error formatter, the per-request owning-result guard and its
 * `onResolution` finalizer), and the kernel `get_entity_snapshot` MCP tool
 * over `makeEntity360`, both with the REAL companies contributor.
 *
 * In memory (no DB): the companies repository port and the flows port are a
 * controllable "world" (the current publication/access scope and the parent
 * organization's privacy), with gates that hold a selected read pending. The
 * kernel `entity` root's identity read is the one other in-memory part: the
 * kernel pool points at a closed port, so only that root is replaced; every
 * Entity field resolver and the transport are production code.
 *
 * Each case starts from an initially public company, changes the world while
 * selected work is pending, and asserts the COMPLETED payload: no earlier
 * name, registry or financial fact of a refused owner remains, an ordinary
 * advisory failure stays its nullable field's, and nothing crosses requests.
 */

import { err, ok } from 'neverthrow';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildRedesignApp } from '@/app/build-redesign-app.js';
import {
  COMPANY_ACCESS_UNREADABLE_MESSAGE,
  REGISTRY_MOVED_MESSAGE,
  noRegistryEvidence,
  type CompanyRegistryEnvelope,
} from '@/modules/companies/core/registry.js';
import { makeCompaniesContributor } from '@/modules/companies/shell/contributor.js';
import { makeCompaniesResolvers } from '@/modules/companies/shell/graphql/resolvers.js';
import { companiesTypeDefs } from '@/modules/companies/shell/graphql/typedefs.js';
import {
  createContributorRegistry,
  databaseError,
  serviceUnavailable,
  type ApiError,
  type ContributorRegistry,
  type FlowsRepo,
  type Organization,
  type SourceContributor,
} from '@/modules/shared/index.js';
import { makeKernelMcpTools } from '@/modules/shared/shell/mcp/tools.js';

import {
  notAssessedQualification,
  statementSource,
} from '../../unit/companies/qualification-fixtures.js';
import {
  NEXT_EDITION_SCOPE,
  PUBLISHED_SCOPE,
  WITHDRAWN_SCOPE,
  recheckOf,
} from '../../unit/companies/registry-fixtures.js';
import { stubFlows, stubRepo } from '../../unit/companies/repo-fixtures.js';

import type {
  CompaniesRepository,
  CompanyPresenceCounts,
  CompanyProfileData,
} from '@/modules/companies/core/ports.js';
import type { CompanyEntitySlice, CompanyFinancialYear } from '@/modules/companies/core/types.js';
import type { Entity360Deps } from '@/modules/shared/core/usecases/entity-360.js';
import type { FastifyInstance } from 'fastify';

const CUI = '2816464';
/** Synthetic names: their absence from a completed payload is the assertion. */
const EARLIER_NAME = 'EARLIER_PUBLIC_COMPANY_NAME';
const EARLIER_LEAN = 'EARLIER_LEAN_COMPANY_NAME';
const ORG_NAME = 'EARLIER_CORE_ORGANIZATION_NAME';

const KERNEL_CONFIG = {
  prodDatabaseUrl: 'postgres://unused:unused@127.0.0.1:1/unused',
  meiliHost: '',
  meiliApiKey: '',
  opensearchUrl: '',
};

// ── the controllable world ────────────────────────────────────────────────────

interface Gate {
  readonly reached: Promise<void>;
  readonly opened: Promise<void>;
  enter(): void;
  open(): void;
}

const gate = (): Gate => {
  let enter: () => void = () => undefined;
  let open: () => void = () => undefined;
  const reached = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return {
    reached,
    opened,
    enter: () => {
      enter();
    },
    open: () => {
      open();
    },
  };
};

/** Hold here while `held` is closed (an opened gate passes at once). */
const pass = async (held: Gate | undefined): Promise<void> => {
  if (held === undefined) return;
  held.enter();
  await held.opened;
};

const FINANCIAL_2024: CompanyFinancialYear = {
  year: 2024,
  sourceSystem: 'anaf',
  turnover: '100.00',
  netProfit: null,
  netLoss: null,
  employees: '5',
  source: statementSource(2024, CUI),
  qualification: notAssessedQualification('no_active_policy'),
  summary: {
    turnover: '100.00',
    netProfit: null,
    netLoss: null,
    totalRevenue: null,
    totalExpenses: null,
    grossProfit: null,
    grossLoss: null,
    receivables: null,
    currentAssets: null,
    fixedAssets: null,
    cashAndBank: null,
    prepaidExpenses: null,
    deferredIncome: null,
    subscribedCapital: null,
    inventories: null,
    debts: null,
    provisions: null,
    totalEquity: null,
    patrimonyRegie: null,
  },
  lines: null,
};

const ORG: Organization = {
  orgId: '1517396',
  cui: CUI,
  registrationNumber: null,
  kind: 'company',
  name: ORG_NAME,
  normalizedName: null,
  countyName: null,
  localityName: null,
  sirutaCode: null,
  firstSeenSource: 'fixture',
  attrs: {},
};

const published = (scope: CompanyRegistryEnvelope): boolean => scope.state === 'published';

/** The profile as the repository assembles it under `scope` (edition values only when published). */
const profileUnder = (scope: CompanyRegistryEnvelope): CompanyProfileData => ({
  cui: CUI,
  orgId: '1517396',
  name: published(scope) ? EARLIER_NAME : 'CORE NAME',
  nameSource: published(scope) ? 'onrc_edition' : 'core_organization',
  legalForm: published(scope) ? 'SRL' : null,
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
  financials: [FINANCIAL_2024],
  euBranches: [],
  asOf: { onrc: published(scope) ? scope.sourcePublishedAt : null, anaf: '2026-06-15' },
});

const sliceUnder = (scope: CompanyRegistryEnvelope): CompanyEntitySlice => ({
  cui: CUI,
  name: published(scope) ? EARLIER_LEAN : 'CORE NAME',
  nameSource: published(scope) ? 'onrc_edition' : 'core_organization',
  legalForm: null,
  headlineStatus: null,
  vatPayer: true,
  declaredFiscallyInactive: false,
  registrationDate: null,
  registrationDatePresent: false,
  territory: null,
  latestFinancial: null,
  registryCuiState: published(scope) ? 'in_edition' : 'withdrawn',
  registry: scope,
  asOf: { onrc: null, anaf: null },
});

const countsUnder = (scope: CompanyRegistryEnvelope): CompanyPresenceCounts => ({
  cui: CUI,
  name: published(scope) ? EARLIER_LEAN : 'CORE NAME',
  nameSource: published(scope) ? 'onrc_edition' : 'core_organization',
  registryCuiState: published(scope) ? 'in_edition' : 'withdrawn',
  headlineStatus: null,
  financials: 1,
  caenActivities: 0,
  representatives: 0,
  onrcAsOf: null,
  anafAsOf: null,
});

/**
 * One world: the current scope and parent privacy (read by every recheck),
 * gates for the selected reads, scripted part failures, and an event log.
 * `churn` moves the access epoch on every recheck (a scope that keeps moving);
 * `privacyUnreadable` makes the mandatory parent check unreadable, as the
 * repository answers it (`COMPANY_ACCESS_UNREADABLE_MESSAGE`).
 */
const makeWorld = () => {
  const state = {
    current: PUBLISHED_SCOPE,
    parentPublic: true,
    churn: false,
    privacyUnreadable: false,
  };
  const holds: {
    flows?: Gate;
    diff?: Gate;
    presence?: Gate;
    probe?: Gate;
    health?: Gate;
  } = {};
  const failures: { diff?: ApiError; fqa?: ApiError } = {};
  const events: string[] = [];
  const hooks: { afterPresence?: (call: number) => void } = {};
  let presenceCalls = 0;
  const repo: CompaniesRepository = stubRepo({
    captureRegistryScope: vi.fn(async () => {
      events.push('capture');
      return ok(state.current);
    }),
    confirmRegistryScope: vi.fn(
      async (_scope: CompanyRegistryEnvelope, cuis: readonly string[]) => {
        events.push('recheck');
        if (state.privacyUnreadable) {
          return err(serviceUnavailable(COMPANY_ACCESS_UNREADABLE_MESSAGE));
        }
        if (state.churn) {
          state.current = {
            ...state.current,
            accessEpoch: String(Number(state.current.accessEpoch) + 1),
          };
        }
        return ok(recheckOf(state.current, state.parentPublic ? [] : [...cuis]));
      }
    ),
    // The organization seek finds a public parent only.
    getProfileData: vi.fn(async (_cui: string, scope: CompanyRegistryEnvelope) =>
      ok(state.parentPublic ? profileUnder(scope) : null)
    ),
    getRegistrationDiffData: vi.fn(async (_cui: string, scope: CompanyRegistryEnvelope) => {
      events.push('diff-read');
      await pass(holds.diff);
      events.push('diff-done');
      return failures.diff === undefined
        ? ok({ registry: scope, later: null, earlier: null })
        : err(failures.diff);
    }),
    getFinancialQualityAssessment: vi.fn(async () => {
      events.push('fqa-read');
      return failures.fqa === undefined
        ? ok({ assessedYears: [2024], assessedAt: null, flags: [] })
        : err(failures.fqa);
    }),
    getFinancials: vi.fn(async () => ok([FINANCIAL_2024])),
    profileSlicesForCuis: vi.fn(
      async (_cuis: readonly string[], scope: CompanyRegistryEnvelope) => {
        events.push('slice-read');
        return ok(state.parentPublic ? new Map([[CUI, sliceUnder(scope)]]) : new Map());
      }
    ),
    presenceCounts: vi.fn(async (_cui: string, scope: CompanyRegistryEnvelope) => {
      presenceCalls += 1;
      const call = presenceCalls;
      events.push('presence-read');
      if (call === 1) await pass(holds.presence);
      const counts = state.parentPublic ? countsUnder(scope) : null;
      hooks.afterPresence?.(call);
      return ok(counts);
    }),
  });
  const flows: FlowsRepo = {
    ...stubFlows(),
    getFlowSummary: vi.fn(async () => {
      events.push('flows-read');
      await pass(holds.flows);
      events.push('flows-done');
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
  return { state, holds, failures, events, hooks, repo, flows };
};

type World = ReturnType<typeof makeWorld>;

/** An unrelated contributor in an outage (advisory: degrades to a missing badge). */
const outage: SourceContributor = {
  source: 'unrelated',
  presenceFor: async () => err(databaseError('unrelated source down')),
};

// ── the registered composition ────────────────────────────────────────────────

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

const buildApp = async (world: World): Promise<FastifyInstance> => {
  let kernelRegistry: ContributorRegistry | undefined;
  const registry: ContributorRegistry = {
    register: (c) => kernelRegistry?.register(c),
    list: () => kernelRegistry?.list() ?? [],
    get: (source) => kernelRegistry?.get(source),
  };
  const companies = makeCompaniesResolvers({
    repo: world.repo,
    flowsRepo: world.flows,
    meili: null,
    registry,
    hubStats: { get: vi.fn() },
  });
  const { app } = await buildRedesignApp({
    logLevel: 'silent',
    modules: [],
    kernelConfig: KERNEL_CONFIG,
    graphqlSlices: [
      { source: 'companies', typeDefs: companiesTypeDefs },
      {
        source: 'tests/owning-response',
        typeDefs:
          'extend type Query { unrelatedProbe: String }\nextend type Entity { slowProbe: String }',
      },
    ],
    graphqlResolvers: {
      ...companies,
      Query: {
        ...(companies['Query'] as Record<string, unknown>),
        // In-memory identity read of the kernel `entity` root (public parent only).
        entity: (_r: unknown, args: { cui: string }) => ({
          cui: args.cui,
          organization: world.state.parentPublic ? ORG : null,
        }),
        // The kernel `health` root (existing HealthReport schema) with its IO
        // replaced by a gate: an unrelated root that can stay pending.
        health: async () => {
          await pass(world.holds.health);
          return { overall: 'fixture' };
        },
        unrelatedProbe: () => 'unrelated',
      },
      Entity: {
        ...(companies['Entity'] as Record<string, unknown>),
        slowProbe: async () => {
          await pass(world.holds.probe);
          return 'settled';
        },
      },
    },
    registerContributors: (kernel) => {
      kernelRegistry = kernel.contributors;
      kernel.contributors.register(makeCompaniesContributor(world.repo));
      kernel.contributors.register(outage);
    },
  });
  apps.push(app);
  await app.ready();
  return app;
};

interface GqlBody {
  readonly data?: Record<string, unknown> | null;
  readonly errors?: readonly {
    readonly message: string;
    readonly path?: readonly (string | number)[];
    readonly extensions?: { readonly code?: string };
  }[];
}

const gql = async (
  app: FastifyInstance,
  query: string,
  variables: Record<string, unknown> = {}
): Promise<{ body: GqlBody; text: string }> => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/graphql',
    payload: { query, variables },
  });
  return { body: res.json<GqlBody>(), text: res.body };
};

/** Let already-settled resolvers run before the world changes. */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

const expectNoEarlierFacts = (text: string): void => {
  for (const earlier of [EARLIER_NAME, EARLIER_LEAN, ORG_NAME, '"year":2024', '1500.00']) {
    expect(text).not.toContain(earlier);
  }
};

const FULL_COMPANY = `{
  company(cui: "${CUI}") {
    name
    registry { registry { state editionId accessEpoch } }
    financials { year }
    publicMoney { totalRon }
    registrationDiff { status reason }
  }
}`;

// ── GraphQL Company root ──────────────────────────────────────────────────────

describe('GraphQL company(cui): the owning Company is decided after ALL its selected work', () => {
  it('a parent restricted while publicMoney and registrationDiff are pending: no earlier Company fact remains', async () => {
    const world = makeWorld();
    world.holds.flows = gate();
    world.holds.diff = gate();
    const app = await buildApp(world);
    const pending = gql(app, FULL_COMPANY);
    await Promise.all([world.holds.flows.reached, world.holds.diff.reached]);
    world.state.parentPublic = false;
    world.state.current = { ...PUBLISHED_SCOPE, accessEpoch: '12' };
    world.holds.diff.open(); // the diff first, then the flows: the request completes last
    await flush();
    world.holds.flows.open();
    const { body, text } = await pending;
    // Re-read under the new pin: the parent is no longer a public directory company.
    expect(body.data).toEqual({ company: null });
    expectNoEarlierFacts(text);
    // The first recheck came only after both selected reads of its attempt.
    const firstRecheck = world.events.indexOf('recheck');
    expect(firstRecheck).toBeGreaterThan(world.events.indexOf('flows-done'));
    expect(firstRecheck).toBeGreaterThan(world.events.indexOf('diff-done'));
  });

  it('the edition withdrawn while selected work is pending: the whole Company is re-read under WITHDRAWN', async () => {
    const world = makeWorld();
    world.holds.flows = gate();
    world.holds.diff = gate();
    const app = await buildApp(world);
    const pending = gql(app, FULL_COMPANY);
    await Promise.all([world.holds.flows.reached, world.holds.diff.reached]);
    world.state.current = WITHDRAWN_SCOPE;
    world.holds.diff.open();
    world.holds.flows.open();
    const { body, text } = await pending;
    expect(body.errors).toBeUndefined();
    expect(body.data).toEqual({
      company: {
        name: 'CORE NAME',
        registry: { registry: { state: 'WITHDRAWN', editionId: null, accessEpoch: '11' } },
        financials: [{ year: 2024 }],
        publicMoney: { totalRon: '1500.00' },
        registrationDiff: { status: 'NOT_COMPARABLE', reason: 'registry_withdrawn' },
      },
    });
    expect(text).not.toContain(EARLIER_NAME);
  });

  it('a scope that keeps moving is refused: the aliased Company is withheld with ONE error at its path', async () => {
    const world = makeWorld();
    world.holds.diff = gate();
    const app = await buildApp(world);
    const pending = gql(
      app,
      `{ c: company(cui: "${CUI}") { name financials { year } registrationDiff { status } } }`
    );
    await world.holds.diff.reached;
    world.state.churn = true;
    world.holds.diff.open();
    const { body, text } = await pending;
    expect(body.data).toEqual({ c: null });
    expect(body.errors).toEqual([
      expect.objectContaining({
        message: REGISTRY_MOVED_MESSAGE,
        path: ['c'],
        extensions: expect.objectContaining({ code: 'SERVICE_UNAVAILABLE' }),
      }),
    ]);
    expectNoEarlierFacts(text);
  });

  it('two Company roots are each refused on their own path', async () => {
    const world = makeWorld();
    world.state.churn = true;
    const app = await buildApp(world);
    const { body, text } = await gql(
      app,
      `{ a: company(cui: "${CUI}") { name } b: company(cui: "${CUI}") { name publicMoney { totalRon } } }`
    );
    expect(body.data).toEqual({ a: null, b: null });
    expect(body.errors?.map((e) => e.path)).toEqual(expect.arrayContaining([['a'], ['b']]));
    expect(body.errors).toHaveLength(2);
    expectNoEarlierFacts(text);
  });

  it('aliases, named/inline fragments and @include/@skip: each root prepares exactly what it selects (stable public success)', async () => {
    const world = makeWorld();
    const app = await buildApp(world);
    const query = `query Q($withDiff: Boolean!) {
      a: company(cui: "${CUI}") {
        ...Head
        registrationDiff @include(if: $withDiff) { status }
        publicMoney @skip(if: true) { totalRon }
      }
      b: company(cui: "${CUI}") {
        name
        ... on Company { money: publicMoney { totalRon } quality: financialQualityAssessment { assessedYears } }
      }
    }
    fragment Head on Company { name registry { registry { state editionId } } financials { year } }`;
    const { body } = await gql(app, query, { withDiff: true });
    expect(body.errors).toBeUndefined();
    expect(body.data).toEqual({
      a: {
        name: EARLIER_NAME,
        registry: { registry: { state: 'PUBLISHED', editionId: '7' } },
        financials: [{ year: 2024 }],
        registrationDiff: { status: 'NOT_COMPARABLE' },
      },
      b: {
        name: EARLIER_NAME,
        money: { totalRon: '1500.00' },
        quality: { assessedYears: [2024] },
      },
    });
    // a: the diff only; b: public money and the assessment only.
    expect(world.events.filter((e) => e === 'diff-read')).toHaveLength(1);
    expect(world.events.filter((e) => e === 'flows-read')).toHaveLength(1);
    expect(world.events.filter((e) => e === 'fqa-read')).toHaveLength(1);

    world.events.length = 0;
    const skipped = await gql(app, query, { withDiff: false });
    expect(skipped.body.errors).toBeUndefined();
    expect(world.events).not.toContain('diff-read');
  });

  it('an ordinary diff or quality failure stays its nullable field error while access holds', async () => {
    const world = makeWorld();
    world.failures.diff = databaseError('comparison read failed');
    world.failures.fqa = databaseError('flags read failed');
    const app = await buildApp(world);
    const { body } = await gql(
      app,
      `{ company(cui: "${CUI}") { name financials { year } registrationDiff { status } financialQualityAssessment { assessedYears } } }`
    );
    expect(body.data).toEqual({
      company: {
        name: EARLIER_NAME,
        financials: [{ year: 2024 }],
        registrationDiff: null,
        financialQualityAssessment: null,
      },
    });
    expect(body.errors?.map((e) => [e.path, e.extensions?.code]).sort()).toEqual([
      [['company', 'financialQualityAssessment'], 'INTERNAL_SERVER_ERROR'],
      [['company', 'registrationDiff'], 'INTERNAL_SERVER_ERROR'],
    ]);
  });

  it('a Company without lazy parts costs its pin recheck plus ONE final recheck; unrelated queries and the standalone financial history read no ONRC scope', async () => {
    const world = makeWorld();
    const app = await buildApp(world);
    const plain = await gql(app, `{ company(cui: "${CUI}") { name } }`);
    expect(plain.body.data).toEqual({ company: { name: EARLIER_NAME } });
    // The pin's recheck, then the operation-final decision of the served root.
    expect(world.events).toEqual(['capture', 'recheck', 'recheck']);

    world.events.length = 0;
    const unrelated = await gql(app, '{ unrelatedProbe }');
    expect(unrelated.body).toEqual({ data: { unrelatedProbe: 'unrelated' } });
    const financials = await gql(app, `{ companyFinancials(cui: "${CUI}") { years { year } } }`);
    expect(financials.body).toEqual({ data: { companyFinancials: { years: [{ year: 2024 }] } } });
    expect(world.events).toEqual([]);
  });
});

// ── a completed Company root versus the end of its operation ──────────────────

/** An aliased Company root next to the unrelated `health` root (held by a gate). */
const companyBesideHealth = (extraRoots = ''): string => `{
  c: company(cui: "${CUI}") {
    name
    registry { registry { state editionId accessEpoch } }
    financials { year }
  }
  ${extraRoots}
  h: health { overall }
}`;

/** Wait until `n` pin rechecks were taken (the roots completed), then settle resolver microtasks. */
const rechecksTaken = async (world: World, n: number): Promise<void> => {
  await vi.waitFor(() => {
    expect(world.events.filter((e) => e === 'recheck')).toHaveLength(n);
  });
  await flush();
};

/** One withheld owner: a static SERVICE_UNAVAILABLE at that root path. */
const withheldAt = (path: string, message: string): unknown =>
  expect.objectContaining({
    message,
    path: [path],
    extensions: expect.objectContaining({ code: 'SERVICE_UNAVAILABLE' }),
  });

describe('a completed Company root is decided again when its whole operation settled', () => {
  it('the parent restricted while another root is pending withholds the completed aliased Company (Sol negative 1)', async () => {
    const world = makeWorld();
    world.holds.health = gate();
    const app = await buildApp(world);
    const pending = gql(app, companyBesideHealth());
    await world.holds.health.reached;
    await rechecksTaken(world, 1);
    expect(world.events).toEqual(['capture', 'recheck']); // completed under A, still pending at h
    world.state.parentPublic = false;
    world.state.current = { ...PUBLISHED_SCOPE, accessEpoch: '12' };
    world.holds.health.open();
    const { body, text } = await pending;
    expect(body.data).toEqual({ c: null, h: { overall: 'fixture' } });
    expect(body.errors).toEqual([withheldAt('c', REGISTRY_MOVED_MESSAGE)]);
    expectNoEarlierFacts(text);
    // Decided, never re-read: one capture, the pin recheck and the final one.
    expect(world.events).toEqual(['capture', 'recheck', 'recheck']);
  });

  it('the edition withdrawn while another root is pending: no PUBLISHED Company evidence survives', async () => {
    const world = makeWorld();
    world.holds.health = gate();
    const app = await buildApp(world);
    const pending = gql(app, companyBesideHealth());
    await world.holds.health.reached;
    await rechecksTaken(world, 1);
    world.state.current = WITHDRAWN_SCOPE; // the parent stays public
    world.holds.health.open();
    const { body, text } = await pending;
    expect(body.data).toEqual({ c: null, h: { overall: 'fixture' } });
    expect(body.errors).toEqual([withheldAt('c', REGISTRY_MOVED_MESSAGE)]);
    expectNoEarlierFacts(text);
  });

  it('a parent check unreadable at the end withholds the completed Company (never a pass)', async () => {
    const world = makeWorld();
    world.holds.health = gate();
    const app = await buildApp(world);
    const pending = gql(app, companyBesideHealth());
    await world.holds.health.reached;
    await rechecksTaken(world, 1);
    world.state.privacyUnreadable = true;
    world.holds.health.open();
    const { body, text } = await pending;
    expect(body.data).toEqual({ c: null, h: { overall: 'fixture' } });
    expect(body.errors).toEqual([withheldAt('c', COMPANY_ACCESS_UNREADABLE_MESSAGE)]);
    expectNoEarlierFacts(text);
  });

  it('a known final refusal of the same CUI withholds BOTH the completed Company and its Entity (Sol negative 2)', async () => {
    const world = makeWorld();
    world.holds.health = gate();
    const app = await buildApp(world);
    const pending = gql(
      app,
      companyBesideHealth(
        `e: entity(cui: "${CUI}") { organization { name } company { name registry { state } } }`
      )
    );
    await world.holds.health.reached;
    await rechecksTaken(world, 2); // the Company pin and the Entity slice pin, both under A
    world.state.parentPublic = false;
    world.state.current = { ...PUBLISHED_SCOPE, accessEpoch: '12' };
    world.holds.health.open();
    const { body, text } = await pending;
    expect(body.data).toEqual({ c: null, e: null, h: { overall: 'fixture' } });
    expect(body.errors).toHaveLength(2);
    expect(body.errors).toEqual(
      expect.arrayContaining([
        withheldAt('c', REGISTRY_MOVED_MESSAGE),
        withheldAt('e', REGISTRY_MOVED_MESSAGE),
      ])
    );
    expectNoEarlierFacts(text);
  });

  it('stable: aliased Company roots, an Entity and the unrelated root are all served; one final recheck per served company owner, none for the unrelated root alone', async () => {
    const world = makeWorld();
    const app = await buildApp(world);
    const { body } = await gql(
      app,
      `{
        a: company(cui: "${CUI}") { name }
        b: company(cui: "${CUI}") { name financials { year } }
        e: entity(cui: "${CUI}") { company { name } }
        h: health { overall }
      }`
    );
    expect(body.errors).toBeUndefined();
    expect(body.data).toEqual({
      a: { name: EARLIER_NAME },
      b: { name: EARLIER_NAME, financials: [{ year: 2024 }] },
      e: { company: { name: EARLIER_LEAN } },
      h: { overall: 'fixture' },
    });
    // Three pins (a, b, the slice), each with its recheck, plus three final rechecks.
    expect(world.events.filter((e) => e === 'capture')).toHaveLength(3);
    expect(world.events.filter((e) => e === 'recheck')).toHaveLength(6);

    world.events.length = 0;
    const unrelatedOnly = await gql(app, '{ h: health { overall } }');
    expect(unrelatedOnly.body).toEqual({ data: { h: { overall: 'fixture' } } });
    expect(world.events).toEqual([]);
  });

  it('independent requests are decided independently: one completed while public is served, the delayed one is withheld, the next is served', async () => {
    const world = makeWorld();
    world.holds.health = gate();
    const app = await buildApp(world);
    const delayed = gql(app, companyBesideHealth());
    await world.holds.health.reached;
    await rechecksTaken(world, 1);
    const independent = await gql(app, `{ company(cui: "${CUI}") { name } }`);
    expect(independent.body).toEqual({ data: { company: { name: EARLIER_NAME } } });
    world.state.parentPublic = false;
    world.holds.health.open();
    expect((await delayed).body.data).toEqual({ c: null, h: { overall: 'fixture' } });

    world.state.parentPublic = true;
    const next = await gql(app, companyBesideHealth());
    expect(next.body.errors).toBeUndefined();
    expect(next.body.data?.['c']).toMatchObject({ name: EARLIER_NAME });
  });

  it('a root reached through a fragment and @include is decided at its own response key; a @skip root is never read or checked', async () => {
    const world = makeWorld();
    world.holds.health = gate();
    const app = await buildApp(world);
    const pending = gql(
      app,
      `query Q($on: Boolean!) {
        ...Roots
        skipped: company(cui: "${CUI}") @skip(if: $on) { name }
        h: health { overall }
      }
      fragment Roots on Query {
        f: company(cui: "${CUI}") @include(if: $on) { name financials { year } }
      }`,
      { on: true }
    );
    await world.holds.health.reached;
    await rechecksTaken(world, 1);
    world.state.parentPublic = false;
    world.holds.health.open();
    const { body, text } = await pending;
    expect(body.data).toEqual({ f: null, h: { overall: 'fixture' } });
    expect(body.errors).toEqual([withheldAt('f', REGISTRY_MOVED_MESSAGE)]);
    expectNoEarlierFacts(text);
    // Only the included root: one pin, its recheck and its final recheck.
    expect(world.events).toEqual(['capture', 'recheck', 'recheck']);
  });
});

// ── GraphQL Entity ────────────────────────────────────────────────────────────

const ENTITY = `{
  entity(cui: "${CUI}") {
    cui
    organization { name }
    company { name registry { state } }
    presence { source }
  }
}`;

describe('GraphQL entity(cui): a companies refusal withholds the owning Entity', () => {
  it('the Sol sequence: presence moves, then the parent turns private before its second recheck; no org, lean company or presence remains', async () => {
    const world = makeWorld();
    world.holds.presence = gate();
    world.hooks.afterPresence = (call) => {
      // Counts of the retry were read while public; the parent turns private before its recheck.
      if (call === 2) world.state.parentPublic = false;
    };
    const app = await buildApp(world);
    const pending = gql(app, ENTITY);
    await world.holds.presence.reached;
    await flush();
    world.state.current = NEXT_EDITION_SCOPE; // a publication while presence is pending
    world.holds.presence.open();
    const { body, text } = await pending;
    expect(body.data).toEqual({ entity: null });
    expect(body.errors).toEqual([
      expect.objectContaining({
        path: ['entity'],
        extensions: expect.objectContaining({ code: 'SERVICE_UNAVAILABLE' }),
      }),
    ]);
    expectNoEarlierFacts(text);
  });

  it('a lean company served before the parent turns private is withheld at the end, after the selected work settled (aliased)', async () => {
    const world = makeWorld();
    world.holds.probe = gate();
    const app = await buildApp(world);
    const pending = gql(
      app,
      `{ e: entity(cui: "${CUI}") { organization { name } company { name } slowProbe } }`
    );
    await world.holds.probe.reached;
    await vi.waitFor(() => {
      expect(world.events).toContain('recheck'); // the slice was served and its pin rechecked
    });
    world.state.parentPublic = false;
    world.holds.probe.open();
    const { body, text } = await pending;
    expect(body.data).toEqual({ e: null });
    expect(body.errors).toEqual([
      expect.objectContaining({
        path: ['e'],
        extensions: expect.objectContaining({ code: 'SERVICE_UNAVAILABLE' }),
      }),
    ]);
    expectNoEarlierFacts(text);
  });

  it('a known Entity.company refusal withholds the Entity, not only the nullable company field', async () => {
    const world = makeWorld();
    world.state.churn = true;
    const app = await buildApp(world);
    const { body, text } = await gql(
      app,
      `{ entity(cui: "${CUI}") { organization { name } company { name } } }`
    );
    expect(body.data).toEqual({ entity: null });
    expect(body.errors).toEqual([
      expect.objectContaining({
        message: REGISTRY_MOVED_MESSAGE,
        path: ['entity'],
        extensions: expect.objectContaining({ code: 'SERVICE_UNAVAILABLE' }),
      }),
    ]);
    expectNoEarlierFacts(text);
  });

  it('stable public success; an unrelated contributor outage still degrades to a missing badge', async () => {
    const world = makeWorld();
    const app = await buildApp(world);
    const { body } = await gql(app, ENTITY);
    expect(body.errors).toBeUndefined();
    expect(body.data).toEqual({
      entity: {
        cui: CUI,
        organization: { name: ORG_NAME },
        company: { name: EARLIER_LEAN, registry: { state: 'PUBLISHED' } },
        presence: [{ source: 'companies' }],
      },
    });
  });

  it('nothing crosses requests: a refused request does not touch a concurrent unrelated one or the next request', async () => {
    const world = makeWorld();
    world.holds.probe = gate();
    const app = await buildApp(world);
    const refused = gql(app, `{ entity(cui: "${CUI}") { company { name } slowProbe } }`);
    await world.holds.probe.reached;
    await vi.waitFor(() => {
      expect(world.events).toContain('recheck');
    });
    world.state.parentPublic = false;
    const concurrent = await gql(app, '{ unrelatedProbe }');
    expect(concurrent.body).toEqual({ data: { unrelatedProbe: 'unrelated' } });
    world.holds.probe.open();
    expect((await refused).body.data).toEqual({ entity: null });

    world.state.parentPublic = true;
    const next = await gql(app, ENTITY);
    expect(next.body.errors).toBeUndefined();
    expect(next.body.data?.['entity']).toMatchObject({ organization: { name: ORG_NAME } });
  });
});

// ── eager entity snapshot (MCP get_entity_snapshot over makeEntity360) ────────

const snapshotTool = (world: World) => {
  const registry = createContributorRegistry();
  registry.register(makeCompaniesContributor(world.repo));
  registry.register(outage);
  const identityRepo = {
    findByCui: vi.fn(async () => ok(world.state.parentPublic ? ORG : null)),
    territoryForCui: vi.fn(async () => ok(null)),
    getIdentifiers: vi.fn(async () => ok([])),
  };
  const entity360Deps = {
    identityRepo,
    flowsRepo: world.flows,
    searchRepo: { countByCui: vi.fn(async () => ok(0)) },
    registry,
  } as unknown as Entity360Deps;
  const tool = makeKernelMcpTools({
    identityRepo: identityRepo as never,
    entity360Deps,
    globalSearchDeps: {} as never,
    clientBaseUrl: 'https://transparenta.test',
  }).find((t) => t.name === 'get_entity_snapshot');
  if (tool === undefined) throw new Error('get_entity_snapshot missing');
  return tool;
};

describe('MCP get_entity_snapshot: the eager fan-out never keeps an earlier org next to a refused company', () => {
  it('the Sol eager sequence: the presence refusal reaches the snapshot (no earlier organization)', async () => {
    const world = makeWorld();
    world.holds.flows = gate();
    world.holds.presence = gate();
    world.hooks.afterPresence = (call) => {
      if (call === 2) world.state.parentPublic = false;
    };
    const pending = snapshotTool(world).handler({ cui: CUI });
    await world.holds.presence.reached;
    world.state.current = NEXT_EDITION_SCOPE;
    world.holds.presence.open();
    await flush();
    world.holds.flows.open();
    const out = await pending;
    expect(out).toEqual({ ok: false, kind: 'entity_snapshot', error: REGISTRY_MOVED_MESSAGE });
    expectNoEarlierFacts(JSON.stringify(out));
  });

  it('a parent restricted after the companies presence but while flows are pending: the final decision after the fan-out refuses', async () => {
    const world = makeWorld();
    world.holds.flows = gate();
    const pending = snapshotTool(world).handler({ cui: CUI });
    await world.holds.flows.reached;
    await vi.waitFor(() => {
      expect(world.events).toContain('recheck'); // the presence was served under its pin
    });
    world.state.parentPublic = false;
    world.holds.flows.open();
    const out = await pending;
    expect(out).toMatchObject({ ok: false, kind: 'entity_snapshot' });
    expectNoEarlierFacts(JSON.stringify(out));
  });

  it('stable success carries the presence scope key; an unrelated outage stays a missing badge', async () => {
    const world = makeWorld();
    const out = await snapshotTool(world).handler({ cui: CUI });
    expect(out.ok).toBe(true);
    const item = out.item as {
      organization: Organization | null;
      presence: { source: string; attrs?: Record<string, unknown> }[];
    };
    expect(item.organization?.name).toBe(ORG_NAME);
    expect(item.presence.map((p) => p.source)).toEqual(['companies']);
    expect(item.presence[0]?.attrs?.['registryScopeKey']).toBe('onrc:published:7:3:11');
  });
});
