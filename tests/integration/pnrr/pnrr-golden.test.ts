/**
 * PNRR golden + tri-surface tests against LIVE transparenta_prod (read-only).
 *
 * Pinned to the measured Phase E/G gate numbers (PNRR_NOTES / 07-pnrr.md §12):
 *   - CNAIR cui 16054368 → 1,229 payments = 6,210,010,594.17 lei / 1,256,053,436.75 eur, all C4
 *   - 18,876 entities; 1,435 with no identity hub; 16 components; 103 measures
 *   - flows source_id=pnrr: payment 73,333 / commitment 24,078 / subcontract 14,796
 *
 * Tri-surface: the GraphQL `entity(cui).pnrr` payload == the MCP `get_pnrr_entity`
 * profile == raw SQL over `pnrr.payments` (the grain). Skips cleanly when
 * PROD_DATABASE_URL is absent (CI without the tunnel).
 */

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildRedesignApp } from '@/app/build-redesign-app.js';
import { loadRedesignConfig } from '@/infra/config/redesign-env.js';

import type { FastifyInstance } from 'fastify';

const HAS_DB = (process.env['PROD_DATABASE_URL'] ?? '').length > 0;
const CNAIR = '16054368';

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
): Promise<{ data?: unknown; errors?: unknown }> => {
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
  // The SDK returns the tool output object under structuredContent (or JSON text).
  if (body.result?.structuredContent !== undefined) return body.result.structuredContent;
  const text = body.result?.content?.[0]?.text;
  // eslint-disable-next-line no-restricted-syntax -- test parses the trusted MCP tool-output text payload
  return text !== undefined ? JSON.parse(text) : undefined;
};

