/**
 * Elections results over the REAL GraphQL slice (Mercurius, inject) and the
 * REAL MCP dispatcher, both over one in-memory repository: identical answers
 * for identical inputs, typed errors on both, the merged slice builds next to
 * the kernel base, and no surface exposes candidate rows, attrs, decision ids
 * or source pointers.
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
} from '@/modules/shared/index.js';
import { createKernelMcpServer } from '@/modules/shared/shell/mcp/server.js';

import {
  COUNCIL,
  EVENT,
  MAYOR,
  OCCURRENCE,
  makeFakeElectionsRepo,
} from '../../fixtures/elections/results.js';

const repo = makeFakeElectionsRepo();
const tools = makeElectionsMcpTools({ repo });
let app: FastifyInstance;

beforeAll(async () => {
  const { typeDefs } = mergeGraphqlSlices(baseTypeDefs, [
    { source: 'elections', typeDefs: electionsTypeDefs },
  ]);
  app = fastifyLib({ logger: false });
  await app.register(
    makeGraphQLPlugin({
      schema: [typeDefs],
      resolvers: [{ ...scalarResolvers, ...makeElectionsResolvers({ repo }) }],
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

const callTool = async (name: string, args: Record<string, unknown>) => {
  const dispatcher = createMcpHttpDispatcher(() => createKernelMcpServer(tools));
  const response = (await dispatcher.dispatch({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name, arguments: args },
  })) as { result?: { structuredContent?: Record<string, unknown>; isError?: boolean } };
  await dispatcher.close();
  const content = response.result?.structuredContent;
  if (content === undefined) throw new Error(`no structured content from ${name}`);
  return content;
};

const SHARE = 'percent numerator denominator basis';
const COMPETITOR = 'competitorKey kind actorKey label reportedLabels';
const PLACE = 'placeKey placeType sirutaCode countyCode name countyName';
const QUALITY =
  'value construction sourceLevel finality geographicCompleteness includesDiaspora status issues';
const TALLY = `competitor { ${COMPETITOR} } reportedLabel measure allocationPhase countedPopulation share { ${SHARE} } ${QUALITY}`;
const RACE_ENTRY = `competitor { ${COMPETITOR} } votes share { ${SHARE} }`;
const RACE = `competitorCount status geographicCompleteness finality issues leader { ${RACE_ENTRY} } runnerUp { ${RACE_ENTRY} } marginVotes marginPoints tied`;
const CONTEST = `contestKey occurrenceKey eventKey office jurisdiction { ${PLACE} } status replacedBy race { ${RACE} }`;
const FIGURES = `place { ${PLACE} } tallies { ${TALLY} } turnout { measure ${QUALITY} } participation { ${SHARE} } race { ${RACE} }`;
const RESULT = `occurrenceKey eventKey office contest { ${CONTEST} } ${FIGURES} coverage { measure allocationPhase placeSpecific state issues }`;
const EVENT_FIELDS = `eventKey family year publication { publicationId activatedAt } occurrences { occurrenceKey eventKey ballotDate round kind status offices { office contests } }`;

describe('elections GraphQL and MCP parity', () => {
  it('returns the same events and event detail on both surfaces', async () => {
    const page = await gql(`{ electionEvents { items { ${EVENT_FIELDS} } total hasMore } }`);
    expect(page.body.errors, page.raw).toBeUndefined();
    const tool = await callTool('list_election_events', {});
    expect((page.body.data?.['electionEvents'] as { items: unknown }).items).toEqual(tool['items']);
    const detail = await gql(`query($k: ID!) { electionEvent(eventKey: $k) { ${EVENT_FIELDS} } }`, {
      k: EVENT,
    });
    expect(detail.body.data?.['electionEvent']).toEqual(
      (await callTool('get_election_event', { eventKey: EVENT }))['item']
    );
  });

  it('returns the same contests, result and breakdown on both surfaces', async () => {
    const contests = await gql(
      `query($o: ID!) { electionContests(occurrenceKey: $o, filter: { offices: { in: ["mayor"] } }) { items { ${CONTEST} } total } }`,
      { o: OCCURRENCE }
    );
    expect(contests.body.errors, contests.raw).toBeUndefined();
    expect((contests.body.data?.['electionContests'] as { items: unknown }).items).toEqual(
      (
        await callTool('list_election_contests', {
          occurrenceKey: OCCURRENCE,
          filter: { offices: { in: ['mayor'] } },
        })
      )['items']
    );
    const result = await gql(
      `query($o: ID!, $c: ID) { electionResult(occurrenceKey: $o, office: "mayor", scopeKey: "uat:1017", contestKey: $c) { ${RESULT} } }`,
      { o: OCCURRENCE, c: MAYOR }
    );
    expect(result.body.errors, result.raw).toBeUndefined();
    expect(result.body.data?.['electionResult']).toEqual(
      (
        await callTool('get_election_result', {
          occurrenceKey: OCCURRENCE,
          office: 'mayor',
          scopeKey: 'uat:1017',
          contestKey: MAYOR,
        })
      )['item']
    );
    const scopes = await gql(
      `query($o: ID!, $c: ID) { electionResultScopes(occurrenceKey: $o, office: "county_council", scopeType: uat, contestKey: $c) { items { ${FIGURES} } total } }`,
      { o: OCCURRENCE, c: COUNCIL }
    );
    expect(scopes.body.errors, scopes.raw).toBeUndefined();
    expect((scopes.body.data?.['electionResultScopes'] as { items: unknown }).items).toEqual(
      (
        await callTool('list_election_result_scopes', {
          occurrenceKey: OCCURRENCE,
          office: 'county_council',
          scopeType: 'uat',
          contestKey: COUNCIL,
        })
      )['items']
    );
  });

  it('answers an unpublished occurrence as NOT_FOUND on GraphQL and as a failure on MCP', async () => {
    const res = await gql(
      `{ electionContests(occurrenceKey: "ro:local:2016:2016-06-05") { total } }`
    );
    expect(res.body.errors?.[0]?.extensions?.['code']).toBe('NOT_FOUND');
    const tool = await callTool('list_election_contests', {
      occurrenceKey: 'ro:local:2016:2016-06-05',
    });
    expect(tool).toMatchObject({ ok: false, errorType: 'NotFound', errorCode: 'NOT_FOUND' });
  });

  it('maps validation errors to INVALID_INPUT on both surfaces', async () => {
    const res = await gql(
      `{ electionResult(occurrenceKey: "x", office: "mayor", scopeKey: "sector:1") { office } }`
    );
    expect(res.body.errors?.[0]?.extensions?.['code']).toBe('INVALID_INPUT');
    const tool = await callTool('get_election_result', {
      occurrenceKey: 'x',
      office: 'mayor',
      scopeKey: 'sector:1',
    });
    expect(tool).toMatchObject({ ok: false, errorType: 'InvalidInput' });
  });
});

describe('elections GraphQL contract', () => {
  interface TypeRef {
    readonly kind: string;
    readonly name: string | null;
    readonly ofType: TypeRef | null;
  }
  const typeOf = async (name: string) => {
    const { body } = await gql(
      `query($n: String!) { __type(name: $n) { kind fields { name type { kind name ofType { kind name ofType { kind name ofType { kind name } } } } } } }`,
      { n: name }
    );
    return body.data?.['__type'] as {
      kind: string;
      fields: { name: string; type: TypeRef }[] | null;
    } | null;
  };
  const named = (type: TypeRef | null): string | null =>
    type === null ? null : (type.name ?? named(type.ofType));

  it('exposes no candidate, attrs, decision, source pointer or source file field at any depth', async () => {
    const forbidden =
      /candida|attrs|decision|pointer|printed|person|source(?!Level)|sha256|manifest|path/iu;
    const seen = new Set<string>();
    const queue = ['Query'];
    const offending: string[] = [];
    while (queue.length > 0) {
      const name = queue.shift() ?? '';
      if (seen.has(name)) continue;
      seen.add(name);
      const type = await typeOf(name);
      for (const field of type?.fields ?? []) {
        if (name === 'Query' && !field.name.startsWith('election')) continue;
        if (forbidden.test(field.name)) offending.push(`${name}.${field.name}`);
        const target = named(field.type);
        if (target?.startsWith('Election') === true) queue.push(target);
      }
    }
    expect(offending).toEqual([]);
    expect(seen.size).toBeGreaterThan(10);
    const query = (await typeOf('Query'))?.fields
      ?.map((field) => field.name)
      .filter((field) => field.startsWith('election'))
      .sort();
    expect(query).toEqual([
      'electionCompetitors',
      'electionContest',
      'electionContests',
      'electionEvent',
      'electionEvents',
      'electionResult',
      'electionResultScopes',
    ]);
  });
});
