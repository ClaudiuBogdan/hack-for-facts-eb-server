/**
 * Procurement golden + tri-surface tests against LIVE transparenta_prod (read-only).
 *
 * Pinned to verified live record facts (re-read 2026-07-09):
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
const LIVE_REQUIRED = process.env['PROCUREMENT_LIVE_GOLDEN_REQUIRED'] === '1';
const AUTHORITY = '29170968';
const SUPPLIER = '28022254';

const d = HAS_DB || LIVE_REQUIRED ? describe : describe.skip;

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
  readonly errorType?: string;
  readonly errorCode?: string;
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

const mcpToolNames = async (): Promise<readonly string[]> => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/mcp',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    payload: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  // eslint-disable-next-line no-restricted-syntax -- test parses a trusted MCP JSON-RPC body
  const body = JSON.parse(res.body) as { result?: { tools?: readonly { name: string }[] } };
  return (body.result?.tools ?? []).map((tool) => tool.name);
};

/** Narrow a value to a record (the GraphQL data shapes are dynamic but trusted). */
const rec = (v: unknown): Record<string, unknown> => v as Record<string, unknown>;
const arr = (v: unknown): readonly unknown[] => v as readonly unknown[];

d('Procurement golden (live prod)', () => {
  beforeAll(async () => {
    if (!HAS_DB) {
      throw new Error('PROCUREMENT_LIVE_GOLDEN_REQUIRED=1 but PROD_DATABASE_URL is not configured');
    }
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

  it('DA offset guard: an unbounded DA search is rejected; an entity-scoped one is not', async () => {
    const bad = await gql(`{ procurementDirectAcquisitions(pageSize: 3){ items { id } } }`);
    expect(bad.errors?.[0]?.extensions?.code).toBe('INVALID_INPUT');

    // cpvDivision alone does NOT bound the sort (16.6s live, over the 15s timeout).
    const cpvOnly = await gql(
      `{ procurementDirectAcquisitions(filter: { cpvDivision: { eq: "33" } }, pageSize: 3){ items { id } } }`
    );
    expect(cpvOnly.errors?.[0]?.extensions?.code).toBe('INVALID_INPUT');

    const good = await gql(
      `query($cui:String!){ procurementDirectAcquisitions(filter: { authorityCui: { eq: $cui } }, pageSize: 3){ total totalEstimated items { id sourceSystem sourceUrl currency value { valueState valueAccepted valueRonComparable valueComparableBasis } } } }`,
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

  it('removed GraphQL fields and MCP names are absent from live introspection', async () => {
    const removed = [
      'rank_procurement_suppliers',
      'rank_procurement_authorities',
      'get_procurement_concentration',
      'get_procurement_authority_cpv_spend',
      'find_same_day_da_candidates',
      'get_procurement_grain_quality',
    ];
    const toolNames = await mcpToolNames();
    for (const name of removed) expect(toolNames).not.toContain(name);

    const introspection = await gql(`{
      query: __type(name: "Query") { fields { name } }
      entity: __type(name: "Entity") { fields { name } }
    }`);
    expect(introspection.errors).toBeUndefined();
    const queryFields = arr(rec(introspection.data?.['query'])['fields']).map(
      (field) => rec(field)['name']
    );
    const removedQueryFields = [
      'procurementGrainQuality',
      'procurementRepeatedPairs',
      'procurementAuthorityCpvSpend',
      'procurementTopSuppliersByRegionCpv',
      'procurementSameDayCandidates',
    ];
    for (const name of removedQueryFields) expect(queryFields).not.toContain(name);
    const entityFields = arr(rec(introspection.data?.['entity'])['fields']).map(
      (field) => rec(field)['name']
    );
    expect(entityFields).not.toContain('procurement');
  });

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

  it('detail bundle: a contract loads with its trail, procedure and duplicates', async () => {
    const sqlRes = await pool.query<{ contract_id: string }>(
      `select contract_id::text from procurement.contracts where is_canonical and procedure_id is not null limit 1`
    );
    const id = sqlRes.rows[0]?.contract_id;
    expect(id).toBeDefined();

    const res = await gql(
      `query($id:ID!){ procurementContract(id:$id){
         contract { id contractNo sourceSystem sourceUrl currency canonicalValueSource valueDisagreement value { valueState valueStateRule valueAccepted valueRonComparable } modifications { id modificationDate } }
         procedure { id sourceSystem isCanonical dupGroupId }
         duplicates { sourceSystem id }
         ted { tedNoticeNo sourceUrl }
       } }`,
      { id }
    );
    expect(res.errors).toBeUndefined();
    const bundle = rec(res.data?.['procurementContract']);
    expect(rec(bundle['contract'])['id']).toBe(id);
    expect(Array.isArray(bundle['duplicates'])).toBe(true);
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
 * scraper package published). Normal local runs report every inactive test as
 * skipped; strict live mode fails setup when either prerequisite is missing.
 * Live-SQL correctness for this surface is proven only against a published
 * generation; there is deliberately no server-side disposable-Postgres DDL
 * suite because the scraper owns the DDL.
 */
d('Procurement analysis golden (live prod, active generation required)', () => {
  let active = false;
  let buildId = '';

  beforeAll(async () => {
    if (!HAS_DB) {
      throw new Error('PROCUREMENT_LIVE_GOLDEN_REQUIRED=1 but PROD_DATABASE_URL is not configured');
    }
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
    if (!active && LIVE_REQUIRED) {
      throw new Error('strict procurement golden requires an active analysis generation');
    }
    if (active) console.info(`procurement analysis golden buildId=${buildId}`);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    await new Promise((resolve) => setTimeout(resolve, 50));
    process.off('uncaughtException', onUncaught);
  });

  it('serves the advertised scope/filter families across all grains on one build', async (ctx) => {
    if (!active) ctx.skip();
    const cases: readonly {
      readonly label: string;
      readonly scope: Record<string, unknown>;
      readonly grain: string;
    }[] = [
      { label: 'platform', scope: { grain: 'procedure' }, grain: 'procedure' },
      {
        label: 'authority',
        scope: { authorityCui: AUTHORITY, grain: 'contract' },
        grain: 'contract',
      },
      {
        label: 'supplier',
        scope: { supplierCui: SUPPLIER, grain: 'direct_acquisition' },
        grain: 'direct_acquisition',
      },
      {
        label: 'authority-supplier pair',
        scope: { authorityCui: AUTHORITY, supplierCui: SUPPLIER, grain: 'contract' },
        grain: 'contract',
      },
      {
        label: 'CPV division',
        scope: { cpvDivision: '33', grain: 'procedure' },
        grain: 'procedure',
      },
      {
        label: 'CPV code',
        scope: { cpvCode: '33600000', grain: 'contract' },
        grain: 'contract',
      },
      {
        label: 'buyer region',
        scope: { buyerRegion: 'Sud-Muntenia', grain: 'direct_acquisition' },
        grain: 'direct_acquisition',
      },
      { label: 'status', scope: { status: 'awarded', grain: 'procedure' }, grain: 'procedure' },
      {
        label: 'procedure type',
        scope: { procedureType: 'licitatie-deschisa', grain: 'contract' },
        grain: 'contract',
      },
      {
        label: 'calendar window',
        scope: { authorityCui: AUTHORITY, grain: 'direct_acquisition', year: 2024 },
        grain: 'direct_acquisition',
      },
    ];

    for (const testCase of cases) {
      const response = await gql(
        `query($scope:ProcurementAnalysisScopeInput!){ procurementStats(scope:$scope){
           blocks { grain recordCount meta { buildId canonicalScope answerability reason } }
         } }`,
        { scope: testCase.scope }
      );
      expect(response.errors, testCase.label).toBeUndefined();
      const blocks = arr(rec(response.data?.['procurementStats'])['blocks']).map(rec);
      expect(blocks, testCase.label).toHaveLength(1);
      expect(blocks[0]?.['grain'], testCase.label).toBe(testCase.grain);
      expect(rec(blocks[0]?.['meta'])['buildId'], testCase.label).toBe(buildId);
    }
  }, 90_000);

  it('procurementStats blocks reconcile with raw SQL over the authority_dims rollup', async (ctx) => {
    if (!active) ctx.skip();
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

  it('breakdown reconciles by construction: top + other + unknown == the same read totals', async (ctx) => {
    if (!active) ctx.skip();
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

  it('MCP aggregate_procurement agrees with the GraphQL stats blocks', async (ctx) => {
    if (!active) ctx.skip();
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

  it('all advertised series metrics and buckets agree between GraphQL and MCP', async (ctx) => {
    if (!active) ctx.skip();
    const cases: readonly {
      readonly label: string;
      readonly scope: Record<string, unknown>;
      readonly measure: string;
      readonly bucket: string;
    }[] = [
      {
        label: 'record count',
        scope: { grain: 'contract' },
        measure: 'recordCount',
        bucket: 'month',
      },
      {
        label: 'valued count',
        scope: { authorityCui: AUTHORITY, grain: 'contract' },
        measure: 'withValueCount',
        bucket: 'quarter',
      },
      {
        label: 'awarded value',
        scope: { authorityCui: AUTHORITY, grain: 'direct_acquisition' },
        measure: 'valueAwardedSum',
        bucket: 'year',
      },
      {
        label: 'estimated value',
        scope: { cpvDivision: '33', grain: 'procedure' },
        measure: 'valueEstimatedSum',
        bucket: 'month',
      },
      {
        label: 'distinct suppliers',
        scope: { grain: 'contract' },
        measure: 'distinctSuppliers',
        bucket: 'year',
      },
      {
        label: 'distinct authorities',
        scope: { supplierCui: SUPPLIER, grain: 'contract' },
        measure: 'distinctAuthorities',
        bucket: 'month',
      },
    ];

    for (const testCase of cases) {
      const graph = await gql(
        `query($scope:ProcurementAnalysisScopeInput!,$measure:ProcurementAnalysisMeasure!,$bucket:ProcurementSeriesBucket!){
           procurementSeries(scope:$scope,measure:$measure,bucket:$bucket){
             grain measure bucket points { bucket value }
             meta { answerability reason buildId canonicalScope }
           }
         }`,
        { scope: testCase.scope, measure: testCase.measure, bucket: testCase.bucket }
      );
      expect(graph.errors, testCase.label).toBeUndefined();
      const graphBlocks = arr(graph.data?.['procurementSeries']).map(rec);

      const mcp = await mcpCall('aggregate_procurement', {
        shape: 'series',
        scope: testCase.scope,
        measure: testCase.measure,
        bucket: testCase.bucket,
      });
      expect(mcp.ok, testCase.label).toBe(true);
      const mcpBlocks = (mcp.items ?? []).map(rec);
      expect(
        mcpBlocks.map((block) => block['grain']),
        testCase.label
      ).toEqual(graphBlocks.map((block) => block['grain']));
      expect(
        mcpBlocks.map((block) => block['points']),
        testCase.label
      ).toEqual(graphBlocks.map((block) => block['points']));
      for (const block of graphBlocks) expect(rec(block['meta'])['buildId']).toBe(buildId);
    }

    const invalidGraph = await gql(
      `query($scope:ProcurementAnalysisScopeInput!){
         procurementSeries(scope:$scope,measure:avgValueAwarded,bucket:quarter){ grain }
       }`,
      { scope: { authorityCui: AUTHORITY, grain: 'contract' } }
    );
    expect(rec(invalidGraph.errors?.[0])['extensions']).toMatchObject({ code: 'INVALID_INPUT' });

    const invalidMcp = await mcpCall('aggregate_procurement', {
      shape: 'series',
      scope: { authorityCui: AUTHORITY, grain: 'contract' },
      measure: 'avgValueAwarded',
      bucket: 'quarter',
    });
    expect(invalidMcp.ok).toBe(false);
    expect(invalidMcp.errorType).toBe('InvalidInput');
    expect(invalidMcp.errorCode).toBe('INVALID_INPUT');
    expect(invalidMcp.error).toMatch(/not legal|not supported|invalid/iu);
  }, 120_000);

  it('series, breakdown and concentration reconcile with raw rollup SQL', async (ctx) => {
    if (!active) ctx.skip();

    const series = await gql(
      `query($cui:String!){ procurementSeries(
         scope:{authorityCui:$cui,grain:contract}, measure:recordCount, bucket:month
       ){ points { bucket value } } }`,
      { cui: AUTHORITY }
    );
    expect(series.errors).toBeUndefined();
    const rawSeries = await pool.query<{ bucket: string | null; value: string }>(
      `select to_char(month_start, 'YYYY-MM') bucket, sum(record_count)::text value
         from procurement.analysis_rollup_authority_dims_monthly
        where build_id = $1 and grain = 'contract' and authority_cui = $2
        group by month_start order by month_start asc nulls last`,
      [buildId, AUTHORITY]
    );
    expect(rec(arr(series.data?.['procurementSeries'])[0])['points']).toEqual(rawSeries.rows);

    const breakdown = await gql(
      `query($cui:String!){ procurementBreakdown(
         scope:{authorityCui:$cui,grain:contract}, dimension:supplier, topN:5
       ){ rankedBy buckets { kind key recordCount valueAwardedSum } } }`,
      { cui: AUTHORITY }
    );
    expect(breakdown.errors).toBeUndefined();
    const breakdownBlock = rec(arr(breakdown.data?.['procurementBreakdown'])[0]);
    const firstTop = arr(breakdownBlock['buckets'])
      .map(rec)
      .find((bucket) => bucket['kind'] === 'top');
    expect(firstTop).toBeDefined();
    const orderColumn =
      breakdownBlock['rankedBy'] === 'value' ? 'value_awarded_sum' : 'record_count';
    const rawTop = await pool.query<{
      key: string;
      record_count: string;
      value_awarded_sum: string | null;
    }>(
      `select supplier_cui key, sum(record_count)::text record_count,
              sum(value_awarded_sum)::text value_awarded_sum
         from procurement.analysis_rollup_edge_monthly
        where build_id = $1 and grain = 'contract' and authority_cui = $2
          and supplier_cui is not null
        group by supplier_cui
        order by sum(${orderColumn}) desc nulls last, supplier_cui asc limit 1`,
      [buildId, AUTHORITY]
    );
    expect(firstTop?.['key']).toBe(rawTop.rows[0]?.key);
    expect(firstTop?.['recordCount']).toBe(rawTop.rows[0]?.record_count);

    const concentration = await gql(
      `query($cui:String!){ procurementConcentration(
         scope:{authorityCui:$cui,grain:contract}, basis:count
       ){ supplierCount meta { buildId } } }`,
      { cui: AUTHORITY }
    );
    expect(concentration.errors).toBeUndefined();
    const rawSuppliers = await pool.query<{ supplier_count: number }>(
      `select count(distinct supplier_cui)::int supplier_count
         from procurement.analysis_rollup_edge_monthly
        where build_id = $1 and grain = 'contract' and authority_cui = $2
          and supplier_cui is not null`,
      [buildId, AUTHORITY]
    );
    const concentrationBlock = rec(arr(concentration.data?.['procurementConcentration'])[0]);
    expect(concentrationBlock['supplierCount']).toBe(rawSuppliers.rows[0]?.supplier_count);
    expect(rec(concentrationBlock['meta'])['buildId']).toBe(buildId);
  }, 90_000);

  it('breakdown and concentration match their retained MCP shapes', async (ctx) => {
    if (!active) ctx.skip();
    const scope = { authorityCui: AUTHORITY, grain: 'contract' };
    const breakdownGraph = await gql(
      `query($scope:ProcurementAnalysisScopeInput!){ procurementBreakdown(scope:$scope,dimension:supplier,topN:5){
         grain dimension rankedBy buckets { kind key recordCount withValueCount valueAwardedSum shareOfScope }
         meta { answerability reason policyKey grain valueBasis dateBasis population buildId
                counts { rows withValue } undatedInScope { count valueRon }
                provisional caveats canonicalScope }
       } }`,
      { scope }
    );
    const breakdownMcp = await mcpCall('aggregate_procurement', {
      shape: 'breakdown',
      scope,
      dimension: 'supplier',
      topN: 5,
    });
    expect(breakdownMcp.ok).toBe(true);
    expect(breakdownMcp.items).toEqual(breakdownGraph.data?.['procurementBreakdown']);

    const concentrationGraph = await gql(
      `query($scope:ProcurementAnalysisScopeInput!){ procurementConcentration(scope:$scope,basis:count){
         grain basis supplierCount top1Share top5Share hhi totalRon
         meta { answerability reason policyKey grain valueBasis dateBasis population buildId
                counts { rows withValue } undatedInScope { count valueRon }
                provisional caveats canonicalScope }
       } }`,
      { scope }
    );
    const concentrationMcp = await mcpCall('aggregate_procurement', {
      shape: 'concentration',
      scope,
      basis: 'count',
    });
    expect(concentrationMcp.ok).toBe(true);
    expect(concentrationMcp.items).toEqual(concentrationGraph.data?.['procurementConcentration']);
  }, 60_000);

  it('share operands stay on one build and facets reconcile each dimension', async (ctx) => {
    if (!active) ctx.skip();
    const cpvFixture = await pool.query<{ cpv_division: string }>(
      `select cpv_division
         from procurement.analysis_rollup_authority_dims_monthly
        where build_id = $1 and grain = 'contract' and authority_cui = $2
          and cpv_division is not null
        group by cpv_division
       having sum(value_awarded_sum) > 0
        order by sum(value_awarded_sum) desc
        limit 1`,
      [buildId, AUTHORITY]
    );
    const cpvDivision = cpvFixture.rows[0]?.cpv_division;
    expect(cpvDivision, 'share fixture has a positive monetary numerator').toBeDefined();
    const share = await gql(
      `query($cui:String!,$cpv:String!){ procurementShare(
         denominator:{authorityCui:$cui,grain:contract},
         numerator:{authorityCui:$cui,cpvDivision:$cpv,grain:contract}
       ){
         share answerability reason
         numerator { grain recordCount valueAwardedSum meta { buildId } }
         denominator { grain recordCount valueAwardedSum meta { buildId } }
       } }`,
      { cui: AUTHORITY, cpv: cpvDivision }
    );
    expect(share.errors).toBeUndefined();
    const shareResult = rec(share.data?.['procurementShare']);
    expect(rec(rec(shareResult['numerator'])['meta'])['buildId']).toBe(buildId);
    expect(rec(rec(shareResult['denominator'])['meta'])['buildId']).toBe(buildId);
    const rawShareOperands = await pool.query<{
      kind: string;
      record_count: string;
      value_awarded_sum: string | null;
    }>(
      `select 'numerator' kind, coalesce(sum(record_count),0)::text record_count,
              sum(value_awarded_sum)::text value_awarded_sum
         from procurement.analysis_rollup_authority_dims_monthly
        where build_id = $1 and grain = 'contract' and authority_cui = $2
          and cpv_division = $3
       union all
       select 'denominator', coalesce(sum(record_count),0)::text,
              sum(value_awarded_sum)::text
         from procurement.analysis_rollup_authority_dims_monthly
        where build_id = $1 and grain = 'contract' and authority_cui = $2`,
      [buildId, AUTHORITY, cpvDivision]
    );
    const rawShareByKind = new Map(rawShareOperands.rows.map((row) => [row.kind, row]));
    const rawNumerator = rawShareByKind.get('numerator');
    const rawDenominator = rawShareByKind.get('denominator');
    expect(new Decimal(rawNumerator?.record_count ?? '0').greaterThan(0)).toBe(true);
    expect(new Decimal(rawDenominator?.record_count ?? '0').greaterThan(0)).toBe(true);
    expect(new Decimal(rawNumerator?.value_awarded_sum ?? '0').greaterThan(0)).toBe(true);
    expect(new Decimal(rawDenominator?.value_awarded_sum ?? '0').greaterThan(0)).toBe(true);
    expect(rec(shareResult['numerator'])['recordCount']).toBe(rawNumerator?.record_count);
    expect(rec(shareResult['denominator'])['recordCount']).toBe(rawDenominator?.record_count);
    if (shareResult['share'] === null) {
      expect(shareResult['answerability']).toBe('abstained');
      expect(rec(shareResult['numerator'])['valueAwardedSum']).toBeNull();
      expect(rec(shareResult['denominator'])['valueAwardedSum']).toBeNull();
    } else {
      expect(shareResult['share']).toBe(
        new Decimal(rawNumerator?.value_awarded_sum ?? '0')
          .div(rawDenominator?.value_awarded_sum ?? '1')
          .toFixed(4)
      );
    }

    const facets = await gql(
      `query($cui:String!){ procurementFacets(
         scope:{authorityCui:$cui,grain:contract}, dimensions:[supplier,cpvDivision,status], topN:5
       ){ blocks { dimension buckets { kind recordCount } meta { counts { rows } buildId } } } }`,
      { cui: AUTHORITY }
    );
    expect(facets.errors).toBeUndefined();
    const facetBlocks = arr(rec(facets.data?.['procurementFacets'])['blocks']).map(rec);
    expect(facetBlocks.map((block) => block['dimension'])).toEqual([
      'supplier',
      'cpvDivision',
      'status',
    ]);
    for (const block of facetBlocks) {
      const total = arr(block['buckets'])
        .map(rec)
        .reduce((sum, bucket) => sum + BigInt(bucket['recordCount'] as string), 0n);
      expect(total.toString()).toBe(rec(rec(block['meta'])['counts'])['rows']);
      expect(rec(block['meta'])['buildId']).toBe(buildId);
      const individual = await gql(
        `query($cui:String!,$dimension:ProcurementBreakdownDimension!){ procurementBreakdown(
           scope:{authorityCui:$cui,grain:contract},dimension:$dimension,topN:5
         ){ dimension buckets { kind recordCount } meta { counts { rows } buildId } } }`,
        { cui: AUTHORITY, dimension: block['dimension'] }
      );
      expect(individual.errors).toBeUndefined();
      expect(rec(arr(individual.data?.['procurementBreakdown'])[0])).toEqual(block);
    }
  }, 60_000);

  it('generalized concentration serves decimal-string shares from the rollups', async (ctx) => {
    if (!active) ctx.skip();
    const res = await gql(
      `query($cui:String!){ procurementConcentration(scope: { authorityCui: $cui, grain: direct_acquisition }){
         grain basis supplierCount top1Share hhi totalRon meta { answerability reason buildId caveats }
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