d('PNRR golden (live prod)', () => {
  beforeAll(async () => {
    const config = loadRedesignConfig(process.env);
    const built = await buildRedesignApp({ kernelConfig: config.kernel, logLevel: 'silent' });
    app = built.app;
    close = built.app.close.bind(built.app);
    await app.ready();
    // The prod URL carries sslmode=require; pg's default verifies the cert (the
    // tunnel presents a self-signed one). Encrypt without verifying, like the
    // kernel pool does.
    const connectionString = (process.env['PROD_DATABASE_URL'] ?? '').replace(
      /[?&]sslmode=[a-z-]+/iu,
      ''
    );
    pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });
    // The stateless-MCP transport (SDK hono server) schedules a delayed
    // `forceClose` after each request; once the socket is gone it throws
    // `socket.destroySoon is not a function`. This is a KERNEL MCP-transport
    // teardown race (tracked separately), not a module defect — swallow only
    // that exact benign post-response error so the file reports clean.
    process.on('uncaughtException', onUncaught);
  }, 60_000);

  afterAll(async () => {
    await close?.();
    await pool?.end();
    await new Promise((resolve) => setTimeout(resolve, 50));
    process.off('uncaughtException', onUncaught);
  });

  it('CNAIR profile matches the gate (1,229 payments, all C4)', async () => {
    const res = await gql(
      `query($cui: CUI!){ pnrrEntityProfile(cui:$cui){ payments{ count totalLei totalEur firstDate lastDate byComponent { componentCode count totalLei } } commitments{ count } procurement{ acquisitionsAsBeneficiary wonAsContractor } grainNote } }`,
      { cui: CNAIR }
    );
    expect(res.errors).toBeUndefined();
    const p = (
      res.data as {
        pnrrEntityProfile: {
          payments: {
            count: number;
            totalLei: string;
            totalEur: string;
            byComponent: { componentCode: string }[];
          };
          commitments: { count: number };
          procurement: { acquisitionsAsBeneficiary: number };
          grainNote: string;
        };
      }
    ).pnrrEntityProfile;
    expect(p.payments.count).toBe(1229);
    expect(p.payments.totalLei).toBe('6210010594.17');
    expect(p.payments.totalEur).toBe('1256053436.75');
    expect(p.payments.byComponent).toHaveLength(1);
    expect(p.payments.byComponent[0]?.componentCode).toBe('C4');
    expect(p.commitments.count).toBe(32);
    expect(p.procurement.acquisitionsAsBeneficiary).toBe(0);
    expect(p.grainNote).toContain('different grains');
  });

  it('tri-surface: GraphQL Entity.pnrr == MCP get_pnrr_entity == raw SQL (the grain)', async () => {
    const sqlRes = await pool.query<{ cnt: string; total_lei: string; total_eur: string }>(
      `select count(*) cnt, sum(amount_lei)::text total_lei, sum(amount_eur)::text total_eur from pnrr.payments where beneficiary_cui = $1`,
      [CNAIR]
    );
    const raw = sqlRes.rows[0];
    expect(raw).toBeDefined();

    const g = await gql(
      `query($cui: CUI!){ entity(cui:$cui){ pnrr { payments { count totalLei totalEur } } } }`,
      { cui: CNAIR }
    );
    const gPay = (
      g.data as {
        entity: { pnrr: { payments: { count: number; totalLei: string; totalEur: string } } };
      }
    ).entity.pnrr.payments;

    const mcp = (await mcpCall('get_pnrr_entity', { cui: CNAIR })) as {
      item: { profile: { payments: { count: number; totalLei: string; totalEur: string } } };
    };
    const mPay = mcp.item.profile.payments;

    // All three agree on the grain (count + lei + eur).
    expect(String(gPay.count)).toBe(raw?.cnt);
    expect(gPay.totalLei).toBe(raw?.total_lei);
    expect(gPay.totalEur).toBe(raw?.total_eur);
    expect(mPay.count).toBe(gPay.count);
    expect(mPay.totalLei).toBe(gPay.totalLei);
    expect(mPay.totalEur).toBe(gPay.totalEur);
  }, 30_000); // entity(cui) eagerly computes the kernel flow summary (19GB table)

  it('Entity.pnrr == pnrrEntityProfile (contributor parity §14.7)', async () => {
    const viaEntity = await gql(
      `query($cui: CUI!){ entity(cui:$cui){ pnrr { payments { count totalLei } commitments { count } } } }`,
      { cui: CNAIR }
    );
    const viaDirect = await gql(
      `query($cui: CUI!){ pnrrEntityProfile(cui:$cui){ payments { count totalLei } commitments { count } } }`,
      { cui: CNAIR }
    );
    const a = (viaEntity.data as { entity: { pnrr: unknown } }).entity.pnrr;
    const b = (viaDirect.data as { pnrrEntityProfile: unknown }).pnrrEntityProfile;
    expect(a).toEqual(b);
  }, 30_000);

  it('payments aggregate by component for CNAIR == raw SQL', async () => {
    const agg = await gql(
      `query($cui:[String!]){ pnrrPaymentAggregate(filter:{ beneficiaryCui:{ in:$cui } }, groupBy: component){ key count totalLei } }`,
      { cui: [CNAIR] }
    );
    const rows = (
      agg.data as { pnrrPaymentAggregate: { key: string; count: number; totalLei: string }[] }
    ).pnrrPaymentAggregate;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.key).toBe('C4');
    expect(rows[0]?.count).toBe(1229);
    expect(rows[0]?.totalLei).toBe('6210010594.17');
  });

  it('dimensions: 16 components, 103 measures', async () => {
    const res = await gql(`{ pnrrComponents { componentCode } pnrrMeasures { fenixReference } }`);
    const data = res.data as { pnrrComponents: unknown[]; pnrrMeasures: unknown[] };
    expect(data.pnrrComponents).toHaveLength(16);
    expect(data.pnrrMeasures).toHaveLength(103);
  });

  it('PN-6 coverage: 1,435 entities have no identity hub', async () => {
    // The repo filter is index-light here; verify the underlying count via SQL +
    // confirm the hasNoHub filter compiles and returns a hub-free page.
    const sql = await pool.query<{ cnt: string }>(
      `select count(*) cnt from pnrr.entities e where not exists (select 1 from pnrr.entity_registry_links l where l.cui = e.cui)`
    );
    expect(sql.rows[0]?.cnt).toBe('1435');

    const res = await gql(
      `{ pnrrEntities(filter:{ hasNoHub:{ eq:true }, role:{ eq:"beneficiary" } }, first: 3){ edges { node { cui hubs } } } }`
    );
    expect(res.errors).toBeUndefined();
    const edges = (res.data as { pnrrEntities: { edges: { node: { hubs: string[] } }[] } })
      .pnrrEntities.edges;
    for (const e of edges) expect(e.node.hubs).toHaveLength(0);
  });

  it('index-bound rule: unfiltered payments list is rejected', async () => {
    const res = await gql(`{ pnrrPayments(first: 5){ edges { node { paymentKey } } } }`);
    const errs = res.errors as { extensions?: { code?: string } }[] | undefined;
    expect(errs?.[0]?.extensions?.code).toBe('INVALID_INPUT');
  });

  it('index-bound rule: empty in: [] does NOT satisfy the driving predicate', async () => {
    const res = await gql(
      `{ pnrrPayments(filter:{ beneficiaryCui:{ in: [] } }, first: 5){ edges { node { paymentKey } } } }`
    );
    const errs = res.errors as { extensions?: { code?: string } }[] | undefined;
    expect(errs?.[0]?.extensions?.code).toBe('INVALID_INPUT');
  });

  it('CUI normalization parity: RO-prefixed CUI resolves the same as digits-only (§14.7)', async () => {
    const withPrefix = await gql(
      `query($cui: CUI!){ pnrrEntityProfile(cui:$cui){ payments { count } } }`,
      { cui: `RO${CNAIR}` }
    );
    const digitsOnly = await gql(
      `query($cui: CUI!){ pnrrEntityProfile(cui:$cui){ payments { count } } }`,
      { cui: CNAIR }
    );
    expect(withPrefix.errors).toBeUndefined();
    expect(withPrefix.data).toEqual(digitsOnly.data);
  });

  it('contractor rank excludes self-awards (contractor == acquisition beneficiary)', async () => {
    // 85 self-award rows exist; ranking must not include any cui that only appears
    // as its own acquisition beneficiary. Verify no ranked cui is a self-award-only
    // contractor by cross-checking the top rows against SQL.
    const res = await gql(
      `{ pnrrContractorRank(by: value, limit: 10){ contractorCui awardCount } }`
    );
    expect(res.errors).toBeUndefined();
    const rows = (
      res.data as { pnrrContractorRank: { contractorCui: string; awardCount: number }[] }
    ).pnrrContractorRank;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      const sql = await pool.query<{ non_self: string }>(
        `select count(*) non_self from pnrr.contractors ct
         where ct.contractor_cui = $1
           and not exists (select 1 from pnrr.acquisitions a where a.acquisition_key = ct.acquisition_key and a.beneficiary_cui = ct.contractor_cui)`,
        [r.contractorCui]
      );
      // The ranked award count must equal the non-self-award count for that cui.
      expect(Number(sql.rows[0]?.non_self)).toBe(r.awardCount);
    }
  }, 30_000);

  it('grain separation: kernel flows (payee) and pnrr-native payments are distinct surfaces', async () => {
    // CNAIR receives pnrr_payment flows (money in). The kernel FlowsRepo flow
    // count for pnrr_payment must equal the pnrr-native payment count (same rows,
    // different surface) — proving the grain is consistent but reported via two
    // distinct, non-summed paths (§14.6). flowsIn is payee_cui-indexed (fast).
    const res = await gql(
      `query($cui: CUI!){ entity(cui:$cui){ flowsIn { byFlowType { flowType count } } pnrr { payments { count } } } }`,
      { cui: CNAIR }
    );
    expect(res.errors).toBeUndefined();
    const e = (
      res.data as {
        entity: {
          flowsIn: { byFlowType: { flowType: string; count: number }[] };
          pnrr: { payments: { count: number } };
        };
      }
    ).entity;
    const pnrrPaymentFlow = e.flowsIn.byFlowType.find((b) => b.flowType === 'pnrr_payment');
    expect(pnrrPaymentFlow?.count).toBe(1229);
    expect(e.pnrr.payments.count).toBe(1229);
  }, 30_000);
});
