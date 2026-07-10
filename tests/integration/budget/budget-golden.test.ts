/**
 * Budget golden + tri-surface + perf-guard tests against LIVE transparenta_prod
 * (read-only). Pinned to measured values (verified 2026-06-17):
 *   - MUNICIPIUL CLUJ-NAPOCA cui 4305857, 2025, EXECUTION_DETAILED MV:
 *       income 2371025424.36 / expense 1522424280.79 / balance 848601143.57
 *   - its default report type is AGG_PRINCIPAL (drives the entity-360 slice).
 *   - bgc_official_facts = 0 ⇒ vs-execution is empty + caveat.
 *
 * Tri-surface: GraphQL summary == MCP snapshot == raw SQL over the MV. Perf-guard:
 * a fact list/aggregate EXPLAIN prunes to ≤1 leaf (no Seq Scan / all-partition
 * Append over the 126M-row parent). Skips cleanly when PROD_DATABASE_URL is absent.
 */

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildRedesignApp } from '@/app/build-redesign-app.js';
import { loadRedesignConfig } from '@/infra/config/redesign-env.js';

import type { FastifyInstance } from 'fastify';

const HAS_DB = (process.env['PROD_DATABASE_URL'] ?? '').length > 0;
const CLUJ = '4305857';
const d = HAS_DB ? describe : describe.skip;

let app: FastifyInstance;
let close: () => Promise<void>;
let pool: Pool;

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

const mcpCall = async (
  name: string,
  args: Record<string, unknown>
): Promise<Record<string, unknown>> => {
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
  if (body.result?.structuredContent !== undefined)
    return body.result.structuredContent as Record<string, unknown>;
  const text = body.result?.content?.[0]?.text;
  // eslint-disable-next-line no-restricted-syntax -- test parses the trusted MCP tool-output text payload
  return text !== undefined ? (JSON.parse(text) as Record<string, unknown>) : {};
};

