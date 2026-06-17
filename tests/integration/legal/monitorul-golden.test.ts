/**
 * Monitorul-Oficial golden + tri-surface tests against LIVE transparenta_prod
 * (read-only). Verified 2026-06-17 numbers:
 *   - legal.mo_issues 42,173 · mo_act_publications 150,666 · mo_lifecycle_edges 15,385.
 *   - Golden act 25592 (Legea nr. 334/2006): 2 publications, 11 MO in-edges,
 *     11 MO status events (promulgare 1 / rectificare 9 / republicare 1).
 *   - Issue 10245 = PI / label 632 / 2006-07-21.
 *
 * Exercises: the LegalAct.gazette* extension resolving, GraphQL≡MCP parity for
 * find_act_publications + get_act_gazette_timeline, browse + aggregate coverage,
 * and (critically) that the portal legal slice STILL builds alongside the MO
 * extensions. Skips cleanly when PROD_DATABASE_URL is absent.
 */

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildRedesignApp } from '@/app/build-redesign-app.js';
import { loadRedesignConfig } from '@/infra/config/redesign-env.js';

import type { FastifyInstance } from 'fastify';

const HAS_DB = (process.env['PROD_DATABASE_URL'] ?? '').length > 0;
const ACT = '25592'; // Legea nr. 334/2006
const ISSUE = '10245';

const d = HAS_DB ? describe : describe.skip;

let app: FastifyInstance;
let close: () => Promise<void>;
let pool: Pool;

const onUncaught = (err: unknown): void => {
  if (err instanceof Error && err.message.includes('destroySoon')) return;
  throw err;
};

interface GqlResponse<TData> {
  readonly data?: TData;
  readonly errors?: unknown;
}
interface JsonRpcResponse {
  readonly result?: { readonly structuredContent?: unknown; readonly content?: readonly { readonly text?: string }[] };
}

const gql = async <TData>(query: string, variables?: Record<string, unknown>): Promise<GqlResponse<TData>> => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/graphql',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ query, variables }),
  });
  return res.json();
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

const expectData = <TData>(res: GqlResponse<TData>): TData => {
  expect(res.errors).toBeUndefined();
  expect(res.data).toBeDefined();
  return res.data as TData;
};

