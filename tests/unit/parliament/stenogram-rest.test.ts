/**
 * The cacheable canonical full-transcript REST route, over a real Fastify instance
 * with in-memory fakes (`app.inject()`, no DB, no mocking library).
 *
 * The contract under test: ONE successful response IS the complete ordered sitting —
 * there is no pagination on this endpoint, and a large sitting must not come back
 * truncated-but-plausible. Plus the HTTP semantics that justify having REST here at
 * all (a deterministic strong ETag, `If-None-Match` → 304, `Cache-Control`) and the
 * typed error taxonomy with its actionable session payload.
 */

import fastifyLib, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { STENOGRAM_TRANSCRIPT_CHUNK } from '@/modules/parliament/core/usecases.js';
import { makeParliamentRoutes } from '@/modules/parliament/shell/rest/routes.js';

import {
  makeFakeParliamentRepo,
  stenogramReading,
  stenogramSession,
  type FakeStenogramData,
} from '../../fixtures/parliament-stenogram.js';

interface SessionRefBody {
  readonly sessionKey: string;
  readonly title: string | null;
  readonly chamber: string;
  readonly sessionDate: string | null;
  readonly sourceUrl: string;
  readonly sourceUrlKind: string;
  readonly availability: string;
}

interface TranscriptBody {
  readonly ok: true;
  readonly data: {
    readonly session: { readonly sessionKey: string; readonly availability: string };
    readonly segments: readonly { readonly position: number; readonly kind: string }[];
    readonly navigation: {
      readonly previous: SessionRefBody | null;
      readonly next: SessionRefBody | null;
    };
  };
  readonly meta: {
    readonly totalSegments: number;
    readonly complete: true;
    readonly asOf: string | null;
    readonly canonicalDigest: string;
  };
}

interface ErrorBody {
  readonly ok: false;
  readonly error: string;
  readonly message: string;
  readonly reason?: string;
  readonly sessionKey?: string | null;
  readonly session?: SessionRefBody | null;
}

const COMPLETE: FakeStenogramData = {
  sessions: [{ session: stenogramSession() }],
  segments: stenogramReading(3).map((segment) => ({ segment })),
};

/** A sitting with `count` blocks, plus a chamber sibling on either side of it. */
const sittingWithNeighbours = (count: number): FakeStenogramData => ({
  sessions: [
    { session: stenogramSession({ sessionKey: 'cdep:9000', sessionDate: '2003-09-22' }) },
    { session: stenogramSession({ segmentCount: count }) }, // cdep:9043, 2003-09-29
    { session: stenogramSession({ sessionKey: 'cdep:9100', sessionDate: '2003-10-06' }) },
    // A joint sitting BETWEEN the two CDep ones: it must not become a neighbour.
    {
      session: stenogramSession({
        sessionKey: 'comun:77',
        sessionDate: '2003-09-30',
        chamber: 'comun',
      }),
    },
  ],
  segments: stenogramReading(count).map((segment) => ({ segment })),
});

let app: FastifyInstance | undefined;

const buildApp = async (data: FakeStenogramData, ttl?: number): Promise<FastifyInstance> => {
  const instance = fastifyLib({ logger: false });
  await instance.register(
    makeParliamentRoutes({
      repo: makeFakeParliamentRepo(data),
      meili: null,
      transcriptSearch: null,
      ...(ttl !== undefined && { transcriptCacheTtlSeconds: ttl }),
    }),
    { prefix: '/api/v1/parliament' }
  );
  await instance.ready();
  app = instance;
  return instance;
};

const get = async (instance: FastifyInstance, url: string, headers: Record<string, string> = {}) =>
  instance.inject({ method: 'GET', url, headers });

/**
 * The response ETag as a plain string (a missing header stringifies to 'undefined'
 * and fails the assertion loudly). `etag` is declared explicitly rather than read off
 * an index signature, so the access is a real property read.
 */
const etagOf = (res: {
  readonly headers: { readonly etag?: string | readonly string[] | undefined };
}): string => String(res.headers.etag);

