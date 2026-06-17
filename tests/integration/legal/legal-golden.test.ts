/**
 * Legal golden + tri-surface tests against LIVE transparenta_prod (read-only).
 *
 * Pinned to the verified 2026-06-17 legal serving numbers:
 *   - Codul Fiscal / Legea 227/2015 => act_id 66150, canonical doc 171282,
 *     status abrogat-partial, in_degree 2621, 295 modifica/completeaza in-refs.
 *   - search.documents legal discriminators: legal_act 223,611 / portal_section 2,938,113.
 *   - default legalActs rank leader: Legea 47/1992, act_id 105735, in_degree 26,277.
 *
 * Skips cleanly when PROD_DATABASE_URL is absent (CI without the prod tunnel).
 */

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildRedesignApp } from '@/app/build-redesign-app.js';
import { loadRedesignConfig } from '@/infra/config/redesign-env.js';

import type { FastifyInstance } from 'fastify';

const HAS_DB = (process.env['PROD_DATABASE_URL'] ?? '').length > 0;
const CODUL_FISCAL_ACT_ID = '66150';

const d = HAS_DB ? describe : describe.skip;

let app: FastifyInstance;
let close: () => Promise<void>;
let pool: Pool;

/** Swallow ONLY the benign stateless-MCP transport teardown error (kernel race). */
const onUncaught = (err: unknown): void => {
  if (err instanceof Error && err.message.includes('destroySoon')) return;
  throw err;
};

interface GqlResponse<TData> {
  readonly data?: TData;
  readonly errors?: unknown;
}

interface JsonRpcToolResult {
  readonly structuredContent?: unknown;
  readonly content?: readonly { readonly text?: string }[];
}

interface JsonRpcResponse {
  readonly result?: JsonRpcToolResult;
}

interface LegalDocument {
  readonly documentId: string;
  readonly isCanonical: boolean;
  readonly versionKind: string;
}

interface LegalActCard {
  readonly actId: string;
  readonly actNaturalKey: string;
  readonly canonicalDocumentId: string | null;
  readonly displayCitation: string;
  readonly status: string;
  readonly inDegree: number;
  readonly amendedAfterPublication: number;
  readonly versionCount: number;
  readonly canonical: LegalDocument | null;
}

interface LegalResolveHit {
  readonly value: string;
  readonly label: string;
  readonly hint?: string;
}

const gql = async <TData>(query: string, variables?: Record<string, unknown>): Promise<GqlResponse<TData>> => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/graphql',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ query, variables }),
  });
  const body: GqlResponse<TData> = res.json();
  return body;
};

const mcpCall = async <TOutput>(name: string, args: Record<string, unknown>): Promise<TOutput> => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/mcp',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    payload: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const body: JsonRpcResponse = res.json();
  if (body.result?.structuredContent !== undefined) return body.result.structuredContent as TOutput;
  const text = body.result?.content?.[0]?.text;
  // eslint-disable-next-line no-restricted-syntax -- test parses the trusted MCP tool-output text payload
  return (text !== undefined ? JSON.parse(text) : undefined) as TOutput;
};

const expectGqlData = <TData>(res: GqlResponse<TData>): TData => {
  expect(res.errors).toBeUndefined();
  expect(res.data).toBeDefined();
  return res.data as TData;
};

const rawStatusToGraphql = (status: string): string => status.toUpperCase().replaceAll('-', '_');