d('Monitorul-Oficial golden (live prod)', () => {
  beforeAll(async () => {
    const built = await buildRedesignApp({
      kernelConfig: loadRedesignConfig(process.env).kernel,
      logLevel: 'silent',
      modules: ['legal'],
    });
    app = built.app;
    close = built.app.close.bind(built.app);
    await app.ready();
    const connectionString = (process.env['PROD_DATABASE_URL'] ?? '').replace(/[?&]sslmode=[a-z-]+/iu, '');
    pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });
    process.on('uncaughtException', onUncaught);
  }, 60_000);

  afterAll(async () => {
    await close?.();
    await pool?.end();
    await new Promise((resolve) => setTimeout(resolve, 50));
    process.off('uncaughtException', onUncaught);
  });

  it('mo_* table counts match the verified serving numbers', async () => {
    const r = await pool.query<{ t: string; c: string }>(
      `select 'issues' t, count(*)::text c from legal.mo_issues
       union all select 'pubs', count(*)::text from legal.mo_act_publications
       union all select 'edges', count(*)::text from legal.mo_lifecycle_edges
       union all select 'mo_status', count(*)::text from legal.act_status_events where event_source='monitorul-oficial'`
    );
    const m = new Map(r.rows.map((x) => [x.t, Number(x.c)]));
    expect(m.get('issues')).toBe(42173);
    expect(m.get('pubs')).toBe(150666);
    expect(m.get('edges')).toBe(15385);
    expect(m.get('mo_status')).toBe(9522);
  }, 30_000);

  it('the portal legal slice STILL builds (legalActs resolves alongside MO)', async () => {
    const data = expectData(
      await gql<{ legalActs: { edges: { node: { actId: string } }[] } }>(
        `{ legalActs(first:1){ edges{ node{ actId } } } }`
      )
    );
    expect(data.legalActs.edges).toHaveLength(1);
    expect(data.legalActs.edges[0]?.node.actId).toBe('105735'); // Legea 47/1992
  });

  it('LegalAct.gazette* extension resolves for act 25592', async () => {
    const data = expectData(
      await gql<{
        legalAct: {
          actId: string;
          displayCitation: string;
          gazettePublications: { moActKey: string; resolution: string; actId: string | null }[];
          gazetteStatusEvents: { eventKind: string }[];
          gazetteInEdges: { relation: string; resolution: string }[];
        } | null;
      }>(
        `query($actId: BigInt!){
          legalAct(actId:$actId){
            actId displayCitation
            gazettePublications{ moActKey resolution actId }
            gazetteStatusEvents{ eventKind }
            gazetteInEdges{ relation resolution }
          }
        }`,
        { actId: ACT }
      )
    );
    const act = data.legalAct;
    expect(act?.displayCitation).toBe('Legea nr. 334/2006');
    expect(act?.gazettePublications).toHaveLength(2);
    for (const p of act?.gazettePublications ?? []) expect(p.actId).toBe(ACT);
    expect(act?.gazetteStatusEvents).toHaveLength(11);
    expect(act?.gazetteInEdges).toHaveLength(11);
    // promulgare 1 / rectificare 9 / republicare 1 (verified).
    const kinds = (act?.gazetteStatusEvents ?? []).map((e) => e.eventKind);
    expect(kinds.filter((k) => k === 'promulgare')).toHaveLength(1);
    expect(kinds.filter((k) => k === 'rectificare')).toHaveLength(9);
    expect(kinds.filter((k) => k === 'republicare')).toHaveLength(1);
  });

  it('gazette counts agree with raw SQL', async () => {
    const pubs = await pool.query<{ c: string }>(
      `select count(*)::text c from legal.mo_act_publications where act_id=$1`,
      [ACT]
    );
    const edges = await pool.query<{ c: string }>(
      `select count(*)::text c from legal.mo_lifecycle_edges where target_act_id=$1`,
      [ACT]
    );
    const events = await pool.query<{ c: string }>(
      `select count(*)::text c from legal.act_status_events where act_id=$1 and event_source='monitorul-oficial'`,
      [ACT]
    );
    expect(Number(pubs.rows[0]?.c)).toBe(2);
    expect(Number(edges.rows[0]?.c)).toBe(11);
    expect(Number(events.rows[0]?.c)).toBe(11);
  });

  it('GraphQL gazettePublications ≡ MCP find_act_publications (tri-surface)', async () => {
    const graph = expectData(
      await gql<{ legalAct: { gazettePublications: { moActKey: string }[] } | null }>(
        `query($actId: BigInt!){ legalAct(actId:$actId){ gazettePublications{ moActKey } } }`,
        { actId: ACT }
      )
    );
    const mcp = await mcpCall<{ ok: boolean; items: { moActKey: string }[] }>('find_act_publications', { actId: ACT });
    expect(mcp.ok).toBe(true);
    const graphKeys = new Set((graph.legalAct?.gazettePublications ?? []).map((p) => p.moActKey));
    const mcpKeys = new Set(mcp.items.map((p) => p.moActKey));
    expect(mcpKeys).toEqual(graphKeys);
  });

  it('get_act_gazette_timeline counts split status-events vs edges (§8.3)', async () => {
    const mcp = await mcpCall<{
      ok: boolean;
      summary: string;
      item: { statusEvents: { eventKind: string }[]; inEdges: { relation: string }[]; confidence: string };
    }>('get_act_gazette_timeline', { actId: ACT });
    expect(mcp.ok).toBe(true);
    expect(mcp.item.confidence).toBe('deterministic');
    // 1 promulgare status event; respinge count from edges (0 for this act).
    expect(mcp.item.statusEvents.filter((e) => e.eventKind === 'promulgare')).toHaveLength(1);
    expect(mcp.summary).toContain('promulgation');
  });

  it('moIssue 10245 = Partea I, label 632, 2006-07-21', async () => {
    const data = expectData(
      await gql<{ moIssue: { partCode: string; issueLabel: string; issueDate: string | null; moPart: number | null } | null }>(
        `query($id: BigInt!){ moIssue(moIssueId:$id){ partCode issueLabel issueDate moPart } }`,
        { id: ISSUE }
      )
    );
    expect(data.moIssue?.partCode).toBe('PI');
    expect(data.moIssue?.issueLabel).toBe('632');
    expect(data.moIssue?.issueDate).toBe('2006-07-21');
    expect(data.moIssue?.moPart).toBe(1);
  });

  it('moIssues browse requires a year (bounded) and returns coverage shape', async () => {
    const data = expectData(
      await gql<{ moIssues: { total: number; edges: { node: { issueYear: number } }[] } }>(
        `{ moIssues(filter:{year:{eq:2006}}, pageSize:3){ total edges{ node{ issueYear } } } }`
      )
    );
    expect(data.moIssues.total).toBeGreaterThan(0);
    for (const e of data.moIssues.edges) expect(e.node.issueYear).toBe(2006);
  });

  it('count_mo_publications_by_issuer is deterministic and matches raw SQL', async () => {
    const mcp = await mcpCall<{
      ok: boolean;
      item: { denominator: number; confidence: string };
    }>('count_mo_publications_by_issuer', { year: 2006, groupBy: 'act_type' });
    expect(mcp.ok).toBe(true);
    expect(mcp.item.confidence).toBe('deterministic');
    const raw = await pool.query<{ c: string }>(
      `select count(*)::text c from legal.mo_act_publications where issue_year = 2006`
    );
    expect(mcp.item.denominator).toBe(Number(raw.rows[0]?.c));
  }, 30_000);

  it('matchedVia DB value act-year surfaces as the GraphQL alias act_year', async () => {
    const data = expectData(
      await gql<{ moPublications: { edges: { node: { matchedVia: string | null } }[] } }>(
        `{ moPublications(filter:{actId:{eq:"${ACT}"}}, first:2){ edges{ node{ matchedVia } } } }`
      )
    );
    const vias = data.moPublications.edges.map((e) => e.node.matchedVia);
    // none should be the raw hyphenated DB value
    for (const v of vias) expect(v).not.toBe('act-year');
    expect(vias).toContain('act_year');
  });

  it('mo publications list rejects a query with no bounding predicate', async () => {
    const res = await gql<{ moPublications: unknown }>(
      `{ moPublications(filter:{ resolution:{ in:["unique"] } }, first:3){ edges{ node{ moActKey } } } }`
    );
    // bounding predicate enforced → an InvalidInput GraphQL error.
    expect(res.errors).toBeDefined();
  });

  it('moIssues without a year is an InvalidInput error, not an empty success (Codex #7)', async () => {
    const res = await gql<{ moIssues: unknown }>(`{ moIssues{ total edges{ node{ moIssueId } } } }`);
    expect(res.errors).toBeDefined();
  });

  it('aggregate denominator equals the true filtered total even when groups > 100', async () => {
    // grouping by issuer over a busy year exceeds the 100-group cap; the denominator
    // must still be the exact count(*), not the capped-group sum (Codex #1).
    const mcp = await mcpCall<{ ok: boolean; item: { items: unknown[]; denominator: number } }>(
      'count_mo_publications_by_issuer',
      { year: 2020, groupBy: 'issuer' }
    );
    const raw = await pool.query<{ c: string; g: string }>(
      `select count(*)::text c, count(distinct issuer_slug)::text g
       from legal.mo_act_publications where issue_year = 2020`
    );
    expect(mcp.item.denominator).toBe(Number(raw.rows[0]?.c));
    // sanity: the grouped rows are capped at 100 while distinct issuers may exceed it.
    expect(mcp.item.items.length).toBeLessThanOrEqual(100);
  }, 30_000);

  it('Entity.monitorul resolves null gracefully for a non-issuer CUI (best-effort)', async () => {
    const data = expectData(
      await gql<{ entity: { monitorul: { publicationCount: number } | null } | null }>(
        `{ entity(cui:"4221306"){ monitorul{ publicationCount } } }`
      )
    );
    // a typical company CUI has no MO issuer match → null, never an error.
    expect(data.entity?.monitorul ?? null).toBeNull();
  });
});
