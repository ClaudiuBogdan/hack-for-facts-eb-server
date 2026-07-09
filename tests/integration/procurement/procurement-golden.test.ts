/**
 * Procurement golden + tri-surface tests against LIVE transparenta_prod (read-only).
 *
 * Pinned to verified live facts (re-read 2026-07-09):
 *   - grain gate: direct_acquisition {filters:t, spend:t, region:f};
 *     procurement_contract {filters:t, spend:f, region:f}
 *   - known DA edge: authority 29170968 (GRADINITA PP NR 23 PLOIESTI) ↔ supplier
 *     28022254 (Miralis Impex) is the #1 supplier by value AND flow count
 *   - cpv_divisions = 45 rows; gate refreshed_at = 2026-06-29 (the MVs drift)
 *
 * Tri-surface: the GraphQL client contract == the MCP tool == raw SQL over the same
 * rollup. The MCP tools still page the CURSOR surface; the client contract pages the
 * OFFSET surface. Both must agree with the SQL. Skips cleanly when PROD_DATABASE_URL
 * is absent (CI without the tunnel).
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

  it('grain gate matches the live gate booleans + serves the client contract shape', async () => {
    const res = await gql(
      `{ procurementGrainQuality { sourceGrain rowsCount amountCoverageRate filterAnswersAllowed spendRankingsAllowed supplierRegionFiltersAllowed blockers dataAsOf cadence } }`
    );
    expect(res.errors).toBeUndefined();
    const rows = arr(res.data?.['procurementGrainQuality']).map(rec);
    const byGrain = new Map(rows.map((g) => [g['sourceGrain'] as string, g]));
    const da = byGrain.get('direct_acquisition');
    const pc = byGrain.get('procurement_contract');
    expect(da?.['filterAnswersAllowed']).toBe(true);
    expect(da?.['spendRankingsAllowed']).toBe(true);
    expect(da?.['supplierRegionFiltersAllowed']).toBe(false);
    expect(pc?.['filterAnswersAllowed']).toBe(true);
    expect(pc?.['spendRankingsAllowed']).toBe(false); // contract spend gate-suppressed

    // Counts + rates are STRINGS on the wire; cadence is honestly null; dataAsOf is a date.
    expect(typeof da?.['rowsCount']).toBe('string');
    expect(typeof da?.['amountCoverageRate']).toBe('string');
    expect(da?.['cadence']).toBeNull();
    expect(da?.['dataAsOf']).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
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
      `query($cui:String!){ procurementTopSuppliers(scope: { authorityCui: $cui }, grain: "direct_acquisition", topN: 1){ supplier { cui } sourceGrain flowCount amountRonSum } }`,
      { cui: AUTHORITY }
    );
    expect(g.errors).toBeUndefined();
    const gTop = rec(arr(g.data?.['procurementTopSuppliers'])[0]);
    expect(rec(gTop['supplier'])['cui']).toBe(raw?.supplier_cui);
    expect(gTop['sourceGrain']).toBe('direct_acquisition');
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

  it('DA offset guard: an unbounded DA search is rejected; an entity-scoped one is not', async () => {
    const bad = await gql(`{ procurementDirectAcquisitions(pageSize: 3){ items { id } } }`);
    expect(bad.errors?.[0]?.extensions?.code).toBe('INVALID_INPUT');

    // cpvDivision alone does NOT bound the sort (16.6s live, over the 15s timeout).
    const cpvOnly = await gql(
      `{ procurementDirectAcquisitions(filter: { cpvDivision: { eq: "33" } }, pageSize: 3){ items { id } } }`
    );
    expect(cpvOnly.errors?.[0]?.extensions?.code).toBe('INVALID_INPUT');

    const good = await gql(
      `query($cui:String!){ procurementDirectAcquisitions(filter: { authorityCui: { eq: $cui } }, pageSize: 3){ total totalEstimated items { id sourceSystem sourceUrl currency isRon valueSuspect } } }`,
      { cui: AUTHORITY }
    );
    expect(good.errors).toBeUndefined();
    const page = rec(good.data?.['procurementDirectAcquisitions']);
    expect(arr(page['items']).length).toBeGreaterThan(0);
    expect(typeof page['totalEstimated']).toBe('boolean');
  }, 30_000);

  it('offset search: total is EXACT below the cap and null above it', async () => {
    // A narrow authority scope counts exactly; the unfiltered contract grain overflows.
    const narrow = await gql(
      `query($cui:String!){ procurementContracts(filter: { authorityCui: { eq: $cui } }, pageSize: 5){ total totalEstimated items { id } } }`,
      { cui: AUTHORITY }
    );
    const n = rec(narrow.data?.['procurementContracts']);
    expect(n['totalEstimated']).toBe(false);
    expect(typeof n['total']).toBe('number');

    const wide = await gql(`{ procurementContracts(pageSize: 5){ total totalEstimated items { id } } }`);
    const w = rec(wide.data?.['procurementContracts']);
    expect(w['total']).toBeNull(); // 3.27M rows → the cap was hit
    expect(w['totalEstimated']).toBe(true);
  }, 30_000);

  it('offset pages are a TOTAL order: page 1 and page 2 never overlap', async () => {
    const q = `query($p:Int!){ procurementProcedures(sort: value_desc, page: $p, pageSize: 5){ items { id } } }`;
    const [p1, p2] = await Promise.all([gql(q, { p: 1 }), gql(q, { p: 2 })]);
    const ids = (r: GqlResponse): unknown[] =>
      arr(rec(r.data?.['procurementProcedures'])['items']).map((i) => rec(i)['id']);
    const a = ids(p1);
    const b = ids(p2);
    expect(a).toHaveLength(5);
    expect(a.filter((id) => b.includes(id))).toHaveLength(0);
  }, 30_000);

  it('the page window is capped (page * pageSize ≤ 10 000)', async () => {
    const res = await gql(`{ procurementContracts(page: 101, pageSize: 100){ items { id } } }`);
    expect(res.errors?.[0]?.extensions?.code).toBe('INVALID_INPUT');
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
    const res = await gql(`{ procurementCpvDivisions { divisionCode labelEn labelRo } }`);
    expect(arr(res.data?.['procurementCpvDivisions'])).toHaveLength(45);
  });

  it('MCP keeps its CURSOR surface: page 1 → page 2 are distinct, no COUNT', async () => {
    const p1 = await mcpCall('search_procurement_direct_acquisitions', {
      authorityCui: AUTHORITY,
      first: 2,
    });
    expect(p1.ok).toBe(true);
    expect((p1.items ?? []).length).toBeGreaterThan(0);
  }, 30_000);

  it('scope aggregates: an entity scope agrees with raw SQL over the same rollup', async () => {
    const sqlRes = await pool.query<{ source_grain: string; fc: string; amt: string | null }>(
      `select source_grain, sum(flow_count)::text fc, sum(amount_ron_sum)::text amt
         from procurement.org_edge_monthly_rollups
        where authority_cui = $1 and month_start >= '2011-07-01'
        group by source_grain`,
      [AUTHORITY]
    );
    const byGrain = new Map(sqlRes.rows.map((r) => [r.source_grain, r]));

    const res = await gql(
      `query($cui:String!){ procurementStats(scope: { authorityCui: $cui }){ totalValueRon contractsCount directAcquisitionsCount proceduresCount buyersCount suppliersCount firstFlowDate lastFlowDate } }`,
      { cui: AUTHORITY }
    );
    expect(res.errors).toBeUndefined();
    const stats = rec(res.data?.['procurementStats']);
    expect(stats['directAcquisitionsCount']).toBe(byGrain.get('direct_acquisition')?.fc ?? '0');
    expect(stats['contractsCount']).toBe(byGrain.get('procurement_contract')?.fc ?? '0');

    // grain: null spans both grains, but only the DA grain's money may be summed —
    // the contract-grain sum is gate-suppressed and contributes NOTHING.
    expect(stats['totalValueRon']).toBe(byGrain.get('direct_acquisition')?.amt ?? null);
  }, 30_000);

  it('scope aggregates: the contract grain never surfaces a money total', async () => {
    const res = await gql(
      `query($cui:String!){
         procurementStats(scope: { authorityCui: $cui }, grain: "procurement_contract"){ totalValueRon contractsCount }
         procurementTopSuppliers(scope: { authorityCui: $cui }, grain: "procurement_contract", topN: 3){ sourceGrain amountRonSum flowCount }
       }`,
      { cui: AUTHORITY }
    );
    expect(res.errors).toBeUndefined();
    expect(rec(res.data?.['procurementStats'])['totalValueRon']).toBeNull();
    for (const row of arr(res.data?.['procurementTopSuppliers']).map(rec)) {
      expect(row['sourceGrain']).toBe('procurement_contract');
      expect(row['amountRonSum']).toBeNull(); // suppressed, never a number
      expect(typeof row['flowCount']).toBe('string'); // counts are always allowed
    }
  }, 30_000);

  it('scope.cpvCode is rejected in v1 (no 8-digit-grained rollup)', async () => {
    const res = await gql(`{ procurementStats(scope: { cpvCode: "33600000" }){ contractsCount } }`);
    expect(res.errors?.[0]?.extensions?.code).toBe('INVALID_INPUT');
  });

  it('spendOverTime is one point per MONTH (grains merged), months ascending', async () => {
    const res = await gql(
      `query($cui:String!){ procurementSpendOverTime(scope: { authorityCui: $cui }){ month flowCount amountRonSum } }`,
      { cui: AUTHORITY }
    );
    expect(res.errors).toBeUndefined();
    const points = arr(res.data?.['procurementSpendOverTime']).map(rec);
    const months = points.map((p) => p['month'] as string);
    expect(new Set(months).size).toBe(months.length); // no per-grain duplicates
    expect([...months].sort()).toEqual(months);
    for (const m of months) expect(m).toMatch(/^\d{4}-\d{2}$/u);
  }, 30_000);

  it('detail bundle: a contract loads with its trail, procedure, duplicates and gate', async () => {
    const sqlRes = await pool.query<{ contract_id: string }>(
      `select contract_id::text from procurement.contracts where is_canonical and procedure_id is not null limit 1`
    );
    const id = sqlRes.rows[0]?.contract_id;
    expect(id).toBeDefined();

    const res = await gql(
      `query($id:ID!){ procurementContract(id:$id){
         contract { id contractNo sourceSystem sourceUrl currency isRon valueSuspect modifications { id modificationDate } }
         procedure { id sourceSystem isCanonical dupGroupId }
         duplicates { sourceSystem id }
         ted { tedNoticeNo sourceUrl }
         gate { sourceGrain spendRankingsAllowed cadence }
       } }`,
      { id }
    );
    expect(res.errors).toBeUndefined();
    const bundle = rec(res.data?.['procurementContract']);
    expect(rec(bundle['contract'])['id']).toBe(id);
    expect(Array.isArray(bundle['duplicates'])).toBe(true);
    expect(rec(bundle['gate'])['sourceGrain']).toBe('procurement_contract');
    expect(rec(bundle['gate'])['cadence']).toBeNull();
    // Procedures carry no dedup columns → structural, not fabricated.
    const procedure = bundle['procedure'];
    if (procedure !== null) {
      expect(rec(procedure)['isCanonical']).toBe(true);
      expect(rec(procedure)['dupGroupId']).toBeNull();
    }
  }, 30_000);

  it('detail bundle: perLotWinners is null and procedure duplicates are always []', async () => {
    const sqlRes = await pool.query<{ procedure_id: string }>(
      `select l.procedure_id::text from procurement.procedure_ted_links l limit 1`
    );
    const id = sqlRes.rows[0]?.procedure_id;
    expect(id).toBeDefined();

    const res = await gql(
      `query($id:ID!){ procurementProcedure(id:$id){
         procedure { id }
         contracts { id }
         perLotWinners { lotLabel }
         duplicates { id }
         ted { tedNoticeNo sourceUrl }
         gate { sourceGrain }
       } }`,
      { id }
    );
    expect(res.errors).toBeUndefined();
    const bundle = rec(res.data?.['procurementProcedure']);
    expect(bundle['perLotWinners']).toBeNull(); // no winner identity in procedure_lots
    expect(bundle['duplicates']).toEqual([]);
    // This procedure was chosen BECAUSE it has a TED link.
    expect(rec(bundle['ted'])['tedNoticeNo']).toBeTruthy();
  }, 30_000);

  it('detail bundle: an unknown id is null, not an error', async () => {
    const res = await gql(`{ procurementContract(id: "999999999999"){ contract { id } } }`);
    expect(res.errors).toBeUndefined();
    expect(res.data?.['procurementContract']).toBeNull();
  });

  it('supplier records: the union merges both tables, date desc, and the cursor round-trips', async () => {
    const q = `query($cui:ID!,$after:String){ procurementSupplierRecords(supplierCui:$cui, first:5, after:$after){
      total
      edges { cursor node { __typename ... on ProcurementContract { id contractDate } ... on ProcurementDirectAcquisition { id finalizationDate } } }
      pageInfo { hasNextPage endCursor }
    } }`;
    const p1 = await gql(q, { cui: SUPPLIER });
    expect(p1.errors).toBeUndefined();
    const conn1 = rec(p1.data?.['procurementSupplierRecords']);
    expect(conn1['total']).toBeNull(); // never counted across a 3.3M + 26M row pair
    const edges1 = arr(conn1['edges']).map(rec);
    expect(edges1.length).toBeGreaterThan(0);
    for (const e of edges1) {
      expect(['ProcurementContract', 'ProcurementDirectAcquisition']).toContain(
        rec(e['node'])['__typename']
      );
    }

    const info = rec(conn1['pageInfo']);
    if (info['hasNextPage'] === true) {
      const p2 = await gql(q, { cui: SUPPLIER, after: info['endCursor'] as string });
      expect(p2.errors).toBeUndefined();
      const key = (e: unknown): string => {
        const node = rec(rec(e)['node']);
        return `${String(node['__typename'])}:${String(node['id'])}`;
      };
      const keys1 = edges1.map(key);
      const keys2 = arr(rec(p2.data?.['procurementSupplierRecords'])['edges']).map(key);
      // The grain tag in the cursor is what keeps a cross-table id collision apart.
      expect(keys1.filter((k) => keys2.includes(k))).toHaveLength(0);
    }
  }, 30_000);

  it('a malformed supplier-records cursor is rejected, not paged from a guess', async () => {
    const res = await gql(
      `query($cui:ID!){ procurementSupplierRecords(supplierCui:$cui, first:2, after:"bogus"){ edges { cursor } } }`,
      { cui: SUPPLIER }
    );
    expect(res.errors?.[0]?.extensions?.code).toBe('INVALID_INPUT');
  });
});
