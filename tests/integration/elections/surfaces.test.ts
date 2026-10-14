/**
 * Elections catalog over the REAL GraphQL slice (Mercurius, inject) and the
 * REAL MCP dispatcher, both over one in-memory repository: identical answers
 * for identical inputs, typed errors on both, the merged slice builds next to
 * the kernel base, and no surface serves a restricted value or a results field.
 */
import fastifyLib, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { makeGraphQLPlugin } from '@/infra/graphql/index.js';
import {
  electionsTypeDefs,
  makeElectionsResolvers,
} from '@/modules/elections/shell/graphql/schema.js';
import { makeElectionsMcpTools } from '@/modules/elections/shell/mcp/tools.js';
import {
  baseTypeDefs,
  createMcpHttpDispatcher,
  mergeGraphqlSlices,
  scalarResolvers,
  type KernelMcpTool,
} from '@/modules/shared/index.js';
import { createKernelMcpServer } from '@/modules/shared/shell/mcp/server.js';

import { makeFakeElectionsRepo, RESTRICTED_SENTINEL } from '../../fixtures/elections/catalog.js';

const deps = { repo: makeFakeElectionsRepo() };
const tools = makeElectionsMcpTools(deps);
let app: FastifyInstance;

beforeAll(async () => {
  const { typeDefs } = mergeGraphqlSlices(baseTypeDefs, [
    { source: 'elections', typeDefs: electionsTypeDefs },
  ]);
  app = fastifyLib({ logger: false });
  await app.register(
    makeGraphQLPlugin({
      schema: [typeDefs],
      resolvers: [{ ...scalarResolvers, ...makeElectionsResolvers(deps) }],
      isProduction: false,
      enableGraphiQL: false,
    })
  );
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

interface GqlResponse {
  readonly data?: Record<string, unknown> | null;
  readonly errors?: readonly {
    readonly message: string;
    readonly extensions?: Record<string, unknown>;
  }[];
}

const gql = async (query: string, variables: Record<string, unknown> = {}) => {
  const res = await app.inject({
    method: 'POST',
    url: '/graphql',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ query, variables }),
  });
  return { status: res.statusCode, raw: res.body, body: res.json<GqlResponse>() };
};

const callTool = async (
  available: readonly KernelMcpTool[],
  name: string,
  args: Record<string, unknown>
) => {
  const dispatcher = createMcpHttpDispatcher(() => createKernelMcpServer(available));
  const response = (await dispatcher.dispatch({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name, arguments: args },
  })) as { result?: { structuredContent?: Record<string, unknown>; isError?: boolean } };
  await dispatcher.close();
  return response;
};

const structured = async (name: string, args: Record<string, unknown>) => {
  const content = (await callTool(tools, name, args)).result?.structuredContent;
  if (content === undefined) throw new Error(`no structured content from ${name}`);
  return content;
};

const READINESS = 'readiness { identity sourceSelection sourceOpening results mandates issues }';
const EDITION = `electionKey eventKey reportedName reportedYear verifiedYear reportedFamily verifiedFamily
  reportedRound reportedDate reportedAuthority ${READINESS}`;
const CONTEST = `contestKey electionKey eventKey reportedOffice verifiedOffice chamber reportedRound
  scopeType sourceScopeKey scopeLabel constituencyCode constituencyName ${READINESS}`;

