/**
 * Companies golden + tri-surface tests against LIVE transparenta_prod (read-only).
 *
 * Pinned to measured live data (verified 2026-06-16 on transparenta-prod-postgres-1):
 *   - core.organizations kind='company' = 3,985,167 (the CUI spine)
 *   - golden CUI 2816464 = DEDEMAN SRL, org_id 1517396, county Bacău (raw_county),
 *     status 1048 funcțiune, legal_form SRL, regnum J1992002621040, vat=true,
 *     is_inactive=false, employees(2024)=12313, also a flows payee.
 *
 * Tri-surface: the GraphQL `company(cui)` / `entity(cui).company` payload == the
 * MCP `get_company_snapshot` profile == raw SQL over `companies.*`. Skips cleanly
 * when PROD_DATABASE_URL is absent (CI without the tunnel).
 */

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildRedesignApp } from '@/app/build-redesign-app.js';
import { loadRedesignConfig } from '@/infra/config/redesign-env.js';

import type { FastifyInstance } from 'fastify';

const HAS_DB = (process.env['PROD_DATABASE_URL'] ?? '').length > 0;
const DEDEMAN = '2816464';

const d = HAS_DB ? describe : describe.skip;

let app: FastifyInstance;
let close: () => Promise<void>;
let pool: Pool;

/** Swallow ONLY the benign stateless-MCP transport teardown error (kernel race). */
const onUncaught = (err: unknown): void => {
  if (err instanceof Error && err.message.includes('destroySoon')) return;
  throw err;
};

const gql = async (query: string, variables?: Record<string, unknown>): Promise<{ data?: unknown; errors?: unknown }> => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/graphql',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ query, variables }),
  });
  return res.json();
};

const mcpCall = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/mcp',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    payload: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  // eslint-disable-next-line no-restricted-syntax -- test parses a trusted MCP JSON-RPC response body
  const body = JSON.parse(res.body) as { result?: { structuredContent?: unknown; content?: { text?: string }[] } };
  if (body.result?.structuredContent !== undefined) return body.result.structuredContent;
  const text = body.result?.content?.[0]?.text;
  // eslint-disable-next-line no-restricted-syntax -- test parses the trusted MCP tool-output text payload
  return text !== undefined ? JSON.parse(text) : undefined;
};

