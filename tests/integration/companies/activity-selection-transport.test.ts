/**
 * `Company.activitySelection` and the class state on the REAL GraphQL slice
 * (Mercurius, inject) and the MCP snapshot, over in-memory ports: the
 * selection is read only when selected, inside the Company's pin; its enums
 * serialize; an aggregate past its bound refuses THIS field only; a lost
 * registry capability re-pins the whole Company; ONRC observations carry
 * their class state and only CLASS rows a label.
 */

import fastifyLib, { type FastifyInstance } from 'fastify';
import { err, ok } from 'neverthrow';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeGraphQLPlugin } from '@/infra/graphql/index.js';
import {
  ACTIVITY_AGGREGATE_GROUP_BOUND,
  type CompanyActivityEvidence,
} from '@/modules/companies/core/activity-selection.js';
import {
  REGISTRY_MOVED_MESSAGE,
  registryCapabilityLost,
  type CompanyRegistryCaenObservation,
  type CompanyRegistryEnvelope,
} from '@/modules/companies/core/registry.js';
import { makeCompanyComposition } from '@/modules/companies/core/usecases.js';
import { makeCompaniesResolvers } from '@/modules/companies/shell/graphql/resolvers.js';
import { companiesTypeDefs } from '@/modules/companies/shell/graphql/typedefs.js';
import { makeCompaniesMcpTools } from '@/modules/companies/shell/mcp/tools.js';
import { baseTypeDefs, mergeGraphqlSlices, scalarResolvers } from '@/modules/shared/index.js';

import { PUBLISHED_SCOPE } from '../../unit/companies/registry-fixtures.js';
import { stubFlows, stubRepo } from '../../unit/companies/repo-fixtures.js';

import type { CompaniesRepository, CompanyProfileData } from '@/modules/companies/core/ports.js';

const CUI = '2816464';

const observation = (
  n: number,
  over: Partial<CompanyRegistryCaenObservation>
): CompanyRegistryCaenObservation => ({
  id: `7:OD_CAEN_AUTORIZAT:${String(n)}`,
  identifierKey: 'J04/2621/1992',
  parseState: 'code',
  code: '4711',
  revisionState: 'known',
  revision: 'rev2',
  classState: 'class',
  catalogLabel: null,
  provenance: {
    resourceKey: 'OD_CAEN_AUTORIZAT',
    sourceRowNumber: n,
    sourceRowSha256: 'a'.repeat(64),
    sourceUrl: null,
    sourceFileSha256: null,
    sourcePublishedAt: '2026-07-08',
  },
  ...over,
});

const OBSERVATIONS = [
  observation(1, {
    catalogLabel: {
      label: 'Comerț cu amănuntul',
      system: 'caen_rev2',
      source: 'current_db_catalog',
    },
  }),
  observation(2, { code: '0111', classState: 'short_token' }),
];

const profileUnder = (scope: CompanyRegistryEnvelope, inEdition = true): CompanyProfileData => ({
  cui: CUI,
  orgId: '1517396',
  name: 'DEDEMAN SRL',
  nameSource: 'onrc_edition',
  legalForm: 'SRL',
  codInmatriculare: null,
  registrationDate: null,
  registrationDatePresent: false,
  headlineStatus: null,
  statusFlags: [],
  territory: null,
  address: { display: '', county: null, locality: null },
  registry: {
    registry: scope,
    cuiState: inEdition ? 'in_edition' : 'not_in_edition',
    profile: inEdition
      ? {
          identityObservations: 1,
          identifierCount: 1,
          unresolvedIdentifierCount: 0,
          unidentifiedObservations: 0,
          name: { value: 'DEDEMAN SRL', basis: 'single_observation' },
          legalForm: { value: 'SRL', basis: 'single_observation' },
          recordedDate: { value: null, basis: 'missing' },
          countyCode: { value: null, basis: 'missing' },
          countyName: null,
          uatSirutaCode: { value: null, basis: 'missing' },
          uatName: null,
          statusCode: { value: null, basis: 'missing' },
          caenCoverage: 'partial',
          statusCoverage: 'complete',
          legalPersonEligibility: 'eligible',
          eligibilityReason: null,
          eligibilityPolicyVersion: 'public-legal-person-v1',
        }
      : null,
    identifiers: [],
    identityObservations: [],
    caenObservations: inEdition ? OBSERVATIONS : [],
    statusObservations: [],
    observationsTruncated: false,
  },
  fiscal: null,
  caenActivities: [
    {
      code: '0111',
      rev: 'rev2',
      source: 'onrc',
      classState: 'short_token',
      label: null,
      labelSource: null,
    },
    {
      code: '4711',
      rev: 'rev2',
      source: 'onrc',
      classState: 'class',
      label: 'Comerț cu amănuntul',
      labelSource: 'current_db_catalog',
    },
  ],
  representatives: [],
  financials: [],
  euBranches: [],
  asOf: { onrc: '2026-07-08', anaf: '2026-09-28' },
});

