/**
 * `Company.mainActivity`, the `isMainCaen` / `matchesAssumedMainCode` flags
 * and `companyMainActivityHistory` through the REGISTERED production
 * composition (`buildRedesignApp`: kernel schema, the companies slice and
 * resolvers, Mercurius with the shared error formatter and the per-request
 * owning-result guard) and the MCP tools, over an in-memory repository.
 *
 * Asserts: the flags alone (aliases, fragments, @include/@skip) prepare the
 * main part; nothing is read when neither is selected; header and badges
 * come from one read; SHORT_TOKEN and the ANAF row never carry a badge;
 * pending / withdrawn / unavailable states never badge and keep the profile;
 * a main move during the response re-reads once then refuses THIS field; a
 * move after the root completed while another root is pending withholds the
 * Company; an unpublished scope serves no ONRC-derived main field; history
 * pages with a bound cursor; a malformed DB value fails closed.
 */

import { err, ok } from 'neverthrow';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildRedesignApp } from '@/app/build-redesign-app.js';
import {
  MAIN_ACTIVITY_MOVED_MESSAGE,
  encodeHistoryCursor,
  mainActivityWitness,
  type CompanyMainActivityEvidence,
  type CompanyMainActivityHistoryRows,
  type CompanyMainActivityOutcome,
} from '@/modules/companies/core/main-activity.js';
import {
  noRegistryEvidence,
  type CompanyRegistryEnvelope,
} from '@/modules/companies/core/registry.js';
import { makeCompaniesResolvers } from '@/modules/companies/shell/graphql/resolvers.js';
import { companiesTypeDefs } from '@/modules/companies/shell/graphql/typedefs.js';
import { makeCompaniesMcpTools } from '@/modules/companies/shell/mcp/tools.js';
import { databaseError, type ContributorRegistry } from '@/modules/shared/index.js';

import {
  LIDL_ACTIVITY,
  LIDL_FLAGS,
  NO_MATCH_ACTIVITY,
  OMV_ACTIVITY,
  OMV_FLAGS,
  UNAVAILABLE_EVIDENCE,
  mainActivity,
  readOf,
} from '../../unit/companies/main-activity-fixtures.js';
import {
  PUBLISHED_SCOPE,
  UNPUBLISHED_SCOPE,
  recheckOf,
} from '../../unit/companies/registry-fixtures.js';
import { stubFlows, stubRepo } from '../../unit/companies/repo-fixtures.js';

import type { CompaniesRepository, CompanyProfileData } from '@/modules/companies/core/ports.js';
import type { CompanyCaenActivity } from '@/modules/companies/core/types.js';
import type { FastifyInstance } from 'fastify';

const CUI = '1590082';

const KERNEL_CONFIG = {
  prodDatabaseUrl: 'postgres://unused:unused@127.0.0.1:1/unused',
  meiliHost: '',
  meiliApiKey: '',
  opensearchUrl: '',
};

const onrc = (rev: string, code: string, classState: CompanyCaenActivity['classState']) => ({
  code,
  rev,
  source: 'onrc',
  classState,
  label: classState === 'class' ? `Etichetă ${code}` : null,
  labelSource: classState === 'class' ? ('current_db_catalog' as const) : null,
});

const OMV_ROWS: CompanyCaenActivity[] = [
  onrc('rev2', '0610', 'class'),
  onrc('rev2', '0610', 'short_token'),
  onrc('rev2', '4711', 'class'),
  { code: '610', rev: null, source: 'anaf', classState: null, label: null, labelSource: null },
];

const profileUnder = (
  scope: CompanyRegistryEnvelope,
  rows: readonly CompanyCaenActivity[]
): CompanyProfileData => ({
  cui: CUI,
  orgId: '42',
  name: 'OMV PETROM SA',
  nameSource: 'core_organization',
  legalForm: null,
  codInmatriculare: null,
  registrationDate: null,
  registrationDatePresent: false,
  headlineStatus: null,
  statusFlags: [],
  territory: null,
  address: { display: '', county: null, locality: null },
  registry: noRegistryEvidence(scope),
  fiscal: null,
  caenActivities: [...rows],
  representatives: [],
  financials: [],
  euBranches: [],
  asOf: { onrc: scope.sourcePublishedAt, anaf: '2026-06-15' },
});

interface World {
  scope: CompanyRegistryEnvelope;
  rows: readonly CompanyCaenActivity[];
  evidence: CompanyMainActivityEvidence;
  /** Witnesses answered in order (then the last one); default: the evidence's own. */
  witnesses: string[] | null;
  history: (request: {
    kind: string;
    beforeId: string | null;
    limit: number;
  }) => CompanyMainActivityHistoryRows;
  /** Current visibility of served history rows; default: what `history` serves now. */
  visibility: ((kind: string, ids: readonly string[]) => ReadonlyMap<string, string>) | null;
  /** The `flags` option of every main read. */
  flagRequests: boolean[];
  events: string[];
  healthGate: {
    reached: Promise<void>;
    open: () => void;
    enter: () => void;
    opened: Promise<void>;
  } | null;
}

