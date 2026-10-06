import { buildSchema, GraphQLError } from 'graphql';
import { ok } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import {
  getPublicEnterpriseProfile,
  listPublicEnterpriseIndicators,
  listPublicEnterprises,
  PUBLIC_ENTERPRISE_NAME_MATCH_LIMIT,
  searchPublicEnterprises,
  type PublicEnterpriseDeps,
} from '@/modules/public-enterprises/core/usecases.js';
import { makePublicEnterprisesModule } from '@/modules/public-enterprises/index.js';
import {
  makePublicEnterpriseResolvers,
  publicEnterpriseTypeDefs,
} from '@/modules/public-enterprises/shell/graphql/schema.js';
import { makePublicEnterpriseMcpTools } from '@/modules/public-enterprises/shell/mcp/tools.js';
import {
  INDICATOR_SORT,
  indicatorFilterHash,
  makePublicEnterpriseRepo,
} from '@/modules/public-enterprises/shell/repo/public-enterprise-repo.js';
import {
  buildNextCursor,
  decodeCursor,
  GRAPHQL_ERROR_CODE,
  type Organization,
  type ProdDatabase,
} from '@/modules/shared/index.js';

import type { PublicEnterpriseRepository } from '@/modules/public-enterprises/core/ports.js';
import type {
  PublicEnterpriseIndicator,
  PublicEnterpriseIndicatorRequest,
  PublicEnterpriseListRequest,
  PublicEnterpriseMembership,
  PublicEnterpriseProfileRecord,
} from '@/modules/public-enterprises/core/types.js';
import type { Kysely } from 'kysely';

const organization = (cui: string): Organization => ({
  orgId: '1',
  cui,
  registrationNumber: null,
  kind: 'company',
  name: `Organization ${cui}`,
  normalizedName: null,
  countyName: null,
  localityName: null,
  sirutaCode: null,
  firstSeenSource: 'test',
  attrs: {},
});

const MEMBERS: PublicEnterpriseMembership[] = [
  { cui: '10020943', isCurrentMember: true, currentFamilies: ['amepip_company_year'] },
  { cui: '360557', isCurrentMember: false, currentFamilies: ['json_apt'] },
  { cui: '44444440', isCurrentMember: false, currentFamilies: [] },
];

const INDICATOR: PublicEnterpriseIndicator = {
  id: 'amepip-1|10020943|2019|Indicatori calculati||MS',
  snapshotId: 'amepip-1',
  enterpriseCui: '10020943',
  year: 2019,
  sourceSheet: 'Indicatori calculati',
  version: '',
  indicatorKey: 'MS',
  kpiCode: 'MS',
  indicatorName: 'Marja neta',
  measureUnit: '%',
  valueKind: 'number',
  rawValue: '0.0425',
  numericValue: '0.0425',
  booleanValue: null,
  textValue: null,
  sourceRowNumber: 8,
  sourceEvidenceKey: 'ev:a1:v:ms2019',
  sourceUrl: 'https://data.gov.ro/amepip-1.xlsx#MS2019',
};

const PROFILE = (cui: string): PublicEnterpriseProfileRecord | null => {
  const member = MEMBERS.find((m) => m.cui === cui);
  return member === undefined
    ? null
    : { ...member, registryObservations: [], authorityEdges: [], sources: [] };
};

function fakes(named: readonly string[] = ['10020943']) {
  const calls = {
    profile: [] as string[],
    list: [] as PublicEnterpriseListRequest[],
    indicators: [] as PublicEnterpriseIndicatorRequest[],
    identity: [] as string[][],
    names: [] as [string, number][],
  };
  const repo: PublicEnterpriseRepository = {
    sources: () => Promise.resolve(ok([])),
    profile: (cui) => {
      calls.profile.push(cui);
      return Promise.resolve(ok(PROFILE(cui)));
    },
    list: (request) => {
      calls.list.push(request);
      return Promise.resolve(
        ok({ items: MEMBERS, page: request.page, pageSize: request.pageSize, total: 3 })
      );
    },
    indicators: (request) => {
      calls.indicators.push(request);
      return Promise.resolve(ok({ items: [INDICATOR], next: null, snapshotId: 'amepip-1' }));
    },
  };
  const deps: PublicEnterpriseDeps = {
    repo,
    identityRepo: {
      findManyByCui: (cuis) => {
        calls.identity.push([...cuis]);
        return Promise.resolve(
          ok(new Map(cuis.filter((c) => named.includes(c)).map((c) => [c, organization(c)])))
        );
      },
      searchByName: (q, limit) => {
        calls.names.push([q, limit]);
        return Promise.resolve(
          ok([
            {
              orgId: '1',
              cui: '10020943',
              name: 'Hidroelectrica',
              normalizedName: null,
              countyName: null,
              kind: 'company',
            },
            {
              orgId: '2',
              cui: null,
              name: 'No CUI',
              normalizedName: null,
              countyName: null,
              kind: 'company',
            },
            {
              orgId: '3',
              cui: '99999999',
              name: 'Other',
              normalizedName: null,
              countyName: null,
              kind: 'company',
            },
          ])
        );
      },
    },
  };
  return { deps, calls };
}

