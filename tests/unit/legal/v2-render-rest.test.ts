/**
 * The REST render route on the legal_v2 source: the same route and response
 * shape, the body read in one statement by the v2 render source (over a
 * capturing database answering with a REAL unit's stored rows), the
 * composition validator as ETag, `meta.renderSource`, and the typed
 * "not loaded" answer for a form without text.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import fastifyLib, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import {
  makeLegalRenderRepoV2,
  makeLegalRenderSourceV2,
} from '@/modules/legal/shell/repo/v2/render-v2.js';
import { makeLegalRoutes } from '@/modules/legal/shell/rest/routes.js';

import { makeCapturingDb } from '../../fixtures/capturing-db.js';

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), '../../fixtures/legal/v2');
// eslint-disable-next-line no-restricted-syntax -- committed repo fixture, trusted source
const unit = JSON.parse(readFileSync(join(fixtureDir, 'unit-8154.json'), 'utf8')) as {
  textSha256: string;
  render: { chunk_seq: number; char_start: number; char_end: number; body: string }[];
  links: { ordinal: number; href: string; target_fragment: string | null }[];
};

const head = {
  form_id: '9',
  composition_digest: 'a'.repeat(64),
  receipt_id: '55',
  current_public: true,
  published_at: '2026-11-19 10:00:00+00',
  generation_seq: '4',
};
const component = {
  ordinal: 0,
  slot: 'whole',
  has_unit: true,
  public: true,
  render_state: 'structured',
  text_sha256: unit.textSha256,
  compiler_version: 'unit-compiler-v1',
  body_sha256: 'b'.repeat(64),
  parse_build_id: 'build',
  content_parser_version: 'v9',
  requested_url: 'https://legislatie.just.ro/Public/DetaliiDocumentAfis/8154',
};

const appOver = async (body: Record<string, unknown>): Promise<FastifyInstance> => {
  const db = makeCapturingDb([], {
    respond: (sql) =>
      sql.includes('as form_id, f.act_id::text as act_id')
        ? [{ form_id: '9', act_id: '7' }]
        : sql.includes('with f as')
          ? [body]
          : [],
  });
  const app = fastifyLib({ logger: false });
  await app.register(
    makeLegalRoutes({ render: makeLegalRenderRepoV2(db), source: makeLegalRenderSourceV2(db) }),
    { prefix: '/api/v1/legal' }
  );
  return app;
};

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('legal_v2 render route', () => {
  const served = {
    head,
    components: [component],
    chunks: unit.render.map((r) => ({ ...r, public: true })),
    links: unit.links.map((l) => ({
      ordinal: l.ordinal,
      href: l.href,
      target_fragment: l.target_fragment,
      target_act_id: '123',
      target_form_id: null,
    })),
    assets: [],
  };

  it('serves the envelope with the composition validator and the source marker', async () => {
    app = await appOver(served);
    const res = await app.inject({ method: 'GET', url: '/api/v1/legal/documents/f9/render' });
    expect(res.statusCode).toBe(200);
    const etag = res.headers.etag;
    expect(etag).toBe(`W/"v2c1-${'a'.repeat(32)}-g4"`);
    const body = res.json<{
      data: { documentId: string; kind: string; chunkCount: number; tldf: Record<string, unknown> };
      meta: Record<string, unknown>;
    }>();
    expect(body.data).toMatchObject({ documentId: 'f9', kind: 'envelope', chunkCount: 1 });
    expect(body.meta).toMatchObject({
      runId: '55',
      textSha256: unit.textSha256,
      renderSource: 'legal_v2:tldf-unit/1',
    });
    const tldf = body.data.tldf as {
      format: string;
      format_version: string;
      generation: { run_id: unknown };
      marks: { link?: { kind: string; target_act_id?: number } }[];
    };
    expect(tldf.format).toBe('tldf');
    expect(tldf.format_version).toBe('1.1');
    expect(tldf.generation.run_id).toBe(55);
    expect(tldf.marks.filter((m) => m.link?.target_act_id === 123).length).toBe(unit.links.length);

    const again = await app.inject({
      method: 'GET',
      url: '/api/v1/legal/documents/f9/render',
      headers: { 'if-none-match': String(etag) },
    });
    expect(again.statusCode).toBe(304);
  });

  it('answers an old page id with the form it shows now', async () => {
    app = await appOver(served);
    const res = await app.inject({ method: 'GET', url: '/api/v1/legal/documents/8154/render' });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ data: { documentId: string } }>().data.documentId).toBe('f9');
  });

  it('answers 409 not_loaded for a form without text, and 404 past the last chunk', async () => {
    app = await appOver({ head, components: [], chunks: [], links: [], assets: [] });
    const res = await app.inject({ method: 'GET', url: '/api/v1/legal/documents/f9/render' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      ok: false,
      error: 'RENDER_UNAVAILABLE',
      renderStatus: 'not_loaded',
    });
    expect(res.headers['cache-control']).toBe('no-store');
    await app.close();

    app = await appOver(served);
    const past = await app.inject({
      method: 'GET',
      url: '/api/v1/legal/documents/f9/render/chunks/1',
    });
    expect(past.statusCode).toBe(404);
  });
});
