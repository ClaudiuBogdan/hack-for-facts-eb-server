/**
 * legal_v2 source — real-DDL proof of the privacy gates, the bridge's nulls
 * and the search verification, through the real repositories, GraphQL and MCP.
 *
 * TARGET GUARD. Touches ONLY an explicitly provided throwaway database:
 * `LEGAL_V2_TEST_PG_URL` + `LEGAL_V2_TEST_DB_NAME` (`server_legal_v2_<run-id>`),
 * a loopback URL whose database path equals that name and carries no query or
 * fragment, holding no `legal_v2`/`legal` schema before setup. Seeding writes
 * rows with triggers off (`session_replication_role = replica`), so the role
 * must be a superuser of that throwaway cluster. Without the inputs it SKIPS;
 * with `TEST_E2E_REQUIRED=1` it FAILS instead.
 *
 * SCHEMA. legal_v2 is the scrapper's own prod migration, hash-pinned, imported
 * from `SCRAPPER_REPO_ROOT` and executed (`up`). The old `legal` corpus is a
 * stub of the columns the bridge reads.
 *
 * FIXTURE. Act 7 (public, in the old corpus), act 8 (public, NOT in the old
 * corpus), act 9 (restricted in legal_v2, in the old corpus). Independently
 * restricted children: a restricted chunk (form 103), a restricted image
 * occurrence, a link to the restricted act, a status event and a reference
 * whose acting act is the restricted one. Default-form cases: act 10 (latest
 * form without text over an older readable one), act 12 (its newest form is
 * ended), act 13 (its only readable form is an original with no Portal
 * ordering date), act 14 (in the old corpus with a summary, no v2 text).
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { makeExecutableSchema } from '@graphql-tools/schema';
import { graphql, type GraphQLSchema } from 'graphql';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { ok } from 'neverthrow';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { provenFold } from '@/modules/legal/core/tldf/fold.js';
import { reassembleTldf } from '@/modules/legal/core/tldf/reassemble.js';
import { computeDefaultForm } from '@/modules/legal/core/v2/forms.js';
import { monitorulTypeDefs } from '@/modules/legal/mo/graphql.js';
import { makeLegalResolvers } from '@/modules/legal/shell/graphql/resolvers.js';
import { legalTypeDefs } from '@/modules/legal/shell/graphql/typedefs.js';
import { makeLegalActLoader } from '@/modules/legal/shell/loader/legal-act-loader.js';
import { makeLegalMcpTools } from '@/modules/legal/shell/mcp/tools.js';
import { makeLegalActsRepo } from '@/modules/legal/shell/repo/acts-repo.js';
import { makeLegalGraphRepo } from '@/modules/legal/shell/repo/graph-repo.js';
import { makeLegalActsRepoV2 } from '@/modules/legal/shell/repo/v2/acts-repo-v2.js';
import { V2_BRIDGE_GATE } from '@/modules/legal/shell/repo/v2/gate.js';
import {
  makeLegalOutlineRepoV2,
  makeV2OutlineReader,
  type V2ProvisionPaths,
} from '@/modules/legal/shell/repo/v2/outline-v2.js';
import {
  makeLegalRenderRepoV2,
  makeLegalRenderSourceV2,
} from '@/modules/legal/shell/repo/v2/render-v2.js';
import { makeLegalV2HitVerifier } from '@/modules/legal/shell/repo/v2/search-verify-v2.js';
import { readFormsForActs, toFormState } from '@/modules/legal/shell/repo/v2/v2-reads.js';
import { makeLegalVocabRepo } from '@/modules/legal/shell/repo/vocab-repo.js';
import { scalarResolvers, scalarTypeDefs } from '@/modules/shared/shell/graphql/scalars.js';

import {
  ACT_DETAIL_QUERY,
  LEGAL_CLIENT_CASES,
  OUTLINE_QUERY,
  RESOLVE_DOCUMENT_QUERY,
} from '../../fixtures/legal/client-documents.js';

import type { LegalActsRepo } from '@/modules/legal/core/ports.js';
import type { TldfPhysicalRow } from '@/modules/legal/core/tldf/types.js';
import type { LegalV2SearchEngine, V2EngineHit } from '@/modules/legal/core/v2/search.js';
import type { KernelMcpTool, ProdDatabase } from '@/modules/shared/index.js';

const REQUIRED = process.env['TEST_E2E_REQUIRED'] === '1';
const TARGET_URL = process.env['LEGAL_V2_TEST_PG_URL'] ?? '';
const TARGET_DB = process.env['LEGAL_V2_TEST_DB_NAME'] ?? '';
const CONFIGURED = TARGET_URL !== '' && TARGET_DB !== '';
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

const assertThrowawayTarget = (targetUrl: string, targetDb: string): void => {
  if (!/^server_legal_v2_[a-z0-9_]{1,40}$/u.test(targetDb)) {
    throw new Error('LEGAL_V2_TEST_DB_NAME must be server_legal_v2_<run-id>');
  }
  const url = new URL(targetUrl);
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error('LEGAL_V2_TEST_PG_URL must be a postgres URL');
  }
  if (url.search !== '' || url.hash !== '') {
    throw new Error('LEGAL_V2_TEST_PG_URL must carry no query parameters or fragment');
  }
  if (!LOOPBACK.has(url.hostname)) throw new Error('LEGAL_V2_TEST_PG_URL must be loopback');
  if (decodeURIComponent(url.pathname.slice(1)) !== targetDb) {
    throw new Error('LEGAL_V2_TEST_PG_URL database does not equal LEGAL_V2_TEST_DB_NAME');
  }
};

describe('legal_v2 pg target guard (pure)', () => {
  it('refuses anything but a loopback throwaway database', () => {
    expect(() => {
      assertThrowawayTarget('postgres://x@10.0.0.1/server_legal_v2_a', 'server_legal_v2_a');
    }).toThrow(/loopback/u);
    expect(() => {
      assertThrowawayTarget('postgres://x@127.0.0.1/transparenta_prod', 'transparenta_prod');
    }).toThrow(/server_legal_v2_/u);
    expect(() => {
      assertThrowawayTarget('postgres://x@127.0.0.1/server_legal_v2_a?host=x', 'server_legal_v2_a');
    }).toThrow(/no query/u);
  });
});

const MIGRATION = '20261116T100000__legal_v2_schema.ts';
const MIGRATION_SHA256 = '6e2a5f738148d2b2638ae715cd36b4a2bed21599aaa1e11bbea1922c739070b7';

/**
 * The owner's default-form policy as the scrapper implements it: the raw
 * function portal_acts.p2a_default_form (writer/sql/21-form-states.sql),
 * hash-pinned. legal_v2.default_forms() is NOT the oracle: its header says it
 * predates the 2026-11-12 decisions and it still applies the older rule.
 */
const FORM_STATES_SQL = 'src/sources/portal-legislativ/prod/rebuild/writer/sql/21-form-states.sql';
const DEFAULT_FORM_FN_SHA256 = '6cc15fddba2042862aa1bb03c581ba08afff112ff926cd6d4d0f292c5041c4dc';

/** The old corpus: only what the bridge reads. */
const LEGACY_STUB = `
  create schema legal;
  create table legal.acts (act_id bigint primary key, act_natural_key text, act_type text,
    act_number text, act_year smallint, issuer_slug text, canonical_document_id text,
    display_citation text, status text, status_evidence jsonb, entry_into_force date,
    in_degree integer);
  create table legal.act_documents (document_id text primary key, act_id bigint,
    version_kind text, version_date date, is_canonical boolean, den text, title text,
    issuer_raw text, publication_raw text, entry_into_force date, first_publication_date date,
    status_markers text[], extraction_status text, compatibility_tier text, mo_part smallint,
    mo_number text, mo_date date, source_url text);
  create table legal.document_summaries (document_id text primary key, description text,
    summary text, plain_language_summary text, document_category text, domains text[],
    affected_audiences text[], keywords text[], key_dates jsonb, penalties_mentioned boolean,
    fiscal_impact text, confidence real, source_extraction_status text);
  create table legal.document_render (document_id text, run_id bigint, chunk_index int,
    privacy_class text);
  create table legal.act_references (source_document_id text, ref_index smallint,
    relation text, target_raw text, target_class text, target_act_id bigint,
    target_external_act_id bigint, target_fragment text, resolution text, confidence real,
    resolver_version text);
  create table legal.act_status_events (event_id bigint primary key, act_id bigint,
    event_kind text, effective_date date, source_act_id bigint, evidence jsonb,
    event_source text, privacy_class text);
  create table legal.mo_act_publications (mo_act_key text, privacy_class text);
  create table legal.document_link_edges (edge_id bigint primary key, document_id text,
    source_node_path text, ordinal int, link_text text, link_kind text, target_act_id bigint,
    target_fragment text, target_node_path text, target_resolution text, char_start int,
    char_end int, privacy_class text);
`;

const HEADER = 'Antet 😀';
const BODY = 'Corp articol';
const PAIR_TEXT = HEADER + '\n' + BODY;
const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
const portalUrl = (page: string): string =>
  `https://legislatie.just.ro/Public/DetaliiDocumentAfis/${page}`;

// Both captures have art:1. The body occurrence is provision 1 in its second chunk.
const pairHits: V2EngineHit[] = [
  { unitId: '6', provisionSeq: 0, charStart: 0, charEnd: 5, contentKey: 'k1:header' },
  { unitId: '7', provisionSeq: 1, charStart: 5, charEnd: 8, contentKey: 'k1:article' },
].map((use) => ({
  actId: '7',
  score: 1,
  citationPath: 'art:1',
  headingPath: null,
  snippet: '<em>match</em>',
  uses: [{ ...use, formId: '106' }],
}));

const run = CONFIGURED || REQUIRED ? describe : describe.skip;

