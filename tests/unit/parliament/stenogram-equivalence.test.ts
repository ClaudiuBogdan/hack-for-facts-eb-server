/**
 * TRI-SURFACE EQUIVALENCE for the canonical stenogram surface (§14.7).
 *
 * The same fake repo + the same fake search projection are driven through all three
 * shells — GraphQL resolvers, MCP tools, REST route — and the answers are compared
 * field by field. This is the test that would catch a surface quietly growing its own
 * privacy rule, its own error vocabulary, or its own ordering: the assertion is not
 * "each surface works" but "they agree".
 *
 * Cursor stability is asserted here too, because a per-edge cursor is minted by the
 * GraphQL shell while `next` is minted by the repo — a drift between the two fhash
 * inputs is invisible until a client pages on an edge cursor.
 */

import fastifyLib, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { stenogramSessionsFhash } from '@/modules/parliament/shell/filters/specs.js';
import { makeParliamentResolvers } from '@/modules/parliament/shell/graphql/resolvers.js';
import { makeParliamentMcpTools } from '@/modules/parliament/shell/mcp/tools.js';
import { makeParliamentRoutes } from '@/modules/parliament/shell/rest/routes.js';

import {
  makeFakeParliamentRepo,
  makeFakeTranscriptSearch,
  stenogramReading,
  stenogramSession,
  type FakeStenogramData,
} from '../../fixtures/parliament-stenogram.js';

import type { ParliamentRepo } from '@/modules/parliament/core/ports.js';
import type { KernelMcpTool, McpToolOutput } from '@/modules/shared/index.js';

const LEGACY_KEY = 'cdep:cdep_stenogram:9043:9:718';

const DATA: FakeStenogramData = {
  sessions: [
    { session: stenogramSession() },
    {
      session: stenogramSession({
        sessionKey: 'cdep:9100',
        sessionDate: '2004-02-11',
        title: 'Ședința din 11 februarie 2004',
      }),
    },
  ],
  segments: stenogramReading(7).map((segment) => ({ segment })),
  redirects: [
    {
      redirect: {
        legacySpeechKey: LEGACY_KEY,
        sessionKey: 'cdep:9043',
        canonicalSpeechKey: 'canon:cdep:9043#00004',
        canonicalSegmentKey: 'cdep:9043#00004',
        canonicalPosition: 4,
        mappingKind: 'exact_segment',
        matchMethod: 'cdep_sitting_ids',
      },
    },
  ],
};

type Resolver = (parent: unknown, args: unknown) => Promise<unknown>;

const surfaces = (
  data: FakeStenogramData,
  searchAvailable: boolean,
  hitSessionKeys?: readonly string[]
) => {
  const repo: ParliamentRepo = makeFakeParliamentRepo(data);
  const transcriptSearch = makeFakeTranscriptSearch({
    available: searchAvailable,
    // The port returns SITTINGS (already grouped + ranked), so a test fixture speaks
    // that shape too.
    ...(hitSessionKeys !== undefined && {
      hits: hitSessionKeys.map((sessionKey) => ({ sessionKey, matchedBlocks: 1 })),
    }),
  });
  const base = { repo, meili: null, transcriptSearch };
  const resolvers = makeParliamentResolvers({
    ...base,
    legalActLoader: undefined,
    searchEngineUp: false,
    isApiKeyAuthorized: (): boolean => false,
  }) as Record<string, Record<string, Resolver>>;
  const tools = makeParliamentMcpTools({ ...base, clientBaseUrl: 'https://transparenta.eu' });
  const tool = (name: string): KernelMcpTool => {
    const found = tools.find((t) => t.name === name);
    if (found === undefined) throw new Error(`missing MCP tool: ${name}`);
    return found;
  };
  return { base, query: resolvers['Query'] ?? {}, tool };
};

let app: FastifyInstance | undefined;

const restApp = async (data: FakeStenogramData): Promise<FastifyInstance> => {
  const instance = fastifyLib({ logger: false });
  await instance.register(
    makeParliamentRoutes({
      repo: makeFakeParliamentRepo(data),
      meili: null,
      transcriptSearch: null,
    }),
    { prefix: '/api/v1/parliament' }
  );
  await instance.ready();
  app = instance;
  return instance;
};