describe('public-enterprise usecases', () => {
  it('validates the CUI before any read and returns null for a non-anchor', async () => {
    const { deps, calls } = fakes();
    const bad = await getPublicEnterpriseProfile(deps, '12a');
    expect(bad._unsafeUnwrapErr().type).toBe('InvalidInput');
    expect(calls.profile).toEqual([]);
    expect((await getPublicEnterpriseProfile(deps, '777')).isOk()).toBe(true);
    expect((await getPublicEnterpriseProfile(deps, '777'))._unsafeUnwrap()).toBeNull();
  });

  it('keeps a profile whose identity is withheld, with organization null', async () => {
    const { deps } = fakes([]);
    const profile = (await getPublicEnterpriseProfile(deps, '44444440'))._unsafeUnwrap();
    expect(profile).toMatchObject({
      cui: '44444440',
      organization: null,
      isCurrentMember: false,
      currentFamilies: [],
    });
  });

  it('never drops a listed record without an identity; names come from ONE batch', async () => {
    const { deps, calls } = fakes(['10020943']);
    const page = (
      await listPublicEnterprises(deps, { filter: {}, page: 1, pageSize: 20 })
    )._unsafeUnwrap();
    expect(page.items.map((i) => [i.cui, i.organization?.name ?? null])).toEqual([
      ['10020943', 'Organization 10020943'],
      ['360557', null],
      ['44444440', null],
    ]);
    expect(page.total).toBe(3);
    expect(calls.identity).toEqual([['10020943', '360557', '44444440']]);
  });

  it('rejects out-of-bound pages and invalid repo-owned filters before reading', async () => {
    const { deps, calls } = fakes();
    for (const [page, pageSize] of [
      [0, 20],
      [1, 0],
      [1, 101],
      [1.5, 20],
    ] as const) {
      const result = await listPublicEnterprises(deps, { filter: {}, page, pageSize });
      expect(result._unsafeUnwrapErr().type).toBe('InvalidInput');
    }
    const level = await listPublicEnterprises(deps, {
      filter: { authorityLevels: { in: ['federal'] } },
      page: 1,
      pageSize: 20,
    });
    expect(level._unsafeUnwrapErr()).toMatchObject({
      type: 'InvalidInput',
      field: 'authorityLevels',
    });
    const current = await listPublicEnterprises(deps, {
      filter: { currentOnly: { eq: 'yes' } },
      page: 1,
      pageSize: 20,
    });
    expect(current._unsafeUnwrapErr()).toMatchObject({
      type: 'InvalidInput',
      field: 'currentOnly',
    });
    const indicators = await listPublicEnterpriseIndicators(deps, {
      cui: '10020943',
      filter: {},
      first: 101,
    });
    expect(indicators._unsafeUnwrapErr()).toMatchObject({ type: 'InvalidInput', field: 'first' });
    expect(calls.list).toEqual([]);
    expect(calls.indicators).toEqual([]);
  });

  it('searches a name through bounded kernel resolution and intersects with the requested CUIs', async () => {
    const { deps, calls } = fakes();
    await searchPublicEnterprises(deps, { q: 'Hidro', filter: {}, page: 1, pageSize: 20 });
    expect(calls.names).toEqual([['Hidro', PUBLIC_ENTERPRISE_NAME_MATCH_LIMIT]]);
    expect(calls.list[0]?.filter).toEqual({ cuis: { in: ['10020943', '99999999'] } });
    await searchPublicEnterprises(deps, {
      q: 'Hidro',
      filter: { cuis: { in: ['99999999'] } },
      page: 1,
      pageSize: 20,
    });
    expect(calls.list[1]?.filter).toEqual({ cuis: { in: ['99999999'] } });
    // Each name query resolves once; there is no cache.
    const twoNameQueries = [
      ['Hidro', PUBLIC_ENTERPRISE_NAME_MATCH_LIMIT],
      ['Hidro', PUBLIC_ENTERPRISE_NAME_MATCH_LIMIT],
    ];
    expect(calls.names).toEqual(twoNameQueries);
    await searchPublicEnterprises(deps, { q: '10020943', filter: {}, page: 1, pageSize: 20 });
    expect(calls.list[2]?.filter).toEqual({ cuis: { in: ['10020943'] } });
    // A CUI query takes the direct path: no name resolution.
    expect(calls.names).toEqual(twoNameQueries);
  });
});