describe('elections GraphQL and MCP parity', () => {
  it('returns the same catalog page, total and paging flags on both surfaces', async () => {
    const filter = { reportedYears: { in: [2024] } };
    const { body } = await gql(
      `query($filter: ElectionCatalogFilter) {
        electionCatalog(filter: $filter, page: 1, pageSize: 2) {
          items { ${EDITION} } page pageSize total hasMore
        }
      }`,
      { filter }
    );
    expect(body.errors).toBeUndefined();
    const page = body.data?.['electionCatalog'] as Record<string, unknown>;
    expect(page).toMatchObject({ page: 1, pageSize: 2, total: 3, hasMore: true });
    const mcp = await structured('list_election_editions', { filter, page: 1, pageSize: 2 });
    expect(mcp['ok']).toBe(true);
    expect(mcp['items']).toEqual(page['items']);
    expect(mcp['meta']).toEqual({
      page: 1,
      pageSize: 2,
      total: 3,
      hasMore: true,
      totalCounts: 'source_editions',
    });
  });

  it('returns the same contest list and contest detail on both surfaces', async () => {
    const filter = { reportedOffices: { in: ['mayor'] } };
    const { body } = await gql(
      `query($key: ID!, $filter: ElectionContestsFilter) {
        electionContests(electionKey: $key, filter: $filter) { items { ${CONTEST} } total hasMore }
      }`,
      { key: 'bec-local-2024', filter }
    );
    const contests = body.data?.['electionContests'] as Record<string, unknown>;
    expect(contests['total']).toBe(3);
    const mcp = await structured('list_election_contests', {
      electionKey: 'bec-local-2024',
      filter,
    });
    expect(mcp['items']).toEqual(contests['items']);

    const key = 'contest:aep-local-2014-t1:mayor:siruta:179141';
    const detail = await gql(
      `query($key: ID!) { electionContest(contestKey: $key) { ${CONTEST} } }`,
      {
        key,
      }
    );
    const mcpDetail = await structured('get_election_contest', { contestKey: key });
    expect(mcpDetail['item']).toEqual(detail.body.data?.['electionContest']);
    expect(mcpDetail['item']).toMatchObject({
      sourceScopeKey: '179141',
      verifiedOffice: null,
      readiness: { results: 'UNAVAILABLE' },
    });
  });

  it('answers a restricted edition as NOT_FOUND / null on both surfaces without echoing data', async () => {
    const key = `restricted-${RESTRICTED_SENTINEL}`;
    const { body, raw } = await gql(
      `query($key: ID!) {
        electionEdition(electionKey: $key) { electionKey }
        electionContests(electionKey: $key) { total }
      }`,
      { key }
    );
    expect(body.data).toBeNull();
    expect(body.errors?.[0]?.extensions?.['code']).toBe('NOT_FOUND');
    expect(raw.split(RESTRICTED_SENTINEL)).toHaveLength(1);
    const mcp = await structured('list_election_contests', { electionKey: key });
    expect(mcp).toMatchObject({ ok: false, errorType: 'NotFound', errorCode: 'NOT_FOUND' });
    const edition = await structured('get_election_edition', { electionKey: key });
    expect(edition['item']).toBeNull();
  });

  it('serves no restricted value anywhere in full listings', async () => {
    const graph = await gql(
      `{ electionCatalog(pageSize: 100) { items { ${EDITION} } }
         electionContests(electionKey: "bec-local-2024", pageSize: 100) { items { ${CONTEST} } } }`
    );
    expect(graph.raw).not.toContain(RESTRICTED_SENTINEL);
    const mcp = JSON.stringify([
      await structured('list_election_editions', { pageSize: 100 }),
      await structured('list_election_contests', { electionKey: 'bec-local-2024', pageSize: 100 }),
    ]);
    expect(mcp).not.toContain(RESTRICTED_SENTINEL);
  });

  it('maps validation errors to INVALID_INPUT on both surfaces', async () => {
    const { body } = await gql(`{ electionCatalog(pageSize: 101) { total } }`);
    expect(body.errors?.[0]?.extensions?.['code']).toBe('INVALID_INPUT');
    const mcp = await structured('list_election_editions', {
      filter: { reportedYears: { in: [24] } },
    });
    expect(mcp).toMatchObject({ ok: false, errorType: 'InvalidInput' });
    const unknownField = await structured('list_election_editions', {
      filter: { verifiedYears: { in: [2024] } },
    });
    expect(unknownField).toMatchObject({ ok: false, errorType: 'InvalidInput' });
    const strict = await callTool(tools, 'list_election_editions', { year: 2024 });
    expect(JSON.stringify(strict)).not.toContain('"ok":true');
  });
});