const gate = () => {
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

const makeWorld = (over: Partial<World> = {}): { world: World; repo: CompaniesRepository } => {
  const world: World = {
    scope: PUBLISHED_SCOPE,
    rows: OMV_ROWS,
    evidence: readOf(OMV_ACTIVITY, OMV_FLAGS),
    witnesses: null,
    history: () => ({ state: 'read', outcomes: [], evidence: [] }),
    visibility: null,
    flagRequests: [],
    events: [],
    healthGate: null,
    ...over,
  };
  const currentVisibility = (kind: string, ids: readonly string[]): ReadonlyMap<string, string> => {
    if (world.visibility !== null) return world.visibility(kind, ids);
    const rows = world.history({ kind, beforeId: null, limit: 1000 });
    if (rows.state === 'unavailable') return new Map();
    const all =
      kind === 'outcomes'
        ? rows.outcomes.map(
            (o) =>
              [o.resolutionId, `${String(o.anafWithdrawn)}:${String(o.onrcWithdrawn)}`] as const
          )
        : rows.evidence.map(
            (e) => [e.supportId, `${String(e.anafWithdrawn)}:${String(e.onrcWithdrawn)}`] as const
          );
    return new Map(all.filter(([id]) => ids.includes(id)));
  };
  const repo = stubRepo({
    captureRegistryScope: vi.fn(async () => ok(world.scope)),
    confirmRegistryScope: vi.fn(async () => {
      world.events.push('recheck');
      return ok(recheckOf(world.scope));
    }),
    getProfileData: vi.fn(async (_cui: string, scope: CompanyRegistryEnvelope) =>
      ok(profileUnder(scope, world.rows))
    ),
    getMainActivity: vi.fn(async (_cui: string, options: { readonly flags: boolean }) => {
      world.events.push('main-read');
      world.flagRequests.push(options.flags);
      return ok(
        options.flags
          ? world.evidence
          : { ...world.evidence, flags: { state: 'not_requested' as const } }
      );
    }),
    readMainActivityWitness: vi.fn(async () => {
      world.events.push('main-witness');
      const scripted = world.witnesses?.shift();
      return ok(scripted ?? mainActivityWitness(world.evidence));
    }),
    getMainActivityHistory: vi.fn(async (_cui: string, request) => ok(world.history(request))),
    readMainActivityHistoryVisibility: vi.fn(async (_cui: string, kind, ids) => {
      world.events.push('history-visibility');
      return ok(currentVisibility(kind, ids));
    }),
    profileSlicesForCuis: vi.fn(async (cuis: readonly string[], scope: CompanyRegistryEnvelope) =>
      ok(
        new Map(
          cuis.includes(CUI)
            ? [
                [
                  CUI,
                  {
                    cui: CUI,
                    name: 'OMV PETROM SA',
                    nameSource: 'core_organization' as const,
                    legalForm: null,
                    headlineStatus: null,
                    vatPayer: null,
                    declaredFiscallyInactive: null,
                    registrationDate: null,
                    registrationDatePresent: false,
                    territory: null,
                    latestFinancial: null,
                    registryCuiState: 'in_edition' as const,
                    registry: scope,
                    asOf: { onrc: null, anaf: null },
                  },
                ],
              ]
            : []
        )
      )
    ),
  });
  return { world, repo };
};

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

const buildApp = async (world: World, repo: CompaniesRepository): Promise<FastifyInstance> => {
  const registry: ContributorRegistry = {
    register: () => undefined,
    list: () => [],
    get: () => undefined,
  };
  const companies = makeCompaniesResolvers({
    repo,
    flowsRepo: stubFlows(),
    meili: null,
    registry,
    hubStats: { get: vi.fn() },
  });
  const { app } = await buildRedesignApp({
    logLevel: 'silent',
    modules: [],
    kernelConfig: KERNEL_CONFIG,
    graphqlSlices: [{ source: 'companies', typeDefs: companiesTypeDefs }],
    graphqlResolvers: {
      ...companies,
      Query: {
        ...(companies['Query'] as Record<string, unknown>),
        health: async () => {
          if (world.healthGate !== null) {
            world.healthGate.enter();
            await world.healthGate.opened;
          }
          return { overall: 'fixture' };
        },
      },
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
): Promise<GqlBody> => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/graphql',
    payload: { query, variables },
  });
  return res.json<GqlBody>();
};

const FLAGS = `caenActivities { code rev source classState isMainCaen matchesAssumedMainCode }`;
const MAIN = `mainActivity {
  availability reason
  activity {
    policy basis currentness status matchBasis revisionBasis
    resolved { revision code label labelSource }
    candidates { revision code }
    correctionId
    anaf { originalToken jsonType tokenForm canonicalDigits assumedCode v3Form statusDate retrievedAt evidenceCustody rawCaptureId }
    edition { editionId sourcePublishedAt caenCoverage }
    derivedAt evidenceAt refreshedAt resolutionId supportId refreshId contentEpoch cacheKey
  }
}`;

const flagTriples = (company: unknown) =>
  (
    company as {
      caenActivities: {
        code: string;
        classState: string | null;
        isMainCaen: boolean | null;
        matchesAssumedMainCode: boolean | null;
      }[];
    }
  ).caenActivities.map((a) => [a.code, a.classState, a.isMainCaen, a.matchesAssumedMainCode]);

describe('main flags and mainActivity on GraphQL', () => {
  it('the flags alone prepare the main part; header and badges agree (OMV-like leading zeros)', async () => {
    const { world, repo } = makeWorld();
    const body = await gql(
      await buildApp(world, repo),
      `{ company(cui: "${CUI}") { ${FLAGS} ${MAIN} } }`
    );
    expect(body.errors).toBeUndefined();
    const company = body.data?.['company'] as Record<string, unknown>;
    expect(flagTriples(company)).toEqual([
      ['0610', 'CLASS', true, true],
      ['0610', 'SHORT_TOKEN', null, null],
      ['4711', 'CLASS', false, false],
      ['610', null, null, null],
    ]);
    expect(company['mainActivity']).toEqual({
      availability: 'ASSIGNED',
      reason: null,
      activity: {
        policy: 'anaf-assumed-main-caen-v1',
        basis: 'ANAF_ASSUMED_MAIN',
        currentness: 'CURRENT',
        status: 'RESOLVED',
        matchBasis: 'LEADING_ZERO_MATCH',
        revisionBasis: 'UNIQUE_ONRC_MATCH',
        resolved: {
          revision: 'rev2',
          code: '0610',
          label: 'Extracția petrolului brut',
          labelSource: 'frozen_at_derivation',
        },
        candidates: [{ revision: 'rev2', code: '0610' }],
        correctionId: null,
        anaf: {
          originalToken: '610',
          jsonType: 'STRING',
          tokenForm: 'OTHER_DIGIT_FORM',
          canonicalDigits: '610',
          assumedCode: null,
          v3Form: 'three_digit',
          statusDate: '2026-06-15',
          retrievedAt: '2026-06-15T08:00:00.000000Z',
          evidenceCustody: 'POINTER_BOUND_AT_DERIVATION',
          rawCaptureId: null,
        },
        edition: { editionId: '7', sourcePublishedAt: '2026-07-08', caenCoverage: 'complete' },
        derivedAt: '2026-10-13T22:30:00.000000Z',
        evidenceAt: '2026-10-13T22:30:00.000000Z',
        refreshedAt: '2026-10-13T22:30:00.000000Z',
        resolutionId: '11',
        supportId: '21',
        refreshId: '3',
        contentEpoch: '2',
        cacheKey: OMV_ACTIVITY.cacheKey,
      },
    });
    // One read, its fresh witness, and the operation-level witness.
    expect(world.events.filter((e) => e === 'main-read')).toHaveLength(1);
    expect(world.events.filter((e) => e === 'main-witness')).toHaveLength(2);
  });

  it('flags only through an alias, a named fragment and @include prepare the part', async () => {
    const { world, repo } = makeWorld();
    const body = await gql(
      await buildApp(world, repo),
      `query Q($x: Boolean!) {
        company(cui: "${CUI}") { ... on Company { acts: caenActivities { ...F } } }
      }
      fragment F on CompanyCaenActivity { code m: isMainCaen @include(if: $x) }`,
      { x: true }
    );
    expect(body.errors).toBeUndefined();
    expect(
      (body.data?.['company'] as { acts: { code: string; m: boolean | null }[] }).acts.map((a) => [
        a.code,
        a.m,
      ])
    ).toEqual([
      ['0610', true],
      ['0610', null],
      ['4711', false],
      ['610', null],
    ]);
    expect(repo.getMainActivity).toHaveBeenCalledTimes(1);
  });

  it('reads nothing of main when neither the field nor a flag is selected (or the flag is skipped)', async () => {
    const { world, repo } = makeWorld();
    const app = await buildApp(world, repo);
    expect(
      (await gql(app, `{ company(cui: "${CUI}") { cui caenActivities { code } } }`)).errors
    ).toBeUndefined();
    const skipped = await gql(
      app,
      `query Q($s: Boolean!) { company(cui: "${CUI}") { caenActivities { code isMainCaen @skip(if: $s) } } }`,
      { s: true }
    );
    expect(skipped.errors).toBeUndefined();
    expect(repo.getMainActivity).not.toHaveBeenCalled();
    expect(repo.readMainActivityWitness).not.toHaveBeenCalled();
  });

  it('Lidl-like: the latest known revision is main, the older one only matches the code', async () => {
    const { world, repo } = makeWorld({
      rows: [
        onrc('rev2', '4711', 'class'),
        onrc('rev3', '4711', 'class'),
        onrc('rev3', '6201', 'class'),
      ],
      evidence: readOf(LIDL_ACTIVITY, LIDL_FLAGS),
    });
    const body = await gql(
      await buildApp(world, repo),
      `{ company(cui: "${CUI}") { ${FLAGS} mainActivity { activity { status resolved { revision code } candidates { revision code } } } } }`
    );
    expect(body.errors).toBeUndefined();
    const company = body.data?.['company'] as Record<string, unknown>;
    expect(flagTriples(company)).toEqual([
      ['4711', 'CLASS', false, true],
      ['4711', 'CLASS', true, true],
      ['6201', 'CLASS', false, false],
    ]);
    expect(company['mainActivity']).toEqual({
      activity: {
        status: 'RESOLVED_LATEST_REVISION',
        resolved: { revision: 'rev3', code: '4711' },
        candidates: [
          { revision: 'rev3', code: '4711' },
          { revision: 'rev2', code: '4711' },
        ],
      },
    });
  });

  it('no ONRC match: the assumed code with no key and no label; no row is main', async () => {
    const { world, repo } = makeWorld({
      rows: [onrc('rev2', '4711', 'class')],
      evidence: readOf(NO_MATCH_ACTIVITY, [
        { ...OMV_FLAGS[1]!, code: '4711', isMainCaen: false, matchesAssumedMainCode: false },
      ]),
    });
    const body = await gql(
      await buildApp(world, repo),
      `{ company(cui: "${CUI}") { ${FLAGS} mainActivity { activity { status resolved { code } anaf { assumedCode } } } } }`
    );
    expect(body.errors).toBeUndefined();
    const company = body.data?.['company'] as Record<string, unknown>;
    expect(company['mainActivity']).toEqual({
      activity: { status: 'NO_ONRC_MATCH', resolved: null, anaf: { assumedCode: '4730' } },
    });
    expect(flagTriples(company)).toEqual([['4711', 'CLASS', false, false]]);
  });

  it.each([
    ['PENDING_REFRESH', mainActivity({ currentness: 'pending_refresh' })],
    [
      'SOURCE_WITHDRAWN',
      mainActivity({
        currentness: 'source_withdrawn',
        status: null,
        matchBasis: null,
        revisionBasis: null,
        resolved: null,
        candidates: null,
        anaf: null,
      }),
    ],
  ])('%s: served without any badge; the authorized list stays', async (state, activity) => {
    const { world, repo } = makeWorld({ evidence: readOf(activity, OMV_FLAGS) });
    const body = await gql(
      await buildApp(world, repo),
      `{ company(cui: "${CUI}") { ${FLAGS} mainActivity { activity { currentness status anaf { originalToken } } } } }`
    );
    expect(body.errors).toBeUndefined();
    const company = body.data?.['company'] as Record<string, unknown>;
    expect(flagTriples(company).map(([, , main, match]) => [main, match])).toEqual(
      Array.from({ length: 4 }, () => [null, null])
    );
    expect(
      (company['mainActivity'] as { activity: { currentness: string } }).activity.currentness
    ).toBe(state);
    if (state === 'SOURCE_WITHDRAWN') {
      expect(company['mainActivity']).toEqual({
        activity: { currentness: 'SOURCE_WITHDRAWN', status: null, anaf: null },
      });
    }
  });

  it('an unreadable main surface is UNAVAILABLE: no error, no badge, the profile intact', async () => {
    const { world, repo } = makeWorld({ evidence: UNAVAILABLE_EVIDENCE });
    const body = await gql(
      await buildApp(world, repo),
      `{ company(cui: "${CUI}") { name ${FLAGS} mainActivity { availability reason activity { status } } } }`
    );
    expect(body.errors).toBeUndefined();
    const company = body.data?.['company'] as Record<string, unknown>;
    expect(company['name']).toBe('OMV PETROM SA');
    expect(company['mainActivity']).toMatchObject({ availability: 'UNAVAILABLE', activity: null });
    expect(flagTriples(company).every(([, , m, x]) => m === null && x === null)).toBe(true);
  });

  it('no assignment yet is a state, never "no main activity"', async () => {
    const { world, repo } = makeWorld({ evidence: readOf(null, []) });
    const body = await gql(
      await buildApp(world, repo),
      `{ company(cui: "${CUI}") { mainActivity { availability reason activity { status } } } }`
    );
    expect(body.errors).toBeUndefined();
    expect(body.data?.['company']).toEqual({
      mainActivity: {
        availability: 'NO_ASSIGNMENT',
        reason: expect.stringContaining('not "no main activity"'),
        activity: null,
      },
    });
  });

  it('an unpublished registry scope serves no ONRC-derived main field', async () => {
    const { world, repo } = makeWorld({ scope: UNPUBLISHED_SCOPE });
    const body = await gql(
      await buildApp(world, repo),
      `{ company(cui: "${CUI}") { ${FLAGS} mainActivity { activity { currentness status resolved { code } candidates { code } edition { editionId } anaf { originalToken } } } } }`
    );
    expect(body.errors).toBeUndefined();
    const company = body.data?.['company'] as Record<string, unknown>;
    expect(company['mainActivity']).toEqual({
      activity: {
        currentness: 'ONRC_UNAVAILABLE',
        status: null,
        resolved: null,
        candidates: null,
        edition: null,
        anaf: { originalToken: '610' },
      },
    });
    expect(flagTriples(company).every(([, , m]) => m === null)).toBe(true);
  });

  it('a main move during the response re-reads once and serves the settled state', async () => {
    const { world, repo } = makeWorld();
    // The first witness disagrees (a refresh landed); the re-read then holds.
    world.witnesses = ['a:10:20:current:1:2:7'];
    const body = await gql(
      await buildApp(world, repo),
      `{ company(cui: "${CUI}") { mainActivity { activity { resolutionId } } } }`
    );
    expect(body.errors).toBeUndefined();
    expect(body.data?.['company']).toEqual({ mainActivity: { activity: { resolutionId: '11' } } });
    expect(world.events.filter((e) => e === 'main-read')).toHaveLength(2);
  });

  it('a main that keeps moving refuses THIS field and its badges; the rest of the Company stays', async () => {
    const { world, repo } = makeWorld();
    world.witnesses = ['a:10:20:current:1:2:7', 'a:12:22:current:3:4:7'];
    const body = await gql(
      await buildApp(world, repo),
      `{ company(cui: "${CUI}") { name ${FLAGS} mainActivity { availability } } }`
    );
    const company = body.data?.['company'] as Record<string, unknown>;
    expect(company['name']).toBe('OMV PETROM SA');
    expect(company['mainActivity']).toBeNull();
    expect(flagTriples(company).every(([, , m, x]) => m === null && x === null)).toBe(true);
    expect(body.errors).toEqual([
      expect.objectContaining({
        message: MAIN_ACTIVITY_MOVED_MESSAGE,
        path: ['company', 'mainActivity'],
        extensions: expect.objectContaining({ code: 'SERVICE_UNAVAILABLE' }),
      }),
    ]);
  });

  it('a main move after the root completed, while another root is pending, withholds the Company', async () => {
    const { world, repo } = makeWorld({ healthGate: gate() });
    const app = await buildApp(world, repo);
    const pending = gql(
      app,
      `{ c: company(cui: "${CUI}") { name ${FLAGS} mainActivity { activity { status } } } h: health { overall } }`
    );
    await world.healthGate!.reached;
    await vi.waitFor(() => {
      expect(world.events.filter((e) => e === 'recheck')).toHaveLength(1);
    });
    // The fiscal row is withdrawn after the Company was served.
    world.evidence = readOf(
      mainActivity({
        currentness: 'source_withdrawn',
        status: null,
        matchBasis: null,
        revisionBasis: null,
        resolved: null,
        candidates: null,
        anaf: null,
      }),
      OMV_FLAGS
    );
    world.healthGate!.open();
    const body = await pending;
    expect(body.data).toEqual({ c: null, h: { overall: 'fixture' } });
    expect(body.errors).toEqual([
      expect.objectContaining({
        message: MAIN_ACTIVITY_MOVED_MESSAGE,
        path: ['c'],
        extensions: expect.objectContaining({ code: 'SERVICE_UNAVAILABLE' }),
      }),
    ]);
    expect(JSON.stringify(body)).not.toContain('Extracția');
  });

  it('a malformed main read fails THIS field closed, never mapped', async () => {
    const { world, repo } = makeWorld();
    repo.getMainActivity = vi.fn(async () =>
      err(databaseError('main activity status is not recognized by this reader'))
    );
    const body = await gql(
      await buildApp(world, repo),
      `{ company(cui: "${CUI}") { name mainActivity { availability } } }`
    );
    expect(body.data?.['company']).toEqual({ name: 'OMV PETROM SA', mainActivity: null });
    expect(body.errors?.[0]?.path).toEqual(['company', 'mainActivity']);
  });
});

const outcome = (
  id: number,
  over: Partial<CompanyMainActivityOutcome> = {}
): CompanyMainActivityOutcome => ({
  resolutionId: String(id),
  previousResolutionId: id > 1 ? String(id - 1) : null,
  refreshId: String(id),
  reasons: ['outcome_change'],
  policy: 'anaf-assumed-main-caen-v1',
  basis: 'anaf_assumed_main',
  status: 'resolved',
  revisionBasis: 'unique_onrc_match',
  matchBasis: 'leading_zero_match',
  anaf: {
    originalToken: '610',
    jsonType: 'string',
    tokenForm: 'other_digit_form',
    canonicalDigits: '610',
    assumedCode: null,
  },
  editionId: '7',
  candidates: [{ revision: 'rev2', code: '0610' }],
  resolved: OMV_ACTIVITY.resolved,
  correctionId: null,
  derivedAt: `2026-10-1${String(id)}T00:00:00.000000Z`,
  anafWithdrawn: false,
  onrcWithdrawn: false,
  ...over,
});

describe('companyMainActivityHistory on GraphQL', () => {
  const HISTORY = `outcomes { resolutionId status resolved { code } anaf { originalToken } derivedAt anafWithdrawn onrcWithdrawn } evidence { supportId } state reason kind hasNextPage endCursor note registry { state }`;

  it('pages newest first with a cursor bound to the CUI and kind', async () => {
    const all = [5, 4, 3].map((id) => outcome(id));
    const { world, repo } = makeWorld({
      history: (request) => {
        const rows = all.filter(
          (o) => request.beforeId === null || BigInt(o.resolutionId) < BigInt(request.beforeId)
        );
        return { state: 'read', outcomes: rows.slice(0, request.limit), evidence: [] };
      },
    });
    const app = await buildApp(world, repo);
    const first = await gql(
      app,
      `{ companyMainActivityHistory(cui: "${CUI}", first: 2) { ${HISTORY} } }`
    );
    expect(first.errors).toBeUndefined();
    const page = first.data?.['companyMainActivityHistory'] as Record<string, unknown>;
    expect(page).toMatchObject({
      state: 'AVAILABLE',
      kind: 'OUTCOMES',
      hasNextPage: true,
      endCursor: encodeHistoryCursor(CUI, 'outcomes', '4'),
      registry: { state: 'PUBLISHED' },
    });
    expect((page['outcomes'] as { resolutionId: string }[]).map((o) => o.resolutionId)).toEqual([
      '5',
      '4',
    ]);
    expect(page['note']).toContain('Never legal effective dates');
    const second = await gql(
      app,
      `{ companyMainActivityHistory(cui: "${CUI}", first: 2, after: "${String(page['endCursor'])}") { ${HISTORY} } }`
    );
    expect(second.errors).toBeUndefined();
    expect(second.data?.['companyMainActivityHistory']).toMatchObject({
      hasNextPage: false,
      endCursor: null,
      outcomes: [{ resolutionId: '3' }],
    });
    // A cursor of another kind is refused, never re-applied.
    const wrong = await gql(
      app,
      `{ companyMainActivityHistory(cui: "${CUI}", kind: EVIDENCE, after: "${String(page['endCursor'])}") { state } }`
    );
    expect(wrong.data?.['companyMainActivityHistory']).toBeNull();
    expect(wrong.errors?.[0]?.extensions?.code).toBe('INVALID_INPUT');
  });

  it('a withdrawal landing during the read re-reads the page (no stale ANAF field)', async () => {
    let call = 0;
    const { world, repo } = makeWorld({
      history: () => {
        call += 1;
        return {
          state: 'read',
          outcomes: [
            call === 1
              ? outcome(1)
              : outcome(1, {
                  anafWithdrawn: true,
                  anaf: null,
                  status: null,
                  resolved: null,
                  candidates: null,
                  matchBasis: null,
                  revisionBasis: null,
                }),
          ],
          evidence: [],
        };
      },
    });
    const body = await gql(
      await buildApp(world, repo),
      `{ companyMainActivityHistory(cui: "${CUI}") { ${HISTORY} } }`
    );
    expect(body.errors).toBeUndefined();
    expect(body.data?.['companyMainActivityHistory']).toMatchObject({
      outcomes: [{ resolutionId: '1', anaf: null, status: null, anafWithdrawn: true }],
    });
    expect(JSON.stringify(body)).not.toContain('"610"');
  });

  it('an unpublished scope withholds ONRC-derived history; unavailable views are a state; unknown CUI null', async () => {
    const { world, repo } = makeWorld({
      scope: UNPUBLISHED_SCOPE,
      history: () => ({ state: 'read', outcomes: [outcome(1)], evidence: [] }),
    });
    const app = await buildApp(world, repo);
    const body = await gql(app, `{ companyMainActivityHistory(cui: "${CUI}") { ${HISTORY} } }`);
    expect(body.errors).toBeUndefined();
    expect(body.data?.['companyMainActivityHistory']).toMatchObject({
      outcomes: [
        { status: null, resolved: null, onrcWithdrawn: true, anaf: { originalToken: '610' } },
      ],
    });

    world.history = () => ({ state: 'unavailable' });
    const unavailable = await gql(
      app,
      `{ companyMainActivityHistory(cui: "${CUI}") { state reason outcomes { resolutionId } } }`
    );
    expect(unavailable.data?.['companyMainActivityHistory']).toMatchObject({
      state: 'UNAVAILABLE',
      outcomes: [],
    });

    const unknown = await gql(app, `{ companyMainActivityHistory(cui: "999999") { state } }`);
    expect(unknown.errors).toBeUndefined();
    expect(unknown.data?.['companyMainActivityHistory']).toBeNull();
  });

  it('refuses a page size outside 1..50', async () => {
    const { world, repo } = makeWorld();
    const body = await gql(
      await buildApp(world, repo),
      `{ companyMainActivityHistory(cui: "${CUI}", first: 51) { state } }`
    );
    expect(body.errors?.[0]?.extensions?.code).toBe('INVALID_INPUT');
  });
});

describe('review corrections (serving-01): through the real composition and the operation settle', () => {
  const ONRC_UNAVAILABLE = {
    currentness: 'onrc_unavailable' as const,
    status: null,
    matchBasis: null,
    revisionBasis: null,
    resolved: null,
    candidates: null,
    edition: null,
  };

  it('[P1-1] a fiscal withdrawal masked by ONRC_UNAVAILABLE after the root completed withholds the Company (ids/epoch/currentness unchanged)', async () => {
    const { world, repo } = makeWorld({
      evidence: readOf(mainActivity(ONRC_UNAVAILABLE), OMV_FLAGS),
      healthGate: gate(),
    });
    const app = await buildApp(world, repo);
    const pending = gql(
      app,
      `{ c: company(cui: "${CUI}") { name mainActivity { activity { currentness anafWithdrawn anaf { originalToken statusDate } } } } h: health { overall } }`
    );
    await world.healthGate!.reached;
    await vi.waitFor(() => {
      expect(world.events.filter((e) => e === 'recheck')).toHaveLength(1);
    });
    world.evidence = readOf(
      mainActivity({ ...ONRC_UNAVAILABLE, anafWithdrawn: true, anaf: null }),
      OMV_FLAGS
    );
    world.healthGate!.open();
    const body = await pending;
    expect(body.data).toEqual({ c: null, h: { overall: 'fixture' } });
    expect(body.errors?.[0]).toMatchObject({ message: MAIN_ACTIVITY_MOVED_MESSAGE, path: ['c'] });
    expect(JSON.stringify(body)).not.toContain('2026-06-15');
  });

  it('[P1-1] the combined withdrawal is served with anafWithdrawn and NO ANAF object', async () => {
    const { world, repo } = makeWorld({
      evidence: readOf(mainActivity({ ...ONRC_UNAVAILABLE, anafWithdrawn: true, anaf: null })),
    });
    const body = await gql(
      await buildApp(world, repo),
      `{ company(cui: "${CUI}") { mainActivity { activity { currentness anafWithdrawn anaf { originalToken } } } } }`
    );
    expect(body.errors).toBeUndefined();
    expect(body.data?.['company']).toEqual({
      mainActivity: {
        activity: { currentness: 'ONRC_UNAVAILABLE', anafWithdrawn: true, anaf: null },
      },
    });
  });

  it('[P2-5] a flag list past its bound leaves mainActivity served and every flag null; a main-only selection never asks for flags', async () => {
    const { world, repo } = makeWorld({ evidence: readOf(OMV_ACTIVITY, 'overflow') });
    const app = await buildApp(world, repo);
    const both = await gql(
      app,
      `{ company(cui: "${CUI}") { ${FLAGS} mainActivity { activity { status resolved { code } } } } }`
    );
    expect(both.errors).toBeUndefined();
    const company = both.data?.['company'] as Record<string, unknown>;
    expect(company['mainActivity']).toEqual({
      activity: { status: 'RESOLVED', resolved: { code: '0610' } },
    });
    expect(flagTriples(company).every(([, , m, x]) => m === null && x === null)).toBe(true);
    const mainOnly = await gql(app, `{ company(cui: "${CUI}") { mainActivity { availability } } }`);
    expect(mainOnly.errors).toBeUndefined();
    expect(world.flagRequests).toEqual([true, false]);
  });

  it('[P2-6] a readable assignment with an unreadable flag view: no false MOVED, the legacy profile and the main activity stay', async () => {
    const { world, repo } = makeWorld({ evidence: readOf(OMV_ACTIVITY, 'unavailable') });
    const body = await gql(
      await buildApp(world, repo),
      `{ company(cui: "${CUI}") { name registry { cuiState } ${FLAGS} mainActivity { availability activity { status } } } }`
    );
    expect(body.errors).toBeUndefined();
    const company = body.data?.['company'] as Record<string, unknown>;
    expect(company['name']).toBe('OMV PETROM SA');
    expect(company['mainActivity']).toEqual({
      availability: 'ASSIGNED',
      activity: { status: 'RESOLVED' },
    });
    expect(flagTriples(company).every(([, , m]) => m === null)).toBe(true);
  });

  it('[P2-6] negative control: a genuine movement is still refused', async () => {
    const { world, repo } = makeWorld({ evidence: readOf(OMV_ACTIVITY, 'unavailable') });
    world.witnesses = ['a:moved-1', 'a:moved-2'];
    const body = await gql(
      await buildApp(world, repo),
      `{ company(cui: "${CUI}") { name mainActivity { availability } } }`
    );
    expect((body.data?.['company'] as Record<string, unknown>)['mainActivity']).toBeNull();
    expect(body.errors?.[0]?.message).toBe(MAIN_ACTIVITY_MOVED_MESSAGE);
  });

  it('[P2-7] the integrity-hold shape (PENDING_REFRESH, suppressed interpretation and token) is served as pending, no badge, no key', async () => {
    const held = mainActivity({
      integrityHeld: true,
      currentness: 'pending_refresh',
      status: null,
      matchBasis: null,
      revisionBasis: null,
      resolved: null,
      candidates: null,
      anaf: {
        ...OMV_ACTIVITY.anaf!,
        originalToken: null,
        jsonType: null,
        tokenForm: null,
        canonicalDigits: null,
        assumedCode: null,
        v3Form: null,
      },
    });
    const { world, repo } = makeWorld({ evidence: readOf(held, OMV_FLAGS) });
    const body = await gql(
      await buildApp(world, repo),
      `{ company(cui: "${CUI}") { ${FLAGS} mainActivity { activity { currentness integrityHeld status resolved { code } candidates { code } anaf { originalToken statusDate } } } } }`
    );
    expect(body.errors).toBeUndefined();
    const company = body.data?.['company'] as Record<string, unknown>;
    expect(company['mainActivity']).toEqual({
      activity: {
        currentness: 'PENDING_REFRESH',
        integrityHeld: true,
        status: null,
        resolved: null,
        candidates: null,
        anaf: { originalToken: null, statusDate: '2026-06-15' },
      },
    });
    expect(flagTriples(company).every(([, , m, x]) => m === null && x === null)).toBe(true);
  });
});

describe('[P1-2] history: the exact served page is decided again when the whole operation settles', () => {
  const HIST = `outcomes { resolutionId status resolved { code label } anaf { originalToken } anafWithdrawn onrcWithdrawn }`;

  const pendingBeside = async (change: (world: World) => void) => {
    const { world, repo } = makeWorld({
      healthGate: gate(),
      history: () => ({
        state: 'read',
        outcomes: [outcome(2), outcome(1, { editionId: '5' })],
        evidence: [],
      }),
    });
    const app = await buildApp(world, repo);
    const pending = gql(
      app,
      `{ a: companyMainActivityHistory(cui: "${CUI}") { ${HIST} } b: companyMainActivityHistory(cui: "${CUI}", first: 1) { ${HIST} } h: health { overall } }`
    );
    await world.healthGate!.reached;
    await vi.waitFor(() => {
      expect(world.events.filter((e) => e === 'recheck').length).toBeGreaterThanOrEqual(2);
    });
    change(world);
    world.healthGate!.open();
    return pending;
  };

  it('an OLD history edition withdrawn (active scope and main witness unchanged) withholds only the alias that served it', async () => {
    const body = await pendingBeside((world) => {
      world.visibility = (_kind, ids) =>
        new Map(ids.map((id) => [id, id === '1' ? 'false:true' : 'false:false']));
    });
    // `a` served row 1 (edition 5, now withdrawn): withheld. `b` served row 2 only: kept.
    expect(body.data?.['a']).toBeNull();
    expect(body.data?.['b']).toEqual({
      outcomes: [expect.objectContaining({ resolutionId: '2' })],
    });
    expect(body.data?.['h']).toEqual({ overall: 'fixture' });
    expect(body.errors).toEqual([
      expect.objectContaining({ message: MAIN_ACTIVITY_MOVED_MESSAGE, path: ['a'] }),
    ]);
  });

  it('a fiscal withdrawal withholds every alias that served ANAF history', async () => {
    const body = await pendingBeside((world) => {
      world.visibility = (_kind, ids) => new Map(ids.map((id) => [id, 'true:false']));
    });
    expect(body.data).toEqual({ a: null, b: null, h: { overall: 'fixture' } });
    expect(JSON.stringify(body.data)).not.toContain('"610"');
  });

  it('negative control: nothing moved, both pages are served as read', async () => {
    const body = await pendingBeside(() => undefined);
    expect(body.errors).toBeUndefined();
    expect((body.data?.['a'] as { outcomes: unknown[] }).outcomes).toHaveLength(2);
  });
});

describe('MCP parity', () => {
  const tools = (repo: CompaniesRepository) =>
    makeCompaniesMcpTools({
      repo,
      flowsRepo: stubFlows(),
      meili: null,
      clientBaseUrl: 'https://transparenta.eu',
      hubStats: { get: vi.fn() },
    });

  it('[P2-8] get_company_snapshot carries caenActivities with the two DB flags of the same settled read', async () => {
    const { repo } = makeWorld();
    const snapshot = tools(repo).find((t) => t.name === 'get_company_snapshot')!;
    const out = (await snapshot.handler({ cui: CUI })) as unknown as {
      item: {
        caenActivities: {
          code: string;
          source: string;
          classState: string | null;
          label: string | null;
          isMainCaen: boolean | null;
          matchesAssumedMainCode: boolean | null;
        }[];
      };
    };
    expect(
      out.item.caenActivities.map((a) => [
        a.code,
        a.source,
        a.classState,
        a.isMainCaen,
        a.matchesAssumedMainCode,
      ])
    ).toEqual([
      ['0610', 'onrc', 'class', true, true],
      ['0610', 'onrc', 'short_token', null, null],
      ['4711', 'onrc', 'class', false, false],
      ['610', 'anaf', null, null, null],
    ]);
    // Source rows keep their label / source fields.
    expect(out.item.caenActivities[0]).toMatchObject({
      label: 'Etichetă 0610',
      labelSource: 'current_db_catalog',
    });
  });

  it('get_company_snapshot carries the same settled mainActivity', async () => {
    const { repo } = makeWorld();
    const snapshot = tools(repo).find((t) => t.name === 'get_company_snapshot')!;
    const out = await snapshot.handler({ cui: CUI });
    expect(out.ok).toBe(true);
    expect((out as { item: { mainActivity: unknown } }).item.mainActivity).toEqual({
      availability: 'assigned',
      reason: null,
      activity: OMV_ACTIVITY,
    });
  });

  it('a refused main part is null with its reason in meta, the snapshot still served', async () => {
    const { world, repo } = makeWorld();
    world.witnesses = ['x', 'y'];
    const snapshot = tools(repo).find((t) => t.name === 'get_company_snapshot')!;
    const out = (await snapshot.handler({ cui: CUI })) as {
      ok: boolean;
      item: { mainActivity: unknown };
      meta?: { mainActivityRefusal?: string };
    };
    expect(out.ok).toBe(true);
    expect(out.item.mainActivity).toBeNull();
    expect(out.meta?.mainActivityRefusal).toBe(MAIN_ACTIVITY_MOVED_MESSAGE);
  });

  it('get_company_main_activity_history answers the same page', async () => {
    const { repo } = makeWorld({
      history: () => ({ state: 'read', outcomes: [outcome(2), outcome(1)], evidence: [] }),
    });
    const history = tools(repo).find((t) => t.name === 'get_company_main_activity_history')!;
    const out = (await history.handler({ cui: CUI, first: 1 })) as unknown as {
      ok: boolean;
      items: readonly CompanyMainActivityOutcome[];
      meta: { hasNextPage: boolean; endCursor: string | null };
    };
    expect(out.ok).toBe(true);
    expect(out.items.map((o) => o.resolutionId)).toEqual(['2']);
    expect(out.meta).toMatchObject({
      hasNextPage: true,
      endCursor: encodeHistoryCursor(CUI, 'outcomes', '2'),
    });
  });
});

describe('the retired v2 evidence fields', () => {
  it('are no part of the schema: asking for them is a validation error', async () => {
    const { world, repo } = makeWorld({ evidence: readOf(OMV_ACTIVITY, OMV_FLAGS) });
    const app = await buildApp(world, repo);
    for (const field of ['timeBasis', 'rawRetrievedAt']) {
      const body = await gql(
        app,
        `{ company(cui: "${CUI}") { mainActivity { activity { anaf { ${field} } } } } }`
      );
      expect(body.errors?.[0]?.message).toMatch(
        new RegExp(
          `^Cannot query field "${field}" on type "CompanyMainActivityAnafEvidence"\\.`,
          'u'
        )
      );
    }
  });
});