const TRANSCRIPT_URL = '/api/v1/parliament/stenograms/cdep:9043/transcript';

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('GET /stenograms/:sessionKey/transcript — one response is the WHOLE sitting', () => {
  it('returns the session, its ordered blocks, and its sitting navigation', async () => {
    const instance = await buildApp(sittingWithNeighbours(3));
    const res = await get(instance, TRANSCRIPT_URL);

    expect(res.statusCode).toBe(200);
    const body = res.json<TranscriptBody>();
    expect(body.ok).toBe(true);
    expect(body.data.session.sessionKey).toBe('cdep:9043');
    expect(body.data.segments.map((s) => s.position)).toEqual([0, 1, 2]);
    expect(body.meta).toMatchObject({ totalSegments: 3, complete: true });
    // §10 freshness watermark + the loader's integrity anchor.
    expect(body.meta.asOf).toBe('2026-07-20T04:31:00.000Z');
    expect(body.meta.canonicalDigest).toBe('canonical-digest-9043');
  });

  it('exposes CHAMBER-SCOPED previous/next sittings, skipping the joint sitting between them', async () => {
    const instance = await buildApp(sittingWithNeighbours(3));
    const body = (await get(instance, TRANSCRIPT_URL)).json<TranscriptBody>();

    expect(body.data.navigation.previous?.sessionKey).toBe('cdep:9000');
    // comun:77 (2003-09-30) is chronologically closer than cdep:9100 (2003-10-06),
    // but it is a DIFFERENT assembly — the control must not jump chambers.
    expect(body.data.navigation.next?.sessionKey).toBe('cdep:9100');
    // A nav target carries enough to render a link AND to open the official source.
    expect(body.data.navigation.next).toMatchObject({
      chamber: 'camera_deputatilor',
      sessionDate: '2003-10-06',
      sourceUrlKind: 'exact',
    });
    expect(body.data.navigation.next?.sourceUrl).toContain('https://');
  });

  it('returns null neighbours at the ends of a chamber history', async () => {
    const instance = await buildApp(COMPLETE);
    const body = (await get(instance, TRANSCRIPT_URL)).json<TranscriptBody>();
    expect(body.data.navigation).toEqual({ previous: null, next: null });
  });

  it('serves a transcript LARGER than the internal chunk in ONE complete response', async () => {
    // 2,401 blocks: past the 2,000 internal chunk, so the usecase must page the repo
    // more than once and still hand back one contiguous reading.
    const large = 2_401;
    expect(large).toBeGreaterThan(STENOGRAM_TRANSCRIPT_CHUNK);
    const instance = await buildApp(sittingWithNeighbours(large));

    const res = await get(instance, TRANSCRIPT_URL);
    expect(res.statusCode).toBe(200);
    const body = res.json<TranscriptBody>();

    // The WHOLE sitting: every block, once, in printed order, with no gaps.
    expect(body.data.segments).toHaveLength(large);
    expect(body.meta.totalSegments).toBe(large);
    expect(body.meta.complete).toBe(true);
    expect(body.data.segments.map((s) => s.position)).toEqual(
      Array.from({ length: large }, (_v, i) => i)
    );
  });

  it('accepts NO pagination parameters — the endpoint has one representation per sitting', async () => {
    const instance = await buildApp(sittingWithNeighbours(2_401));
    // Anything not in the schema is stripped by Fastify's ajv, so a caller cannot
    // reintroduce truncation through the query string: the response stays complete.
    const res = await get(instance, `${TRANSCRIPT_URL}?offset=500&limit=10`);

    expect(res.statusCode).toBe(200);
    const body = res.json<TranscriptBody>();
    expect(body.data.segments).toHaveLength(2_401);
    expect(body.data.segments[0]?.position).toBe(0);
  });
});