/** Two class keys, a short token, and the usable ANAF code matching one key. */
const EVIDENCE: CompanyActivityEvidence = {
  groups: [
    { revision: 'rev2', code: '0111', classState: 'short_token', rows: 1 },
    { revision: 'rev2', code: '4711', classState: 'class', rows: 1 },
    { revision: 'rev2', code: '6201', classState: 'class', rows: 2 },
  ],
  fiscal: {
    code: '4711',
    form: 'four_digit',
    usable: true,
    policy: 'anaf-caen-form-policy-v1',
    catalogued: true,
    statusDate: '2026-09-28',
  },
  catalog: new Map([
    ['4711', [{ revision: 'rev2', label: 'Comerț cu amănuntul' }]],
    ['6201', [{ revision: 'rev2', label: 'Software' }]],
  ]),
};

const repoWith = (
  evidence: () => ReturnType<CompaniesRepository['getActivityEvidence']>,
  inEdition = true
) =>
  stubRepo({
    getProfileData: vi.fn(async (_cui: string, scope: CompanyRegistryEnvelope) =>
      ok(profileUnder(scope, inEdition))
    ),
    getActivityEvidence: vi.fn(evidence),
  });

const deps = (repo: CompaniesRepository) => ({
  repo,
  flowsRepo: stubFlows(),
  meili: null,
  registry: { register: () => undefined, list: () => [], get: () => undefined },
  hubStats: { get: vi.fn() },
});

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

const buildGraphql = async (repo: CompaniesRepository): Promise<FastifyInstance> => {
  const { typeDefs } = mergeGraphqlSlices(baseTypeDefs, [
    { source: 'companies', typeDefs: companiesTypeDefs },
  ]);
  const app = fastifyLib({ logger: false });
  await app.register(
    makeGraphQLPlugin({
      schema: [typeDefs],
      resolvers: [{ ...scalarResolvers, ...makeCompaniesResolvers(deps(repo)) }],
      isProduction: false,
      enableGraphiQL: false,
    })
  );
  await app.ready();
  apps.push(app);
  return app;
};

interface GqlResponse {
  readonly data?: Record<string, unknown> | null;
  readonly errors?: readonly {
    readonly message: string;
    readonly path?: readonly (string | number)[];
    readonly extensions?: Record<string, unknown>;
  }[];
}

const gql = async (app: FastifyInstance, query: string): Promise<GqlResponse> => {
  const res = await app.inject({
    method: 'POST',
    url: '/graphql',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ query }),
  });
  return res.json<GqlResponse>();
};

const SELECTION = `activitySelection {
  basis source code revision label descriptionStatus descriptions { revision label } derived
  classKeyCount unqualifiedObservationCount observationCount caenCoverage editionId
  editionSourceDate anafCode anafCodeForm anafCodeUsable anafCaenFormPolicy anafStatusDate agreement
}`;

