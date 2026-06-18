/**
 * Procurement golden + tri-surface tests against LIVE transparenta_prod (read-only).
 *
 * Pinned to verified live facts (2026-06-17):
 *   - grain gate: direct_acquisition {filters:t, spend:t, region:f};
 *     procurement_contract {filters:f, spend:f, region:f}
 *   - known DA edge: authority 29170968 (GRADINITA PP NR 23 PLOIESTI) ↔ supplier
 *     28022254 (Miralis Impex) is the #1 supplier by value AND flow count
 *   - cpv_divisions = 45 rows
 *
 * Tri-surface: GraphQL `procurementTopSuppliers` == MCP `rank_procurement_suppliers`
 * == raw SQL over the org_edge MV (the same grain, different surfaces). Skips
 * cleanly when PROD_DATABASE_URL is absent (CI without the tunnel).
 */

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildRedesignApp } from '@/app/build-redesign-app.js';
import { loadRedesignConfig } from '@/infra/config/redesign-env.js';

import type { FastifyInstance } from 'fastify';

const HAS_DB = (process.env['PROD_DATABASE_URL'] ?? '').length > 0;
const AUTHORITY = '29170968';
const SUPPLIER = '28022254';

const d = HAS_DB ? describe : describe.skip;

let app: FastifyInstance;
let pool: Pool;

const onUncaught = (err: unknown): void => {
  if (err instanceof Error && err.message.includes('destroySoon')) return;
  throw err;
};

interface GqlResponse {
  readonly data?: Record<string, unknown>;
  readonly errors?: readonly { readonly extensions?: { readonly code?: string } }[];
}

const gql = async (query: string, variables?: Record<string, unknown>): Promise<GqlResponse> => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/graphql',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ query, variables }),
  });
  return res.json();
};

interface McpToolResult {
  readonly ok: boolean;
  readonly error?: string;
  readonly items?: readonly Record<string, unknown>[];
}

const mcpCall = async (name: string, args: Record<string, unknown>): Promise<McpToolResult> => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/mcp',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    payload: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
  // eslint-disable-next-line no-restricted-syntax -- test parses a trusted MCP JSON-RPC body
  const body = JSON.parse(res.body) as {
    result?: { structuredContent?: McpToolResult; content?: { text?: string }[] };
  };
  if (body.result?.structuredContent !== undefined) return body.result.structuredContent;
  const text = body.result?.content?.[0]?.text;
  // eslint-disable-next-line no-restricted-syntax -- trusted MCP tool-output payload
  return text !== undefined ? (JSON.parse(text) as McpToolResult) : { ok: false };
};

/** Narrow a value to a record (the GraphQL data shapes are dynamic but trusted). */
const rec = (v: unknown): Record<string, unknown> => v as Record<string, unknown>;
const arr = (v: unknown): readonly unknown[] => v as readonly unknown[];

