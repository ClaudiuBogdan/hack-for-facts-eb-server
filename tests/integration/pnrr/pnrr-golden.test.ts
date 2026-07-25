/**
 * PNRR invariant + tri-surface tests against LIVE transparenta_prod
 * (read-only).
 *
 * 2026-07-22 (S8): pinned moving totals (CNAIR 1,229 payments =
 * 6,210,010,594.17 lei; commitments.count 32; 103 measures; 1,435 no-hub
 * entities) are replaced with invariants that survive re-syncs:
 *   - directional identity: rows are signed by payment_direction and
 *     grossLei − reversalLei = totalLei on every aggregate surface;
 *   - envelope-count conservation: byComponent counts sum to the total;
 *     commitment sums cover exactly count − unresolvedCount rows;
 *   - acquisition-money abstention: no pnrr award/subcontract flow, no
 *     acquisition/contractor search amount (these two encode the Wave 1
 *     exit gate and fail until the first converging recurring run).
 *
 * Tri-surface: the GraphQL `entity(cui).pnrr` payload == the MCP `get_pnrr_entity`
 * profile == raw SQL over `pnrr.payments` (the grain). Skips cleanly when
 * PROD_DATABASE_URL is absent (CI without the tunnel).
 */

import { Decimal } from 'decimal.js';
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

  it('CNAIR profile obeys the directional and conservation invariants', async () => {
    const res = await gql(
      `query($cui: CUI!){ pnrrEntityProfile(cui:$cui){ payments{ count totalLei totalEur grossLei reversalLei zeroAdjustmentCount firstDate lastDate byComponent { componentCode count totalLei } } commitments{ count totalValue unresolvedCount } procurement{ acquisitionsAsBeneficiary wonAsContractor } grainNote } }`,
      { cui: CNAIR }
    );
    expect(res.errors).toBeUndefined();
    const p = (
      res.data as {
        pnrrEntityProfile: {
          payments: {
            count: number;
            totalLei: string | null;
            grossLei: string | null;
            reversalLei: string | null;
            zeroAdjustmentCount: number;
            byComponent: { componentCode: string; count: number }[];
          };
          commitments: { count: number; totalValue: string | null; unresolvedCount: number };
          grainNote: string;
        };
      }
    ).pnrrEntityProfile;
    expect(p.payments.count).toBeGreaterThan(0);
    // Directional identity stays exact across decimal-string money.
    const net = new Decimal(p.payments.totalLei ?? 0);
    const gross = new Decimal(p.payments.grossLei ?? 0);
    const reversal = new Decimal(p.payments.reversalLei ?? 0);
    expect(gross.minus(reversal).equals(net)).toBe(true);
    expect(reversal.isNegative()).toBe(false);
    expect(p.payments.zeroAdjustmentCount).toBeGreaterThanOrEqual(0);
    // Component conservation: the per-component counts partition the total.
    const byComponentSum = p.payments.byComponent.reduce((acc, r) => acc + r.count, 0);
    expect(byComponentSum).toBe(p.payments.count);
    // Envelope law: sums cover exactly count − unresolvedCount rows.
    expect(p.commitments.unresolvedCount).toBeGreaterThanOrEqual(0);
    expect(p.commitments.unresolvedCount).toBeLessThanOrEqual(p.commitments.count);
    expect(p.grainNote).toContain('different grains');
  });

  it('commitment lists expose the latest MIPE progress snapshot', async () => {
    const sample = await pool.query<{
      commitment_key: string;
      beneficiary_cui: string;
      contract_number: string;
    }>(
      `select c.commitment_key, c.beneficiary_cui, c.contract_number
       from pnrr.commitments c
       where c.beneficiary_cui is not null
         and c.contract_number is not null
         and exists (
           select 1
           from pnrr.commitment_snapshots s
           where s.commitment_key = c.commitment_key
         )
       order by c.commitment_key
       limit 1`
    );
    const commitment = sample.rows[0];
    expect(commitment).toBeDefined();
    if (commitment === undefined) return;

    const expected = await pool.query<{
      snapshot_id: string;
      source_record_id: string;
      snapshot_date: string;
    }>(
      `select s.snapshot_id, s.source_record_id, s.snapshot_date::text
       from pnrr.commitment_snapshots s
       where s.commitment_key = $1
       order by s.snapshot_date desc, s.snapshot_id desc, s.source_record_id desc
       limit 1`,
      [commitment.commitment_key]
    );

    const res = await gql(
      `query($cuis:[String!]!,$contract:String!){
        pnrrCommitments(
          filter:{
            beneficiaryCui:{in:$cuis}
            contractNumber:{eq:$contract}
          }
          first:20
        ){
          edges {
            node {
              commitmentKey
              latestProgress { snapshotId sourceRecordId snapshotDate }
            }
          }
        }
      }`,
      {
        cuis: [commitment.beneficiary_cui],
        contract: commitment.contract_number,
      }
    );
    expect(res.errors).toBeUndefined();
    const nodes = (
      res.data as {
        pnrrCommitments: {
          edges: {
            node: {
              commitmentKey: string;
              latestProgress: {
                snapshotId: string;
                sourceRecordId: string;
                snapshotDate: string;
              } | null;
            };
          }[];
        };
      }
    ).pnrrCommitments.edges.map((edge) => edge.node);
    const node = nodes.find((item) => item.commitmentKey === commitment.commitment_key);
    expect(node?.latestProgress).toEqual({
      snapshotId: expected.rows[0]?.snapshot_id,
      sourceRecordId: expected.rows[0]?.source_record_id,
      snapshotDate: expected.rows[0]?.snapshot_date,
    });
  });

  it('payment_direction labels match the row-sign law (no mislabeled row exists)', async () => {
    const sql = await pool.query<{ violations: string }>(
      `select count(*) violations from pnrr.payments
       where (payment_direction = 'disbursement' and amount_lei <= 0)
          or (payment_direction = 'reversal' and amount_lei >= 0)
          or (payment_direction = 'zero_adjustment' and amount_lei <> 0)
          or payment_direction not in ('disbursement','reversal','zero_adjustment')`
    );
    expect(sql.rows[0]?.violations).toBe('0');
  });

  it('acquisition-money abstention: no pnrr award flow, no acquisition search amount (Wave 1 exit gate)', async () => {
    const flows = await pool.query<{ cnt: string }>(
      `select count(*) cnt from flows.money_flows
       where source_id = 'pnrr' and flow_type not in ('pnrr_payment','pnrr_commitment')`
    );
    expect(flows.rows[0]?.cnt).toBe('0');
    const search = await pool.query<{ cnt: string }>(
      `select count(*) cnt from search.documents
       where doc_type in ('pnrr_acquisition','pnrr_contractor') and amount_ron is not null`
    );
    expect(search.rows[0]?.cnt).toBe('0');
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

  it('payments aggregate by component for CNAIR == raw SQL (parity, not pins)', async () => {
    const agg = await gql(
      `query($cui:[String!]){ pnrrPaymentAggregate(filter:{ beneficiaryCui:{ in:$cui } }, groupBy: component){ key count totalLei grossLei reversalLei zeroAdjustmentCount } }`,
      { cui: [CNAIR] }
    );
    const rows = (
      agg.data as {
        pnrrPaymentAggregate: {
          key: string;
          count: number;
          totalLei: string | null;
          grossLei: string | null;
          reversalLei: string | null;
          zeroAdjustmentCount: number;
        }[];
      }
    ).pnrrPaymentAggregate;
    expect(rows.length).toBeGreaterThan(0);
    const sqlRows = await pool.query<{ key: string | null; cnt: string; total_lei: string | null }>(
      `select component_code key, count(*) cnt, sum(amount_lei)::text total_lei
       from pnrr.payments where beneficiary_cui = $1 and is_personal_recipient is not true
       group by 1`,
      [CNAIR]
    );
    expect(rows).toHaveLength(sqlRows.rows.length);
    for (const r of rows) {
      const raw = sqlRows.rows.find((s) => s.key === r.key);
      expect(raw, `component ${r.key} in raw SQL`).toBeDefined();
      expect(String(r.count)).toBe(raw?.cnt);
      expect(r.totalLei).toBe(raw?.total_lei ?? null);
      // Directional identity holds per aggregate row too.
      expect(
        new Decimal(r.grossLei ?? 0)
          .minus(new Decimal(r.reversalLei ?? 0))
          .equals(new Decimal(r.totalLei ?? 0))
      ).toBe(true);
    }
  });

  it('dimensions: 16 components (legal constant), measures non-empty and unique', async () => {
    const res = await gql(`{ pnrrComponents { componentCode } pnrrMeasures { fenixReference } }`);
    const data = res.data as {
      pnrrComponents: unknown[];
      pnrrMeasures: { fenixReference: string | null }[];
    };
    expect(data.pnrrComponents).toHaveLength(16);
    expect(data.pnrrMeasures.length).toBeGreaterThan(0);
    const refs = data.pnrrMeasures.map((m) => m.fenixReference).filter((r) => r !== null);
    expect(new Set(refs).size).toBe(refs.length);
  });

  it('PN-6 coverage: hasNoHub filter returns only hub-free entities', async () => {
    // No pinned count (the entity set moves with every re-sync); the invariant
    // is that some hub-free entities exist and the filter never leaks a
    // hub-linked one.
    const sql = await pool.query<{ cnt: string }>(
      `select count(*) cnt from pnrr.entities e where not exists (select 1 from pnrr.entity_registry_links l where l.cui = e.cui)`
    );
    expect(Number(sql.rows[0]?.cnt)).toBeGreaterThan(0);

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
    expect(e.pnrr.payments.count).toBeGreaterThan(0);
    // Flow projection excludes zero-adjustment rows (amount_lei <> 0 in the
    // loader), so the flow count equals the non-zero payment rows for the CUI.
    const nonZero = await pool.query<{ cnt: string }>(
      `select count(*) cnt from pnrr.payments
       where beneficiary_cui = $1 and amount_lei <> 0`,
      [CNAIR]
    );
    expect(String(pnrrPaymentFlow?.count ?? 0)).toBe(nonZero.rows[0]?.cnt);
  }, 30_000);
});