describe('Company.activitySelection on GraphQL', () => {
  it('serves the derived selection with its evidence and both source dates', async () => {
    const repo = repoWith(async () => ok(EVIDENCE));
    const body = await gql(
      await buildGraphql(repo),
      `query { company(cui: "${CUI}") { cui ${SELECTION} } }`
    );
    expect(body.errors).toBeUndefined();
    expect(body.data?.['company']).toEqual({
      cui: CUI,
      activitySelection: {
        basis: 'ONRC_CLASS_ANAF_NUMERIC_MATCH',
        source: 'ONRC',
        code: '4711',
        revision: 'rev2',
        label: 'Comerț cu amănuntul',
        descriptionStatus: 'EXACT',
        descriptions: [{ revision: 'rev2', label: 'Comerț cu amănuntul' }],
        derived: true,
        classKeyCount: 2,
        unqualifiedObservationCount: 1,
        observationCount: 4,
        caenCoverage: 'PARTIAL',
        editionId: '7',
        editionSourceDate: '2026-07-08',
        anafCode: '4711',
        anafCodeForm: 'FOUR_DIGIT',
        anafCodeUsable: true,
        anafCaenFormPolicy: 'anaf-caen-form-policy-v1',
        anafStatusDate: '2026-09-28',
        agreement: 'MATCH_ONE_KEY',
      },
    });
    expect(repo.getActivityEvidence).toHaveBeenCalledWith(CUI, PUBLISHED_SCOPE);
  });

  it('serves THREE_DIGIT as the database stated it; policy v1 does not admit it', async () => {
    const repo = repoWith(async () =>
      ok({
        ...EVIDENCE,
        fiscal: { ...EVIDENCE.fiscal!, code: '0111', form: 'three_digit', usable: false },
      })
    );
    const body = await gql(
      await buildGraphql(repo),
      `query { company(cui: "${CUI}") { activitySelection { basis anafCode anafCodeForm anafCodeUsable anafCaenFormPolicy agreement } } }`
    );
    expect(body.errors).toBeUndefined();
    expect(body.data?.['company']).toEqual({
      activitySelection: {
        basis: 'ONRC_MULTIPLE_CLASSES',
        anafCode: '0111',
        anafCodeForm: 'THREE_DIGIT',
        anafCodeUsable: false,
        anafCaenFormPolicy: 'anaf-caen-form-policy-v1',
        agreement: 'ANAF_NOT_USABLE',
      },
    });
  });

  it.each(['0000', '9999'])(
    'serves the placeholder %s as NOT usable with ANAF_PLACEHOLDER, though its form is admitted',
    async (code) => {
      const repo = repoWith(async () =>
        ok({
          ...EVIDENCE,
          fiscal: { ...EVIDENCE.fiscal!, code, form: 'four_digit', usable: true },
        })
      );
      const body = await gql(
        await buildGraphql(repo),
        `query { company(cui: "${CUI}") { activitySelection { basis anafCode anafCodeForm anafCodeUsable agreement } } }`
      );
      expect(body.errors).toBeUndefined();
      expect(body.data?.['company']).toEqual({
        activitySelection: {
          basis: 'ONRC_MULTIPLE_CLASSES',
          anafCode: code,
          anafCodeForm: 'FOUR_DIGIT',
          anafCodeUsable: false,
          agreement: 'ANAF_PLACEHOLDER',
        },
      });
    }
  );

  it('selects from the exact aggregate beyond the 500-row display list, and says the list is truncated', async () => {
    // The registry list shows 500 rows of rev2 4711 and is marked truncated;
    // the only key with the ANAF code's digits (rev3 6201) lies beyond it.
    const shown = Array.from({ length: 500 }, (_, i) => observation(i + 1, {}));
    const repo = stubRepo({
      getProfileData: vi.fn(async (_cui: string, scope: CompanyRegistryEnvelope) => {
        const base = profileUnder(scope);
        return ok({
          ...base,
          registry: { ...base.registry, caenObservations: shown, observationsTruncated: true },
        });
      }),
      getActivityEvidence: vi.fn(async () =>
        ok({
          ...EVIDENCE,
          groups: [
            { revision: 'rev2', code: '4711', classState: 'class', rows: 1000 },
            { revision: 'rev3', code: '6201', classState: 'class', rows: 85 },
            { revision: 'rev1', code: '0201', classState: 'short_token', rows: 5 },
          ],
          fiscal: { ...EVIDENCE.fiscal!, code: '6201' },
        })
      ),
    });
    const body = await gql(
      await buildGraphql(repo),
      `query { company(cui: "${CUI}") {
        registry { observationsTruncated caenObservations { id } }
        activitySelection { basis code revision classKeyCount unqualifiedObservationCount observationCount agreement }
      } }`
    );
    expect(body.errors).toBeUndefined();
    const company = body.data?.['company'] as {
      registry: { observationsTruncated: boolean; caenObservations: unknown[] };
      activitySelection: Record<string, unknown>;
    };
    expect(company.registry.observationsTruncated).toBe(true);
    expect(company.registry.caenObservations).toHaveLength(500);
    expect(company.activitySelection).toEqual({
      basis: 'ONRC_CLASS_ANAF_NUMERIC_MATCH',
      code: '6201',
      revision: 'rev3',
      classKeyCount: 2,
      unqualifiedObservationCount: 5,
      // Exact, from the aggregate: never the 500 rows the list shows.
      observationCount: 1090,
      agreement: 'MATCH_ONE_KEY',
    });
  });

  it('reads no evidence when the field is not selected', async () => {
    const repo = repoWith(async () => ok(EVIDENCE));
    const body = await gql(await buildGraphql(repo), `query { company(cui: "${CUI}") { cui } }`);
    expect(body.errors).toBeUndefined();
    expect(repo.getActivityEvidence).not.toHaveBeenCalled();
  });

  it('refuses an aggregate past its bound on THIS field only, never a truncated selection', async () => {
    const overflow = Array.from({ length: ACTIVITY_AGGREGATE_GROUP_BOUND + 1 }, (_, i) => ({
      revision: null,
      code: null,
      classState: 'unparsed',
      rows: i + 1,
    }));
    const repo = repoWith(async () => ok({ ...EVIDENCE, groups: overflow }));
    const body = await gql(
      await buildGraphql(repo),
      `query { company(cui: "${CUI}") { cui name ${SELECTION} } }`
    );
    expect(body.data?.['company']).toEqual({
      cui: CUI,
      name: 'DEDEMAN SRL',
      activitySelection: null,
    });
    expect(body.errors).toHaveLength(1);
    expect(body.errors?.[0]?.path).toEqual(['company', 'activitySelection']);
    expect(body.errors?.[0]?.extensions).toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    expect(body.errors?.[0]?.message).toContain('more than 2000');
  });

  it('is null for a company without a profile in the edition (no evidence read)', async () => {
    const repo = repoWith(async () => ok(EVIDENCE), false);
    const body = await gql(
      await buildGraphql(repo),
      `query { company(cui: "${CUI}") { ${SELECTION} } }`
    );
    expect(body.errors).toBeUndefined();
    expect(body.data?.['company']).toEqual({ activitySelection: null });
    expect(repo.getActivityEvidence).not.toHaveBeenCalled();
  });

  it('serves the class state; only a CLASS row or entry carries a label', async () => {
    const repo = repoWith(async () => ok(EVIDENCE));
    const body = await gql(
      await buildGraphql(repo),
      `query { company(cui: "${CUI}") {
        registry { caenObservations { code classState catalogLabel { label } } }
        caenActivities { code classState label }
      } }`
    );
    expect(body.errors).toBeUndefined();
    expect(body.data?.['company']).toEqual({
      registry: {
        caenObservations: [
          { code: '4711', classState: 'CLASS', catalogLabel: { label: 'Comerț cu amănuntul' } },
          { code: '0111', classState: 'SHORT_TOKEN', catalogLabel: null },
        ],
      },
      caenActivities: [
        { code: '0111', classState: 'SHORT_TOKEN', label: null },
        { code: '4711', classState: 'CLASS', label: 'Comerț cu amănuntul' },
      ],
    });
  });
});

