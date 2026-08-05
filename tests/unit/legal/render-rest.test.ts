/**
 * The cacheable TLDF render routes, over a real Fastify instance with an
 * in-memory `LegalRenderRepo` fake serving the COMMITTED REAL ARTIFACTS
 * (`tests/fixtures/legal/tldf/`, byte-identical to the scrapper's).
 *
 * The two contracts under test:
 *  - HONEST UNITS: the base route serves the complete envelope for a
 *    single-chunk document and the physical MANIFEST for a chunked one —
 *    never a partial `blocks[]`; chunk groups come only by explicit index.
 *  - BYTE-FAITHFUL PASSTHROUGH: the served `tldf` deep-equals the stored
 *    payload. This pins the `Type.Any()` boundary decision — a declared
 *    object schema would make fast-json-stringify silently STRIP fields,
 *    which is exactly the corruption the fold-sha gate exists to prevent.
 * Plus the HTTP semantics that justify REST here (generation-identity weak
 * ETag, If-None-Match → 304, Cache-Control) and the typed error taxonomy
 * (403 restricted / 409 unavailable / 409 inconsistent / 404).
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import fastifyLib, { type FastifyInstance } from 'fastify';
import { err, ok } from 'neverthrow';
import { afterEach, describe, expect, it } from 'vitest';

import { getDocumentRenderChunk } from '@/modules/legal/core/usecases.js';
import { legalRenderEtag, makeLegalRoutes } from '@/modules/legal/shell/rest/routes.js';
import { databaseError } from '@/modules/shared/index.js';

import type { LegalRenderRepo } from '@/modules/legal/core/ports.js';
import type { LegalRenderInfo, LegalRenderRow } from '@/modules/legal/core/types.js';

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), '../../fixtures/legal/tldf');

interface FixtureRow {
  readonly chunk_index: number;
  readonly chunk_count: number;
  readonly block_id: string | null;
  readonly tldf: Record<string, unknown>;
}

const loadRows = (name: string): FixtureRow[] =>
  // eslint-disable-next-line no-restricted-syntax -- committed repo fixture, trusted source
  JSON.parse(readFileSync(join(fixtureDir, name), 'utf8')) as FixtureRow[];

const singleRows = loadRows('render-rows-100023.json');
const chunkedRows = loadRows('render-rows-100019.json');

interface FakeDoc {
  readonly info: LegalRenderInfo;
  readonly rows: readonly FixtureRow[];
}

const infoFor = (
  documentId: string,
  rows: readonly FixtureRow[],
  overrides?: Partial<LegalRenderInfo>
): LegalRenderInfo => {
  const head = rows[0]?.tldf as
    { generation: { run_id: number }; text_sha256: string; compiler_version: string } | undefined;
  if (head === undefined) throw new Error('fixture carries no rows');
  return {
    documentId,
    renderStatus: 'served',
    privacyClass: 'public',
    runId: String(head.generation.run_id),
    textSha256: head.text_sha256,
    compilerVersion: head.compiler_version,
    compiledAt: '2026-08-05T09:00:00.000Z',
    chunkCount: rows.length,
    ...overrides,
  };
};

const makeFakeRenderRepo = (docs: ReadonlyMap<string, FakeDoc>): LegalRenderRepo => ({
  renderInfo: (documentId) => Promise.resolve(ok(docs.get(documentId)?.info ?? null)),
  renderInfoForDocuments: (documentIds) =>
    Promise.resolve(
      ok(
        new Map(
          documentIds.flatMap((id) => {
            const doc = docs.get(id);
            return doc === undefined ? [] : [[id, doc.info] as const];
          })
        )
      )
    ),
  renderRow: (documentId, chunkIndex) => {
    const row = docs.get(documentId)?.rows.find((r) => r.chunk_index === chunkIndex);
    return Promise.resolve(
      ok(
        row === undefined
          ? null
          : ({
              chunkIndex: row.chunk_index,
              chunkCount: row.chunk_count,
              blockId: row.block_id,
              payload: row.tldf,
            } satisfies LegalRenderRow)
      )
    );
  },
});

const docs = new Map<string, FakeDoc>([
  ['100023', { info: infoFor('100023', singleRows), rows: singleRows }],
  ['100019', { info: infoFor('100019', chunkedRows), rows: chunkedRows }],
  [
    'restricted-doc',
    {
      info: infoFor('restricted-doc', singleRows, { privacyClass: 'restricted' }),
      rows: singleRows,
    },
  ],
  [
    'unavailable-doc',
    {
      info: infoFor('unavailable-doc', singleRows, { renderStatus: 'content_unavailable' }),
      rows: [],
    },
  ],
  ['rowless-doc', { info: infoFor('rowless-doc', singleRows, { chunkCount: null }), rows: [] }],
]);

let app: FastifyInstance | undefined;

const buildApp = async (repo: LegalRenderRepo = makeFakeRenderRepo(docs)) => {
  const instance = fastifyLib({ logger: false });
  await instance.register(makeLegalRoutes({ render: repo }), { prefix: '/api/v1/legal' });
  await instance.ready();
  app = instance;
  return instance;
};

afterEach(async () => {
  await app?.close();
  app = undefined;
});

interface OkBody {
  readonly ok: true;
  readonly data: {
    readonly documentId: string;
    readonly kind: string;
    readonly chunkIndex: number;
    readonly chunkCount: number;
    readonly tldf: Record<string, unknown>;
  };
  readonly meta: {
    readonly runId: string;
    readonly textSha256: string;
    readonly compilerVersion: string;
  };
}

interface ErrBody {
  readonly ok: false;
  readonly error: string;
  readonly message: string;
  readonly renderStatus?: string;
  readonly detail?: string;
}

describe('GET /api/v1/legal/documents/:documentId/render', () => {
  it('serves the COMPLETE envelope for a single-chunk document, byte-faithful', async () => {
    const instance = await buildApp();
    const res = await instance.inject({ url: '/api/v1/legal/documents/100023/render' });
    expect(res.statusCode).toBe(200);
    // eslint-disable-next-line no-restricted-syntax -- response produced by the app under test
    const body = JSON.parse(res.body) as OkBody;
    expect(body.data.kind).toBe('envelope');
    expect(body.data.chunkCount).toBe(1);
    // Deep equality against the STORED payload: nothing stripped, nothing added.
    expect(body.data.tldf).toEqual(singleRows[0]?.tldf);
    expect(body.meta.textSha256).toBe(docs.get('100023')?.info.textSha256);
  });

  it('serves the MANIFEST for a chunked document — never a partial blocks[]', async () => {
    const instance = await buildApp();
    const res = await instance.inject({ url: '/api/v1/legal/documents/100019/render' });
    expect(res.statusCode).toBe(200);
    // eslint-disable-next-line no-restricted-syntax -- response produced by the app under test
    const body = JSON.parse(res.body) as OkBody;
    expect(body.data.kind).toBe('manifest');
    expect(body.data.chunkCount).toBe(3);
    expect(body.data.tldf).toEqual(chunkedRows[0]?.tldf);
    expect(body.data.tldf['physical']).toBe('manifest');
    expect(body.data.tldf['blocks']).toBeUndefined();
  });

  it('sets the generation-identity weak ETag and honours If-None-Match with 304', async () => {
    const instance = await buildApp();
    const first = await instance.inject({ url: '/api/v1/legal/documents/100023/render' });
    const info = docs.get('100023')?.info;
    if (info === undefined) throw new Error('fixture doc missing');
    const expectedTag = `W/"${info.runId}-${info.textSha256.slice(0, 16)}-${info.compilerVersion}"`;
    expect(legalRenderEtag(info)).toBe(expectedTag);
    expect(first.headers.etag).toBe(expectedTag);
    expect(first.headers['cache-control']).toContain('public');
    expect(first.headers['cache-control']).toContain('s-maxage=86400');

    const revalidated = await instance.inject({
      url: '/api/v1/legal/documents/100023/render',
      headers: { 'if-none-match': expectedTag },
    });
    expect(revalidated.statusCode).toBe(304);
    expect(revalidated.body).toBe('');
    // A 304 must repeat the validators (RFC 9110 §15.4.5).
    expect(revalidated.headers.etag).toBe(expectedTag);

    // Weak comparison: a client echoing the tag WITHOUT the W/ prefix still hits.
    const strongEcho = await instance.inject({
      url: '/api/v1/legal/documents/100023/render',
      headers: { 'if-none-match': expectedTag.replace(/^W\//u, '') },
    });
    expect(strongEcho.statusCode).toBe(304);
  });

  it('404s an unknown document', async () => {
    const instance = await buildApp();
    const res = await instance.inject({ url: '/api/v1/legal/documents/999999/render' });
    expect(res.statusCode).toBe(404);
    // eslint-disable-next-line no-restricted-syntax -- response produced by the app under test
    const body = JSON.parse(res.body) as ErrBody;
    expect(body.error).toBe('NOT_FOUND');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('403s a restricted expression — the act exists, so 404 would lie', async () => {
    const instance = await buildApp();
    const res = await instance.inject({ url: '/api/v1/legal/documents/restricted-doc/render' });
    expect(res.statusCode).toBe(403);
    // eslint-disable-next-line no-restricted-syntax -- response produced by the app under test
    const body = JSON.parse(res.body) as ErrBody;
    expect(body.error).toBe('RENDER_RESTRICTED');
  });

  it('409s content_unavailable with the render status named', async () => {
    const instance = await buildApp();
    const res = await instance.inject({ url: '/api/v1/legal/documents/unavailable-doc/render' });
    expect(res.statusCode).toBe(409);
    // eslint-disable-next-line no-restricted-syntax -- response produced by the app under test
    const body = JSON.parse(res.body) as ErrBody;
    expect(body.error).toBe('RENDER_UNAVAILABLE');
    expect(body.renderStatus).toBe('content_unavailable');
  });

  it('409s a served generation whose render rows are missing (inconsistent)', async () => {
    const instance = await buildApp();
    const res = await instance.inject({ url: '/api/v1/legal/documents/rowless-doc/render' });
    expect(res.statusCode).toBe(409);
    // eslint-disable-next-line no-restricted-syntax -- response produced by the app under test
    const body = JSON.parse(res.body) as ErrBody;
    expect(body.error).toBe('RENDER_INCONSISTENT');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('maps a repo Database error to the module 500 envelope', async () => {
    const failing: LegalRenderRepo = {
      renderInfo: () => Promise.resolve(err(databaseError('boom'))),
      renderInfoForDocuments: () => Promise.resolve(err(databaseError('boom'))),
      renderRow: () => Promise.resolve(err(databaseError('boom'))),
    };
    const instance = await buildApp(failing);
    const res = await instance.inject({ url: '/api/v1/legal/documents/100023/render' });
    expect(res.statusCode).toBe(500);
    // eslint-disable-next-line no-restricted-syntax -- response produced by the app under test
    const body = JSON.parse(res.body) as ErrBody;
    expect(body.error).toBe('Database');
  });
});

describe('GET /api/v1/legal/documents/:documentId/render/chunks/:chunkIndex', () => {
  it('serves one physical chunk group, byte-faithful', async () => {
    const instance = await buildApp();
    const res = await instance.inject({ url: '/api/v1/legal/documents/100019/render/chunks/1' });
    expect(res.statusCode).toBe(200);
    // eslint-disable-next-line no-restricted-syntax -- response produced by the app under test
    const body = JSON.parse(res.body) as OkBody;
    expect(body.data.kind).toBe('chunk');
    expect(body.data.chunkIndex).toBe(1);
    expect(body.data.tldf).toEqual(chunkedRows[1]?.tldf);
  });

  it('chunk 0 of a chunked document is the manifest again', async () => {
    const instance = await buildApp();
    const res = await instance.inject({ url: '/api/v1/legal/documents/100019/render/chunks/0' });
    expect(res.statusCode).toBe(200);
    // eslint-disable-next-line no-restricted-syntax -- response produced by the app under test
    const body = JSON.parse(res.body) as OkBody;
    expect(body.data.kind).toBe('manifest');
  });

  it('404s a chunk index past the declared count', async () => {
    const instance = await buildApp();
    const res = await instance.inject({ url: '/api/v1/legal/documents/100019/render/chunks/3' });
    expect(res.statusCode).toBe(404);
  });

  it('400s a malformed chunk index via the boundary schema', async () => {
    const instance = await buildApp();
    const res = await instance.inject({
      url: '/api/v1/legal/documents/100019/render/chunks/not-a-number',
    });
    expect(res.statusCode).toBe(400);
    // eslint-disable-next-line no-restricted-syntax -- response produced by the app under test
    const body = JSON.parse(res.body) as ErrBody;
    expect(body.error).toBe('INVALID_INPUT');
  });
});

describe('getDocumentRenderChunk cross-row layout guard', () => {
  it('refuses a chunked row that carries the wrong physical marker', async () => {
    const forged = new Map<string, FakeDoc>([
      [
        '100019',
        {
          info: infoFor('100019', chunkedRows),
          // Row 1 claims to be a manifest — a mislabeled payload must never
          // be served as a chunk group.
          rows: [
            chunkedRows[0]!,
            { ...chunkedRows[1]!, tldf: chunkedRows[0]?.tldf as never },
            chunkedRows[2]!,
          ],
        },
      ],
    ]);
    const outcome = await getDocumentRenderChunk(makeFakeRenderRepo(forged), '100019', 1);
    expect(outcome.isErr()).toBe(true);
    if (outcome.isErr()) {
      expect(outcome.error).toMatchObject({ reason: 'render_inconsistent' });
    }
  });

  it('refuses a single-row document whose payload carries a physical marker', async () => {
    const forged = new Map<string, FakeDoc>([
      [
        '100023',
        {
          info: infoFor('100023', singleRows),
          rows: [{ ...singleRows[0]!, tldf: chunkedRows[0]?.tldf as never }],
        },
      ],
    ]);
    const outcome = await getDocumentRenderChunk(makeFakeRenderRepo(forged), '100023', 0);
    expect(outcome.isErr()).toBe(true);
    if (outcome.isErr()) {
      expect(outcome.error).toMatchObject({ reason: 'render_inconsistent' });
    }
  });
});