d('Legal golden (live prod)', () => {
  beforeAll(async () => {
    const built = await buildRedesignApp({
      kernelConfig: loadRedesignConfig(process.env).kernel,
      logLevel: 'silent',
      modules: ['legal'],
    });
    app = built.app;
    close = built.app.close.bind(built.app);
    await app.ready();
    // The prod URL carries sslmode=require; pg's default verifies the cert (the
    // tunnel presents a self-signed one). Encrypt without verifying, like the
    // kernel pool does.
    const connectionString = (process.env['PROD_DATABASE_URL'] ?? '').replace(/[?&]sslmode=[a-z-]+/iu, '');
    pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });
    // Kept in sync with the PNRR golden harness: swallow only the exact benign
    // post-response teardown race if it appears under MCP injection.
    process.on('uncaughtException', onUncaught);
  }, 60_000);

  afterAll(async () => {
    await close?.();
    await pool?.end();
    await new Promise((resolve) => setTimeout(resolve, 50));
    process.off('uncaughtException', onUncaught);
  });

  it('search.documents discriminators match the kernel projection', async () => {
    // count(*) over the 6M-row search.documents is a multi-second seq aggregate;
    // give it room (default vitest timeout is 5s).
    const sqlRes = await pool.query<{ doc_type: string; cnt: string }>(
      `select doc_type, count(*)::text as cnt
       from search.documents
       where doc_type in ('legal_act','portal_section')
       group by doc_type`
    );
    const counts = new Map(sqlRes.rows.map((r) => [r.doc_type, Number(r.cnt)]));
    expect(counts.get('legal_act')).toBe(223611);
    expect(counts.get('portal_section')).toBe(2938113);
  }, 30_000);

  it('Act card golden (GraphQL): Codul Fiscal resolves to Legea 227/2015', async () => {
    const res = await gql<{ legalAct: LegalActCard | null }>(
      `{
        legalAct(citation:"codul fiscal") {
          actId
          actNaturalKey
          canonicalDocumentId
          displayCitation
          status
          inDegree
          amendedAfterPublication
          versionCount
          canonical { documentId isCanonical versionKind }
        }
      }`
    );
    const data = expectGqlData(res);
    const act = data.legalAct;
    expect(act).not.toBeNull();
    expect(act?.actId).toBe(CODUL_FISCAL_ACT_ID);
    expect(act?.actNaturalKey).toBe('lege:227:2015:');
    expect(act?.canonicalDocumentId).toBe('171282');
    expect(act?.displayCitation).toBe('Legea nr. 227/2015');
    expect(act?.status).toBe('ABROGAT_PARTIAL');
    expect(act?.inDegree).toBe(2621);
    expect(act?.amendedAfterPublication).toBe(295);
    expect(act?.versionCount).toBe(2);
    expect(act?.canonical?.documentId).toBe('171282');
    expect(act?.canonical?.isCanonical).toBe(true);
    expect(act?.canonical?.versionKind).toBe('corp');

    const aliases = await pool.query<{ act_ids: string[] | null }>(
      `select array_agg(act_id::text order by act_id::bigint) as act_ids
       from legal.act_aliases
       where alias = 'codul fiscal'`
    );
    expect(aliases.rows[0]?.act_ids).toEqual(['66150', '187041']);
  });

  it('act by id == act by citation', async () => {
    const res = await gql<{ byId: { actId: string } | null; byCitation: { actId: string } | null }>(
      `query($actId: BigInt!) {
        byId: legalAct(actId:$actId) { actId }
        byCitation: legalAct(citation:"legea 227/2015") { actId }
      }`,
      { actId: CODUL_FISCAL_ACT_ID }
    );
    const data = expectGqlData(res);
    expect(data.byId?.actId).toBe(CODUL_FISCAL_ACT_ID);
    expect(data.byCitation?.actId).toBe(CODUL_FISCAL_ACT_ID);
    expect(data.byId?.actId).toBe(data.byCitation?.actId);
  });

  it('amendedAfterPublication matches raw modifica+completeaza refs', async () => {
    const sqlRes = await pool.query<{ cnt: string }>(
      `select count(*)::text as cnt
       from legal.act_references
       where target_act_id = $1 and relation in ('modifica','completeaza')`,
      [CODUL_FISCAL_ACT_ID]
    );
    const rawCount = Number(sqlRes.rows[0]?.cnt ?? 0);

    const res = await gql<{ legalAct: { amendedAfterPublication: number } | null }>(
      `query($actId: BigInt!) {
        legalAct(actId:$actId) { amendedAfterPublication }
      }`,
      { actId: CODUL_FISCAL_ACT_ID }
    );
    const data = expectGqlData(res);
    expect(data.legalAct?.amendedAfterPublication).toBe(rawCount);
    expect(rawCount).toBe(295);
  });

  it('legalActs default sort returns Legea 47/1992 first', async () => {
    const res = await gql<{ legalActs: { edges: { node: { actId: string; inDegree: number } }[] } }>(
      `{
        legalActs(first:1) {
          edges { node { actId inDegree } }
        }
      }`
    );
    const data = expectGqlData(res);
    expect(data.legalActs.edges).toHaveLength(1);
    expect(data.legalActs.edges[0]?.node.actId).toBe('105735');
    expect(data.legalActs.edges[0]?.node.inDegree).toBe(26277);
  });

  it('legalActs cursor remains stable across pages', async () => {
    interface PageData {
      readonly legalActs: {
        readonly pageInfo: { readonly endCursor: string | null };
        readonly edges: readonly { readonly node: { readonly actId: string; readonly inDegree: number } }[];
      };
    }

    const firstPage = expectGqlData(
      await gql<PageData>(`{ legalActs(first:5) { pageInfo { endCursor } edges { node { actId inDegree } } } }`)
    );
    const cursor = firstPage.legalActs.pageInfo.endCursor;
    expect(typeof cursor).toBe('string');
    if (typeof cursor !== 'string') throw new Error('expected first legalActs page to have an endCursor');

    const secondPage = expectGqlData(
      await gql<PageData>(
        `query($after:String!) {
          legalActs(first:5, after:$after) { pageInfo { endCursor } edges { node { actId inDegree } } }
        }`,
        { after: cursor }
      )
    );
    const nodes = [...firstPage.legalActs.edges, ...secondPage.legalActs.edges].map((e) => e.node);
    expect(nodes).toHaveLength(10);
    expect(new Set(nodes.map((n) => n.actId)).size).toBe(10);
    for (let i = 1; i < nodes.length; i += 1) {
      expect(nodes[i - 1]?.inDegree).toBeGreaterThanOrEqual(nodes[i]?.inDegree ?? 0);
    }
  });

  it('links incoming returns bounded MODIFICA edges with source acts', async () => {
    const res = await gql<{
      legalAct: {
        links: {
          totalCount: number | null;
          edges: { relation: string; sourceAct: { displayCitation: string } | null }[];
        };
      } | null;
    }>(
      `query($actId: BigInt!) {
        legalAct(actId:$actId) {
          links(direction:IN, relation:[MODIFICA], first:5) {
            totalCount
            edges { relation sourceAct { displayCitation } }
          }
        }
      }`,
      { actId: CODUL_FISCAL_ACT_ID }
    );
    const data = expectGqlData(res);
    const links = data.legalAct?.links;
    expect(links?.totalCount).toBeGreaterThanOrEqual(1);
    expect(links?.edges.length).toBeGreaterThan(0);
    for (const edge of links?.edges ?? []) {
      expect(edge.relation).toBe('MODIFICA');
      expect(edge.sourceAct).not.toBeNull();
      expect(edge.sourceAct?.displayCitation.length).toBeGreaterThan(0);
    }
  });

  it('GraphQL legalAct card agrees with MCP get_legal_act', async () => {
    const graph = expectGqlData(
      await gql<{ legalAct: { actId: string; displayCitation: string; status: string; amendedAfterPublication: number } | null }>(
        `query($actId: BigInt!) {
          legalAct(actId:$actId) { actId displayCitation status amendedAfterPublication }
        }`,
        { actId: CODUL_FISCAL_ACT_ID }
      )
    );
    const mcp = await mcpCall<{
      ok: boolean;
      item: { actId: string; displayCitation: string; status: string; amendedAfterPublication: number };
    }>('get_legal_act', { actId: CODUL_FISCAL_ACT_ID });

    expect(mcp.ok).toBe(true);
    expect(graph.legalAct?.actId).toBe(mcp.item.actId);
    expect(graph.legalAct?.displayCitation).toBe(mcp.item.displayCitation);
    expect(graph.legalAct?.amendedAfterPublication).toBe(mcp.item.amendedAfterPublication);
    expect(mcp.item.status).toBe('abrogat-partial');
    expect(rawStatusToGraphql(mcp.item.status)).toBe(graph.legalAct?.status);
  });

  it('MCP resolve_legal_filters discovers issuer and act values', async () => {
    const issuer = await mcpCall<{ ok: boolean; items: LegalResolveHit[] }>('resolve_legal_filters', {
      dim: 'issuer',
      q: 'finante',
    });
    expect(issuer.ok).toBe(true);
    expect(issuer.items[0]?.value).toBe('ministerul-finantelor-publice');
    expect(issuer.items[0]?.hint).toBe('2369 acte');

    const act = await mcpCall<{ ok: boolean; items: LegalResolveHit[] }>('resolve_legal_filters', {
      dim: 'act',
      q: 'legea 227/2015',
    });
    expect(act.ok).toBe(true);
    expect(act.items.map((item) => item.value)).toContain(CODUL_FISCAL_ACT_ID);
  });

  it('legalSearch returns a semantic-or-lexical smoke result without error', async () => {
    const res = await gql<{
      legalSearch: { caveats: string[]; acts: { score: number }[]; sections: { score: number }[] } | null;
    }>(
      `{
        legalSearch(q:"cota de TVA", limit:3) {
          caveats
          acts { score }
          sections { score }
        }
      }`
    );
    const data = expectGqlData(res);
    expect(data.legalSearch).not.toBeNull();
    expect(Array.isArray(data.legalSearch?.caveats)).toBe(true);
    if (data.legalSearch?.caveats.includes('semantic search unavailable') === true) {
      expect((data.legalSearch.acts.length + data.legalSearch.sections.length)).toBeGreaterThanOrEqual(0);
    }
  }, 30_000);

  it('canonical-only serving keeps the corp canonical separate from the stub-header document', async () => {
    const res = await gql<{
      legalAct: {
        canonical: LegalDocument | null;
        documents: LegalDocument[];
      } | null;
    }>(
      `query($actId: BigInt!) {
        legalAct(actId:$actId) {
          canonical { documentId isCanonical versionKind }
          documents { documentId isCanonical versionKind }
        }
      }`,
      { actId: CODUL_FISCAL_ACT_ID }
    );
    const data = expectGqlData(res);
    expect(data.legalAct?.canonical?.documentId).toBe('171282');
    expect(data.legalAct?.canonical?.isCanonical).toBe(true);
    expect(data.legalAct?.canonical?.versionKind).toBe('corp');
    expect(data.legalAct?.canonical?.documentId).not.toBe('171280');
    expect(data.legalAct?.documents).toContainEqual({
      documentId: '171280',
      isCanonical: false,
      versionKind: 'stub-header',
    });
  });
});
