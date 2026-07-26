/**
 * APP-LEVEL response compression (`@fastify/compress`, registered by
 * `registerRedesignSurface` via `registerCompression`).
 *
 * WHY THIS TEST EXISTS. A full stenogram transcript is the largest JSON this API serves
 * — thousands of reading blocks in one response. Compression is what makes that
 * affordable, and it belongs at the app layer: an `onSend` transform that negotiates
 * `Accept-Encoding` per request and leaves `ETag` a representation-level validator valid
 * for every encoding. So there are two things to pin, and the second is the one that is
 * easy to get wrong:
 *
 *   1. WITH the app-level plugin, a large response really is gzipped.
 *   2. WITHOUT it, the route plugin does NOT compress by itself — the route deliberately
 *      returns a plain object and only sets `Vary: Accept-Encoding`. Expecting the route
 *      to compress on its own would be testing a behaviour we explicitly do not want
 *      (a route that gzipped its own buffer would break negotiation and the 304 path).
 *
 * This registers the REAL plugin with the REAL production options by calling the
 * exported `registerCompression`, on a bare Fastify scope. It does not boot the whole
 * redesign app, which would require a live kernel/postgres.
 */

import { gunzipSync } from 'node:zlib';

import fastifyLib, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { registerCompression } from '@/app/build-redesign-app.js';
import { makeParliamentRoutes } from '@/modules/parliament/shell/rest/routes.js';

import {
  makeFakeParliamentRepo,
  stenogramReading,
  stenogramSession,
} from '../fixtures/parliament-stenogram.js';

/** Big enough to be well past the 1 KiB compression threshold. */
const BLOCKS = 400;

let app: FastifyInstance | undefined;

const buildApp = async (opts: { compression: boolean }): Promise<FastifyInstance> => {
  const instance = fastifyLib({ logger: false });
  // Order matters: compression must be registered BEFORE the routes, because Fastify
  // hooks are inherited only by routes registered after the plugin. This mirrors
  // `registerRedesignSurface`, which calls registerCompression first.
  if (opts.compression) await registerCompression(instance);
  await instance.register(
    makeParliamentRoutes({
      repo: makeFakeParliamentRepo({
        sessions: [{ session: stenogramSession({ segmentCount: BLOCKS }) }],
        segments: stenogramReading(BLOCKS).map((segment) => ({ segment })),
      }),
      meili: null,
      transcriptSearch: null,
    }),
    { prefix: '/api/v1/parliament' }
  );
  await instance.ready();
  app = instance;
  return instance;
};

const TRANSCRIPT_URL = '/api/v1/parliament/stenograms/cdep:9043/transcript';

const getTranscript = async (instance: FastifyInstance, acceptEncoding?: string) =>
  instance.inject({
    method: 'GET',
    url: TRANSCRIPT_URL,
    headers: acceptEncoding === undefined ? {} : { 'accept-encoding': acceptEncoding },
    // Keep the payload as raw bytes so a compressed body is not silently decoded.
    payloadAsStream: false,
  });

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('app-level compression — a large transcript is actually gzipped', () => {
  it('gzips the response when the client asks for gzip', async () => {
    const instance = await buildApp({ compression: true });
    const res = await getTranscript(instance, 'gzip');

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-encoding']).toBe('gzip');

    // The bytes on the wire really are a gzip stream, and they decode to the same JSON
    // the uncompressed route would have produced.
    const raw = res.rawPayload;
    expect(raw.length).toBeGreaterThan(0);
    // gzip magic number: 0x1f 0x8b.
    expect(raw[0]).toBe(0x1f);
    expect(raw[1]).toBe(0x8b);

    const decoded: unknown =
      // eslint-disable-next-line no-restricted-syntax -- test decodes the gzip stream this app just produced
      JSON.parse(gunzipSync(raw).toString('utf8'));
    const body = decoded as {
      ok: boolean;
      data: { segments: readonly unknown[] };
      meta: { totalSegments: number; complete: boolean };
    };
    expect(body.ok).toBe(true);
    expect(body.data.segments).toHaveLength(BLOCKS);
    expect(body.meta).toMatchObject({ totalSegments: BLOCKS, complete: true });

    // Worth having: the compression is actually buying something on this payload.
    expect(raw.length).toBeLessThan(gunzipSync(raw).length / 2);
  });

  it('keeps the ETag a representation-level validator across encodings', async () => {
    const instance = await buildApp({ compression: true });
    const gzipped = await getTranscript(instance, 'gzip');
    const plain = await getTranscript(instance, 'identity');

    // Same resource, same tag, regardless of transfer encoding — which is what lets a
    // conditional request work no matter what the client negotiated.
    expect(String(gzipped.headers.etag)).toBe(String(plain.headers.etag));
    expect(gzipped.headers['content-encoding']).toBe('gzip');
    expect(plain.headers['content-encoding']).toBeUndefined();

    // And the 304 path still works through the compressor.
    const conditional = await instance.inject({
      method: 'GET',
      url: TRANSCRIPT_URL,
      headers: { 'accept-encoding': 'gzip', 'if-none-match': String(gzipped.headers.etag) },
    });
    expect(conditional.statusCode).toBe(304);
  });

  it('serves identity when the client does not request an encoding', async () => {
    const instance = await buildApp({ compression: true });
    const res = await getTranscript(instance);

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-encoding']).toBeUndefined();
    expect(res.json<{ ok: boolean }>().ok).toBe(true);
  });

  it('does NOT compress a small response (below the 1 KiB threshold)', async () => {
    const instance = fastifyLib({ logger: false });
    await registerCompression(instance);
    instance.get('/tiny', async () => ({ ok: true }));
    await instance.ready();
    app = instance;

    const res = await instance.inject({
      method: 'GET',
      url: '/tiny',
      headers: { 'accept-encoding': 'gzip' },
    });
    // Below the floor the framing overhead can exceed the saving, so the plugin skips it.
    expect(res.headers['content-encoding']).toBeUndefined();
  });
});

describe('the route plugin does NOT compress on its own', () => {
  it('serves an uncompressed body when only the route is registered', async () => {
    const instance = await buildApp({ compression: false });
    const res = await getTranscript(instance, 'gzip');

    expect(res.statusCode).toBe(200);
    // This is the DESIRED behaviour, not a gap: compression is an app-level concern, and
    // a route that gzipped its own buffer would fight the negotiation and the 304 path.
    // The route's only encoding-related duty is the Vary header below.
    expect(res.headers['content-encoding']).toBeUndefined();
    expect(res.headers.vary).toBe('accept-encoding');
    expect(res.json<{ ok: boolean }>().ok).toBe(true);
  });
});