d('Procurement golden (live prod)', () => {
  beforeAll(async () => {
    const config = loadRedesignConfig(process.env);
    const built = await buildRedesignApp({
      kernelConfig: config.kernel,
      modules: ['procurement'],
      logLevel: 'silent',
    });
    app = built.app;
    await app.ready();
    const connectionString = (process.env['PROD_DATABASE_URL'] ?? '').replace(
      /[?&]sslmode=[a-z-]+/iu,
      ''
    );
    pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });
    process.on('uncaughtException', onUncaught);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    await new Promise((resolve) => setTimeout(resolve, 50));
    process.off('uncaughtException', onUncaught);
  });

  it('grain gate matches the live gate booleans', async () => {
    const res = await gql(
      `{ procurementGrainQuality { grain filterAnswersAllowed spendRankingsAllowed supplierRegionFiltersAllowed } }`
    );
    expect(res.errors).toBeUndefined();
    const rows = arr(res.data?.['procurementGrainQuality']).map(rec);
    const byGrain = new Map(rows.map((g) => [g['grain'] as string, g]));
    const da = byGrain.get('direct_acquisition');
    const pc = byGrain.get('procurement_contract');
    expect(da?.['filterAnswersAllowed']).toBe(true);
    expect(da?.['spendRankingsAllowed']).toBe(true);
    expect(da?.['supplierRegionFiltersAllowed']).toBe(false);
    expect(pc?.['filterAnswersAllowed']).toBe(false);
    expect(pc?.['spendRankingsAllowed']).toBe(false); // contract spend gate-suppressed
  });

  it('tri-surface: GraphQL topSuppliers == MCP rank == raw SQL over the org_edge MV', async () => {
    const sqlRes = await pool.query<{ supplier_cui: string; fc: string; amt: string }>(
      `select supplier_cui, sum(flow_count)::text fc, sum(amount_ron_sum)::text amt
       from procurement.org_edge_monthly_rollups
       where authority_cui = $1 and source_grain = 'direct_acquisition' and month_start >= '2011-07-01'
       group by supplier_cui order by sum(amount_ron_sum) desc nulls last limit 1`,
      [AUTHORITY]
    );
    const raw = sqlRes.rows[0];
    expect(raw?.supplier_cui).toBe(SUPPLIER);

    const g = await gql(
      `query($cui:CUI!){ procurementTopSuppliers(authorityCui:$cui, grain: direct_acquisition, topN: 1){ items { supplierCui flowCount amountRonSum } } }`,
      { cui: AUTHORITY }
    );
    const gTop = rec(arr(rec(g.data?.['procurementTopSuppliers'])['items'])[0]);
    expect(gTop['supplierCui']).toBe(raw?.supplier_cui);
    expect(gTop['flowCount']).toBe(raw?.fc);
    expect(gTop['amountRonSum']).toBe(raw?.amt);

    const mcp = await mcpCall('rank_procurement_suppliers', {
      authorityCui: AUTHORITY,
      grain: 'direct_acquisition',
      topN: 1,
    });
    expect(mcp.ok).toBe(true);
    expect(mcp.items?.[0]?.['supplierCui']).toBe(gTop['supplierCui']);
    expect(mcp.items?.[0]?.['flowCount']).toBe(gTop['flowCount']);
  }, 30_000);

  it('Entity.procurement == the contributor profile (parity §14.7)', async () => {
    const res = await gql(
      `query($cui:CUI!){ entity(cui:$cui){ procurement { asAuthority { daCount rankBasis } caveats } } }`,
      { cui: AUTHORITY }
    );
    expect(res.errors).toBeUndefined();
    const p = rec(rec(res.data?.['entity'])['procurement']);
    const role = rec(p['asAuthority']);
    expect(Number(role['daCount'])).toBeGreaterThan(0);
    expect((p['caveats'] as string[]).some((c) => c.includes('separate grains'))).toBe(true);
  }, 30_000);

  it('grain separation: contract spend totals are suppressed (never summed with DAs)', async () => {
    const res = await gql(
      `query($cui:CUI!){ entity(cui:$cui){ procurement { asAuthority { contractTotalRon daTotalRon } } } }`,
      { cui: AUTHORITY }
    );
    const role = rec(rec(rec(res.data?.['entity'])['procurement'])['asAuthority']);
    expect(role['contractTotalRon']).toBeNull(); // gate-suppressed → null, not summed in
  }, 30_000);

  it('§3a(1) guard: an unfiltered DA list is rejected (InvalidInput), a selective one is not', async () => {
    const bad = await gql(
      `{ procurementDirectAcquisitions(filter: {}, first: 3){ edges { node { daId } } } }`
    );
    expect(bad.errors?.[0]?.extensions?.code).toBe('INVALID_INPUT');

    const good = await gql(
      `query($cui:String!){ procurementDirectAcquisitions(filter: { authorityCui: { in: [$cui] } }, first: 3){ edges { node { daId } } } }`,
      { cui: AUTHORITY }
    );
    expect(good.errors).toBeUndefined();
    expect(arr(rec(good.data?.['procurementDirectAcquisitions'])['edges']).length).toBeGreaterThan(
      0
    );
  });

  it('§3a(1) guard (MCP surface): DA search with no selective filter is rejected', async () => {
    const mcp = await mcpCall('search_procurement_direct_acquisitions', {});
    expect(mcp.ok).toBe(false);
    expect(mcp.error).toContain('selective filter');
  });

  it('concentration (PC-5) is value-based for DA grain (spend allowed)', async () => {
    const res = await gql(
      `query($cui:CUI!){ procurementConcentration(authorityCui:$cui, grain: direct_acquisition){ basis supplierCount hhi totalRon } }`,
      { cui: AUTHORITY }
    );
    const c = rec(res.data?.['procurementConcentration']);
    expect(c['basis']).toBe('value');
    expect(c['supplierCount'] as number).toBeGreaterThan(0);
    expect(c['totalRon']).not.toBeNull();
  }, 30_000);

  it('cpv divisions catalog is the reliable 45-row hierarchy', async () => {
    const res = await gql(`{ procurementCpvDivisions { code labelEn } }`);
    expect(arr(res.data?.['procurementCpvDivisions'])).toHaveLength(45);
  });

  it('cursor pagination over DAs works without a COUNT (page 1 → page 2 distinct)', async () => {
    const p1 = await gql(
      `query($cui:String!){ procurementDirectAcquisitions(filter: { authorityCui: { in: [$cui] } }, first: 2){ edges { node { daId } cursor } pageInfo { hasNextPage endCursor } } }`,
      { cui: AUTHORITY }
    );
    const conn1 = rec(p1.data?.['procurementDirectAcquisitions']);
    const edges1 = arr(conn1['edges']).map(rec);
    expect(edges1.length).toBe(2);
    const pageInfo1 = rec(conn1['pageInfo']);
    if (pageInfo1['hasNextPage'] === true) {
      const p2 = await gql(
        `query($cui:String!,$after:String!){ procurementDirectAcquisitions(filter: { authorityCui: { in: [$cui] } }, first: 2, after: $after){ edges { node { daId } } } }`,
        { cui: AUTHORITY, after: pageInfo1['endCursor'] as string }
      );
      expect(p2.errors).toBeUndefined();
      const ids1 = edges1.map((e) => rec(e['node'])['daId']);
      const ids2 = arr(rec(p2.data?.['procurementDirectAcquisitions'])['edges']).map(
        (e) => rec(rec(e)['node'])['daId']
      );
      expect(ids1.filter((id) => ids2.includes(id))).toHaveLength(0);
    }
  }, 30_000);

  it('a cursor minted under one filter is rejected against another (fhash bind)', async () => {
    const p1 = await gql(
      `query($cui:String!){ procurementDirectAcquisitions(filter: { authorityCui: { in: [$cui] } }, first: 2){ pageInfo { endCursor hasNextPage } } }`,
      { cui: AUTHORITY }
    );
    const cursor = rec(rec(p1.data?.['procurementDirectAcquisitions'])['pageInfo'])['endCursor'];
    if (typeof cursor === 'string') {
      const replay = await gql(
        `query($cui:String!,$after:String!){ procurementDirectAcquisitions(filter: { authorityCui: { in: [$cui] }, cpvDivision: { in: ["45"] } }, first: 2, after: $after){ edges { node { daId } } } }`,
        { cui: AUTHORITY, after: cursor }
      );
      expect(replay.errors?.[0]?.extensions?.code).toBe('INVALID_INPUT');
    }
  }, 30_000);
});