describe('public-enterprise GraphQL and MCP', () => {
  it('serve the same records through the same usecases', async () => {
    const { deps, calls } = fakes();
    const resolvers = makePublicEnterpriseResolvers(deps);
    const tools = makePublicEnterpriseMcpTools(deps);
    const tool = (name: string) => tools.find((t) => t.name === name)!;

    const gqlList = await resolvers.Query.publicEnterprises(null, {
      filter: { families: { in: ['s1001'] }, authorityCuis: null },
      page: 1,
      pageSize: 20,
    });
    const mcpList = await tool('search_public_enterprises').handler({
      filter: { families: { in: ['s1001'] } },
    });
    expect(calls.list[0]).toEqual(calls.list[1]);
    expect(mcpList.items).toEqual(gqlList.items);

    const gqlProfile = await resolvers.Query.publicEnterprise(null, { cui: '10020943' });
    const mcpProfile = await tool('get_public_enterprise_profile').handler({ cui: '10020943' });
    expect(mcpProfile.item).toEqual(gqlProfile);

    const connection = await resolvers.PublicEnterpriseProfile.indicators(gqlProfile!, {
      filter: { years: { in: [2019] } },
      first: 10,
    });
    const mcpIndicators = await tool('list_public_enterprise_indicators').handler({
      cui: '10020943',
      filter: { years: { in: [2019] } },
      first: 10,
    });
    expect(mcpIndicators.items).toEqual(connection.edges.map((e) => e.node));
    expect(calls.indicators[0]).toEqual(calls.indicators[1]);
    // Each edge cursor is the kernel envelope over the full ordering tuple.
    const decoded = decodeCursor(connection.edges[0]!.cursor, {
      sort: INDICATOR_SORT,
      dir: 'asc',
      fhash: indicatorFilterHash('10020943', 'amepip-1', { years: { in: [2019] } }),
    });
    expect(decoded._unsafeUnwrap().keys).toEqual(['2019', 'Indicatori calculati', '', 'MS']);
    expect(await tool('search_public_enterprises').handler({ filter: { bogus: 1 } })).toMatchObject(
      {
        ok: false,
        errorType: 'InvalidInput',
      }
    );
  });

  it('builds a valid SDL slice over the kernel base types', () => {
    const schema = buildSchema(
      'scalar Date\nscalar DateTime\nscalar CUI\nscalar BigInt\nscalar JSON\n' +
        'type PageInfo { hasNextPage: Boolean! endCursor: String }\n' +
        'type Organization { orgId: BigInt! cui: CUI name: String! }\n' +
        'type Query { ping: String }\n' +
        publicEnterpriseTypeDefs
    );
    expect(Object.keys(schema.getQueryType()?.getFields() ?? {}).sort()).toEqual([
      'ping',
      'publicEnterprise',
      'publicEnterpriseSources',
      'publicEnterprises',
    ]);
  });
});

describe('public-enterprise kernel cursor', () => {
  it('pins the CUI, the canonical filters and the AMEPIP snapshot', () => {
    const base = indicatorFilterHash('10020943', 'amepip-1', { years: { in: [2019, 2020] } });
    expect(indicatorFilterHash('10020943', 'amepip-1', { years: { in: [2020, 2019] } })).toBe(base);
    expect(indicatorFilterHash('10020944', 'amepip-1', { years: { in: [2019, 2020] } })).not.toBe(
      base
    );
    expect(indicatorFilterHash('10020943', 'amepip-2', { years: { in: [2019, 2020] } })).not.toBe(
      base
    );
    expect(indicatorFilterHash('10020943', 'amepip-1', { years: { in: [2019] } })).not.toBe(base);
    const cursor = buildNextCursor({
      sort: INDICATOR_SORT,
      dir: 'asc',
      fhash: base,
      lastKeys: [2019, 'Indicatori formular', 'v1', 'NOTE'],
    });
    const stale = decodeCursor(cursor, {
      sort: INDICATOR_SORT,
      dir: 'asc',
      fhash: indicatorFilterHash('10020943', 'amepip-2', { years: { in: [2019, 2020] } }),
    });
    expect(stale._unsafeUnwrapErr()).toMatchObject({
      type: 'InvalidInput',
      message: 'cursor/filter mismatch; restart pagination',
    });
  });
});

describe('public-enterprise module disabled (the default)', () => {
  it('registers no MCP tool and refuses every read without touching the database', async () => {
    const touched: string[] = [];
    const db = new Proxy(
      {},
      {
        get(_target, property) {
          touched.push(String(property));
          throw new Error('database touched');
        },
      }
    ) as unknown as Kysely<ProdDatabase>;
    const { deps } = fakes();
    const module = makePublicEnterprisesModule({ db, identityRepo: deps.identityRepo });
    expect(module.mcpTools).toEqual([]);
    await expect(module.graphqlResolvers.Query.publicEnterpriseSources()).rejects.toMatchObject({
      extensions: { code: GRAPHQL_ERROR_CODE.ServiceUnavailable },
    });
    await expect(
      module.graphqlResolvers.Query.publicEnterprise(null, { cui: '10020943' })
    ).rejects.toBeInstanceOf(GraphQLError);
    const repo = makePublicEnterpriseRepo(db, false);
    const results = await Promise.all([
      repo.sources(),
      repo.profile('10020943'),
      repo.list({ filter: {}, page: 1, pageSize: 20 }),
      repo.indicators({ cui: '10020943', filter: {}, first: 10 }),
    ]);
    expect(results.map((r) => r._unsafeUnwrapErr().type)).toEqual([
      'ServiceUnavailable',
      'ServiceUnavailable',
      'ServiceUnavailable',
      'ServiceUnavailable',
    ]);
    expect(touched).toEqual([]);
  });
});
