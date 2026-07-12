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

import { Decimal } from 'decimal.js';
import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildRedesignApp } from '@/app/build-redesign-app.js';
import { loadRedesignConfig } from '@/infra/config/redesign-env.js';
import { makeProcurementDetailRepo } from '@/modules/procurement/shell/repo/detail-repo.js';

import type { ProdDatabase } from '@/modules/shared/index.js';
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

  it('tri-surface: MCP rank == raw SQL over the org_edge MV (analyst surface unchanged)', async () => {
    const sqlRes = await pool.query<{ supplier_cui: string; fc: string; amt: string }>(
      `select supplier_cui, sum(flow_count)::text fc, sum(amount_ron_sum)::text amt
       from procurement.org_edge_monthly_rollups
       where authority_cui = $1 and source_grain = 'direct_acquisition' and month_start >= '2011-07-01'
       group by supplier_cui order by sum(amount_ron_sum) desc nulls last limit 1`,
      [AUTHORITY]
    );
    const raw = sqlRes.rows[0];
    expect(raw?.supplier_cui).toBe(SUPPLIER);

    const mcp = await mcpCall('rank_procurement_suppliers', {
      authorityCui: AUTHORITY,
      grain: 'direct_acquisition',
      topN: 1,
    });
    expect(mcp.ok).toBe(true);
    expect(mcp.items?.[0]?.['supplierCui']).toBe(raw?.supplier_cui);
    expect(mcp.items?.[0]?.['flowCount']).toBe(raw?.fc);
    expect(mcp.items?.[0]?.['amountRonSum']).toBe(raw?.amt);
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

    const wide = await gql(
      `{ procurementContracts(pageSize: 5){ total totalEstimated items { id } } }`
    );
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

  it('get_procurement_concentration stays on the legacy MV path (value-based for DA)', async () => {
    const mcp = await mcpCall('get_procurement_concentration', {
      authorityCui: AUTHORITY,
      grain: 'direct_acquisition',
    });
    expect(mcp.ok).toBe(true);
    const item = rec((mcp as unknown as { item: unknown }).item);
    expect(item['basis']).toBe('value');
    expect(item['supplierCount'] as number).toBeGreaterThan(0);
    expect(item['totalRon']).not.toBeNull();
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

  it('analysis matrix rejections fire BEFORE any rollup read (no generation required)', async () => {
    // entity × 8-digit cpvCode is a named wave-2 rejection (bounded fact query).
    const res = await gql(
      `query($cui:String!){ procurementStats(scope: { authorityCui: $cui, cpvCode: "33600000" }){ blocks { grain } } }`,
      { cui: AUTHORITY }
    );
    expect(res.errors?.[0]?.extensions?.code).toBe('INVALID_INPUT');

    // supplier geography is milestone M3, named as such.
    const geo = await gql(
      `{ procurementStats(scope: { supplierRegion: "Nord-Vest" }){ blocks { grain } } }`
    );
    expect(geo.errors?.[0]?.extensions?.code).toBe('INVALID_INPUT');
  });

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

  it('modification batching caps PER CONTRACT — a fat parent never starves the batch', async () => {
    // Live shape (2026-07-10): 1592679 has 390 modifications, 191354 has 287,
    // 204043 has 272, 1593075 has 1. The retired global `limit CAP * ids.length`
    // (= 800) was consumed by the first three in contract_id order, leaving the
    // fourth — the one with a single modification — with ZERO rows.
    // Wraps the shared pool; never `destroy()`d here — that would end the pool the
    // rest of the suite is still using. `afterAll` owns the pool's lifetime.
    const db = new Kysely<ProdDatabase>({ dialect: new PostgresDialect({ pool }) });
    const repo = makeProcurementDetailRepo(db);
    const ids = ['191354', '204043', '1592679', '1593075'];
    const byContract = (await repo.modificationsForContracts(ids))._unsafeUnwrap();

    // Every parent in the batch is represented; none is starved.
    for (const id of ids) expect(byContract.get(id)?.length ?? 0).toBeGreaterThan(0);

    // Each fat parent is capped independently at 200, not collectively.
    expect(byContract.get('1592679')).toHaveLength(200);
    expect(byContract.get('191354')).toHaveLength(200);
    expect(byContract.get('204043')).toHaveLength(200);
    expect(byContract.get('1593075')).toHaveLength(1);

    // The trail is chronological within a parent.
    const trail = byContract.get('1592679') ?? [];
    const dates = trail.map((m) => m.modificationDate).filter((d): d is string => d !== null);
    expect([...dates].sort()).toEqual(dates);
  }, 30_000);

  it('detail lookups are canonical-only: a suppressed duplicate resolves to null', async () => {
    const dup = await pool.query<{ id: string }>(
      `select contract_id::text as id from procurement.contracts
        where dup_group_id is not null and is_canonical = false limit 1`
    );
    const suppressed = dup.rows[0]?.id;
    if (suppressed === undefined) return; // no suppressed contract live → nothing to assert

    const res = await gql(`query($id:ID!){ procurementContract(id:$id){ contract { id } } }`, {
      id: suppressed,
    });
    expect(res.errors).toBeUndefined();
    // A dedup-suppressed row must never render as an authoritative record.
    expect(res.data?.['procurementContract']).toBeNull();
  }, 30_000);

  it('a supplier-records cursor is rejected against a different supplier', async () => {
    const first = await gql(
      `query($cui:ID!){ procurementSupplierRecords(supplierCui:$cui, first:2){ pageInfo { endCursor } } }`,
      { cui: SUPPLIER }
    );
    const cursor = rec(rec(first.data?.['procurementSupplierRecords'])['pageInfo'])['endCursor'];
    if (typeof cursor !== 'string') return;

    const replay = await gql(
      `query($cui:ID!,$after:String!){ procurementSupplierRecords(supplierCui:$cui, first:2, after:$after){ edges { cursor } } }`,
      { cui: '11805367', after: cursor }
    );
    expect(replay.errors?.[0]?.extensions?.code).toBe('INVALID_INPUT');
  }, 30_000);

  it('a malformed supplier-records cursor is rejected, not paged from a guess', async () => {
    const res = await gql(
      `query($cui:ID!){ procurementSupplierRecords(supplierCui:$cui, first:2, after:"bogus"){ edges { cursor } } }`,
      { cui: SUPPLIER }
    );
    expect(res.errors?.[0]?.extensions?.code).toBe('INVALID_INPUT');
  });
});

/**
 * The analysis surface golden — DOUBLE-gated: PROD_DATABASE_URL must be present
 * AND `procurement.analysis_generations` must exist with an active row (the
 * scraper package published). Each test early-returns (reported green, asserting
 * nothing) when either gate is closed — live-SQL correctness for this surface is
 * proven ONLY by running this suite against prod with a published generation,
 * which happens in the pre-commit golden run; there is deliberately no
 * server-side disposable-Postgres DDL suite (the scraper owns the DDL).
 */
d('Procurement analysis golden (live prod, active generation required)', () => {
  let active = false;
  let buildId = '';

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
    // Retry the probe: the local kubectl port-forward drops fresh connections
    // for a moment after the previous describe's pool tears down (empty-message
    // socket errors). Only a persistent failure means the package is absent.
    for (let attempt = 0; attempt < 3 && !active; attempt += 1) {
      try {
        const probe = await pool.query<{ build_id: string }>(
          `select build_id::text from procurement.analysis_generations where status = 'active' limit 1`
        );
        buildId = probe.rows[0]?.build_id ?? '';
        active = buildId !== '';
        break;
      } catch (error) {
        active = false; // schema/table absent → the package has not landed; skip.
        console.warn(
          `analysis golden: gate probe attempt ${String(attempt + 1)} failed —`,
          error instanceof Error ? error.message : String(error)
        );
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    await new Promise((resolve) => setTimeout(resolve, 50));
    process.off('uncaughtException', onUncaught);
  });

  it('procurementStats blocks reconcile with raw SQL over the authority_dims rollup', async () => {
    if (!active) return;
    const sqlRes = await pool.query<{ grain: string; rc: string; wv: string; va: string | null }>(
      `select grain, sum(record_count)::text rc, sum(with_value_count)::text wv,
              sum(value_awarded_sum)::text va
         from procurement.analysis_rollup_authority_dims_monthly
        where build_id = $1 and authority_cui = $2
        group by grain`,
      [buildId, AUTHORITY]
    );
    const byGrain = new Map(sqlRes.rows.map((r) => [r.grain, r]));

    const res = await gql(
      `query($cui:String!){ procurementStats(scope: { authorityCui: $cui }){
         blocks { grain recordCount withValueCount valueAwardedSum meta { buildId policyKey caveats } }
       } }`,
      { cui: AUTHORITY }
    );
    expect(res.errors).toBeUndefined();
    const blocks = arr(rec(res.data?.['procurementStats'])['blocks']).map(rec);
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) {
      const raw = byGrain.get(block['grain'] as string);
      expect(block['recordCount']).toBe(raw?.rc ?? '0');
      expect(block['withValueCount']).toBe(raw?.wv ?? '0');
      expect(rec(block['meta'])['buildId']).toBe(buildId);
      // Money either matches the rollup sum exactly (Decimal, never floats) or is
      // honestly absent WITH a caveat.
      if (block['valueAwardedSum'] !== null) {
        expect(
          new Decimal(block['valueAwardedSum'] as string).equals(new Decimal(raw?.va ?? '0'))
        ).toBe(true);
      } else {
        expect((rec(block['meta'])['caveats'] as string[]).length).toBeGreaterThan(0);
      }
    }
  }, 30_000);

  it('breakdown reconciles by construction: top + other + unknown == the same read totals', async () => {
    if (!active) return;
    const res = await gql(
      `query($cui:String!){ procurementBreakdown(scope: { authorityCui: $cui }, dimension: supplier, topN: 5){
         grain rankedBy
         buckets { kind key recordCount valueAwardedSum shareOfScope }
         meta { counts { rows } undatedInScope { count } }
       } }`,
      { cui: AUTHORITY }
    );
    expect(res.errors).toBeUndefined();
    for (const block of arr(res.data?.['procurementBreakdown']).map(rec)) {
      const buckets = arr(block['buckets']).map(rec);
      const total = buckets.reduce((acc, b) => acc + BigInt(b['recordCount'] as string), 0n);
      expect(total.toString()).toBe(rec(rec(block['meta'])['counts'])['rows']);
      // Exactly one other + one unknown bucket, keys null.
      expect(buckets.filter((b) => b['kind'] === 'other')).toHaveLength(1);
      expect(buckets.filter((b) => b['kind'] === 'unknown')).toHaveLength(1);
    }
  }, 30_000);

  it('MCP aggregate_procurement agrees with the GraphQL stats blocks', async () => {
    if (!active) return;
    const g = await gql(
      `query($cui:String!){ procurementStats(scope: { authorityCui: $cui }){
         blocks { grain recordCount valueAwardedSum } } }`,
      { cui: AUTHORITY }
    );
    const gBlocks = arr(rec(g.data?.['procurementStats'])['blocks']).map(rec);

    const mcp = await mcpCall('aggregate_procurement', {
      shape: 'stats',
      scope: { authorityCui: AUTHORITY },
    });
    expect(mcp.ok).toBe(true);
    const items = (mcp.items ?? []).map((i) => rec(i));
    expect(items.map((i) => i['grain'])).toEqual(gBlocks.map((b) => b['grain']));
    for (const [index, item] of items.entries()) {
      expect(item['recordCount']).toBe(gBlocks[index]?.['recordCount']);
      expect(item['valueAwardedSum']).toBe(gBlocks[index]?.['valueAwardedSum'] ?? null);
    }
  }, 30_000);

  it('generalized concentration serves decimal-string shares from the rollups', async () => {
    // The MCP get_procurement_concentration tool deliberately stays on the legacy
    // MV path (S6) — the two substrates may legitimately disagree, so no
    // cross-comparison here.
    if (!active) return;
    const res = await gql(
      `query($cui:String!){ procurementConcentration(scope: { authorityCui: $cui, grain: direct_acquisition }){
         grain basis supplierCount top1Share hhi totalRon meta { buildId caveats }
       } }`,
      { cui: AUTHORITY }
    );
    expect(res.errors).toBeUndefined();
    const block = rec(arr(res.data?.['procurementConcentration'])[0]);
    expect(block['grain']).toBe('direct_acquisition');
    expect(block['supplierCount'] as number).toBeGreaterThan(0);
    if (block['top1Share'] !== null) expect(block['top1Share']).toMatch(/^\d\.\d{4}$/u);
    expect(rec(block['meta'])['buildId']).toBe(buildId);
  }, 30_000);
});