afterEach(async () => {
  await app?.close();
  app = undefined;
});

interface CursorEnvelopeShape {
  readonly fhash: string;
  readonly sort: string;
  readonly dir: string;
  readonly keys: readonly string[];
}

/**
 * Decode a kernel cursor so its envelope can be inspected. The cursor is minted by
 * our own encoder in the same process, so the payload is trusted — the same
 * justification the parliament golden suite uses for parsing MCP tool text.
 */
const decodeCursorEnvelope = (cursor: string): CursorEnvelopeShape =>
  // eslint-disable-next-line no-restricted-syntax -- test inspects a cursor this process just encoded
  JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as CursorEnvelopeShape;

interface GqlTranscript {
  readonly session: { readonly sessionKey: string; readonly availability: string };
  readonly segments: readonly { readonly position: number; readonly text: string }[];
  readonly totalSegments: number;
}

describe('the transcript READ is the same answer on GraphQL, MCP and REST', () => {
  it('returns identical session + ordered blocks on all three surfaces', async () => {
    const { query, tool } = surfaces(DATA, true);

    const gql = (await query['parliamentStenogramSession']?.(null, {
      sessionKey: 'cdep:9043',
      limit: 500,
    })) as GqlTranscript;

    const mcp = (await tool('get_parliament_stenogram_session').handler({
      sessionKey: 'cdep:9043',
      limit: 500,
    })) as McpToolOutput & {
      item?: { session: unknown; segments: readonly { position: number }[] };
      meta?: { totalSegments: number };
    };

    const instance = await restApp(DATA);
    const rest = (
      await instance.inject({
        method: 'GET',
        url: '/api/v1/parliament/stenograms/cdep:9043/transcript?limit=500',
      })
    ).json<{
      data: { session: unknown; segments: readonly { position: number; text: string }[] };
      meta: { totalSegments: number };
    }>();

    // Same session object.
    expect(mcp.item?.session).toEqual(gql.session);
    expect(rest.data.session).toEqual(gql.session);
    // Same blocks, in the same order.
    const positions = gql.segments.map((s) => s.position);
    expect(positions).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(mcp.item?.segments.map((s) => s.position)).toEqual(positions);
    expect(rest.data.segments.map((s) => s.position)).toEqual(positions);
    expect(rest.data.segments).toEqual(gql.segments);
    // Same total.
    expect(mcp.meta?.totalSegments).toBe(gql.totalSegments);
    expect(rest.meta.totalSegments).toBe(gql.totalSegments);
  });

  it('reports a SOURCE_ONLY capture with the SAME code AND the SAME session payload everywhere', async () => {
    const sourceOnly: FakeStenogramData = {
      sessions: [
        {
          session: stenogramSession({
            availability: 'SOURCE_ONLY',
            segmentCount: 0,
            speechCount: 0,
            speakerCount: 0,
            captureDigest: null,
          }),
        },
      ],
    };
    const { query, tool } = surfaces(sourceOnly, true);

    // The sitting metadata every surface must carry so a client can still offer the
    // official-transcript action instead of showing a dead end.
    const expectedSession = {
      sessionKey: 'cdep:9043',
      chamber: 'camera_deputatilor',
      sessionDate: '2003-09-29',
      availability: 'SOURCE_ONLY',
      sourceUrl: 'https://www.cdep.ro/pls/steno/steno2015.stenograma?ids=9043',
      sourceUrlKind: 'exact',
    };

    // GraphQL: a thrown GraphQLError carrying extensions.code + extensions.session.
    let gqlExtensions: unknown;
    try {
      await query['parliamentStenogramSession']?.(null, { sessionKey: 'cdep:9043' });
    } catch (e) {
      gqlExtensions = (e as { extensions?: unknown }).extensions;
    }
    expect(gqlExtensions).toMatchObject({
      code: 'TRANSCRIPT_UNAVAILABLE',
      reason: 'source_only',
      session: expectedSession,
    });

    // MCP: in-band {ok:false} with the same code in `errorCode` and the ref in meta.
    const mcp = await tool('get_parliament_stenogram_session').handler({ sessionKey: 'cdep:9043' });
    expect(mcp.ok).toBe(false);
    expect(mcp.errorCode).toBe('TRANSCRIPT_UNAVAILABLE');
    expect(mcp.meta).toMatchObject({ reason: 'source_only', session: expectedSession });

    // REST: the same code in the envelope's `error`, the same ref in `session`.
    const instance = await restApp(sourceOnly);
    const rest = await instance.inject({
      method: 'GET',
      url: '/api/v1/parliament/stenograms/cdep:9043/transcript',
    });
    expect(rest.statusCode).toBe(409);
    expect(rest.json<{ error: string; reason: string; session: unknown }>()).toMatchObject({
      error: 'TRANSCRIPT_UNAVAILABLE',
      reason: 'source_only',
      session: expectedSession,
    });
  });

  it('agrees on SITTING NAVIGATION across GraphQL, MCP and REST', async () => {
    const withNeighbours: FakeStenogramData = {
      sessions: [
        { session: stenogramSession({ sessionKey: 'cdep:9000', sessionDate: '2003-09-22' }) },
        { session: stenogramSession() },
        { session: stenogramSession({ sessionKey: 'cdep:9100', sessionDate: '2003-10-06' }) },
      ],
      segments: ['cdep:9000', 'cdep:9043', 'cdep:9100'].flatMap((sessionKey) =>
        stenogramReading(3, sessionKey).map((segment) => ({ segment }))
      ),
    };
    const { query, tool } = surfaces(withNeighbours, true);

    const gql = (await query['parliamentStenogramSession']?.(null, {
      sessionKey: 'cdep:9043',
    })) as {
      navigation: { previous: { sessionKey: string } | null; next: { sessionKey: string } | null };
    };

    const mcp = (await tool('get_parliament_stenogram_session').handler({
      sessionKey: 'cdep:9043',
    })) as McpToolOutput & {
      item?: { navigation?: unknown };
      meta?: { previousSessionKey: string | null; nextSessionKey: string | null };
    };

    const instance = await restApp(withNeighbours);
    const rest = (
      await instance.inject({
        method: 'GET',
        url: '/api/v1/parliament/stenograms/cdep:9043/transcript',
      })
    ).json<{ data: { navigation: unknown } }>();

    expect(gql.navigation.previous?.sessionKey).toBe('cdep:9000');
    expect(gql.navigation.next?.sessionKey).toBe('cdep:9100');
    expect(mcp.item?.navigation).toEqual(gql.navigation);
    expect(mcp.meta).toMatchObject({
      previousSessionKey: 'cdep:9000',
      nextSessionKey: 'cdep:9100',
    });
    expect(rest.data.navigation).toEqual(gql.navigation);
  });

  it('REST serves the COMPLETE reading that GraphQL only slices', async () => {
    const large = 2_401;
    const data: FakeStenogramData = {
      sessions: [{ session: stenogramSession({ segmentCount: large }) }],
      segments: stenogramReading(large).map((segment) => ({ segment })),
    };
    const { query } = surfaces(data, true);

    // GraphQL: an explicit slice, with the FULL count reported so a caller knows.
    const sliced = (await query['parliamentStenogramSession']?.(null, {
      sessionKey: 'cdep:9043',
      limit: 500,
    })) as { segments: readonly { position: number }[]; totalSegments: number };
    expect(sliced.segments).toHaveLength(500);
    expect(sliced.totalSegments).toBe(large);

    // REST: one response, the whole sitting — and its prefix equals the GraphQL slice,
    // so the two surfaces agree on content and order, not just on counts.
    const instance = await restApp(data);
    const rest = (
      await instance.inject({
        method: 'GET',
        url: '/api/v1/parliament/stenograms/cdep:9043/transcript',
      })
    ).json<{
      data: { segments: readonly { position: number }[] };
      meta: { totalSegments: number; complete: boolean };
    }>();
    expect(rest.data.segments).toHaveLength(large);
    expect(rest.meta).toMatchObject({ totalSegments: large, complete: true });
    expect(rest.data.segments.slice(0, 500)).toEqual(sliced.segments);
  });

  it('reports an unknown sitting as NOT_FOUND on all three surfaces', async () => {
    const { query, tool } = surfaces(DATA, true);

    let gqlCode: unknown;
    try {
      await query['parliamentStenogramSession']?.(null, { sessionKey: 'cdep:nope' });
    } catch (e) {
      gqlCode = (e as { extensions?: { code?: string } }).extensions?.code;
    }
    expect(gqlCode).toBe('NOT_FOUND');

    const mcp = await tool('get_parliament_stenogram_session').handler({ sessionKey: 'cdep:nope' });
    expect(mcp.ok).toBe(false);
    expect(mcp.errorCode).toBe('NOT_FOUND');

    const instance = await restApp(DATA);
    const rest = await instance.inject({
      method: 'GET',
      url: '/api/v1/parliament/stenograms/cdep:nope/transcript',
    });
    expect(rest.statusCode).toBe(404);
    expect(rest.json<{ error: string }>().error).toBe('NOT_FOUND');
  });
});

