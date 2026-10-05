/**
 * Companies golden + tri-surface tests against LIVE transparenta_prod (read-only).
 *
 * Pinned to measured live data (verified 2026-06-16 on transparenta-prod-postgres-1):
 *   - golden CUI 2816464 = DEDEMAN SRL, org_id 1517396, vat=true, is_inactive=false,
 *     employees(2024)=12313, also a flows payee.
 *
 * The ONRC registry is STATE-AWARE (scrapper migration 20261003T172000): every
 * registry assertion first reads `companyRegistry`. Before an edition is
 * published (or while unreadable/withdrawn) the registry fields are null with
 * the state on the profile, registry filters/groupings are refused, and the
 * fiscal/financial/public-money content is unchanged. Once published, the
 * registry fields are compared with raw SQL over the PUBLIC views bound to the
 * pinned edition id. Skips cleanly when PROD_DATABASE_URL is absent.
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

const gql = async (
  query: string,
  variables?: Record<string, unknown>
): Promise<{ data?: unknown; errors?: { extensions?: { code?: string } }[] }> => {
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
    payload: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
  // eslint-disable-next-line no-restricted-syntax -- test parses a trusted MCP JSON-RPC response body
  const body = JSON.parse(res.body) as {
    result?: { structuredContent?: unknown; content?: { text?: string }[] };
  };
  if (body.result?.structuredContent !== undefined) return body.result.structuredContent;
  const text = body.result?.content?.[0]?.text;
  // eslint-disable-next-line no-restricted-syntax -- test parses the trusted MCP tool-output text payload
  return text !== undefined ? JSON.parse(text) : undefined;
};

interface Registry {
  state: 'PUBLISHED' | 'UNPUBLISHED' | 'WITHDRAWN' | 'UNAVAILABLE';
  editionId: string | null;
  scopeKey: string;
}

const registry = async (): Promise<Registry> => {
  const res = await gql(`query{ companyRegistry { registry { state editionId scopeKey } } }`);
  expect(res.errors).toBeUndefined();
  return (res.data as { companyRegistry: { registry: Registry } }).companyRegistry.registry;
};

const expectUnavailable = (res: { errors?: { extensions?: { code?: string } }[] }): void => {
  expect(res.errors?.[0]?.extensions?.code).toBe('SERVICE_UNAVAILABLE');
};

d('Companies golden (live prod)', () => {
  beforeAll(async () => {
    const config = loadRedesignConfig(process.env);
    const built = await buildRedesignApp({ kernelConfig: config.kernel, logLevel: 'silent' });
    app = built.app;
    close = built.app.close.bind(built.app);
    await app.ready();
    const connectionString = (process.env['PROD_DATABASE_URL'] ?? '').replace(
      /[?&]sslmode=[a-z-]+/iu,
      ''
    );
    pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });
    process.on('uncaughtException', onUncaught);
  }, 60_000);

  afterAll(async () => {
    await close?.();
    await pool?.end();
    await new Promise((resolve) => setTimeout(resolve, 50));
    process.off('uncaughtException', onUncaught);
  });

  it('company(2816464): directory spine, fiscal and financial content in every registry state', async () => {
    const reg = await registry();
    const res = await gql(
      `query($cui: CUI!){ company(cui:$cui){
         cui orgId name nameSource legalForm codInmatriculare registrationDate registrationDatePresent
         headlineStatus { code label labelSource } euBranches { country }
         fiscal { vatPayer declaredFiscallyInactive mainCaenCode }
         financials { year turnover employees } representatives { name role }
         publicMoney { totalRon flowCount } asOf { onrc anaf }
         registry { cuiState registry { state editionId scopeKey } }
       } }`,
      { cui: DEDEMAN }
    );
    expect(res.errors).toBeUndefined();
    const c = (
      res.data as {
        company: {
          orgId: string;
          nameSource: string;
          legalForm: string | null;
          headlineStatus: { code: string } | null;
          euBranches: unknown[];
          fiscal: { vatPayer: boolean; declaredFiscallyInactive: boolean };
          financials: { year: number; employees: string }[];
          representatives: unknown[];
          publicMoney: { flowCount: number } | null;
          asOf: { onrc: string | null };
          registry: { cuiState: string; registry: Registry };
        };
      }
    ).company;
    expect(c.orgId).toBe('1517396');
    expect(c.fiscal.vatPayer).toBe(true);
    expect(c.fiscal.declaredFiscallyInactive).toBe(false);
    expect(c.financials.find((f) => f.year === 2024)?.employees).toBe('12313'); // bigint string
    expect(c.representatives).toEqual([]); // v2 person/role tables are restricted.
    expect(c.euBranches).toEqual([]); // not part of the ONRC edition contract
    expect(c.publicMoney?.flowCount).toBeGreaterThan(0);
    expect(c.registry.registry.scopeKey).toBe(reg.scopeKey);
    if (reg.state !== 'PUBLISHED') {
      // No legacy fallback: the registry fields are the state, not old scalars.
      expect(c.registry.cuiState).toBe(reg.state);
      expect(c.legalForm).toBeNull();
      expect(c.headlineStatus).toBeNull();
      expect(c.asOf.onrc).toBeNull();
      expect(c.nameSource).toBe('CORE_ORGANIZATION');
    }
  }, 25_000);

  it('published registry fields equal raw SQL over the public views of the pinned edition', async () => {
    const reg = await registry();
    if (reg.state !== 'PUBLISHED' || reg.editionId === null) return;
    const raw = await pool.query<{
      name: string | null;
      legal_form: string | null;
      status_code: string | null;
      recorded_date: string | null;
    }>(
      `select p.name, p.legal_form, p.status_code, p.recorded_date::text as recorded_date
         from companies_v2.onrc_published_profiles p
        where p.edition_id = $1::bigint and p.cui = $2`,
      [reg.editionId, DEDEMAN]
    );
    const res = await gql(
      `query($cui: CUI!){ company(cui:$cui){ name legalForm registrationDate headlineStatus { code }
         registry { cuiState profile { statusCode { value basis } } } } }`,
      { cui: DEDEMAN }
    );
    const c = (
      res.data as {
        company: {
          name: string;
          legalForm: string | null;
          registrationDate: string | null;
          headlineStatus: { code: string } | null;
          registry: { cuiState: string };
        };
      }
    ).company;
    const row = raw.rows[0];
    if (row === undefined) {
      expect(c.registry.cuiState).toBe('NOT_IN_EDITION');
      return;
    }
    expect(c.registry.cuiState).toBe('IN_EDITION');
    if (row.name !== null) expect(c.name).toBe(row.name);
    expect(c.legalForm).toBe(row.legal_form);
    expect(c.registrationDate).toBe(row.recorded_date);
    expect(c.headlineStatus?.code ?? null).toBe(row.status_code);
  });

  it('drops is_active: no surface emits an "active"-named boolean; declaredFiscallyInactive present', async () => {
    const res = await gql(
      `query($cui: CUI!){ company(cui:$cui){ fiscal { declaredFiscallyInactive } } }`,
      { cui: DEDEMAN }
    );
    const str = JSON.stringify(res.data);
    expect(str).toContain('declaredFiscallyInactive');
    expect(/"is_?active"/i.test(str)).toBe(false);
    const r = await pool.query<{ cnt: string }>(
      `select count(*) cnt
         from information_schema.columns
        where table_schema='companies_v2'
          and table_name='fiscal_status'
          and column_name='is_active'`
    );
    expect(Number(r.rows[0]?.cnt)).toBe(0);
  });

  it('registry filters: same-identifier list when published, refused (never empty) otherwise', async () => {
    const reg = await registry();
    const res = await gql(
      `query{ companies(filter: { county: { in: ["Bacău"] }, status: { in: ["1048"] } }, first: 5){
         totalCount edges { node { cui hasActiveObservation registryCuiState } }
         registry { state editionId }
       } }`
    );
    if (reg.state !== 'PUBLISHED') {
      expectUnavailable(res);
      return;
    }
    expect(res.errors).toBeUndefined();
    const conn = (
      res.data as {
        companies: {
          edges: { node: { hasActiveObservation: boolean; registryCuiState: string } }[];
          registry: { editionId: string };
        };
      }
    ).companies;
    expect(conn.registry.editionId).toBe(reg.editionId);
    for (const e of conn.edges) {
      expect(e.node.registryCuiState).toBe('IN_EDITION');
      expect(e.node.hasActiveObservation).toBe(true);
    }
  });

  it('companyResolve(REGNUM) uses the pinned edition when published, refused otherwise', async () => {
    const reg = await registry();
    const res = await gql(
      `query{ companyResolve(dim: REGNUM, q: "J1992002621040"){ dim value label cui labelSource } }`
    );
    if (reg.state !== 'PUBLISHED') {
      expectUnavailable(res);
      return;
    }
    expect(res.errors).toBeUndefined();
  });

  it('companyResolve(NAME) returns the golden company (Meili-primary or pg fallback)', async () => {
    const res = await gql(
      `query{ companyResolve(dim: NAME, q: "DEDEMAN", limit: 5){ value label cui labelSource } }`
    );
    const hits = (res.data as { companyResolve: { cui: string | null }[] }).companyResolve;
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((h) => h.cui === DEDEMAN)).toBe(true);
  });

  it('tri-surface: GraphQL company == Entity.company == MCP snapshot (one registry contract)', async () => {
    const g = await gql(
      `query($cui: CUI!){ company(cui:$cui){ name nameSource legalForm headlineStatus { code } } }`,
      { cui: DEDEMAN }
    );
    const gc = (
      g.data as {
        company: {
          name: string;
          legalForm: string | null;
          headlineStatus: { code: string } | null;
        };
      }
    ).company;
    const e = await gql(
      `query($cui: CUI!){ entity(cui:$cui){ company { name legalForm headlineStatus { code } } } }`,
      { cui: DEDEMAN }
    );
    const ec = (
      e.data as {
        entity: {
          company: {
            name: string;
            legalForm: string | null;
            headlineStatus: { code: string } | null;
          };
        };
      }
    ).entity.company;
    const m = (await mcpCall('get_company_snapshot', { cui: DEDEMAN })) as {
      item: { name: string; legalForm: string | null; headlineStatus: { code: string } | null };
    };
    expect(ec.name).toBe(gc.name);
    expect(m.item.name).toBe(gc.name);
    expect(ec.legalForm).toBe(gc.legalForm);
    expect(m.item.legalForm).toBe(gc.legalForm);
    expect(ec.headlineStatus?.code ?? null).toBe(gc.headlineStatus?.code ?? null);
    expect(m.item.headlineStatus?.code ?? null).toBe(gc.headlineStatus?.code ?? null);
  }, 20_000);

  it('MCP exposes the expected company tools', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/mcp',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      payload: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    });
    // eslint-disable-next-line no-restricted-syntax -- test parses a trusted MCP JSON-RPC response
    const body = JSON.parse(res.body) as { result?: { tools?: { name: string }[] } };
    const names = (body.result?.tools ?? []).map((t) => t.name);
    for (const name of [
      'resolve_company_filter',
      'get_company_snapshot',
      'list_companies',
      'get_company_financials',
      'company_county_profile',
      'company_hub_stats',
      'get_company_registry',
    ]) {
      expect(names).toContain(name);
    }
  });

  it('county aggregate is gated without a selective predicate', async () => {
    const res = await gql(
      `query{ companyCountyProfile(groupBy: COUNTY){ denominator groups { key count } } }`
    );
    expect(res.errors).toBeDefined();
  });

  it('county aggregate: the population once per bucket when published, refused otherwise', async () => {
    const reg = await registry();
    const res = await gql(
      `query{ companyCountyProfile(filter: { status: { in: ["1048"] } }, groupBy: COUNTY){
         denominator coverage { territoryMatched territoryUnmatched note } groups { key count basis } } }`
    );
    if (reg.state !== 'PUBLISHED') {
      expectUnavailable(res);
      return;
    }
    expect(res.errors).toBeUndefined();
    const prof = (
      res.data as {
        companyCountyProfile: {
          denominator: number;
          coverage: { territoryMatched: number; territoryUnmatched: number };
          groups: { count: number }[];
        };
      }
    ).companyCountyProfile;
    expect(prof.groups.reduce((s, g) => s + g.count, 0)).toBe(prof.denominator);
    expect(prof.coverage.territoryMatched + prof.coverage.territoryUnmatched).toBe(
      prof.denominator
    );
  }, 60_000);

  it('rejects an empty in: [] (would otherwise match all companies)', async () => {
    const res = await gql(
      `query{ companies(filter: { status: { in: [] } }, first: 1){ totalCount } }`
    );
    expect(res.errors).toBeDefined();
  });

  it('C4: companyResolve(CAEN) resolves by CODE with its revision and exact key', async () => {
    const res = await gql(
      `query{ companyResolve(dim: CAEN, q: "6201"){ dim value label revision key labelSource } }`
    );
    expect(res.errors).toBeUndefined();
    const hits = (
      res.data as { companyResolve: { value: string; revision: string; key: string }[] }
    ).companyResolve;
    expect(hits.some((h) => h.value === '6201')).toBe(true);
    for (const h of hits) expect(h.key).toBe(`${h.revision}:${h.value}`);
  });

  it('H4: publicMoney.byYear carries a populated year and byFlowType is present', async () => {
    const query = `query($cui: CUI!){ company(cui:$cui){ publicMoney {
         flowCount byYear { year flowType totalRon } byFlowType { flowType totalRon } } } }`;
    await gql(query, { cui: DEDEMAN }).catch(() => undefined); // warm the 219k-flow payee's pages
    const res = await gql(query, { cui: DEDEMAN });
    expect(res.errors).toBeUndefined();
    const pm = (
      res.data as {
        company: {
          publicMoney: {
            byYear: { year: number | null }[];
            byFlowType: { flowType: string }[];
          } | null;
        };
      }
    ).company.publicMoney;
    expect(pm).not.toBeNull();
    expect(pm?.byYear.some((b) => b.year !== null)).toBe(true);
    expect(pm?.byFlowType.length).toBeGreaterThan(0);
  }, 25_000);

  it('companyHubStats: bound to the registry scope (refused when not published)', async () => {
    const reg = await registry();
    const res = await gql(
      `query{ companyHubStats { totalCompanies activeCompanies computedAt
         statusMix { key count basis } registry { scopeKey } } }`
    );
    if (reg.state !== 'PUBLISHED') {
      expectUnavailable(res);
      return;
    }
    expect(res.errors).toBeUndefined();
    const s = (
      res.data as {
        companyHubStats: {
          totalCompanies: number;
          activeCompanies: number;
          statusMix: { count: number }[];
          registry: { scopeKey: string };
        };
      }
    ).companyHubStats;
    expect(s.registry.scopeKey).toBe(reg.scopeKey);
    // Each spine company in exactly one consensus/basis bucket.
    expect(s.statusMix.reduce((acc, g) => acc + g.count, 0)).toBe(s.totalCompanies);
    expect(s.activeCompanies).toBeLessThanOrEqual(s.totalCompanies);
  }, 180_000);
});