d('budget golden (live prod)', () => {
  beforeAll(async () => {
    const config = loadRedesignConfig(process.env);
    const built = await buildRedesignApp({
      kernelConfig: config.kernel,
      logLevel: 'silent',
      modules: ['budget'],
    });
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

  it('Cluj-Napoca 2025 DETAILED summary matches the pinned MV golden', async () => {
    const res = await gql(
      `query($cui: CUI!){ budgetEntitySummary(cui:$cui, year:2025, reportType:EXECUTION_DETAILED){ year totalIncome totalExpense budgetBalance reportType } }`,
      { cui: CLUJ }
    );
    expect(res.errors).toBeUndefined();
    const rows = (
      res.data as {
        budgetEntitySummary: {
          year: number;
          totalIncome: string;
          totalExpense: string;
          budgetBalance: string;
        }[];
      }
    ).budgetEntitySummary;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.year).toBe(2025);
    expect(rows[0]?.totalIncome).toBe('2371025424.36');
    expect(rows[0]?.totalExpense).toBe('1522424280.79');
    expect(rows[0]?.budgetBalance).toBe('848601143.57');
  });

  it('tri-surface: GraphQL summary == raw MV SQL == MCP snapshot', async () => {
    const sqlRes = await pool.query<{
      total_income: string;
      total_expense: string;
      budget_balance: string;
    }>(
      `select total_income::text, total_expense::text, budget_balance::text
       from budget.mv_execution_summary_annual
       where entity_cui = $1 and year = 2025 and report_type = 'Executie bugetara detaliata'`,
      [CLUJ]
    );
    const raw = sqlRes.rows[0];
    expect(raw).toBeDefined();

    const g = await gql(
      `query($cui: CUI!){ budgetEntitySummary(cui:$cui, year:2025, reportType:EXECUTION_DETAILED){ totalIncome totalExpense } }`,
      { cui: CLUJ }
    );
    const gRow = (
      g.data as { budgetEntitySummary: { totalIncome: string; totalExpense: string }[] }
    ).budgetEntitySummary[0];
    expect(gRow?.totalIncome).toBe(raw?.total_income);
    expect(gRow?.totalExpense).toBe(raw?.total_expense);

    const mcp = await mcpCall('get_budget_entity_snapshot', {
      cui: CLUJ,
      year: 2025,
      reportType: 'EXECUTION_DETAILED',
    });
    const item = (mcp['item'] as { execution: { totalIncome: string; totalExpense: string } })
      .execution;
    expect(item.totalIncome).toBe(raw?.total_income);
    expect(item.totalExpense).toBe(raw?.total_expense);
  });

  it('classification aggregate (fact path) reconciles with raw SQL over the pruned leaf', async () => {
    const g = await gql(
      `query($cui: String!){ budgetAggregateByClassification(filter:{ reportingYear:{eq:2025}, reportType:{eq:"EXECUTION_DETAILED"}, accountCategory:{eq:"EXPENSE"}, frequency:{eq:"YEAR"}, entityCuis:{in:[$cui]} }, limit:5){ functionalCode economicCode amount lineCount } }`,
      { cui: CLUJ }
    );
    const rows = (
      g.data as {
        budgetAggregateByClassification: {
          functionalCode: string;
          economicCode: string | null;
          amount: string;
        }[];
      }
    ).budgetAggregateByClassification;
    expect(rows.length).toBeGreaterThan(0);
    const top = rows[0];
    // Independent SQL recomputation of the top (functional × economic) bucket
    // (the Aggregate Accuracy Gate). economic_code may be NULL — a real bucket.
    const sqlRes = await pool.query<{ amount: string }>(
      `select sum(ytd_amount)::text amount from budget.execution_line_items
       where reporting_year = 2025 and report_type = 'Executie bugetara detaliata'
         and account_category = 'ch' and is_yearly = true and entity_cui = $1
         and functional_code = $2 and economic_code is not distinct from $3`,
      [CLUJ, top?.functionalCode, top?.economicCode ?? null]
    );
    expect(sqlRes.rows[0]?.amount).toBe(top?.amount);
  });

  it('contributor parity: Entity.budget uses the default report type (AGG_PRINCIPAL)', async () => {
    const g = await gql(
      `query($cui: CUI!){ entity(cui:$cui){ budget { presence latestCompleteYear reportType totalExpense } } }`,
      { cui: CLUJ }
    );
    const b = (
      g.data as {
        entity: { budget: { presence: boolean; reportType: string; totalExpense: string } };
      }
    ).entity.budget;
    expect(b.presence).toBe(true);
    expect(b.reportType).toBe('EXECUTION_AGG_PRINCIPAL'); // the entity's default_report_type
    expect(b.totalExpense).toBe('2259241251.68');
  }, 30_000);

  it('commitment MONTHLY summary returns null for gap metrics (no crash — R1 fix)', async () => {
    const g = await gql(
      `{ budgetCommitmentSummary(cui:"${CLUJ}", year:2025, frequency:MONTH){ month crediteAngajament platiTrezor receptiiNeplatite crediteBugetare } }`
    );
    expect(g.errors).toBeUndefined();
    const rows = (
      g.data as {
        budgetCommitmentSummary: {
          month: number;
          crediteAngajament: string | null;
          receptiiNeplatite: string | null;
        }[];
      }
    ).budgetCommitmentSummary;
    expect(rows.length).toBeGreaterThan(0);
    // The monthly MV carries crediteAngajament/platiTrezor but NOT receptiiNeplatite/crediteBugetare.
    expect(rows[0]?.crediteAngajament).not.toBeNull();
    expect(rows[0]?.receptiiNeplatite).toBeNull();
  });

  it('aggregate rejects per-capita normalization (no bucket-grain population — R1 fix)', async () => {
    const g = await gql(
      `query($cui: String!){ budgetAggregateByClassification(filter:{ reportingYear:{eq:2025}, reportType:{eq:"EXECUTION_DETAILED"}, accountCategory:{eq:"EXPENSE"}, frequency:{eq:"YEAR"}, entityCuis:{in:[$cui]} }, normalization:PER_CAPITA){ functionalCode } }`,
      { cui: CLUJ }
    );
    expect(JSON.stringify(g.errors)).toContain('per-capita');
  });

  it('aggregate TOTAL_EURO applies the FX factor in SQL (numeric-precise, < RON total)', async () => {
    const ron = await gql(
      `query($cui: String!){ budgetAggregateByClassification(filter:{ reportingYear:{eq:2025}, reportType:{eq:"EXECUTION_DETAILED"}, accountCategory:{eq:"EXPENSE"}, frequency:{eq:"YEAR"}, entityCuis:{in:[$cui]} }, normalization:TOTAL, limit:1){ amount } }`,
      { cui: CLUJ }
    );
    const eur = await gql(
      `query($cui: String!){ budgetAggregateByClassification(filter:{ reportingYear:{eq:2025}, reportType:{eq:"EXECUTION_DETAILED"}, accountCategory:{eq:"EXPENSE"}, frequency:{eq:"YEAR"}, entityCuis:{in:[$cui]} }, normalization:TOTAL_EURO, limit:1){ amount } }`,
      { cui: CLUJ }
    );
    const ronTop = Number(
      (ron.data as { budgetAggregateByClassification: { amount: string }[] })
        .budgetAggregateByClassification[0]?.amount
    );
    const eurTop = Number(
      (eur.data as { budgetAggregateByClassification: { amount: string }[] })
        .budgetAggregateByClassification[0]?.amount
    );
    expect(eurTop).toBeLessThan(ronTop); // EUR is RON / FX(>1)
    expect(eurTop).toBeGreaterThan(ronTop / 10); // sane FX band
  });

  it('capability gate: vs-execution is empty + a caveat (bgc not loaded)', async () => {
    const g = await gql(`{ budgetVsExecution(budgetYear:2024){ items { budgetYear } caveats } }`);
    const v = (g.data as { budgetVsExecution: { items: unknown[]; caveats: string[] } })
      .budgetVsExecution;
    expect(v.items).toHaveLength(0);
    expect(v.caveats.join(' ')).toContain('not yet loaded');
  });

  it('refusal: a year-less fact query is rejected (unbounded-scan guard)', async () => {
    const g = await gql(
      `query($cui: String!){ budgetExecutionLineItems(filter:{ reportType:{eq:"EXECUTION_DETAILED"}, accountCategory:{eq:"EXPENSE"}, entityCuis:{in:[$cui]} }){ edges { node { ytdAmount } } } }`,
      { cui: CLUJ }
    );
    expect(g.errors).toBeDefined();
    expect(JSON.stringify(g.errors)).toContain('unbounded budget scan');
  });

  it('perf-guard: the fact list EXPLAIN prunes to ≤1 leaf (no Seq Scan / all-partition Append)', async () => {
    // eslint-disable-next-line @typescript-eslint/naming-convention -- pg returns the literal column name "QUERY PLAN"
    const plan = await pool.query<{ 'QUERY PLAN': string }>(
      `explain (costs off)
       select execution_line_item_id, ytd_amount::text from budget.execution_line_items
       where reporting_year = 2025 and report_type = 'Executie bugetara detaliata'
         and account_category = 'ch' and is_yearly = true and entity_cui = $1
       order by ytd_amount desc, execution_line_item_id desc limit 6`,
      [CLUJ]
    );
    const text = plan.rows.map((r) => r['QUERY PLAN']).join('\n');
    // Exactly one leaf scanned; no Seq Scan; no all-partition Append.
    expect(text).toMatch(/execution_line_items_y2025_rt1_ch/u);
    expect(text).not.toMatch(/Seq Scan on execution_line_items\b/u);
    const leafCount = (text.match(/execution_line_items_y20\d\d/gu) ?? []).length;
    expect(leafCount).toBeLessThanOrEqual(2); // the leaf may appear in scan + index lines
  });
});