describe('the legacy-key REDIRECT resolves the same way on GraphQL and MCP', () => {
  it('lands on the same canonical block and reports the same mapping', async () => {
    const { query, tool } = surfaces(DATA, true);

    const gql = (await query['parliamentSpeechContext']?.(null, { speechKey: LEGACY_KEY })) as {
      speechKey: string;
      segment: { segmentKey: string; position: number } | null;
      session: { sessionKey: string };
      redirect: { mappingKind: string } | null;
      previousContribution: { position: number } | null;
      nextContribution: { position: number } | null;
    };

    const mcp = (await tool('get_parliament_speech_context').handler({
      speechKey: LEGACY_KEY,
    })) as McpToolOutput & {
      item?: unknown;
      meta?: { redirected: boolean; mappingKind: string | null; position: number | null };
    };

    expect(gql.speechKey).toBe(LEGACY_KEY);
    expect(gql.segment?.segmentKey).toBe('cdep:9043#00004');
    expect(gql.redirect?.mappingKind).toBe('exact_segment');
    // Neighbouring CONTRIBUTIONS, skipping the CONTEXT blocks at 3 and 5.
    expect(gql.previousContribution?.position).toBe(2);
    expect(gql.nextContribution?.position).toBe(6);
    // The MCP payload is the SAME object the resolver returns.
    expect(mcp.item).toEqual(gql);
    expect(mcp.meta).toMatchObject({
      redirected: true,
      mappingKind: 'exact_segment',
      position: 4,
    });
  });

  it('reports an unmapped legacy key as "no context" on both surfaces, never as an error', async () => {
    const { query, tool } = surfaces({ sessions: [{ session: stenogramSession() }] }, true);

    await expect(
      query['parliamentSpeechContext']?.(null, { speechKey: LEGACY_KEY })
    ).resolves.toBeNull();

    const mcp = await tool('get_parliament_speech_context').handler({ speechKey: LEGACY_KEY });
    expect(mcp.ok).toBe(true);
    expect(mcp.item).toBeUndefined();
    expect(mcp.summary).toContain('No canonical stenogram context');
  });

  it('exposes the canonical context lazily on ParliamentSpeech without failing the speech read', async () => {
    const repo = makeFakeParliamentRepo({ ...DATA, projectionAvailable: false });
    const resolvers = makeParliamentResolvers({
      repo,
      meili: null,
      transcriptSearch: null,
      legalActLoader: undefined,
      searchEngineUp: false,
      isApiKeyAuthorized: (): boolean => false,
    }) as Record<string, Record<string, Resolver>>;

    // The projection is unavailable, so `context` must resolve NULL rather than
    // failing the enclosing speech selection.
    const context = await resolvers['ParliamentSpeech']?.['context']?.(
      { speechKey: LEGACY_KEY },
      {}
    );
    expect(context).toBeNull();
  });
});