describe('ETag determinism and If-None-Match → 304', () => {
  it('is DETERMINISTIC across independent app instances for the same rows', async () => {
    const first = await buildApp(COMPLETE);
    const a = await get(first, TRANSCRIPT_URL);
    await first.close();
    app = undefined;

    const second = await buildApp(COMPLETE);
    const b = await get(second, TRANSCRIPT_URL);

    // No per-process salt, no timestamp, no request id in the hash — so two replicas
    // agree and a client's cached validator keeps working across a deploy.
    expect(etagOf(a)).toBe(etagOf(b));
    expect(a.json<TranscriptBody>().meta).toEqual(b.json<TranscriptBody>().meta);
  });

  it('is cacheable: a strong ETag, a public max-age, and Vary: Accept-Encoding', async () => {
    const instance = await buildApp(COMPLETE, 900);
    const res = await get(instance, TRANSCRIPT_URL);

    expect(res.statusCode).toBe(200);
    expect(res.headers.etag).toMatch(/^"[A-Za-z0-9_-]+"$/u);
    expect(res.headers['cache-control']).toBe('public, max-age=900, stale-while-revalidate=900');
    // The route never writes Content-Encoding itself — compression is an app-level
    // onSend transform — but it declares the response varies by encoding so a cache in
    // front of the app keys correctly.
    expect(res.headers.vary).toBe('accept-encoding');
    expect(res.headers['content-encoding']).toBeUndefined();
  });

  it('answers 304 with no body when the client already holds that representation', async () => {
    const instance = await buildApp(COMPLETE, 900);
    const etag = etagOf(await get(instance, TRANSCRIPT_URL));

    const second = await get(instance, TRANSCRIPT_URL, { 'if-none-match': etag });

    expect(second.statusCode).toBe(304);
    expect(second.body).toBe('');
    // A 304 MUST repeat the validators (RFC 9110 §15.4.5) or the client cannot refresh
    // its freshness lifetime.
    expect(etagOf(second)).toBe(etag);
    expect(second.headers['cache-control']).toBe('public, max-age=900, stale-while-revalidate=900');
    expect(second.headers.vary).toBe('accept-encoding');
  });

  it('honours a WEAK validator and a multi-tag / wildcard If-None-Match', async () => {
    const instance = await buildApp(COMPLETE);
    const etag = etagOf(await get(instance, TRANSCRIPT_URL));

    expect((await get(instance, TRANSCRIPT_URL, { 'if-none-match': `W/${etag}` })).statusCode).toBe(
      304
    );
    expect(
      (await get(instance, TRANSCRIPT_URL, { 'if-none-match': `"other", ${etag}` })).statusCode
    ).toBe(304);
    expect((await get(instance, TRANSCRIPT_URL, { 'if-none-match': '*' })).statusCode).toBe(304);
  });

  it('re-sends the body (200) when the client holds a DIFFERENT tag', async () => {
    const instance = await buildApp(COMPLETE);
    const res = await get(instance, TRANSCRIPT_URL, { 'if-none-match': '"stale-tag"' });
    expect(res.statusCode).toBe(200);
  });

  it('is STABLE for a large transcript — the same sitting hashes the same twice', async () => {
    const instance = await buildApp(sittingWithNeighbours(2_401));
    const a = await get(instance, TRANSCRIPT_URL);
    const b = await get(instance, TRANSCRIPT_URL);
    expect(etagOf(a)).toBe(etagOf(b));
    // …and it round-trips through a conditional request.
    expect((await get(instance, TRANSCRIPT_URL, { 'if-none-match': etagOf(a) })).statusCode).toBe(
      304
    );
  });

  it('changes the tag when the served CONTENT changes (a re-parsed block)', async () => {
    const original = await buildApp(COMPLETE);
    const before = etagOf(await get(original, TRANSCRIPT_URL));
    await original.close();
    app = undefined;

    const changed = await buildApp({
      sessions: [{ session: stenogramSession({ canonicalDigest: 'canonical-digest-9043-v2' }) }],
      segments: stenogramReading(3).map((segment, i) => ({
        segment: i === 1 ? { ...segment, text: 'A re-parse changed this block.' } : segment,
      })),
    });
    expect(etagOf(await get(changed, TRANSCRIPT_URL))).not.toBe(before);
  });

  it('changes the tag when a NEIGHBOURING sitting appears (navigation is part of the representation)', async () => {
    const alone = await buildApp(COMPLETE);
    const before = etagOf(await get(alone, TRANSCRIPT_URL));
    await alone.close();
    app = undefined;

    const withNeighbours = await buildApp(sittingWithNeighbours(3));
    expect(etagOf(await get(withNeighbours, TRANSCRIPT_URL))).not.toBe(before);
  });

  it('changes the tag when a block becomes RESTRICTED (a privacy flip must invalidate caches)', async () => {
    const open = await buildApp(COMPLETE);
    const before = etagOf(await get(open, TRANSCRIPT_URL));
    await open.close();
    app = undefined;

    const gated = await buildApp({
      sessions: [{ session: stenogramSession() }],
      segments: stenogramReading(3).map((segment, i) => ({
        segment,
        ...(i === 1 && { privacyClass: 'restricted' as const }),
      })),
    });
    const res = await get(gated, TRANSCRIPT_URL);
    const body = res.json<TranscriptBody>();

    expect(etagOf(res)).not.toBe(before);
    // The restricted block is simply not in the reading, and the count agrees.
    expect(body.data.segments.map((s) => s.position)).toEqual([0, 2]);
    expect(body.meta.totalSegments).toBe(2);
  });
});