describe('the activity selection inside the Company pin', () => {
  it('re-pins the whole Company when the evidence read loses the registry capability', async () => {
    const repo = repoWith(async () => err(registryCapabilityLost()));
    const result = await makeCompanyComposition(
      { repo, flowsRepo: stubFlows(), meili: null },
      CUI,
      { activitySelection: true }
    );
    expect(result._unsafeUnwrapErr()).toEqual({
      type: 'ServiceUnavailable',
      message: REGISTRY_MOVED_MESSAGE,
    });
    expect(repo.captureRegistryScope).toHaveBeenCalledTimes(2);
  });

  it('keeps an ordinary evidence failure on the field while the Company is served', async () => {
    const repo = repoWith(async () =>
      err({ type: 'Database', message: 'activity selection evidence read failed' })
    );
    const composition = (
      await makeCompanyComposition({ repo, flowsRepo: stubFlows(), meili: null }, CUI, {
        activitySelection: true,
      })
    )._unsafeUnwrap();
    expect(composition?.profile.cui).toBe(CUI);
    expect(composition?.activitySelection?._unsafeUnwrapErr().type).toBe('Database');
  });
});

describe('the MCP snapshot', () => {
  const snapshot = async (repo: CompaniesRepository) => {
    const tool = makeCompaniesMcpTools({
      ...deps(repo),
      clientBaseUrl: 'https://transparenta.test',
    }).find((t) => t.name === 'get_company_snapshot');
    if (tool === undefined) throw new Error('no snapshot tool');
    return tool.handler({ cui: CUI });
  };

  it('adds the derived activity selection (derived wording in the tool description)', async () => {
    const out = await snapshot(repoWith(async () => ok(EVIDENCE)));
    expect(out).toMatchObject({
      ok: true,
      item: {
        activitySelection: {
          basis: 'onrc_class_anaf_numeric_match',
          source: 'ONRC',
          code: '4711',
          revision: 'rev2',
          derived: true,
          agreement: 'match_one_key',
          anafCodeForm: 'four_digit',
          editionSourceDate: '2026-07-08',
          anafStatusDate: '2026-09-28',
        },
      },
    });
    expect(out).not.toHaveProperty('meta.activitySelectionRefusal');
    const tool = makeCompaniesMcpTools({ ...deps(stubRepo()), clientBaseUrl: 'x' }).find(
      (t) => t.name === 'get_company_snapshot'
    );
    expect(tool?.description).toContain("never the 'principal' or 'main' activity");
  });

  it('states a refused selection instead of a truncated one', async () => {
    const overflow = Array.from({ length: ACTIVITY_AGGREGATE_GROUP_BOUND + 1 }, () => ({
      revision: null,
      code: null,
      classState: 'unparsed',
      rows: 1,
    }));
    const out = await snapshot(repoWith(async () => ok({ ...EVIDENCE, groups: overflow })));
    expect(out).toMatchObject({ ok: true, item: { activitySelection: null } });
    expect(
      String((out as { meta?: Record<string, unknown> }).meta?.['activitySelectionRefusal'])
    ).toContain('more than 2000');
  });
});