d('Companies golden (live prod)', () => {
  beforeAll(async () => {
    const config = loadRedesignConfig(process.env);
    const built = await buildRedesignApp({ kernelConfig: config.kernel, logLevel: 'silent' });
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

  it('the CUI spine count is the measured 3,985,167', async () => {
    const r = await pool.query<{ cnt: string }>(`select count(*) cnt from core.organizations where kind='company'`);
    expect(Number(r.rows[0]?.cnt)).toBe(3_985_167);
  });

  it('company(2816464) profile matches the golden row', async () => {
    const res = await gql(
      `query($cui: CUI!){ company(cui:$cui){
         cui orgId name legalForm codInmatriculare registrationDate registrationDatePresent
         headlineStatus { code label } address { county locality }
         territory { matchConfidence }
         fiscal { vatPayer declaredFiscallyInactive mainCaenCode }
         financials { year turnover employees } representatives { name role } statusFlags { code label }
         caenActivities { code rev } euBranches { country }
         publicMoney { totalRon flowCount } asOf { onrc anaf }
       } }`,
      { cui: DEDEMAN }
    );
    expect(res.errors).toBeUndefined();
    const c = (res.data as {
      company: {
        name: string;
        orgId: string;
        legalForm: string;
        codInmatriculare: string;
        registrationDate: string;
        registrationDatePresent: boolean;
        headlineStatus: { code: string };
        address: { county: string };
        fiscal: { vatPayer: boolean; declaredFiscallyInactive: boolean };
        financials: { year: number; employees: string }[];
        publicMoney: { flowCount: number } | null;
      };
    }).company;
    expect(c.name).toBe('DEDEMAN SRL');
    expect(c.orgId).toBe('1517396');
    expect(c.legalForm).toBe('SRL');
    expect(c.codInmatriculare).toBe('J1992002621040');
    expect(c.registrationDate).toBe('1992-11-05');
    expect(c.registrationDatePresent).toBe(true);
    expect(c.headlineStatus.code).toBe('1048');
    expect(c.address.county).toBe('Bacău');
    expect(c.fiscal.vatPayer).toBe(true);
    expect(c.fiscal.declaredFiscallyInactive).toBe(false);
    const y2024 = c.financials.find((f) => f.year === 2024);
    expect(y2024?.employees).toBe('12313'); // bigint as string, never a JS number
    expect(c.publicMoney?.flowCount).toBeGreaterThan(0);
  }, 25_000); // full profile incl. the public-money slice (3 flow aggregates) on a 219k-flow payee.

  it('drops is_active: no surface emits an "active"-named boolean; declaredFiscallyInactive present', async () => {
    const res = await gql(`query($cui: CUI!){ company(cui:$cui){ fiscal { declaredFiscallyInactive } } }`, { cui: DEDEMAN });
    const str = JSON.stringify(res.data);
    expect(str).toContain('declaredFiscallyInactive');
    expect(/"is_?active"/i.test(str)).toBe(false);
    // is_active == NOT is_inactive on all rows (the drop rationale, R1).
    const r = await pool.query<{ mismatch: string }>(
      `select count(*) mismatch from companies.fiscal_status where is_active is distinct from (not is_inactive)`
    );
    expect(Number(r.rows[0]?.mismatch)).toBe(0);
  });

  it('companies list is bounded (county+status filter, raw_county)', async () => {
    const res = await gql(
      `query{ companies(filter: { county: { in: ["Bacău"] }, status: { in: ["1048"] } }, first: 5){
         totalCount totalEstimated edges { node { cui name county headlineStatus { code } } } pageInfo { hasNextPage }
       } }`
    );
    expect(res.errors).toBeUndefined();
    const conn = (res.data as { companies: { totalCount: number; edges: { node: { county: string; headlineStatus: { code: string } } }[] } }).companies;
    expect(conn.edges.length).toBeGreaterThan(0);
    expect(conn.edges.length).toBeLessThanOrEqual(5);
    for (const e of conn.edges) {
      expect(e.node.county).toBe('Bacău');
      expect(e.node.headlineStatus.code).toBe('1048');
    }
    expect(conn.totalCount).toBeGreaterThan(0);
  });

  it('county filter folds diacritics with NO unaccent (Bacău matches; SQL fold == TS fold)', async () => {
    const res = await gql(`query{ companies(filter: { county: { in: ["bacau"] } }, first: 1){ totalCount edges { node { county } } } }`);
    const conn = (res.data as { companies: { totalCount: number; edges: { node: { county: string } }[] } }).companies;
    // "bacau" (folded, no diacritics) must match the stored "Bacău".
    expect(conn.edges[0]?.node.county).toBe('Bacău');
    expect(conn.totalCount).toBeGreaterThan(0);
  });

  it('companyResolve(REGNUM) is a two-hop list resolving to the golden CUI', async () => {
    const res = await gql(`query{ companyResolve(dim: REGNUM, q: "J1992002621040"){ dim value label cui } }`);
    const hits = (res.data as { companyResolve: { cui: string; value: string }[] }).companyResolve;
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0]?.cui).toBe(DEDEMAN);
    expect(hits[0]?.value).toBe(DEDEMAN);
  });

  it('companyResolve(NAME) returns the golden company (Meili-primary or pg fallback)', async () => {
    const res = await gql(`query{ companyResolve(dim: NAME, q: "DEDEMAN", limit: 5){ value label cui } }`);
    const hits = (res.data as { companyResolve: { cui: string | null }[] }).companyResolve;
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((h) => h.cui === DEDEMAN)).toBe(true);
  });

  it('tri-surface: GraphQL company == Entity.company == MCP snapshot == raw SQL', async () => {
    const sqlRes = await pool.query<{ name: string; status_code: string; legal_form: string }>(
      `select o.name, r.status_code, r.legal_form
         from core.organizations o join companies.registrations r on r.cui=o.cui
        where o.cui=$1 and o.kind='company'`,
      [DEDEMAN]
    );
    const raw = sqlRes.rows[0];
    expect(raw).toBeDefined();

    const g = await gql(`query($cui: CUI!){ company(cui:$cui){ name legalForm headlineStatus { code } } }`, { cui: DEDEMAN });
    const gc = (g.data as { company: { name: string; legalForm: string; headlineStatus: { code: string } } }).company;

    const e = await gql(`query($cui: CUI!){ entity(cui:$cui){ company { name legalForm headlineStatus { code } } } }`, { cui: DEDEMAN });
    const ec = (e.data as { entity: { company: { name: string; legalForm: string; headlineStatus: { code: string } } } }).entity.company;

    const m = (await mcpCall('get_company_snapshot', { cui: DEDEMAN })) as { item: { name: string; legalForm: string; headlineStatus: { code: string } } };

    expect(gc.name).toBe(raw?.name);
    expect(ec.name).toBe(raw?.name);
    expect(m.item.name).toBe(raw?.name);
    expect(gc.headlineStatus.code).toBe(raw?.status_code);
    expect(ec.headlineStatus.code).toBe(raw?.status_code);
    expect(m.item.headlineStatus.code).toBe(raw?.status_code);
    expect(gc.legalForm).toBe(raw?.legal_form);
  }, 20_000); // DEDEMAN is a 219k-flow payee; two full profiles (GraphQL + MCP) each
  // run the public-money slice (~1.2s of flows each) — the 15s public-money timeout
  // class applies, so this 4-call cross-check needs a generous bound.

  it('MCP exposes the expected company tools', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/mcp',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      payload: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    });
    // eslint-disable-next-line no-restricted-syntax -- test parses a trusted MCP JSON-RPC response
    const body = JSON.parse(res.body) as { result?: { tools?: { name: string }[] } };
    const names = (body.result?.tools ?? []).map((t) => t.name);
    expect(names).toContain('resolve_company_filter');
    expect(names).toContain('get_company_snapshot');
    expect(names).toContain('list_companies');
    expect(names).toContain('get_company_financials');
    expect(names).toContain('company_county_profile');
  });

  it('county aggregate is gated without a selective predicate', async () => {
    const res = await gql(`query{ companyCountyProfile(groupBy: COUNTY){ denominator groups { key count } } }`);
    // groupBy=COUNTY with no filter must be rejected (no raw_county index).
    expect(res.errors).toBeDefined();
  });

  it('county aggregate runs with a selective predicate', async () => {
    const res = await gql(
      `query{ companyCountyProfile(filter: { status: { in: ["1048"] } }, groupBy: COUNTY){ denominator coverage { note } groups { key count } } }`
    );
    expect(res.errors).toBeUndefined();
    const prof = (res.data as { companyCountyProfile: { denominator: number; groups: unknown[] } }).companyCountyProfile;
    expect(prof.denominator).toBeGreaterThan(0);
    expect(prof.groups.length).toBeGreaterThan(0);
  });

  it('territory.matchConfidence serializes to the SDL enum (SAFE) on a safe-matched company', async () => {
    // CUI 33243634 has a safe-matched UAT territory; the lowercase domain value
    // 'safe' must serialize to the GraphQL enum SAFE (not error).
    const res = await gql(`query{ company(cui: "33243634"){ territory { matchConfidence sirutaCode } } }`);
    expect(res.errors).toBeUndefined();
    const t = (res.data as { company: { territory: { matchConfidence: string } | null } }).company.territory;
    expect(t?.matchConfidence).toBe('SAFE');
  });

  it('q (name) intersects with the filter and paginates (does not bypass filters)', async () => {
    // "DEDEMAN" + a status the golden company does NOT have → empty (filter applied).
    const res = await gql(
      `query{ companies(q: "DEDEMAN", filter: { status: { in: ["1084"] } }, first: 5){ totalCount edges { node { cui } } } }`
    );
    expect(res.errors).toBeUndefined();
    const conn = (res.data as { companies: { edges: { node: { cui: string } }[] } }).companies;
    // The golden DEDEMAN SRL is status 1048, so a 1084 filter must exclude it.
    expect(conn.edges.every((e) => e.node.cui !== '2816464')).toBe(true);
  });

  it('rejects an empty in: [] (would otherwise match all companies)', async () => {
    const res = await gql(`query{ companies(filter: { status: { in: [] } }, first: 1){ totalCount } }`);
    expect(res.errors).toBeDefined();
  });

  // ── QA-audit fixes (server doc 03-private-companies-qa-audit) ────────────────

  it('C4: companyResolve(CAEN) resolves by CODE, not only label text', async () => {
    const res = await gql(`query{ companyResolve(dim: CAEN, q: "6201"){ dim value label } }`);
    expect(res.errors).toBeUndefined();
    const hits = (res.data as { companyResolve: { value: string }[] }).companyResolve;
    // "6201" must surface the 6201 code (label-only search returned 0 before).
    expect(hits.some((h) => h.value === '6201')).toBe(true);
  });

  it('M9: companyResolve(REGNUM) is case-insensitive (lowercase j… resolves)', async () => {
    const res = await gql(`query{ companyResolve(dim: REGNUM, q: "j1992002621040"){ cui } }`);
    expect(res.errors).toBeUndefined();
    const hits = (res.data as { companyResolve: { cui: string }[] }).companyResolve;
    expect(hits.some((h) => h.cui === DEDEMAN)).toBe(true);
  });

  it('M11: county aggregate coverage is populated and sums to the denominator', async () => {
    const res = await gql(
      `query{ companyCountyProfile(filter: { status: { in: ["1048"] } }, groupBy: COUNTY){
         denominator coverage { territoryMatched territoryUnmatched } } }`
    );
    expect(res.errors).toBeUndefined();
    const prof = (res.data as { companyCountyProfile: { denominator: number; coverage: { territoryMatched: number | null; territoryUnmatched: number | null } } }).companyCountyProfile;
    expect(prof.coverage.territoryMatched).not.toBeNull();
    expect(prof.coverage.territoryUnmatched).not.toBeNull();
    expect((prof.coverage.territoryMatched ?? 0) + (prof.coverage.territoryUnmatched ?? 0)).toBe(prof.denominator);
  }, 15_000);

  it('C1/C2: CAEN_DIVISION + caenCode runs (no timeout) and APPLIES the filter', async () => {
    // The audit hypothesized an alias crash (C1) / ignored filter (C2). The REAL
    // cause was a slow per-org EXISTS forcing the full o⋈r⋈f product before the
    // filter (~27s). The IN-subquery rewrite (caenExists, audit M8) + a materialized
    // filtered CTE bring it to ~3.6s warm (~14s on a fully cold cache — a data-volume
    // property of the 18M-row caen_activities table; the durable fix is a precomputed
    // (cui, division) rollup, tracked as a follow-up). Warm once, then assert the
    // realistic (warm) behavior.
    const q = `query{ companyCountyProfile(filter: { caenCode: { eq: "6201" } }, groupBy: CAEN_DIVISION){ denominator groups { key count } } }`;
    await gql(q).catch(() => undefined); // warm caen_activities pages
    const res = await gql(q);
    expect(res.errors).toBeUndefined();
    const prof = (res.data as { companyCountyProfile: { denominator: number; groups: { key: string }[] } }).companyCountyProfile;
    expect(prof.groups.some((g) => g.key === '62')).toBe(true);
    expect(prof.denominator).toBeGreaterThan(0);
    expect(prof.denominator).toBeLessThan(1_000_000); // C2: filter applied (not the full ~1.2M universe)
  }, 40_000);

  it('H4: publicMoney.byYear carries a populated year and byFlowType is present', async () => {
    const query = `query($cui: CUI!){ company(cui:$cui){ publicMoney {
         flowCount byYear { year flowType totalRon } byFlowType { flowType totalRon } } } }`;
    await gql(query, { cui: DEDEMAN }).catch(() => undefined); // warm the 219k-flow payee's pages
    const res = await gql(query, { cui: DEDEMAN });
    expect(res.errors).toBeUndefined();
    const pm = (res.data as { company: { publicMoney: { byYear: { year: number | null }[]; byFlowType: { flowType: string }[] } | null } }).company.publicMoney;
    expect(pm).not.toBeNull();
    expect(pm?.byYear.length).toBeGreaterThan(0);
    // at least one bucket carries a real year (was 100% null before H4).
    expect(pm?.byYear.some((b) => b.year !== null)).toBe(true);
    expect(pm?.byFlowType.length).toBeGreaterThan(0);
  }, 25_000); // 3 concurrent flow aggregates on a 219k-flow payee, cold cache.
});