describe('typed errors — NOT_FOUND vs TRANSCRIPT_UNAVAILABLE, and the actionable session payload', () => {
  it('404 NOT_FOUND for an unknown sitting, with no session payload to render', async () => {
    const instance = await buildApp(COMPLETE);
    const res = await get(instance, '/api/v1/parliament/stenograms/cdep:nope/transcript');

    expect(res.statusCode).toBe(404);
    const body = res.json<ErrorBody>();
    expect(body).toMatchObject({ ok: false, error: 'NOT_FOUND' });
    expect(body.session).toBeUndefined();
    // No ETag/Cache-Control on an error — an error is not a cacheable representation.
    expect(res.headers.etag).toBeUndefined();
  });

  it('404 NOT_FOUND for a RESTRICTED sitting (never distinguishable from absent)', async () => {
    const instance = await buildApp({
      sessions: [{ session: stenogramSession(), privacyClass: 'restricted' }],
      segments: stenogramReading(3).map((segment) => ({ segment })),
    });
    const res = await get(instance, TRANSCRIPT_URL);

    expect(res.statusCode).toBe(404);
    expect(res.json<ErrorBody>().error).toBe('NOT_FOUND');
    // Crucially: nothing about the restricted sitting leaks into the failure.
    expect(res.json<ErrorBody>().session).toBeUndefined();
  });

  it('409 TRANSCRIPT_UNAVAILABLE/source_only CARRIES the sitting so the client can offer the source', async () => {
    const instance = await buildApp({
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
    });
    const res = await get(instance, TRANSCRIPT_URL);

    // 409, not 404: the sitting is REAL and its official URL is still available. Not
    // 503 either — re-requesting a sitting we hold no capture for never yields one.
    expect(res.statusCode).toBe(409);
    const body = res.json<ErrorBody>();
    expect(body.error).toBe('TRANSCRIPT_UNAVAILABLE');
    expect(body.reason).toBe('source_only');
    expect(body.sessionKey).toBe('cdep:9043');
    // THE POINT of keeping this distinct from NOT_FOUND: everything the client needs to
    // render the source action, without a second request that would 409 again.
    expect(body.session).toMatchObject({
      sessionKey: 'cdep:9043',
      chamber: 'camera_deputatilor',
      sessionDate: '2003-09-29',
      availability: 'SOURCE_ONLY',
      sourceUrlKind: 'exact',
    });
    expect(body.session?.sourceUrl).toBe(
      'https://www.cdep.ro/pls/steno/steno2015.stenograma?ids=9043'
    );
    expect(body.session?.title).toContain('29 septembrie 2003');
  });

  it('409 TRANSCRIPT_UNAVAILABLE/no_public_segments when every block is restricted', async () => {
    const instance = await buildApp({
      sessions: [{ session: stenogramSession() }],
      segments: stenogramReading(3).map((segment) => ({
        segment,
        privacyClass: 'restricted' as const,
      })),
    });
    const res = await get(instance, TRANSCRIPT_URL);

    expect(res.statusCode).toBe(409);
    const body = res.json<ErrorBody>();
    expect(body.reason).toBe('no_public_segments');
    // The sitting is public even though its reading is not, so the source action stays.
    expect(body.session?.sessionKey).toBe('cdep:9043');
  });

  it("409 no_public_segments when every block's CANONICAL SPEECH row is restricted", async () => {
    const reading = stenogramReading(3);
    const instance = await buildApp({
      sessions: [{ session: stenogramSession() }],
      // Blocks themselves are public; the speech rows they point at are not.
      segments: reading.map((segment) => ({ segment })),
      restrictedCanonicalSpeechKeys: reading
        .map((s) => s.speechKey)
        .filter((k): k is string => k !== null),
    });
    const res = await get(instance, TRANSCRIPT_URL);

    // Only the SPEECH blocks are withheld; the CONTEXT blocks have no speech row, so
    // they survive — the reading shrinks rather than vanishing.
    expect(res.statusCode).toBe(200);
    const body = res.json<TranscriptBody>();
    expect(body.data.segments.every((s) => s.kind !== 'SPEECH')).toBe(true);
    expect(body.data.segments).toHaveLength(1); // position 1 (CONTEXT) of 0,1,2
  });

  it('503 TRANSCRIPT_UNAVAILABLE/projection_unavailable when the canonical migration is absent', async () => {
    const instance = await buildApp({ ...COMPLETE, projectionAvailable: false });
    const res = await get(instance, TRANSCRIPT_URL);

    // 503: retryable, unlike a SOURCE_ONLY capture. No session payload — we cannot read
    // sittings at all, so there is nothing honest to describe.
    expect(res.statusCode).toBe(503);
    const body = res.json<ErrorBody>();
    expect(body.error).toBe('TRANSCRIPT_UNAVAILABLE');
    expect(body.reason).toBe('projection_unavailable');
    expect(body.session).toBeNull();
  });

  it('surfaces a DATABASE failure as 500, never as NOT_FOUND', async () => {
    const instance = await buildApp({
      ...COMPLETE,
      failWith: { type: 'Database', message: 'connection reset by peer' },
    });
    const res = await get(instance, TRANSCRIPT_URL);

    // "We could not read" is not "it does not exist". Collapsing this into a 404 would
    // tell a client the sitting is gone during an outage.
    expect(res.statusCode).toBe(500);
    expect(res.json<ErrorBody>().error).toBe('INTERNAL_SERVER_ERROR');
  });
});