/**
 * B5 traceability over the same transports: long-format-only statements as
 * metadata beside the typed history (GraphQL `companyFinancials`, MCP
 * `get_company_financials`), and the public-flow wording of the MCP snapshot.
 */
describe('long-format-only statements and public-flow wording on the transports', () => {
  const OMV = '1590082';
  const LONG = {
    year: 2013,
    sourceSystem: 'mfp',
    filerClass: 'ir',
    sourceSnapshotId: 'mfp:situatii_financiare_2021:2013:13dec119-4013-4689-90e0-52da4c69d3ea',
    resourceUrl: 'https://data.gov.ro/dataset/x/resource/13dec119/download/web_ir_an2013.txt',
  };
  const LONG_FIELDS = 'longFormOnly { year sourceSystem filerClass sourceSnapshotId resourceUrl }';
  const longOnlyRepo = (longFormOnly: readonly (typeof LONG)[] | null) =>
    stubRepo({ getLongFormOnlyStatements: vi.fn(async () => ok(longFormOnly)) });
  const financialsTool = (repo: CompaniesRepository) => {
    const tool = makeCompaniesMcpTools({ ...deps(repo), clientBaseUrl: 'x' }).find(
      (t) => t.name === 'get_company_financials'
    );
    if (tool === undefined) throw new Error('no financials tool');
    return tool;
  };

  it('GraphQL: a long-format-only CUI answers years [], latest/trajectory null, with its statements', async () => {
    const body = await gql(
      await buildGraphql(longOnlyRepo([LONG])),
      `query { companyFinancials(cui: "${OMV}") { years { year } latest { year } trajectory { fromYear } ${LONG_FIELDS} } }`
    );
    expect(body.errors).toBeUndefined();
    expect(body.data?.['companyFinancials']).toEqual({
      years: [],
      latest: null,
      trajectory: null,
      longFormOnly: [LONG],
    });
  });

  it('GraphQL: an unreadable ledger is null (unknown), and nothing known is a null answer', async () => {
    const unknown = await gql(
      await buildGraphql(longOnlyRepo(null)),
      `query { companyFinancials(cui: "${OMV}") { years { year } ${LONG_FIELDS} } }`
    );
    expect(unknown.data?.['companyFinancials']).toEqual({ years: [], longFormOnly: null });
    const none = await gql(
      await buildGraphql(longOnlyRepo([])),
      `query { companyFinancials(cui: "${OMV}") { years { year } } }`
    );
    expect(none.errors).toBeUndefined();
    expect(none.data?.['companyFinancials']).toBeNull();
  });

  it('GraphQL: file-level only, the contract names no physical row', async () => {
    const body = await gql(
      await buildGraphql(longOnlyRepo([LONG])),
      `query { companyFinancials(cui: "${OMV}") { longFormOnly { year statementLocator } } }`
    );
    expect(body.data?.['companyFinancials'] ?? null).toBeNull();
    expect(JSON.stringify(body.errors)).toContain('statementLocator');
  });

  it('MCP get_company_financials: the statements ride in the item, no figures, stated in the summary', async () => {
    const out = (await financialsTool(longOnlyRepo([LONG])).handler({ cui: OMV })) as {
      item?: { years: unknown[]; latest: unknown; longFormOnly: unknown };
      summary?: string;
    };
    expect(out.item).toMatchObject({ years: [], latest: null, longFormOnly: [LONG] });
    expect(out.summary).toBe(
      `0 financial year(s) for CUI ${OMV}; 1 long-format-only statement(s) outside the series (no figures).`
    );
    expect(financialsTool(stubRepo()).description).toContain('longFormOnly');
  });

  it('MCP snapshot: incoming public flows, exact total, never "received", not proof of payment', async () => {
    const repo = repoWith(async () => ok(EVIDENCE));
    const flows = {
      ...stubFlows(),
      getFlowSummary: vi.fn(async () =>
        ok({
          direction: 'in' as const,
          count: 5103,
          totalAmountRon: '2551589338.63',
          minYear: 2007,
          maxYear: 2026,
          byFlowType: [{ flowType: 'pnrr_commitment', count: 3, totalAmountRon: '822525171.83' }],
          byYear: [],
        })
      ),
    };
    const tools = makeCompaniesMcpTools({ ...deps(repo), flowsRepo: flows, clientBaseUrl: 'x' });
    const snapshot = tools.find((t) => t.name === 'get_company_snapshot');
    if (snapshot === undefined) throw new Error('no snapshot tool');
    const out = (await snapshot.handler({ cui: CUI })) as {
      summary?: string;
      item?: { publicMoney?: { totalRon: string } | null };
    };
    expect(out.summary).toContain(
      'incoming public flows as payee: 2551589338.63 RON over 5103 record(s), not proof of payment'
    );
    expect(out.summary).not.toMatch(/received|paid/iu);
    expect(out.item?.publicMoney?.totalRon).toBe('2551589338.63');
    expect(snapshot.description).toContain('not proof of payment');
    expect(snapshot.description).not.toContain('public money received');
    // No indexed flow: said as such, never a verified zero.
    const none = (await makeCompaniesMcpTools({ ...deps(repo), clientBaseUrl: 'x' })
      .find((t) => t.name === 'get_company_snapshot')
      ?.handler({ cui: CUI })) as { summary?: string };
    expect(none.summary).toContain('no indexed incoming public flow');
    expect(none.summary).not.toContain('0 RON');
  });
});
