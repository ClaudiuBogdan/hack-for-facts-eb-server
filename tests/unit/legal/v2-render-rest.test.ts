/**
 * The REST render route on the legal_v2 source: the same route and response
 * shape, the body read in one statement by the v2 render source (over a
 * capturing database answering with a REAL unit's stored rows), served
 * `no-store` with no validator, `meta.servedForm` and `meta.renderHead`, the
 * typed "not loaded" answer, and links whose target act is hidden.
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

const served = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  route_status: 'bound',
  head: {
    form_id: '9',
    form_kind: 'original',
    caveat: null,
    portal_label_raw: null,
    portal_label_date: null,
    portal_order_date: '2001-05-05',
    receipt_id: '55',
    status: 'served',
    public_chunks: unit.render.length,
    published_at: '2026-11-19T10:00:00+00:00',

    text_sha256: unit.textSha256,
    compiler_version: 'unit-compiler-v1',
    body_sha256: 'b'.repeat(64),
    parse_build_id: 'build',
    content_parser_version: 'v9',
    source_url: 'https://legislatie.just.ro/Public/DetaliiDocumentAfis/8154',
    ...over,
  },
  components: [
    {
      ordinal: 0,
      render_state: 'structured',
      fidelity_flags: [],
      chunks: unit.render,
      links: unit.links.map((l, i) => ({
        ordinal: l.ordinal,
        href: l.href,
        target_fragment: l.target_fragment,
        // The first link's target act is not public: no act id, no locator.
        target_act_id: i === 0 ? null : '123',
        target_form_id: null,
      })),
      assets: [],
    },
  ],
});

const appOver = async (body: Record<string, unknown>): Promise<FastifyInstance> => {
  const db = makeCapturingDb([], {
    respond: (sql) => (sql.includes('with pick as') ? [body] : []),
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
  it('serves the envelope no-store, with no validator, stating the served form', async () => {
    app = await appOver(served());
    const res = await app.inject({ method: 'GET', url: '/api/v1/legal/documents/f9/render' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers.etag).toBeUndefined();
    const body = res.json<{
      data: { documentId: string; kind: string; chunkCount: number; tldf: Record<string, unknown> };
      meta: Record<string, unknown>;
    }>();
    expect(body.data).toMatchObject({ documentId: 'f9', kind: 'envelope', chunkCount: 1 });
    expect(body.meta).toMatchObject({
      runId: '55',
      textSha256: unit.textSha256,
      renderSource: 'legal_v2:tldf-unit/1',
      servedForm: { documentId: 'f9', versionKind: 'original', caveat: null },
      renderHead: { version: 1 },
    });
    const tldf = body.data.tldf as {
      format_version: string;
      generation: { run_id: unknown };
      marks: { kind: string; link?: { kind: string; target_act_id?: number; href?: string } }[];
    };
    expect(tldf.format_version).toBe('1.1');
    expect(tldf.generation.run_id).toBe(55);
    const links = tldf.marks.filter((m) => m.kind === 'reference').map((m) => m.link);
    expect(links[0]).toEqual({ kind: 'act' });
    expect(links.slice(1).every((l) => l?.target_act_id === 123)).toBe(true);
    // The hidden target's page (7919, the first link) appears nowhere in the body.
    expect(JSON.stringify(tldf.marks[0])).not.toContain('7919');

    const again = await app.inject({
      method: 'GET',
      url: '/api/v1/legal/documents/f9/render',
      headers: { 'if-none-match': '*' },
    });
    expect(again.statusCode).toBe(200);
  });

  it('answers an old page id with the form it shows now', async () => {
    app = await appOver(served());
    const res = await app.inject({ method: 'GET', url: '/api/v1/legal/documents/8154/render' });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ data: { documentId: string } }>().data.documentId).toBe('f9');
  });

  it('answers 409 not_loaded for a form without text, and 404 past the last chunk', async () => {
    app = await appOver(served({ status: 'not_loaded', public_chunks: 0 }));
    const res = await app.inject({ method: 'GET', url: '/api/v1/legal/documents/f9/render' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      ok: false,
      error: 'RENDER_UNAVAILABLE',
      renderStatus: 'not_loaded',
    });
    expect(res.headers['cache-control']).toBe('no-store');
    await app.close();

    app = await appOver(served());
    const past = await app.inject({
      method: 'GET',
      url: '/api/v1/legal/documents/f9/render/chunks/1',
    });
    expect(past.statusCode).toBe(404);
  });
});