run('legal_v2 on real DDL', () => {
  let setup: pg.Client;
  let db: Kysely<ProdDatabase>;
  let schema: GraphQLSchema;
  let tools: readonly KernelMcpTool[];
  let v2Acts: LegalActsRepo;
  /** The faked index's hits; a test may swap them and must restore them. */
  const sectionHit: V2EngineHit = {
    actId: '7',
    score: 2,
    citationPath: 'art:999',
    headingPath: 'INDEX HEADING',
    snippet: '<em>Art</em>',
    uses: [
      // the exporter's first use: a replaced unit (never verified)
      {
        formId: '101',
        unitId: '99',
        provisionSeq: 0,
        charStart: 0,
        charEnd: 3,
        contentKey: 'k1:abc',
      },
      {
        formId: '101',
        unitId: '2',
        provisionSeq: 0,
        charStart: 0,
        charEnd: 3,
        contentKey: 'k1:abc',
      },
    ],
  };
  let actHits: V2EngineHit[] = [];
  let unitHits: V2EngineHit[] = [sectionHit];
  const q = (text: string, params: unknown[] = []): Promise<pg.QueryResult> =>
    setup.query(text, params);

  beforeAll(async () => {
    assertThrowawayTarget(TARGET_URL, TARGET_DB);
    setup = new pg.Client({ connectionString: TARGET_URL });
    await setup.connect();
    const before = await q(
      `select count(*)::int as n from pg_namespace where nspname in ('legal', 'legal_v2')`
    );
    if ((before.rows[0] as { n: number }).n !== 0) throw new Error('target is not empty');
    db = new Kysely<ProdDatabase>({
      dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: TARGET_URL, max: 2 }) }),
    });
    const root = process.env['SCRAPPER_REPO_ROOT'] ?? '';
    if (root === '') throw new Error('SCRAPPER_REPO_ROOT is required for the pinned migration');
    const full = path.join(root, 'src', 'db', 'prod-migrations', MIGRATION);
    const actual = createHash('sha256').update(fs.readFileSync(full)).digest('hex');
    if (actual !== MIGRATION_SHA256) throw new Error(`migration drift: ${MIGRATION} ${actual}`);
    const mod = (await import(pathToFileURL(full).href)) as {
      up: (d: Kysely<unknown>) => Promise<void>;
    };
    await mod.up(db as unknown as Kysely<unknown>);
    await q(LEGACY_STUB);
    await seed(q);

    const legacy = makeLegalActsRepo(db, V2_BRIDGE_GATE);
    const acts = makeLegalActsRepoV2({ db, legacy, today: () => '2026-11-20' });
    v2Acts = acts;
    const graph = makeLegalGraphRepo(db, V2_BRIDGE_GATE);
    // As mounted: search names a provision by the outline's own path (one reader).
    const outlineReader = makeV2OutlineReader(db);
    const outline = outlineReader.repo;
    const render = makeLegalRenderRepoV2(db);
    const vocab = makeLegalVocabRepo(db, V2_BRIDGE_GATE);
    // The index is faked (no OpenSearch here); its hits are verified by the
    // REAL verifier against this database.
    const v2Engine: LegalV2SearchEngine = {
      searchActs: () =>
        Promise.resolve(
          ok({ hits: actHits, total: null, totalExhaustive: false, asOf: '2026-11-18' })
        ),
      searchUnits: (query) =>
        Promise.resolve(
          ok({
            hits: query === 'pereche' ? pairHits : unitHits,
            total: null,
            totalExhaustive: false,
            asOf: '2026-11-18',
          })
        ),
    };
    const searchDeps = {
      retrieval: {} as never,
      acts,
      synthetic: {} as never,
      capabilities: {} as never,
      embeddingModel: 'none',
      semanticReady: false,
      clientBaseUrl: 'https://t',
      v2Mode: true,
      v2Engine,
      v2Verifier: makeLegalV2HitVerifier(db, outlineReader.provisionPaths),
    };
    const resolveDeps = { base: acts, acts, vocab };
    schema = makeExecutableSchema({
      // The legal slice as mounted, Monitorul included (its fields answer
      // empty here: Monitorul is unchanged by the v2 source).
      typeDefs: `${scalarTypeDefs}
        type PageInfo { hasNextPage: Boolean!, endCursor: String }
        type Entity { _stub: String }
        type Query { _root: String }
        ${legalTypeDefs}
        ${monitorulTypeDefs}`,
      resolvers: [
        scalarResolvers,
        makeLegalResolvers({ acts, graph, outline, render, searchDeps, resolveDeps }) as never,
        {
          LegalAct: { gazettePublications: () => [] },
          Query: {
            moIssues: () => ({
              edges: [],
              pageInfo: { hasNextPage: false, endCursor: null },
              total: 0,
            }),
          },
        },
      ],
    });
    tools = makeLegalMcpTools({
      acts,
      graph,
      outline,
      searchDeps,
      resolveDeps,
      clientBaseUrl: 'https://t',
      v2: true,
    });
  }, 120_000);

  afterAll(async () => {
    await db?.destroy();
    await setup?.end();
  });

  const gql = async (source: string): Promise<Record<string, unknown>> => {
    const res = await graphql({ schema, source });
    expect(res.errors ?? []).toEqual([]);
    return res.data as Record<string, unknown>;
  };

  it('serves an act the old corpus lacks with every bridged fact null, never zero or empty', async () => {
    const data = await gql(`{ legalAct(actId: "8") {
      actId status statusEvidence inDegree amendedAfterPublication dataSource bridgedFields
      timeline { kind } timelineComplete
      links(direction: IN) { edges { relation } } incomingAnchors { totalCount }
      newerNotAvailable versionProvenance { amendedAfterPublication } } }`);
    expect(data['legalAct']).toEqual({
      actId: '8',
      status: null,
      statusEvidence: null,
      inDegree: null,
      amendedAfterPublication: null,
      dataSource: 'legal_v2',
      bridgedFields: [],
      timeline: null,
      timelineComplete: null,
      links: null,
      incomingAnchors: null,
      newerNotAvailable: 0,
      versionProvenance: { amendedAfterPublication: null },
    });
    const mcp = tools.find((t) => t.name === 'get_legal_act');
    const out = (await mcp?.handler({ actId: '8' })) as unknown as {
      item: Record<string, unknown>;
      summary: string;
      meta: { caveats: string[] };
    };
    expect(out.item).toMatchObject({ status: null, statusEvidence: null, inDegree: null });
    expect(out.summary).toContain('status unknown');
    expect(out.summary).not.toContain('status: necunoscut');
    expect(out.meta.caveats.join(' ')).not.toContain('versiunile publicate');
  });

  it('never shows a restricted act, on either end of a bridged fact', async () => {
    const data = await gql(`{
      restricted: legalAct(actId: "9") { actId }
      bridged: legalAct(actId: "7") {
        status inDegree
        links(direction: IN) { edges { sourceAct { actId } } }
        incomingAnchors { totalCount edges { node { sourceAct { actId } } } }
        timeline { relatedActId }
      }
      feed: legalRecentChanges(first: 20) { edges { node { actId sourceActId } } }
    }`);
    expect(data['restricted']).toBeNull();
    const bridged = data['bridged'] as Record<string, unknown>;
    expect(bridged['status']).toBe('MODIFICAT');
    expect(JSON.stringify(bridged)).not.toContain('"9"');
    expect((bridged['incomingAnchors'] as { totalCount: number }).totalCount).toBe(1);
    const feed = data['feed'] as {
      edges: { node: { actId: string; sourceActId: string | null } }[];
    };
    expect(feed.edges.map((e) => e.node.actId)).toEqual(['7']);
    expect(JSON.stringify(feed)).not.toContain('"9"');
    const issuers = await gql(`{ legalResolve(dim: "issuer", q: "secret") { value } }`);
    expect(issuers['legalResolve']).toEqual([]);
  });

  it('gates render metadata, link locators and image descriptions', async () => {
    const data = await gql(`{ legalAct(actId: "7") { documents { documentId readable
      render { renderStatus privacyClass textSha256 compilerVersion compiledAt chunkCount } } } }`);
    const docs = (data['legalAct'] as { documents: Record<string, unknown>[] }).documents;
    const byId = new Map(docs.map((d) => [d['documentId'], d]));
    expect(byId.get('f103')).toEqual({
      documentId: 'f103',
      readable: false,
      render: {
        renderStatus: 'content_unavailable',
        privacyClass: 'restricted',
        textSha256: '',
        compilerVersion: '',
        compiledAt: '',
        chunkCount: null,
      },
    });
    expect(byId.has('f104')).toBe(false);
    const source = makeLegalRenderSourceV2(db);
    expect((await source.read('f103', 0))._unsafeUnwrapErr()).toMatchObject({
      reason: 'render_restricted',
    });
    expect((await source.read('f104', 0))._unsafeUnwrapErr()).toMatchObject({
      reason: 'render_not_found',
    });
    const body = (await source.read('f101', 0))._unsafeUnwrap();
    const text = JSON.stringify(body.tldf);
    expect(text).not.toContain('Imagine secreta');
    expect(text).not.toContain('/777');
    expect(body.extraMeta?.['servedForm']).toMatchObject({
      documentId: 'f101',
      versionKind: 'consolidare',
      caveat: 'unofficial_consolidation',
      portalLabelDate: '2024-03-01',
      sourceUrl: 'https://legislatie.just.ro/Public/DetaliiDocumentAfis/5101',
    });
    expect((await source.read('f105', 0))._unsafeUnwrapErr()).toMatchObject({
      renderStatus: 'label_missing',
    });
  });

  it('resolves an old page id by its preferred route, never falling through a held one', async () => {
    const source = makeLegalRenderSourceV2(db);
    expect((await source.read('5101', 0))._unsafeUnwrap().info.documentId).toBe('f101');
    expect((await source.read('5200', 0))._unsafeUnwrapErr()).toMatchObject({
      reason: 'render_unavailable',
    });
    const data = await gql(`{ legalAct(actId: "7") {
      a: resolveDocument(documentId: "5101") b: resolveDocument(documentId: "5200") } }`);
    // GraphQL and REST agree: page 5200's preferred route is held, so neither
    // falls through to the bound detail route.
    expect(data['legalAct']).toEqual({ a: 'f101', b: null });
    const other = await gql(`{ legalAct(actId: "8") { resolveDocument(documentId: "5101") } }`);
    expect(other['legalAct']).toEqual({ resolveDocument: null });
  });

  it('verifies search hits against the current public unit, provision and chunks', async () => {
    const verifier = makeLegalV2HitVerifier(db);
    const use = (
      formId: string,
      unitId: string,
      provisionSeq: number | null,
      charEnd = 3,
      contentKey: string | null = 'k1:abc'
    ) => ({ formId, unitId, provisionSeq, charStart: 0, charEnd, contentKey });
    const res = await verifier.verifyUses([
      { key: 0, actId: '7', uses: [use('101', '99', 0), use('101', '2', 0)] },
      { key: 1, actId: '7', uses: [use('101', '99', 0)] },
      { key: 2, actId: '7', uses: [use('101', '2', 1)] },
      { key: 3, actId: '7', uses: [use('103', '3', 0)] },
      { key: 4, actId: '9', uses: [use('901', '9', 0)] },
      { key: 5, actId: '7', uses: [use('101', '2', 0, 4)] },
      { key: 6, actId: '7', uses: [use('101', '2', 0, 3, 'k1:other')] },
    ]);
    const verified = res._unsafeUnwrap();
    expect([...verified.keys()].sort()).toEqual([0, 6]);
    // The verified occurrence (the second use), not the exporter's first use.
    expect(verified.get(0)).toMatchObject({
      use: { unitId: '2' },
      address: 'art:1',
      label: 'Articolul 1',
      sameWording: true,
      servedForm: {
        documentId: 'f101',
        caveat: 'unofficial_consolidation',
        sourceUrl: 'https://legislatie.just.ro/Public/DetaliiDocumentAfis/5101',
      },
    });
    expect(verified.get(6)?.sameWording).toBe(false);
  });

  it('serves the section from the verified occurrence, with the served form and its link', async () => {
    const data = await gql(`{ legalSearch(q: "art", channel: sections, includeHistorical: true) {
      sections { documentId nodePath nodeLabel snippet portalDeepLink
        servedForm { documentId caveat sourceUrl amendedAfterPublication } }
      sectionsTotal unhydratedHits } }`);
    expect(data['legalSearch']).toEqual({
      sections: [
        {
          documentId: 'f101',
          // The outline's path of the provision (its render block), not the parser address.
          nodePath: 'b1',
          nodeLabel: 'Articolul 1',
          snippet: '<em>Art</em>',
          portalDeepLink: `https://t/legislation/acts/7?doc=${encodeURIComponent('"f101"')}`,
          servedForm: {
            documentId: 'f101',
            caveat: 'unofficial_consolidation',
            sourceUrl: 'https://legislatie.just.ro/Public/DetaliiDocumentAfis/5101',
            // D7b's and D10b's modifica: D9's comes from the restricted act 9.
            amendedAfterPublication: 2,
          },
        },
      ],
      sectionsTotal: null,
      unhydratedHits: 0,
    });
  });

  it('serves a dated pair through its header, both page routes, and ordered physical chunks', async () => {
    const source = makeLegalRenderSourceV2(db);
    const rows: TldfPhysicalRow[] = [];
    for (const [i, id] of ['5108', 'f106', '5106', 'f106'].entries()) {
      const { kind, info, tldf, extraMeta } = (await source.read(id, i))._unsafeUnwrap();
      expect(info).toMatchObject({ documentId: 'f106', chunkCount: 4, textSha256: sha(PAIR_TEXT) });
      expect(extraMeta?.['servedForm']).toMatchObject({
        portalLabelRaw: 'Consolidarea din 06.05.2025',
        portalLabelDate: '2025-05-06',
        caveat: 'unofficial_consolidation',
        sourceUrl: portalUrl('5106'),
      });
      expect(kind).toBe(i === 0 ? 'manifest' : 'chunk');
      const payload = tldf as unknown as TldfPhysicalRow['payload'];
      rows.push({
        chunkIndex: i,
        chunkCount: 4,
        blockId: 'blocks' in payload ? payload.blocks[0]!.id : null,
        payload,
      });
    }
    const envelope = reassembleTldf(rows)._unsafeUnwrap();
    expect(provenFold(envelope)._unsafeUnwrap()).toBe(PAIR_TEXT);
    expect(envelope.contains_non_bmp).toBe(true);
    expect(envelope.shape).toBe('standard_articles');
    expect(envelope.accounting.emitted_chars + envelope.accounting.separator_chars).toBe(
      PAIR_TEXT.length
    );
    expect(envelope.marks.map((m) => [m.ordinal, m.span, m.link?.href])).toEqual([
      [0, [0, 5], portalUrl('5108')],
      [1, [HEADER.length + 6, HEADER.length + 9], '#1.id_art1'],
    ]);
    expect(JSON.stringify(envelope.blocks)).not.toContain('hidden header image');
    const bodyArticle = envelope.blocks.find((b) => b.id === '1.1');
    expect(bodyArticle).toMatchObject({
      source_element_id: '1.id_art1',
      children: [{ id: '1.1.1', asset: { alt: 'body image', sha256: sha('image') } }],
    });
    expect((await source.read('f106', 4))._unsafeUnwrapErr()).toMatchObject({
      reason: 'render_not_found',
    });

    const result = await gql(`{ legalAct(actId: "7") { canonical { documentId readable sourceUrl
      render { renderStatus textSha256 chunkCount } } } }`);
    expect(result['legalAct']).toEqual({
      canonical: {
        documentId: 'f106',
        readable: true,
        sourceUrl: portalUrl('5106'),
        render: { renderStatus: 'served', textSha256: sha(PAIR_TEXT), chunkCount: 4 },
      },
    });
  });

  it('translates outline, presentation nodes and verified search ranges into the same UTF-16 text', async () => {
    const outline = makeLegalOutlineRepoV2(db);
    const headings = (
      await outline.outline({ documentId: 'f106', maxDepth: 7, page: { first: 9 } })
    )._unsafeUnwrap().items;
    expect(
      headings.map((e) => [e.path, e.numberKey, PAIR_TEXT.slice(e.charStart!, e.charEnd!)])
    ).toEqual([
      ['0.1', '1', HEADER],
      ['1.1', '1', 'articol'],
    ]);
    for (const [path, end] of [
      ['0.1.1', HEADER.length],
      ['1.1.1', PAIR_TEXT.length],
    ] as const) {
      expect((await outline.entryByPath('5108', path))._unsafeUnwrap()).toMatchObject({
        documentId: 'f106',
        nodeKind: 'imagine',
        depth: null,
        charStart: end,
        charEnd: end,
      });
    }
    const result =
      await gql(`{ legalSearch(q: "pereche", channel: sections, includeHistorical: true) {
      sections { sectionKey nodePath nodeLabel charStart charEnd servedForm { documentId sourceUrl } } } }`);
    expect(result['legalSearch']).toEqual({
      sections: [
        // Each section names the outline's namespaced path; both carry the FORM's source,
        // the header capture, never the body page.
        {
          sectionKey: 'unit:6:seq:0',
          nodePath: '0.1',
          nodeLabel: 'Antet',
          charStart: 0,
          charEnd: 5,
          servedForm: { documentId: 'f106', sourceUrl: portalUrl('5106') },
        },
        {
          sectionKey: 'unit:7:seq:1',
          nodePath: '1.1',
          nodeLabel: 'Articolul 1',
          charStart: HEADER.length + 6,
          charEnd: HEADER.length + 9,
          servedForm: { documentId: 'f106', sourceUrl: portalUrl('5106') },
        },
      ],
    });
    // From the returned ranges, not the fixture's constants: the header's heading ends where
    // the one boundary character sits, and the body section's range reads its own word.
    const headerEnd = headings[0]?.charEnd ?? -1;
    expect(headerEnd).toBe(HEADER.length);
    expect(PAIR_TEXT.slice(headerEnd, headerEnd + 1)).toBe('\n');
    const bodySection = (
      result['legalSearch'] as { sections: { charStart: number; charEnd: number }[] }
    ).sections[1];
    expect(PAIR_TEXT.slice(bodySection?.charStart ?? 0, bodySection?.charEnd ?? 0)).toBe('art');
    expect(PAIR_TEXT.slice(headerEnd + 1, bodySection?.charStart ?? 0)).toBe('Corp ');
    const invalid = (
      await makeLegalV2HitVerifier(db).verifyUses([
        {
          key: 0,
          actId: '7',
          uses: [
            { ...pairHits[0]!.uses[0]!, charStart: HEADER.length - 1, charEnd: HEADER.length + 2 },
            { ...pairHits[1]!.uses[0]!, unitId: '6' },
          ],
        },
      ])
    )._unsafeUnwrap();
    expect(invalid.size).toBe(0);
    // A highlight across the boundary is two ranges, one per component, each verified in its
    // own unit and placed in form coordinates on either side of the newline.
    const across = (
      await makeLegalV2HitVerifier(db).verifyUses([
        {
          key: 0,
          actId: '7',
          uses: [{ ...pairHits[0]!.uses[0]!, charStart: 3, charEnd: 5 }],
        },
        { key: 1, actId: '7', uses: [pairHits[1]!.uses[0]!] },
      ])
    )._unsafeUnwrap();
    const ranges = [0, 1].map((k) => [across.get(k)?.charStart, across.get(k)?.charEnd]);
    expect(ranges).toEqual([
      [3, 5],
      [HEADER.length + 6, HEADER.length + 9],
    ]);
    expect(PAIR_TEXT.slice(3, 5)).toBe(HEADER.slice(3, 5));
    expect(PAIR_TEXT.slice(5, HEADER.length + 6)).toContain('\n');
  });

  it('drops a reference mark whose link occurrence is withheld, and renumbers the rest', async () => {
    const trx = await db.startTransaction().execute();
    try {
      await sql`update legal_v2.unit_links set privacy_class = 'restricted'
                 where unit_id = 7 and ordinal = 0`.execute(trx);
      const manifest = (await makeLegalRenderSourceV2(trx).read('f106', 0))._unsafeUnwrap();
      const marks = (manifest.tldf as { marks: { ordinal: number; span: number[] }[] }).marks;
      expect(marks.map((m) => [m.ordinal, m.span])).toEqual([[0, [0, 5]]]);
    } finally {
      await trx.rollback().execute();
    }
  });

  it('reads forms afresh for each call, never through a read still in flight for another', async () => {
    const trx = await db.startTransaction().execute();
    try {
      const acts = makeLegalActsRepoV2({
        db: trx,
        legacy: makeLegalActsRepo(trx, V2_BRIDGE_GATE),
        today: () => '2026-11-20',
      });
      // One connection runs statements in the order they are issued: A's read, the
      // restriction, then B's read. Before, B shared A's read while it was in flight and got
      // A's verdict, taken before the restriction.
      const a = acts.listDocuments('7');
      const restrict = sql`update legal_v2.form_components set privacy_class = 'restricted'
                            where unit_id = 7`.execute(trx);
      const b = acts.listDocuments('7');
      await restrict;
      const pairOf = (docs: readonly { documentId: string }[]) =>
        docs.find((d) => d.documentId === 'f106');
      expect(pairOf((await a)._unsafeUnwrap())).toMatchObject({ readable: true });
      expect(pairOf((await b)._unsafeUnwrap())).toMatchObject({ readable: false, sourceUrl: null });
    } finally {
      await trx.rollback().execute();
    }
  });

  it('returns a section only when the outline confirms its act, composition and unit', async () => {
    const reader = makeV2OutlineReader(db);
    const hits = pairHits.map((h, key) => ({ ...h, key }));
    const verifier = (paths: Parameters<typeof makeLegalV2HitVerifier>[1]) =>
      makeLegalV2HitVerifier(db, paths);
    const uses = [
      ...(await verifier(reader.provisionPaths).verifyUses(hits))._unsafeUnwrap().values(),
    ];
    expect(uses.length).toBe(2);
    const confirm = async (
      paths: Parameters<typeof makeLegalV2HitVerifier>[1],
      actId = '7'
    ): Promise<(string | null)[]> =>
      Promise.all(
        uses.map(async (u) => (await verifier(paths).confirmPath!(actId, u))._unsafeUnwrap())
      );
    // Control: the outline of the composition the verification read names both sections.
    expect(await confirm(reader.provisionPaths)).toEqual(['0.1', '1.1']);
    const altered = (change: (p: V2ProvisionPaths) => V2ProvisionPaths) => async (id: string) =>
      (await reader.provisionPaths(id)).map((p) => (p === null ? null : change(p)));
    // Another composition (a body replaced between the two reads).
    expect(
      await confirm(altered((p) => ({ ...p, compositionDigest: 'another composition' })))
    ).toEqual([null, null]);
    // The form moved to another act by an identity publication, same composition.
    expect(await confirm(altered((p) => ({ ...p, actId: '8' })))).toEqual([null, null]);
    expect(await confirm(reader.provisionPaths, '8')).toEqual([null, null]);
    // A serving unit withdrawn and restored under another id, same composition.
    expect(
      await confirm(
        altered((p) => ({
          ...p,
          unitIds: new Map([
            [0, '6'],
            [1, '70'],
          ]),
        }))
      )
    ).toEqual(['0.1', null]);
    // A form the outline no longer reads (restricted between the two reads).
    expect(await confirm(() => Promise.resolve(ok(null)))).toEqual([null, null]);
  });

  it('reads no outline to verify, and one per section it returns', async () => {
    const reader = makeV2OutlineReader(db);
    const asked: string[] = [];
    const counting: Parameters<typeof makeLegalV2HitVerifier>[1] = (id) => {
      asked.push(id);
      return reader.provisionPaths(id);
    };
    const verifier = makeLegalV2HitVerifier(db, counting);
    // A section whose wording the index records in two verifiable forms (a passage repeated
    // across versions), and the pair's two sections.
    const candidate = {
      ...sectionHit,
      key: 0,
      uses: [
        {
          formId: '101',
          unitId: '2',
          provisionSeq: 0,
          charStart: 0,
          charEnd: 3,
          contentKey: 'k1:abc',
        },
        {
          formId: '106',
          unitId: '7',
          provisionSeq: 1,
          charStart: 5,
          charEnd: 8,
          contentKey: 'k1:article',
        },
      ],
    };
    const out = (
      await verifier.verifyUses([candidate, ...pairHits.map((h, i) => ({ ...h, key: i + 1 }))])
    )._unsafeUnwrap();
    expect(out.size).toBe(3);
    expect(asked).toEqual([]);
    const first = out.get(0);
    expect(first?.servedForm.documentId).toBe('f101');
    expect((await verifier.confirmPath!('7', first!))._unsafeUnwrap()).not.toBeNull();
    expect(asked).toEqual(['f101']);
  });

  it('keeps a whole consolidation with the literal label and no date readable', async () => {
    const trx = await db.startTransaction().execute();
    try {
      await sql`update legal_v2.forms set portal_label_date = null,
                 portal_label_raw = 'Consolidarea din 01.03.2024' where form_id = 101`.execute(trx);
      expect(
        (await makeLegalRenderRepoV2(trx).renderInfo('f101'))._unsafeUnwrap()?.renderStatus
      ).toBe('served');
    } finally {
      await trx.rollback().execute();
    }
  });

  it('pins a cached hash to the composition when a new body is published', async () => {
    const trx = await db.startTransaction().execute();
    try {
      await sql`set local session_replication_role = replica`.execute(trx);
      const render = makeLegalRenderSourceV2(trx);
      expect((await render.read('f106', 3))._unsafeUnwrap().info.textSha256).toBe(sha(PAIR_TEXT));
      await sql`delete from legal_v2.form_components where unit_id = 8`.execute(trx);
      await sql`update legal_v2.form_components set unit_id = 8 where unit_id = 7`.execute(trx);
      await sql`update legal_v2.form_sources set form_id = 106, component_slot = 'body' where capture_ref_id = 8`.execute(
        trx
      );
      await sql`update legal_v2.form_current set composition_digest = legal_v2.composition_digest(106) where form_id = 106`.execute(
        trx
      );
      const replaced = (await render.read('f106', 2))._unsafeUnwrap();
      expect(replaced.info).toMatchObject({ textSha256: sha(HEADER + '\nArt'), chunkCount: 3 });
      await sql`update legal_v2.form_components set privacy_class = 'restricted' where unit_id = 8`.execute(
        trx
      );
      expect((await render.read('f106', 1))._unsafeUnwrapErr()).toMatchObject({
        reason: 'render_restricted',
      });
    } finally {
      await trx.rollback().execute();
    }
  });

  it('requires the whole unit to be the sole component', async () => {
    const trx = await db.startTransaction().execute();
    try {
      await sql`set local session_replication_role = replica`.execute(trx);
      await sql`insert into legal_v2.form_components (form_id, ordinal, slot, linked_page_id)
        values (101, 1, 'linked_annex', '5109')`.execute(trx);
      expect((await makeLegalRenderSourceV2(trx).read('f101', 0))._unsafeUnwrapErr()).toMatchObject(
        { renderStatus: 'composition_not_served' }
      );
    } finally {
      await trx.rollback().execute();
    }
  });

  it('rechecks withheld provisions in each component under the same composition digest', async () => {
    const trx = await db.startTransaction().execute();
    try {
      const outline = makeLegalOutlineRepoV2(trx);
      const paths = async () =>
        (await outline.outline({ documentId: 'f106', maxDepth: 7, page: { first: 8 } }))
          ._unsafeUnwrap()
          .items.map((e) => e.path);
      expect(await paths()).toEqual(['0.1', '1.1']);
      await sql`update legal_v2.unit_provisions set privacy_class = 'restricted' where unit_id = 7`.execute(
        trx
      );
      expect(await paths()).toEqual(['0.1']);
      expect((await outline.entryByPath('f106', '1.1'))._unsafeUnwrap()).toBeNull();
      await sql`update legal_v2.unit_provisions set privacy_class =
        case when unit_id = 6 then 'restricted' else 'public' end where unit_id in (6,7)`.execute(
        trx
      );
      expect(await paths()).toEqual(['1.1']);
    } finally {
      await trx.rollback().execute();
    }
  });

  it.each([
    [
      'restricted body',
      'restricted',
      sql`update legal_v2.form_components set privacy_class = 'restricted' where unit_id = 7`,
    ],
    [
      'restricted header unit',
      'restricted',
      sql`update legal_v2.text_units set privacy_class = 'restricted' where unit_id = 6`,
    ],
    [
      'restricted body chunk',
      'restricted',
      sql`update legal_v2.unit_render set privacy_class = 'restricted' where unit_id = 7 and chunk_seq = 1`,
    ],
    [
      'restricted composition',
      'restricted',
      sql`update legal_v2.form_current set privacy_class = 'restricted' where form_id = 106`,
    ],
    ['empty body', 'not_loaded', sql`delete from legal_v2.unit_render where unit_id = 7`],
    ['ended form', 'not_loaded', sql`update legal_v2.forms set ended = true where form_id = 106`],
    // Combined faults: privacy is decided before availability and shape.
    [
      'unsupported shape with a restricted component',
      'restricted',
      sql`with shape as (update legal_v2.form_components set slot = 'whole' where unit_id = 7 returning 1)
          update legal_v2.form_components set privacy_class = 'restricted' where unit_id = 6`,
    ],
    [
      'missing body with a restricted header chunk',
      'restricted',
      sql`with gone as (update legal_v2.form_components
                          set slot = 'missing_body', unit_id = null, linked_page_id = '5107'
                        where unit_id = 7 returning 1)
          update legal_v2.unit_render set privacy_class = 'restricted' where unit_id = 6`,
    ],
    [
      'unpublished composition',
      'not_loaded',
      sql`delete from legal_v2.form_current where form_id = 106`,
    ],
    [
      'whole plus a second text component',
      'composition_not_served',
      sql`update legal_v2.form_components set slot = 'whole' where unit_id = 6`,
    ],
    [
      'blank label wording',
      'label_missing',
      sql`update legal_v2.forms set portal_label_raw = '  ' where form_id = 106`,
    ],
    [
      'label of tabs and line breaks',
      'label_missing',
      sql`update legal_v2.forms set portal_label_raw = E'\t\n' where form_id = 106`,
    ],
    [
      'label wording alone',
      'label_missing',
      sql`update legal_v2.forms set portal_label_date = null where form_id = 106`,
    ],
    [
      'label date alone',
      'label_missing',
      sql`update legal_v2.forms set portal_label_raw = null where form_id = 106`,
    ],
    [
      'wrong form kind',
      'composition_not_served',
      sql`update legal_v2.forms set form_kind = 'republication' where form_id = 106`,
    ],
    [
      'body at ordinal two',
      'composition_not_served',
      sql`update legal_v2.form_components set ordinal = 2 where unit_id = 7`,
    ],
    [
      'extra annex',
      'composition_not_served',
      sql`insert into legal_v2.form_components (form_id, ordinal, slot, linked_page_id) values (106, 2, 'linked_annex', '5109')`,
    ],
    [
      'private source',
      'source_not_bound',
      sql`update legal_v2.form_sources set privacy_class = 'restricted' where capture_ref_id = 7`,
    ],
    [
      'wrong binding slot',
      'source_not_bound',
      sql`update legal_v2.form_sources set component_slot = 'header' where capture_ref_id = 7`,
    ],
    [
      'swapped body',
      'source_not_bound',
      sql`update legal_v2.form_components set unit_id = 8 where unit_id = 7`,
    ],
  ] as const)('rejects the %s fixture on every surface', async (fixture, status, change) => {
    const trx = await db.startTransaction().execute();
    try {
      await sql`set local session_replication_role = replica`.execute(trx);
      const outline = makeLegalOutlineRepoV2(trx);
      expect((await outline.entryByPath('f106', '0.1'))._unsafeUnwrap()).not.toBeNull();
      if (fixture === 'swapped body') {
        // Substitute the public text of f107, whose capture never supplied f106.
        await sql`delete from legal_v2.form_components where unit_id = 8`.execute(trx);
      }
      await change.execute(trx);
      const source = makeLegalRenderSourceV2(trx);
      const body = (await source.read('f106', 1))._unsafeUnwrapErr();
      expect(body).toMatchObject(
        status === 'restricted'
          ? { reason: 'render_restricted' }
          : { reason: 'render_unavailable', renderStatus: status }
      );
      expect((await makeLegalRenderRepoV2(trx).renderInfo('f106'))._unsafeUnwrap()).toMatchObject({
        renderStatus: status === 'restricted' ? 'content_unavailable' : status,
        textSha256: '',
        compilerVersion: '',
        compiledAt: '',
        chunkCount: null,
      });
      const acts = makeLegalActsRepoV2({
        db: trx,
        legacy: makeLegalActsRepo(trx, V2_BRIDGE_GATE),
        today: () => '2026-11-20',
      });
      const documents = (await acts.listDocuments('7'))._unsafeUnwrap();
      const pair = documents.find((d) => d.documentId === 'f106');
      if (fixture === 'ended form') expect(pair).toBeUndefined();
      else expect(pair).toMatchObject({ readable: false, isCanonical: false });
      // A restricted verdict names no source at all; otherwise the header's, never the body's
      // page (the inconsistent "wrong binding slot" labels the body capture a header).
      if (status === 'restricted') expect(pair?.sourceUrl).toBeNull();
      else if (fixture !== 'ended form' && fixture !== 'wrong binding slot') {
        expect(pair?.sourceUrl).toBe(portalUrl('5106'));
      }
      // latest_any_kind: an unavailable f106 is still act 7's latest form, so no form is
      // canonical and f101 is the latest available; an ended f106 takes no part.
      expect(documents.find((d) => d.isCanonical)?.documentId).toBe(
        fixture === 'ended form' ? 'f101' : undefined
      );
      const def = (await acts.defaultFormsForActs?.(['7']))?._unsafeUnwrap().get('7');
      expect(def).toMatchObject(
        fixture === 'ended form'
          ? { posture: 'current', defaultFormId: '101' }
          : { posture: 'latest_not_available', chosenFormId: '106', latestAvailableFormId: '101' }
      );
      expect((await outline.entryByPath('f106', '0.1'))._unsafeUnwrap()).toBeNull();
      expect(
        (
          await makeLegalV2HitVerifier(trx).verifyUses(pairHits.map((h, key) => ({ ...h, key })))
        )._unsafeUnwrap().size
      ).toBe(0);
    } finally {
      await trx.rollback().execute();
    }
  });

  it('keeps the evidence, the citing acts and the outline fallback to what is public', async () => {
    const data = await gql(`{ legalAct(actId: "7") { statusEvidence
      links(direction: IN) { edges { sourceDocumentId sourceAct { actId } } } } }`);
    const act = data['legalAct'] as {
      statusEvidence: { abrogated_by: number[] };
      links: { edges: { sourceDocumentId: string; sourceAct: { actId: string } | null }[] };
    };
    expect(act.statusEvidence.abrogated_by).toEqual([7]);
    // Public NON-canonical citing documents stay, each with its act.
    expect(act.links.edges).toEqual([
      { sourceDocumentId: 'D10b', sourceAct: { actId: '10' } },
      { sourceDocumentId: 'D7b', sourceAct: { actId: '7' } },
    ]);
    const outline = makeLegalOutlineRepoV2(db);
    // Form 107 is served, but every provision at b1's span is withheld: the
    // legal block must not answer through the presentation fallback.
    expect((await outline.entryByPath('f107', 'b1'))._unsafeUnwrap()).toBeNull();
    expect((await outline.entryByPath('f101', 'b1'))._unsafeUnwrap()).toMatchObject({
      nodeKind: 'articol',
    });
    expect((await outline.entryByPath('f107', 'i1'))._unsafeUnwrap()).toMatchObject({
      nodeKind: 'imagine',
      depth: null,
    });
  });

  it('reports unknown references for an unbridged act over MCP', async () => {
    const links = tools.find((t) => t.name === 'get_legal_act_links');
    const out = (await links?.handler({ actId: '8' })) as unknown as {
      items: unknown[];
      meta: { known: boolean };
      summary: string;
    };
    expect(out).toMatchObject({ items: [], meta: { known: false } });
    expect(out.summary).toContain('references unknown');
  });

  it('runs every mounted client document against the fixture with no errors', async () => {
    const run = async (query: string, variables: Record<string, unknown>): Promise<void> => {
      const res = await graphql({ schema, source: query, variableValues: variables });
      expect(res.errors ?? []).toEqual([]);
    };
    // Monitorul-only documents are validated by the contract suite; Monitorul
    // is unchanged by the v2 source and stubbed here.
    for (const c of LEGAL_CLIENT_CASES) {
      if (c.monitorulOnly !== true) await run(c.query, c.variables);
    }
    const resolved = await graphql({
      schema,
      source: RESOLVE_DOCUMENT_QUERY,
      variableValues: { actId: '7', documentId: '5101' },
    });
    expect(resolved.data).toEqual({ legalAct: { actId: '7', resolveDocument: 'f101' } });
    // On the fixture's own ids: a bridged act, an unbridged act, a served form.
    for (const actId of ['7', '8']) {
      await run(ACT_DETAIL_QUERY, { actId, outFirst: 60, inFirst: 12, anchorsFirst: 12 });
    }
    await run(OUTLINE_QUERY, { documentId: 'f101', maxDepth: 7, first: 200, after: null });
  });

  it('names the citing act of a non-canonical document in the timeline', async () => {
    const data = await gql(`{ legalAct(actId: "7") { timeline { kind label relatedActId } } }`);
    const amendments = (
      data['legalAct'] as {
        timeline: { kind: string; label: string; relatedActId: string | null }[];
      }
    ).timeline.filter((e) => e.kind === 'amendment');
    // D10b is a NON-canonical document of act 10: act 10 is the amender, never
    // the target itself, and never a null act.
    expect(amendments).toContainEqual({
      kind: 'amendment',
      label: 'modifica de Legea nr. 10/2023',
      relatedActId: '10',
    });
    expect(amendments.every((e) => e.relatedActId !== null)).toBe(true);
  });

  it("fills the citing acts' default document over MCP, from one batched read", async () => {
    const links = tools.find((t) => t.name === 'get_legal_act_links');
    const out = (await links?.handler({ actId: '7', direction: 'in' })) as unknown as {
      items: { edge: { sourceDocumentId: string }; sourceAct: Record<string, unknown> | null }[];
    };
    const byDoc = new Map(out.items.map((i) => [i.edge.sourceDocumentId, i.sourceAct]));
    // Act 10's latest form (a listed republication) has no text: no default, but the readable
    // older form travels with the citing act, from the same batch.
    expect(byDoc.get('D10b')).toMatchObject({
      actId: '10',
      canonicalDocumentId: null,
      defaultBasis: 'latest_not_available',
      latestDocumentId: 'f111',
      latestAvailableDocumentId: 'f110',
    });
    // Act 7's latest form is the readable header+body consolidation f106.
    expect(byDoc.get('D7b')).toMatchObject({
      actId: '7',
      canonicalDocumentId: 'f106',
      defaultBasis: 'current',
      latestDocumentId: 'f106',
      latestAvailableDocumentId: 'f106',
    });
  });

  it('serves the human citation, never the stored natural key', async () => {
    const data = await gql(`{
      bridged: legalAct(actId: "7") { displayCitation }
      unbridged: legalAct(actId: "8") { displayCitation }
      noNumber: legalAct(actId: "11") { displayCitation }
      directory: legalActs(first: 10) { edges { node { actId displayCitation } } }
      search: legalSearch(q: "art", includeHistorical: true) { acts { act { displayCitation } } }
      resolve: legalResolve(dim: "act", q: "legea 1/2020") { value label }
    }`);
    expect(data['bridged']).toEqual({ displayCitation: 'Legea nr. 1/2020' });
    expect(data['unbridged']).toEqual({ displayCitation: 'Legea nr. 2/2021' });
    expect(data['noNumber']).toEqual({ displayCitation: 'Decretul din 2001' });
    expect(JSON.stringify(data)).not.toMatch(/[a-z]+:[0-9]*:[0-9]*:/u);
    const mcp = tools.find((t) => t.name === 'get_legal_act');
    const out = (await mcp?.handler({ actId: '7' })) as unknown as {
      item: { displayCitation: string };
    };
    expect(out.item.displayCitation).toBe('Legea nr. 1/2020');
    const loaded = await makeLegalActLoader({ acts: v2Acts }).loadAct?.('11');
    expect(loaded).toMatchObject({ displayCitation: 'Decretul din 2001' });
  });

  it('agrees with the raw p2a_default_form (latest_any_kind) on the fixture, for several days', async () => {
    const root = process.env['SCRAPPER_REPO_ROOT'] ?? '';
    const sqlText = fs.readFileSync(path.join(root, FORM_STATES_SQL), 'utf8');
    const start = sqlText.indexOf('create or replace function portal_acts.p2a_default_form(');
    const fn = sqlText.slice(start, sqlText.indexOf('\n$$;', start) + 4);
    expect(createHash('sha256').update(fn).digest('hex')).toBe(DEFAULT_FORM_FN_SHA256);
    // The function verbatim, reading its per-form facts from a table the test
    // fills with the API's own facts (so the comparison is of the RULE).
    await q(`create schema test_oracle;
      create table test_oracle.states (lineage_id bigint, form_id bigint, form_kind text,
        form_key text, portal_order_date date, order_rank smallint, portal_list_position integer,
        max_page_id bigint, accepted boolean, body_resolved boolean, readable boolean);
      create function test_oracle.p2a_form_states(p_selection_seq bigint, p_lineage_id bigint)
        returns setof test_oracle.states language sql stable as
        $f$ select * from test_oracle.states where lineage_id = p_lineage_id $f$;`);
    await q(fn.replaceAll('portal_acts.', 'test_oracle.'));
    const actIds = ['7', '8', '10', '11', '12', '13', '14', '16'];
    const rows = (await readFormsForActs(db, actIds))._unsafeUnwrap();
    // The raw function never sees an ended form (p2a_form_states leaves it out); inserting one as
    // unreadable would let it win the date. Act 12's newest form is ended.
    expect(rows.some((r) => r.ended)).toBe(true);
    for (const r of rows.filter((x) => !x.ended)) {
      await q(
        `insert into test_oracle.states values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          r.act_id,
          r.form_id,
          r.form_kind,
          r.form_key,
          r.portal_order_date,
          r.order_rank,
          r.portal_list_position,
          r.max_page_id,
          r.accepted,
          r.body_resolved,
          r.readable,
        ]
      );
    }
    let compared = 0;
    for (const day of [null, '2019-06-01', '2021-01-01', '2023-06-01', '2026-11-20']) {
      for (const actId of actIds) {
        await q('begin');
        const res = await q(
          `select posture, form_id::text, chosen_form_id::text, latest_available_form_id::text,
                  position_date::text, forms_at_position, order_reviewed, tie_basis,
                  unavailable_at_or_after, later_other_kind, forms_without_position
             from test_oracle.p2a_default_form($1::bigint, $2::date, 0)`,
          [actId, day]
        );
        await q('commit');
        const sqlRow = res.rows[0] as Record<string, unknown>;
        const mine = computeDefaultForm(
          actId,
          rows.filter((r) => r.act_id === actId).map(toFormState),
          day
        );
        expect(
          {
            posture: mine.posture,
            form_id: mine.defaultFormId,
            chosen_form_id: mine.chosenFormId,
            latest_available_form_id: mine.latestAvailableFormId,
            position_date: mine.positionDate,
            forms_at_position: mine.formsAtPosition,
            order_reviewed: mine.orderReviewed,
            tie_basis: mine.tieBasis,
            unavailable_at_or_after: mine.newerNotAvailable,
            later_other_kind: mine.laterOtherKind,
            forms_without_position: mine.formsWithoutPosition,
          },
          `act ${actId} on ${String(day)}`
        ).toEqual(sqlRow);
        compared += 1;
      }
    }
    expect(compared).toBe(40);
    // The fixture exercises the policy: act 7's latest form is the readable
    // header+body consolidation f106; act 10's latest date holds a listed republication without
    // text over the unlisted original, so no form is current.
    // latestDocumentId: the form the rule picks as latest, with text or not.
    const latest = await gql(`{
      a7: legalAct(actId: "7") { latestDocumentId latestAvailableDocumentId canonicalDocumentId }
      a8: legalAct(actId: "8") { latestDocumentId defaultBasis }
      a10: legalAct(actId: "10") {
        latestDocumentId latestAvailableDocumentId canonicalDocumentId defaultOrderReviewed } }`);
    expect(latest).toEqual({
      a7: {
        latestDocumentId: 'f106',
        latestAvailableDocumentId: 'f106',
        canonicalDocumentId: 'f106',
      },
      a8: { latestDocumentId: null, defaultBasis: 'no_known_form' },
      a10: {
        latestDocumentId: 'f111',
        latestAvailableDocumentId: 'f110',
        canonicalDocumentId: null,
        defaultOrderReviewed: false,
      },
    });
    const def = (await v2Acts.defaultFormsForActs?.(['7', '10']))?._unsafeUnwrap();
    expect(def?.get('7')).toMatchObject({ posture: 'current', defaultFormId: '106' });
    expect(def?.get('10')).toMatchObject({
      posture: 'latest_not_available',
      chosenFormId: '111',
      latestAvailableFormId: '110',
      orderReviewed: false,
      tieBasis: 'listed_over_unlisted',
      newerNotAvailable: 1,
    });
  });

  it('keeps the bridged summary of an act without a readable default form under a domain filter', async () => {
    // Act 10: latest form without text, an older readable one (and a verified section in it).
    // Act 14: no v2 text at all. Both have a fiscal summary in the old corpus; act 7 has none.
    actHits = ['10', '14', '7'].map((actId) => ({
      actId,
      score: 1,
      citationPath: null,
      headingPath: null,
      snippet: null,
      uses: [],
    }));
    unitHits = [
      {
        ...sectionHit,
        actId: '10',
        uses: [
          {
            formId: '110',
            unitId: '10',
            provisionSeq: 0,
            charStart: 0,
            charEnd: 3,
            contentKey: 'k1:abc',
          },
        ],
      },
    ];
    try {
      const data = await gql(`{ legalSearch(q: "x", includeHistorical: true,
          filter: { domain: { in: ["fiscal-si-bugetar"] } }) {
        acts { act { actId defaultBasis canonicalDocumentId } summary { domains } }
        sections { act { actId } documentId } } }`);
      expect(data['legalSearch']).toEqual({
        acts: [
          {
            act: { actId: '10', defaultBasis: 'latest_not_available', canonicalDocumentId: null },
            summary: { domains: ['fiscal-si-bugetar'] },
          },
          {
            act: { actId: '14', defaultBasis: 'latest_not_available', canonicalDocumentId: null },
            summary: { domains: ['fiscal-si-bugetar'] },
          },
        ],
        sections: [{ act: { actId: '10' }, documentId: 'f110' }],
      });
    } finally {
      actHits = [];
      unitHits = [sectionHit];
    }
  });

  it('serves the shared-pointer headers as two gaps, and no pair', async () => {
    const data = await gql(`{ legalAct(actId: "16") { defaultBasis canonicalDocumentId
      latestDocumentId latestAvailableDocumentId newerNotAvailable
      documents { documentId readable sourceUrl render { renderStatus chunkCount } }
      resolveDocument(documentId: "209845") } }`);
    expect(data['legalAct']).toEqual({
      defaultBasis: 'latest_not_available',
      canonicalDocumentId: null,
      latestDocumentId: 'f162',
      latestAvailableDocumentId: 'f160',
      newerNotAvailable: 2,
      documents: [
        {
          documentId: 'f162',
          readable: false,
          sourceUrl: portalUrl('5162'),
          render: { renderStatus: 'composition_not_served', chunkCount: null },
        },
        {
          documentId: 'f161',
          readable: false,
          sourceUrl: portalUrl('5161'),
          render: { renderStatus: 'composition_not_served', chunkCount: null },
        },
        {
          documentId: 'f160',
          readable: true,
          sourceUrl: portalUrl('5160'),
          render: { renderStatus: 'served', chunkCount: 1 },
        },
      ],
      resolveDocument: null,
    });
    const source = makeLegalRenderSourceV2(db);
    for (const id of ['f161', 'f162']) {
      expect((await source.read(id, 0))._unsafeUnwrapErr()).toMatchObject({
        reason: 'render_unavailable',
        renderStatus: 'composition_not_served',
      });
      expect(
        (await makeLegalOutlineRepoV2(db).entryByPath(id, '0.unmarked:0'))._unsafeUnwrap()
      ).toBeNull();
    }
    // The shared page itself serves nothing: its capture is bound to no form.
    expect((await source.read('209845', 0)).isErr()).toBe(true);
  });

  it('answers every default-form field of a list row and of the card from one selection', async () => {
    const fields = `actId defaultBasis canonicalDocumentId canonical { documentId }
      latestDocumentId latestAvailableDocumentId newerNotAvailable defaultOrderReviewed`;
    const data = await gql(`{
      list: legalActs(first: 20) { edges { node { ${fields} } } }
      a7: legalAct(actId: "7") { ${fields} } a10: legalAct(actId: "10") { ${fields} }
      a12: legalAct(actId: "12") { ${fields} } a13: legalAct(actId: "13") { ${fields} }
      a14: legalAct(actId: "14") { ${fields} } }`);
    const list = (data['list'] as { edges: { node: Record<string, unknown> }[] }).edges.map(
      (e) => e.node
    );
    const byId = new Map(list.map((n) => [n['actId'], n]));
    for (const id of ['7', '10', '12', '13', '14']) {
      expect(byId.get(id), `act ${id}`).toEqual(data[`a${id}`]);
    }
    // An explicit null canonical on the card is served as null, never re-read.
    expect(data['a10']).toMatchObject({
      defaultBasis: 'latest_not_available',
      canonical: null,
      canonicalDocumentId: null,
      latestAvailableDocumentId: 'f110',
    });
  });

  it('ignores an ended newest form', async () => {
    const data = await gql(`{ legalAct(actId: "12") { defaultBasis canonicalDocumentId
      latestDocumentId latestAvailableDocumentId newerNotAvailable
      documents { documentId readable } } }`);
    // Form 121 (consolidation 2025, with text) is ended: the 2020 original is current.
    expect(data['legalAct']).toEqual({
      defaultBasis: 'current',
      canonicalDocumentId: 'f120',
      latestDocumentId: 'f120',
      latestAvailableDocumentId: 'f120',
      newerNotAvailable: 0,
      documents: [{ documentId: 'f120', readable: true }],
    });
  });

  it('serves an act whose only readable form is an undated original as having no default', async () => {
    // Production holds 1,924 such acts. The policy places only dated forms, so this act has no
    // latest position: no canonical and no ids, while its documents list offers the form.
    const data = await gql(`{ legalAct(actId: "13") { defaultBasis defaultOrderReviewed
      canonical { documentId } canonicalDocumentId latestDocumentId latestAvailableDocumentId
      newerNotAvailable documents { documentId versionKind versionDate isCanonical readable } } }`);
    expect(data['legalAct']).toEqual({
      defaultBasis: 'no_known_form',
      defaultOrderReviewed: null,
      canonical: null,
      canonicalDocumentId: null,
      latestDocumentId: null,
      latestAvailableDocumentId: null,
      newerNotAvailable: 0,
      documents: [
        {
          documentId: 'f130',
          versionKind: 'original',
          versionDate: null,
          isCanonical: false,
          readable: true,
        },
      ],
    });
    const def = (await v2Acts.defaultFormsForActs?.(['13']))?._unsafeUnwrap().get('13');
    expect(def).toMatchObject({ positionDate: null, formsWithoutPosition: 1 });
  });
});

/** The fixture, written with triggers off. */
const seed = async (q: (t: string, p?: unknown[]) => Promise<pg.QueryResult>): Promise<void> => {
  await q('set session_replication_role = replica');
  await q(`insert into legal_v2.load_runs (job_kind, loader_version, code_dirty)
           values ('act_load', 't', false)`);
  await q(`insert into legal_v2.package_receipts (load_run_id, unit_kind, act_id, package_seq,
             generation_seq, release_selection_seq, act_identity_digest, input_digest,
             output_digest, outcome)
           values (1, 'act_package', 7, 1, 4, 1, 'd', 'i', 'o', 'published')`);
  await q(`insert into legal_v2.acts (act_id, act_natural_key, act_type, act_number, act_year,
             issuer_slug, display_citation, identity_generation_seq, privacy_class) values
           (7, 'lege:1:2020:', 'lege', '1', 2020, 'parlamentul', 'lege:1:2020:', 4, 'public'),
           (8, 'lege:2:2021:', 'lege', '2', 2021, 'parlamentul', 'lege:2:2021:', 4, 'public'),
           (9, 'lege:3:2022:', 'lege', '3', 2022, 'secret-issuer', 'lege:3:2022:', 4, 'restricted'),
           (10, 'lege:10:2023:', 'lege', '10', 2023, 'parlamentul', 'lege:10:2023:', 4, 'public'),
           (11, 'decret::2001:', 'decret', null, 2001, null, 'decret::2001:', 4, 'public'),
           (12, 'lege:12:2024:', 'lege', '12', 2024, 'parlamentul', 'lege:12:2024:', 4, 'public'),
           (13, 'lege:13:2024:', 'lege', '13', 2024, 'parlamentul', 'lege:13:2024:', 4, 'public'),
           (14, 'lege:14:2024:', 'lege', '14', 2024, 'parlamentul', 'lege:14:2024:', 4, 'public')`);
  await q(`insert into legal_v2.page_acts values ('5101', 7, 'ledger_member', 'public'),
           ('777', 9, 'ledger_member', 'public')`);
  // forms: 101 consolidation (served), 103 original (restricted chunk),
  // 104 restricted form, 105 consolidation without label or date
  await q(`insert into legal_v2.forms (form_id, act_id, form_kind, form_key, accepted,
             body_resolved, portal_order_date, caveat, portal_label_date, privacy_class) values
           (101, 7, 'consolidation', 'cons:2024', true, true, '2024-03-01',
            'unofficial_consolidation', '2024-03-01', 'public'),
           (103, 7, 'original', 'orig', true, true, '2020-01-10', null, null, 'public'),
           (104, 7, 'consolidation', 'cons:2025', true, true, '2025-01-01',
            'unofficial_consolidation', '2025-01-01', 'restricted'),
           (105, 7, 'consolidation', 'cons:2023', true, true, '2023-01-01',
            'unofficial_consolidation', null, 'public'),
           (901, 9, 'original', 'orig', true, true, '2022-01-01', null, null, 'public'),
           (106, 7, 'consolidation', 'cons:2025-05', true, true, '2025-05-06', 'unofficial_consolidation', '2025-05-06', 'public'),
           (107, 7, 'original', 'orig2', true, true, '2019-01-01', null, null, 'public'),
           (110, 10, 'original', 'orig', true, true, '2023-01-01', null, null, 'public'),
           (111, 10, 'republication', 'rep', true, true, '2023-01-01', null, null, 'public'),
           (120, 12, 'original', 'orig', true, true, '2020-05-01', null, null, 'public'),
           (121, 12, 'consolidation', 'cons:2025', true, true, '2025-05-01',
            'unofficial_consolidation', '2025-05-01', 'public'),
           (130, 13, 'original', 'orig', true, true, null, null, null, 'public'),
           (140, 14, 'original', 'orig', true, false, '2024-02-01', null, null, 'public')`);
  // form 121, the newest of act 12 and with text, is ended
  await q(`update legal_v2.forms set ended = true where form_id = 121`);
  // form 111 is listed by the Portal, form 110 (the original) is not
  await q(`update legal_v2.forms set portal_list_position = 4 where form_id = 111`);
  const body = JSON.stringify({
    format: 'tldf-unit',
    format_version: '1',
    offset_unit: 'utf16_code_unit',
    contains_non_bmp: false,
    shape: 'paragraph_stream',
    blocks: [
      {
        id: 'b1',
        kind: 'paragraf',
        type: 'PAR',
        span: [0, 3],
        content: [{ text: 'Art', span: [0, 3] }],
      },
      {
        id: 'i1',
        kind: 'imagine',
        type: 'IMG',
        span: [3, 3],
        content: [],
        asset: { asset_ordinal: 0, width: 10, height: 10, alt: 'Imagine secreta' },
      },
    ],
    marks: [{ ordinal: 0, kind: 'reference', span: [0, 3], link_ordinal: 0 }],
  });
  for (const [unit, form, page] of [
    [2, 101, '5101'],
    [3, 103, '5103'],
    [4, 104, '5104'],
    [5, 105, '5105'],
    [9, 901, '5901'],
    [8, 107, '5107'],
    [10, 110, '5110'],
    [12, 120, '5120'],
    [13, 121, '5121'],
    [14, 130, '5130'],
  ] as const) {
    await q(
      `insert into legal_v2.text_units (unit_id, capture_ref_id, custody_lane, page_id, route,
         requested_url, body_sha256, captured_at, parse_lane, parse_source_id, parse_build_id,
         parse_result_digest, parse_run_id, certificate_id, content_parser_version,
         compiler_version, load_run_id, text_sha256, content_digest, render_state, sealed)
       overriding system value values ($1, $1, 'l', $2, 'afis', 'unit-url', 'b', now(), 'afis',
         $2, 'build', 'r', 1, 1, 'v9', 'unit-compiler-v1', 1, 't', 'cd', 'structured', true)`,
      [unit, page]
    );
    await q(`insert into legal_v2.unit_render values ($1, 0, $2, 0, 3, $3)`, [
      unit,
      body,
      unit === 3 ? 'restricted' : 'public',
    ]);
    await q(
      `insert into legal_v2.unit_provisions (unit_id, provision_seq, kind, citation_path,
         address_state, label_raw, char_start, char_end, address, content_key, privacy_class)
       values ($1, 0, 'articol', null, 'unnumbered', 'Articolul 1', 0, 3, 'art:1', 'k1:abc', $2),
              ($1, 1, 'alineat', null, 'unnumbered', null, 0, 3, null, null, 'restricted')`,
      // unit 3 (form 103) and unit 8 (form 107): their provisions are withheld
      [unit, unit === 3 || unit === 8 ? 'restricted' : 'public']
    );
    await q(
      `insert into legal_v2.unit_links (unit_id, ordinal, char_start, char_end, href,
         target_page_id, target_route, privacy_class)
       values ($1, 0, 0, 3, '~/../Public/DetaliiDocumentAfis/777', '777', 'afis', 'public')`,
      [unit]
    );
    await q(
      `insert into legal_v2.unit_assets values ($1, 0, null, 'portal-image:x', 'a.jpg', 'restricted')`,
      [unit]
    );
    await q(
      `insert into legal_v2.form_components (form_id, ordinal, slot, unit_id)
             values ($1, 0, 'whole', $2)`,
      [form, unit]
    );
    await q(`insert into legal_v2.form_current values ($1, 'cd', 1, 'public')`, [form]);
    await q(
      `insert into legal_v2.form_sources (binding_id, subject_kind, act_id, form_id, page_id,
         route, capture_ref_id, requested_url, body_sha256, is_latest, status, method, component_slot)
       values ($1, 'capture', (select act_id from legal_v2.forms where form_id = $2), $2, $3,
         'afis', $1, $4, 'b', true, 'bound', 'rule', 'whole')`,
      [unit, form, page, `https://legislatie.just.ro/Public/DetaliiDocumentAfis/${page}`]
    );
  }
  await seedPair(q);
  await seedSharedPointer(q);
  // page 5200: afis capture HELD, detail capture bound to 101 — must not fall through
  await q(`insert into legal_v2.form_sources (binding_id, subject_kind, act_id, form_id, page_id,
             route, capture_ref_id, requested_url, body_sha256, is_latest, status, method) values
           (20, 'capture', 7, 101, '5200', 'afis', 20, 'u', 'b', true, 'held', 'rule'),
           (21, 'capture', 7, 101, '5200', 'detail', 21, 'u', 'b', true, 'bound', 'rule')`);
  await q(`update legal_v2.identity_publication set generation_seq = 4,
             release_selection_seq = 1, act_partition_digest = 'a', identity_set_digest = 'b',
             unassigned_digest = 'c'`);

  // The old corpus: acts 7 and 9 (not 8).
  await q(`insert into legal.acts values
           (7, 'lege/1/2020', 'lege', '1', 2020, 'parlamentul', 'D7', 'Legea nr. 1/2020',
            'modificat', '{"abrogated_by": [9, 7]}', null, 3),
           (9, 'lege/3/2022', 'lege', '3', 2022, 'secret-issuer', 'D9', 'Legea nr. 3/2022',
            'in-vigoare', '{}', null, 1),
           (10, 'lege/10/2023', 'lege', '10', 2023, 'parlamentul', 'D10', 'Legea nr. 10/2023',
            'in-vigoare', '{}', '2023-02-01', 0),
           (14, 'lege/14/2024', 'lege', '14', 2024, 'parlamentul', 'D14', 'Legea nr. 14/2024',
            'in-vigoare', '{}', null, 0)`);
  await q(`insert into legal.act_documents (document_id, act_id, is_canonical, title) values
           ('D7', 7, true, 'Titlu 7'), ('D7b', 7, false, 'Titlu 7 (alt)'),
           ('D10', 10, true, 'Titlu 10'), ('D10b', 10, false, 'Titlu 10 (republicat)'),
           ('D9', 9, true, 'Titlu secret'), ('D14', 14, true, 'Titlu 14')`);
  // Summaries on the canonical documents of acts 10 and 14 (act 7 has none).
  await q(`insert into legal.document_summaries (document_id, document_category, domains,
             penalties_mentioned) values
           ('D10', 'lege', '{fiscal-si-bugetar}', false),
           ('D14', 'lege', '{fiscal-si-bugetar}', false)`);
  // References: 9 modifies 7 (restricted citing act), 7 cites 9 (restricted target).
  await q(`insert into legal.act_references (source_document_id, ref_index, relation, target_raw,
             target_class, target_act_id, resolution) values
           ('D9', 1, 'modifica', 'Legea 1/2020', 'domestic', 7, 'unique'),
           ('D7', 1, 'face-referire', 'Legea 3/2022', 'domestic', 9, 'unique'),
           ('D7b', 1, 'modifica', 'Legea 1/2020', 'domestic', 7, 'unique'),
           ('D10b', 1, 'modifica', 'Legea 1/2020', 'domestic', 7, 'unique')`);
  await q(`insert into legal.act_status_events values
           (1, 7, 'modificare', '2024-01-01', null, '{}', 'portal', 'public'),
           (2, 7, 'modificare', '2024-02-01', 9, '{}', 'portal', 'public'),
           (3, 9, 'promulgare', '2022-01-01', null, '{}', 'portal', 'public')`);
  await q(`insert into legal.document_link_edges values
           (1, 'D9', null, 0, 'x', 'act', 7, null, null, null, 0, 1, 'public'),
           (2, 'D7', null, 1, 'y', 'act', 7, null, null, null, 0, 1, 'public')`);
  await q('set session_replication_role = origin');
};

/**
 * The design's shared pointer (Codul fiscal, page 209845): two dated headers of act 16 whose
 * links name ONE body page that serves two dates. Its capture is conflicting, so neither form
 * gets a body: two gaps (header plus missing body) and no served pair. Form 160, the original,
 * is the act's readable text.
 */
const seedSharedPointer = async (
  q: (t: string, p?: unknown[]) => Promise<pg.QueryResult>
): Promise<void> => {
  await q(`insert into legal_v2.acts (act_id, act_natural_key, act_type, act_number, act_year,
             issuer_slug, display_citation, identity_generation_seq, privacy_class) values
           (16, 'lege:16:2010:', 'lege', '16', 2010, 'parlamentul', 'lege:16:2010:', 4, 'public')`);
  await q(`insert into legal_v2.forms (form_id, act_id, form_kind, form_key, accepted,
             body_resolved, portal_order_date, caveat, portal_label_raw, portal_label_date,
             privacy_class) values
           (160, 16, 'original', 'orig', true, true, '2010-01-01', null, null, null, 'public'),
           (161, 16, 'consolidation', 'cons:2025-01', true, false, '2025-01-01',
            'unofficial_consolidation', 'Consolidarea din 01.01.2025', '2025-01-01', 'public'),
           (162, 16, 'consolidation', 'cons:2025-06', true, false, '2025-06-01',
            'unofficial_consolidation', 'Consolidarea din 01.06.2025', '2025-06-01', 'public')`);
  for (const [unit, form, page, slot] of [
    [16, 160, '5160', 'whole'],
    [17, 161, '5161', 'header'],
    [18, 162, '5162', 'header'],
  ] as const) {
    await q(
      `insert into legal_v2.text_units (unit_id, capture_ref_id, custody_lane, page_id, route,
         requested_url, body_sha256, captured_at, parse_lane, parse_source_id, parse_build_id,
         parse_result_digest, parse_run_id, certificate_id, content_parser_version,
         load_run_id, text_sha256, content_digest, render_state, sealed)
       overriding system value values ($1, $1, 'l', $2, 'afis', 'u', 'b', now(), 'afis',
         $2, 'build', 'r', 1, 1, 'v9', 1, 't', 'cd', 'text_only', true)`,
      [unit, page]
    );
    await q(`insert into legal_v2.unit_render values ($1, 0, 'Text', 0, 4, 'public')`, [unit]);
    await q(
      `insert into legal_v2.form_sources (binding_id, subject_kind, act_id, form_id, page_id,
         route, capture_ref_id, requested_url, body_sha256, is_latest, status, method, component_slot)
       values ($1, 'capture', 16, $2, $3, 'afis', $1, $4, 'b', true, 'bound', 'rule', $5)`,
      [unit, form, page, portalUrl(page), slot]
    );
    await q(
      `insert into legal_v2.form_components (form_id, ordinal, slot, unit_id) values ($1, 0, $2, $3)`,
      [form, slot, unit]
    );
    if (slot === 'header') {
      await q(
        `insert into legal_v2.unit_links (unit_id, ordinal, char_start, char_end, href,
           target_page_id, target_route, privacy_class)
         values ($1, 0, 0, 4, $2, '209845', 'afis', 'public')`,
        [unit, portalUrl('209845')]
      );
      await q(
        `insert into legal_v2.form_components (form_id, ordinal, slot, linked_page_id,
           link_unit_id, link_ordinal) values ($1, 1, 'missing_body', '209845', $2, 0)`,
        [form, unit]
      );
    }
    await q(`insert into legal_v2.form_current values ($1, 'cd', 1, 'public')`, [form]);
  }
  // The shared body page: one capture serving two dates, conflicting, bound to no form.
  await q(
    `insert into legal_v2.form_sources (binding_id, subject_kind, act_id, form_id, page_id,
             route, capture_ref_id, requested_url, body_sha256, is_latest, status, method,
             component_slot, reason_code)
           values (209845, 'capture', 16, null, '209845', 'afis', 209845, $1, 'b', true,
             'conflicting', 'rule', 'body', 'two_dates')`,
    [portalUrl('209845')]
  );
};

/** Two independently compiled pages, each with local mark, link and image ordinal zero. */
const seedPair = async (
  q: (t: string, p?: unknown[]) => Promise<pg.QueryResult>
): Promise<void> => {
  await q(
    `update legal_v2.forms set portal_label_raw = 'Consolidarea din 06.05.2025' where form_id = 106`
  );
  for (const [unit, slot, page] of [
    [6, 'header', '5106'],
    [7, 'body', '5108'],
  ] as const) {
    const header = slot === 'header';
    const text = header ? HEADER : BODY;
    await q(
      `insert into legal_v2.text_units (unit_id, capture_ref_id, custody_lane, page_id, route,
         requested_url, body_sha256, captured_at, parse_lane, parse_source_id, parse_build_id,
         parse_result_digest, parse_run_id, certificate_id, content_parser_version, compiler_version,
         load_run_id, text_sha256, content_digest, render_state, sealed)
       overriding system value values ($1, $1, 'l', $2, 'afis', 'u', 'b', now(), 'afis',
         $2, 'build', 'r', 1, 1, 'v9', 'unit-v1', 1, $3, $3, 'structured', true)`,
      [unit, page, sha(text)]
    );
    // A binding-id sort would pick the body first.
    await q(
      `insert into legal_v2.form_sources (binding_id, subject_kind, act_id, form_id, page_id,
         route, capture_ref_id, requested_url, body_sha256, is_latest, status, method, component_slot)
       values ($1, 'capture', 7, 106, $2, 'afis', $3, $4, 'b', true, 'bound', 'rule', $5)`,
      [header ? 31 : 30, page, unit, portalUrl(page), slot]
    );
    await q(`insert into legal_v2.page_acts values ($1, 7, 'ledger_member', 'public')`, [page]);
    await q(
      `insert into legal_v2.form_components (form_id, ordinal, slot, unit_id)
             values (106, $1, $2, $3)`,
      [header ? 0 : 1, slot, unit]
    );
    const start = header ? 0 : 5;
    const end = text.length;
    const article = {
      id: '1',
      kind: 'articol',
      type: 'ART',
      span: [start, end],
      source_element_id: 'id_art1',
      content: [{ text: text.slice(start), span: [start, end], ...(header ? {} : { sep: ' ' }) }],
      children: [
        {
          id: '1.1',
          kind: 'imagine',
          type: 'IMG',
          span: [end, end],
          content: [],
          asset: { asset_ordinal: 0, alt: header ? 'hidden header image' : 'body image' },
        },
      ],
    };
    const marks = [
      { ordinal: 0, kind: 'reference', span: header ? [0, 5] : [5, 8], link_ordinal: 0 },
    ];
    const head = {
      format: 'tldf-unit',
      format_version: '1',
      offset_unit: 'utf16_code_unit',
      shape: header ? 'paragraph_stream' : 'standard_articles',
      contains_non_bmp: header,
    };
    const first = header
      ? { ...head, blocks: [article], marks }
      : {
          ...head,
          blocks: [
            {
              id: '0',
              kind: 'paragraf',
              type: 'PAR',
              span: [0, 4],
              content: [{ text: 'Corp', span: [0, 4] }],
            },
          ],
          marks: [],
        };
    await q(`insert into legal_v2.unit_render values ($1, 0, $2, 0, $3, 'public')`, [
      unit,
      JSON.stringify(first),
      header ? end : 4,
    ]);
    if (!header)
      await q(`insert into legal_v2.unit_render values ($1, 1, $2, 4, $3, 'public')`, [
        unit,
        JSON.stringify({ blocks: [article], marks }),
        end,
      ]);
    await q(
      `insert into legal_v2.unit_provisions (unit_id, provision_seq, kind, citation_path,
        address_state, label_raw, source_element_id, char_start, char_end, address, content_key)
      values ($1, $2, 'articol', 'art:1', 'unique', $3, 'id_art1', $4, $5, 'art:1', $6)`,
      [
        unit,
        header ? 0 : 1,
        header ? 'Antet' : 'Articolul 1',
        start,
        end,
        header ? 'k1:header' : 'k1:article',
      ]
    );
    await q(
      `insert into legal_v2.unit_links (unit_id, ordinal, href, target_page_id, target_route, target_fragment, char_start, char_end)
      values ($1, 0, $2, $3, $4, $5, $6, $7)`,
      [
        unit,
        header ? portalUrl('5108') : '#id_art1',
        header ? '5108' : null,
        header ? 'afis' : null,
        header ? null : 'id_art1',
        header ? 0 : 5,
        header ? 5 : 8,
      ]
    );
    await q(`insert into legal_v2.unit_assets values ($1, 0, null, $2, 'image', $3)`, [
      unit,
      slot,
      header ? 'restricted' : 'public',
    ]);
  }
  await q(`insert into legal_v2.asset_custody values ('body', true, $1, 'public')`, [sha('image')]);
  await q(
    `insert into legal_v2.form_current values (106, legal_v2.composition_digest(106), 1, 'public')`
  );
};