describe('the sessions SEARCH agrees across surfaces, and cursors are stable', () => {
  it('refuses a full-history q identically when the projection is unavailable', async () => {
    const { query, tool } = surfaces(DATA, false);

    let gqlExtensions: unknown;
    try {
      await query['parliamentStenogramSessions']?.(null, { q: 'buget', first: 10 });
    } catch (e) {
      gqlExtensions = (e as { extensions?: unknown }).extensions;
    }
    expect(gqlExtensions).toMatchObject({
      code: 'SEARCH_UNAVAILABLE',
      docType: 'parliament_speech_segment',
    });

    const mcp = await tool('search_parliament_stenogram_sessions').handler({ q: 'buget' });
    expect(mcp.ok).toBe(false);
    expect(mcp.errorCode).toBe('SEARCH_UNAVAILABLE');
    // No partial answer rides along with the refusal.
    expect(mcp.items).toBeUndefined();
  });

  it('returns the same narrowed sittings on GraphQL and MCP when the projection answers', async () => {
    const { query, tool } = surfaces(DATA, true, ['cdep:9043']);

    const gql = (await query['parliamentStenogramSessions']?.(null, {
      q: 'buget',
      first: 10,
    })) as { edges: readonly { node: { sessionKey: string }; cursor: string }[]; total: number };
    const mcp = (await tool('search_parliament_stenogram_sessions').handler({
      q: 'buget',
    })) as McpToolOutput<{ sessionKey: string }> & { meta?: { total: number } };

    expect(gql.edges.map((e) => e.node.sessionKey)).toEqual(['cdep:9043']);
    expect(mcp.items?.map((s) => s.sessionKey)).toEqual(['cdep:9043']);
    expect(mcp.meta?.total).toBe(gql.total);
  });

  it('mints per-edge cursors under the SAME fhash the repo pages with', async () => {
    const { query } = surfaces(DATA, true);

    const page = (await query['parliamentStenogramSessions']?.(null, { first: 10 })) as {
      edges: readonly { node: { sessionKey: string }; cursor: string }[];
    };

    // The resolver must derive its per-edge fhash from (filter, q) exactly as the
    // repo does — otherwise paging on an edge cursor is rejected as a filter mismatch.
    const expected = stenogramSessionsFhash({}, undefined);
    for (const edge of page.edges) {
      const decoded = decodeCursorEnvelope(edge.cursor);
      expect(decoded.fhash).toBe(expected);
      expect(decoded.sort).toBe('sessionDate');
      expect(decoded.dir).toBe('desc');
      // The keyset tuple shape must match the repo's: [sessionDate, sessionKey].
      expect(decoded.keys).toHaveLength(2);
      expect(decoded.keys[1]).toBe(edge.node.sessionKey);
    }
  });

  it('derives a DIFFERENT fhash for a different q, so a cursor cannot replay across searches', () => {
    const plain = stenogramSessionsFhash({}, undefined);
    const searched = stenogramSessionsFhash({}, 'buget');
    const other = stenogramSessionsFhash({}, 'sanatate');
    const filtered = stenogramSessionsFhash({ chamber: { eq: 'senat' } }, undefined);

    expect(new Set([plain, searched, other, filtered]).size).toBe(4);
    // …and it is STABLE for the same inputs (the cache key / cursor identity).
    expect(stenogramSessionsFhash({}, 'buget')).toBe(searched);
  });

  it('is stable under filter key ORDER (the canonicalizer, not object insertion order)', () => {
    const a = stenogramSessionsFhash(
      { chamber: { eq: 'senat' }, availability: { eq: 'COMPLETE' } },
      'buget'
    );
    const b = stenogramSessionsFhash(
      { availability: { eq: 'COMPLETE' }, chamber: { eq: 'senat' } },
      'buget'
    );
    expect(a).toBe(b);
  });
});

describe('MCP exposes the canonical stenogram tools alongside the legacy speech tool', () => {
  it('registers the search + two read tools without removing search_parliament_speeches', () => {
    const { tool } = surfaces(DATA, true);
    // The legacy tool keeps working (old contract preserved) …
    expect(tool('search_parliament_speeches').name).toBe('search_parliament_speeches');
    // … and the canonical surface is additive.
    expect(tool('search_parliament_stenogram_sessions').inputShape).toBeDefined();
    expect(tool('get_parliament_stenogram_session').inputShape).toBeDefined();
    expect(tool('get_parliament_speech_context').inputShape).toBeDefined();
  });

  it('refuses a read with no sessionKey instead of scanning', async () => {
    const { tool } = surfaces(DATA, true);
    const res = await tool('get_parliament_stenogram_session').handler({});
    expect(res.ok).toBe(false);
    expect(res.error).toContain('sessionKey is required');
  });
});