describe('elections page offset guard across surfaces', () => {
  const LAST_GRAPHQL_INT = 2_147_483_647;

  it('rejects an unsafe page offset on both MCP list tools without a repository read', async () => {
    const repo = makeFakeElectionsRepo();
    const guarded = makeElectionsMcpTools({ repo });
    const page = Number.MAX_SAFE_INTEGER;
    for (const [name, args] of [
      ['list_election_editions', { page, pageSize: 100 }],
      ['list_election_contests', { electionKey: 'bec-local-2024', page, pageSize: 100 }],
    ] as const) {
      const response = await callTool(guarded, name, args);
      expect(response.result?.structuredContent).toMatchObject({
        ok: false,
        errorType: 'InvalidInput',
        errorCode: 'INVALID_INPUT',
      });
    }
    expect(repo.calls).toEqual([]);
  });

  it('cannot express that page on GraphQL, whose Int is 32-bit', async () => {
    const { body } = await gql(`query($page: Int) { electionCatalog(page: $page) { total } }`, {
      page: Number.MAX_SAFE_INTEGER,
    });
    expect(body.data ?? null).toBeNull();
    expect(body.errors?.[0]?.message).toContain('Int cannot represent non 32-bit signed integer');
  });

  it('answers the largest GraphQL page identically on both surfaces', async () => {
    const { body } = await gql(
      `query($page: Int) {
        electionCatalog(page: $page, pageSize: 100) { items { electionKey } page pageSize total hasMore }
      }`,
      { page: LAST_GRAPHQL_INT }
    );
    expect(body.data?.['electionCatalog']).toEqual({
      items: [],
      page: LAST_GRAPHQL_INT,
      pageSize: 100,
      total: 6,
      hasMore: false,
    });
    const mcp = await structured('list_election_editions', {
      page: LAST_GRAPHQL_INT,
      pageSize: 100,
    });
    expect(mcp).toMatchObject({
      ok: true,
      items: [],
      meta: { page: LAST_GRAPHQL_INT, pageSize: 100, total: 6, hasMore: false },
    });
  });
});

describe('elections GraphQL contract', () => {
  const fieldsOf = async (type: string) => {
    const { body } = await gql(`query($t: String!) { __type(name: $t) { fields { name } } }`, {
      t: type,
    });
    const described = body.data?.['__type'] as { fields: { name: string }[] } | null;
    return described?.fields.map((field) => field.name).sort();
  };

  it('exposes only governed metadata fields: no results, winners, attrs or artifact URLs', async () => {
    expect(await fieldsOf('ElectionContest')).toEqual(
      [
        'chamber',
        'constituencyCode',
        'constituencyName',
        'contestKey',
        'electionKey',
        'eventKey',
        'readiness',
        'reportedOffice',
        'reportedRound',
        'scopeLabel',
        'scopeType',
        'sourceScopeKey',
        'verifiedOffice',
      ].sort()
    );
    expect(await fieldsOf('ElectionEdition')).toEqual(
      [
        'electionKey',
        'eventKey',
        'readiness',
        'reportedAuthority',
        'reportedDate',
        'reportedFamily',
        'reportedName',
        'reportedRound',
        'reportedYear',
        'verifiedFamily',
        'verifiedYear',
      ].sort()
    );
    expect(await fieldsOf('ElectionReadiness')).toEqual(
      ['identity', 'issues', 'mandates', 'results', 'sourceOpening', 'sourceSelection'].sort()
    );
  });

  it('keeps every row explicit about held identity and unavailable results', async () => {
    const { body } = await gql(`{ electionCatalog(pageSize: 100) { items { ${EDITION} } } }`);
    const items = (body.data?.['electionCatalog'] as { items: Record<string, unknown>[] }).items;
    expect(items).toHaveLength(6);
    for (const item of items) {
      expect(item).toMatchObject({
        verifiedYear: null,
        verifiedFamily: null,
        readiness: {
          identity: 'HELD',
          sourceOpening: 'HELD',
          results: 'UNAVAILABLE',
          mandates: 'UNAVAILABLE',
        },
      });
    }
  });
});
