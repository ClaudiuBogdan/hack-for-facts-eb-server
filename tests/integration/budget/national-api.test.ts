/**
 * National budget readers through the REAL transports: the budget module's
 * one-transaction SQL port runs over a capturing Kysely driver whose rows come
 * from the in-memory source world (P0-derived values, synthetic where marked),
 * and every request goes through the kernel's actual GraphQL and MCP HTTP
 * endpoints. Expected numbers are the P0 values, not mapper output.
 *
 * This proves wiring, projection, transport parity and error surfaces. It does
 * NOT prove PostgreSQL semantics of the SQL (Zeus DDL tests) or the actual API
 * output against production rows (primary-owned qualification).
 */

import { ok } from 'neverthrow';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildRedesignApp } from '@/app/build-redesign-app.js';
import { makeBudgetModule, type FactorSource } from '@/modules/budget/index.js';

import { makeCapturingDb, type CapturedQuery } from '../../fixtures/capturing-db.js';
import { CATALOG_ITEMS } from '../../fixtures/national-budget/catalog-items.js';
import {
  INTERPRETATIONS,
  makeSourceWorld,
  RELEASES,
  SELECTION_ROWS,
  SELECTIONS,
} from '../../fixtures/national-budget/source-world.js';

import type { ContributorRegistry, SourceContributor } from '@/modules/shared/index.js';
import type { FastifyInstance } from 'fastify';
import type { TransactionSettings } from 'kysely';

const E2022 = '2022:law_2022_as_sent_to_monitorul_oficial';
const E2025 = '2025:law_2025_as_sent_to_monitorul_oficial';

const factors: FactorSource = { yearly: () => Promise.resolve(ok(null)) };

const makeRegistry = (): ContributorRegistry => {
  const contributors = new Map<string, SourceContributor>();
  return {
    register: (c) => contributors.set(c.source, c),
    list: () => [...contributors.values()],
    get: (source) => contributors.get(source),
  };
};

interface GraphqlEnvelope {
  data?: Record<string, unknown> | null;
  errors?: { message: string; extensions?: Record<string, unknown> }[];
}

let app: FastifyInstance;
let world = makeSourceWorld();
const captured: CapturedQuery[] = [];
const transactions: TransactionSettings[] = [];
const responses: string[] = [];

const gql = async (
  query: string,
  variables: Record<string, unknown> = {}
): Promise<GraphqlEnvelope> => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/graphql',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ query, variables }),
  });
  responses.push(res.body);
  return res.json<GraphqlEnvelope>();
};

const mcp = async (
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
  responses.push(res.body);
  const body = res.json<{ result?: { structuredContent?: Record<string, unknown> } }>();
  return body.result?.structuredContent ?? {};
};

/** A raw JSON-RPC call (tools/list, or a call whose arguments the SDK may reject). */
const rpc = async (
  method: string,
  params: Record<string, unknown>
): Promise<{ result?: Record<string, unknown>; error?: Record<string, unknown> }> => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/mcp',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    payload: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  // Only data responses are scanned for leaks (tools/list is kernel-wide metadata).
  if (method === 'tools/call') responses.push(res.body);
  return res.json();
};

/** Did the MCP surface refuse the call (SDK schema validation or a tool error)? */
const mcpRefused = async (name: string, args: Record<string, unknown>): Promise<boolean> => {
  const body = await rpc('tools/call', { name, arguments: args });
  return body.error !== undefined || body.result?.['isError'] === true;
};

/** The root payload of a successful response (`_shape` only names the expected type). */
const data = <T>(envelope: GraphqlEnvelope, root: string, _shape?: T): T => {
  expect(envelope.errors ?? []).toEqual([]);
  return envelope.data?.[root] as T;
};

const firstError = (envelope: GraphqlEnvelope) => {
  expect(envelope.data ?? null).toBeNull();
  return envelope.errors?.[0];
};

beforeAll(async () => {
  const db = makeCapturingDb(captured, {
    respond: (sql, parameters) => world.respond(sql, parameters),
    onBeginTransaction: (settings) => transactions.push(settings),
  });
  const budget = makeBudgetModule({
    db,
    registry: makeRegistry(),
    legacyFactors: factors,
    nationalCache: null,
  });
  const built = await buildRedesignApp({
    logLevel: 'silent',
    modules: [],
    kernelConfig: {
      prodDatabaseUrl: 'postgres://unused:unused@127.0.0.1:1/unused',
      meiliHost: '',
      meiliApiKey: '',
      opensearchUrl: '',
    },
    graphqlSlices: [budget.graphqlSlice],
    graphqlResolvers: budget.graphqlResolvers,
    mcpTools: budget.mcpTools,
  });
  app = built.app;
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  world = makeSourceWorld();
});

describe('one read-only repeatable-read transaction per root', () => {
  it('opens exactly one RR READ ONLY transaction with the root deadline', async () => {
    const before = transactions.length;
    const queries = captured.length;
    await gql('{ budgetNationalCatalog { snapshots { approved execution } } }');
    expect(transactions.slice(before)).toEqual([
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    ]);
    const statements = captured.slice(queries).map((query) => query.sql);
    // Inherited timeout read, reset, strictly positive re-arm, then ISO dates.
    expect(statements[0]).toContain('budget.national:inherited_transaction_timeout');
    expect(statements[1]).toBe('set local transaction_timeout = 0');
    expect(statements[2]).toMatch(/^set local transaction_timeout = [1-9]\d*$/u);
    expect(statements[3]).toBe("set local DateStyle = 'ISO, YMD'");
    // Every source statement runs under the REMAINING root budget (≤ 5 s).
    const budgets = statements
      .filter((sql) => sql.startsWith('set local statement_timeout'))
      .map((sql) => Number(sql.split('= ')[1]));
    expect(budgets.length).toBeGreaterThanOrEqual(3);
    expect(budgets.every((ms) => ms > 0 && ms <= 5000)).toBe(true);
    expect(statements.some((sql) => sql.includes('budget.national:approved_inventory_forms'))).toBe(
      true
    );
    expect(statements.some((sql) => sql.includes('budget.national:execution_current_leaves'))).toBe(
      true
    );

    const seriesBefore = captured.length;
    await gql(`{ budgetNationalExecutionSeries(input: { itemIds: ["mfin.bgc.revenue.total"], basis: YTD,
      period: { type: MONTH, selection: { dates: ["2025-06"] } } }) { snapshot } }`);
    const seriesBudgets = captured
      .slice(seriesBefore)
      .map((query) => query.sql)
      .filter((sql) => sql.startsWith('set local statement_timeout'))
      .map((sql) => Number(sql.split('= ')[1]));
    expect(seriesBudgets[0]).toBeGreaterThan(5000);
    expect(seriesBudgets[0]).toBeLessThanOrEqual(15000);
  });
});

describe('budgetNationalCatalog', () => {
  it('discovers loaded editions, forms, named totals, coverage and the 52 catalog items', async () => {
    const catalog = data<{
      snapshots: { approved: string; execution: string };
      approved: {
        editions: {
          id: string;
          budgetYear: number;
          slots: { field: string; measureYear: number }[];
          forms: {
            form: string;
            fund: string;
            interpretationIds: string[];
            authorityCount: number | null;
          }[];
          hasConflictingInterpretations: boolean;
        }[];
        totals: { key: string; requiresCreditType: boolean }[];
        unrecognized: { fund: string; form: string; lineCount: number }[];
      };
      execution: {
        coverage: { firstMonth: string; lastMonth: string; missingMonths: string[] };
        seriesItems: { itemId: string }[];
      };
    }>(
      await gql(`{ budgetNationalCatalog {
        snapshots { approved execution }
        approved {
          editions { id budgetYear slots { field measureYear } forms { form fund interpretationIds authorityCount } hasConflictingInterpretations }
          totals { key requiresCreditType }
          unrecognized { fund form lineCount }
        }
        execution { coverage { firstMonth lastMonth missingMonths } seriesItems { itemId } }
      } }`),
      'budgetNationalCatalog'
    );
    expect(catalog.snapshots.approved).toMatch(/^a1\.[0-9a-f]{32}$/u);
    expect(catalog.snapshots.execution).toMatch(/^e1\.[0-9a-f]{32}$/u);
    expect(catalog.approved.editions.map((e) => e.id)).toEqual([
      E2022,
      '2023:law_2023_as_sent_to_monitorul_oficial',
      '2024:law_2024_as_sent_to_monitorul_oficial',
      E2025,
    ]);
    const e2025 = catalog.approved.editions[3];
    expect(e2025?.slots.map((slot) => slot.field)).toEqual([
      'PROGRAM_2025',
      'ESTIMARI2026',
      'ESTIMARI2027',
      'ESTIMARI2028',
    ]);
    expect(e2025?.forms).toEqual([
      {
        form: 'HEALTH_INSURANCE_SYNTHESIS',
        fund: 'HEALTH_INSURANCE',
        interpretationIds: [INTERPRETATIONS.health2025],
        authorityCount: null,
      },
      {
        form: 'STATE_BUDGET_AUTHORITY_DETAIL',
        fund: 'STATE_BUDGET',
        interpretationIds: [INTERPRETATIONS.authority2025],
        authorityCount: 2,
      },
      {
        form: 'STATE_BUDGET_SYNTHESIS',
        fund: 'STATE_BUDGET',
        interpretationIds: [INTERPRETATIONS.state2025],
        authorityCount: null,
      },
    ]);
    expect(catalog.approved.totals.map((t) => t.key)).toEqual([
      'REVENUE_TOTAL',
      'EXPENDITURE_5000_TOTAL_GENERAL',
      'EXPENDITURE_5001_STATE_BUDGET',
      'EXPENDITURE_5005_CHELTUIELI_TOTAL',
      'AUTHORITY_EXPENDITURE_5001',
    ]);
    expect(catalog.approved.unrecognized).toEqual([
      { fund: 'local_budgets', form: 'local_budget_synthesis', lineCount: 12 },
    ]);
    expect(catalog.execution.coverage.firstMonth).toBe('2006-06');
    expect(catalog.execution.coverage.lastMonth).toBe('2026-07');
    expect(catalog.execution.coverage.missingMonths).toContain('2025-05');
    expect(catalog.execution.seriesItems).toHaveLength(52);
    expect(catalog.execution.seriesItems.map((i) => i.itemId).sort()).toEqual(
      CATALOG_ITEMS.map((i) => i.item_id).sort()
    );
  });
});

describe('budgetApprovedTotals', () => {
  const totals = (input: string) =>
    gql(`{ budgetApprovedTotals(input: ${input}) { snapshot unloadedEditionIds missingAuthorities { editionId code }
      cells { edition { id } fund total authorityCode authority { code name } measure measureYear creditType status matchCount value unit
        line { interpretationId recordIndex field document { url sha256 } } candidates { recordIndex } } } }`);

  it('keeps health 5000, 5005 and revenue separate with their own exact P0 values', async () => {
    const result = data<{
      cells: {
        total: string;
        value: string | null;
        status: string;
        authorityCode: string | null;
        line: { document: { url: string | null } } | null;
      }[];
    }>(
      await totals(`{ totals: [REVENUE_TOTAL, EXPENDITURE_5000_TOTAL_GENERAL, EXPENDITURE_5005_CHELTUIELI_TOTAL],
        creditTypes: [BUDGET_CREDITS], funds: [HEALTH_INSURANCE], editionIds: ["${E2025}"], measureYears: [2025] }`),
      'budgetApprovedTotals'
    );
    expect(result.cells.map((c) => [c.total, c.status, c.value, c.authorityCode])).toEqual([
      ['REVENUE_TOTAL', 'AVAILABLE', '77220381', null],
      ['EXPENDITURE_5000_TOTAL_GENERAL', 'AVAILABLE', '77224741', null],
      ['EXPENDITURE_5005_CHELTUIELI_TOTAL', 'AVAILABLE', '77220381', null],
    ]);
    // Law links stay explicitly pending: never a guessed or raw URL.
    expect(result.cells.every((c) => c.line?.document.url === null)).toBe(true);
  });

  it('converts to RON exactly and intersects targets with each law horizon', async () => {
    const result = data<{
      cells: {
        edition: { id: string };
        measure: string;
        measureYear: number;
        value: string;
        unit: string;
      }[];
    }>(
      await totals(`{ totals: [EXPENDITURE_5001_STATE_BUDGET], creditTypes: [BUDGET_CREDITS],
        editionIds: ["${E2022}", "${E2025}"], measureYears: [2025, 2028], unit: RON }`),
      'budgetApprovedTotals'
    );
    expect(
      result.cells.map((c) => [c.edition.id, c.measure, c.measureYear, c.value, c.unit])
    ).toEqual([
      [E2022, 'FORECAST', 2025, '346134145000', 'RON'],
      [E2025, 'APPROVED', 2025, '499582980000', 'RON'],
      [E2025, 'FORECAST', 2028, '500083194000', 'RON'],
    ]);
  });

  it('reports a missing form, an unloaded edition and missing authority codes explicitly', async () => {
    const result = data<{
      unloadedEditionIds: string[];
      missingAuthorities: { editionId: string; code: string }[];
      cells: {
        fund: string;
        total: string;
        authorityCode: string | null;
        authority: { name: string } | null;
        status: string;
        value: string | null;
      }[];
    }>(
      await totals(`{ totals: [AUTHORITY_EXPENDITURE_5001, EXPENDITURE_5000_TOTAL_GENERAL], creditTypes: [BUDGET_CREDITS],
        funds: [STATE_BUDGET, STATE_SOCIAL_INSURANCE], editionIds: ["${E2025}", "2030:law_2030"], measureYears: [2025],
        authorityCodes: ["01", "77"] }`),
      'budgetApprovedTotals'
    );
    expect(result.unloadedEditionIds).toEqual(['2030:law_2030']);
    expect(result.missingAuthorities).toEqual([{ editionId: E2025, code: '77' }]);
    expect(
      result.cells.map((c) => [
        c.fund,
        c.total,
        c.authorityCode,
        c.authority?.name ?? null,
        c.status,
        c.value,
      ])
    ).toEqual([
      ['STATE_BUDGET', 'EXPENDITURE_5000_TOTAL_GENERAL', null, null, 'NO_MATCHING_RECORD', null],
      [
        'STATE_SOCIAL_INSURANCE',
        'EXPENDITURE_5000_TOTAL_GENERAL',
        null,
        null,
        'FORM_NOT_LOADED',
        null,
      ],
      [
        'STATE_BUDGET',
        'AUTHORITY_EXPENDITURE_5001',
        '01',
        'Administratia Prezidentiala',
        'AVAILABLE',
        '1250000.5',
      ],
    ]);
  });

  it('marks a conflicting form AMBIGUOUS even when only one interpretation matches', async () => {
    world = makeSourceWorld({
      extraFormRows: [
        {
          budget_year: 2025,
          publication: 'law_2025_as_sent_to_monitorul_oficial',
          fund: 'state_budget',
          form: 'state_budget_synthesis',
          interpretation_id: 'budget-law-approved:fixture-second-reading',
          line_count: 10,
          record_count: 3,
          credit_types: [],
          sources: [],
          authorities: [],
        },
      ],
    });
    const result = data<{ cells: { status: string; value: string | null; matchCount: number }[] }>(
      await totals(`{ totals: [EXPENDITURE_5001_STATE_BUDGET], creditTypes: [BUDGET_CREDITS],
        editionIds: ["${E2025}"], measureYears: [2025] }`),
      'budgetApprovedTotals'
    );
    expect(result.cells).toHaveLength(1);
    expect(result.cells[0]).toMatchObject({ status: 'AMBIGUOUS', value: null, matchCount: 1 });
  });

  it('refuses credit types on revenue-only requests on both transports', async () => {
    const graphql = firstError(
      await totals('{ totals: [REVENUE_TOTAL], creditTypes: [BUDGET_CREDITS] }')
    );
    expect(graphql?.extensions).toMatchObject({
      code: 'INVALID_INPUT',
      field: 'input.creditTypes',
    });
    const tool = await mcp('get_budget_approved_totals', {
      input: { totals: ['REVENUE_TOTAL'], creditTypes: ['BUDGET_CREDITS'] },
    });
    expect(tool).toMatchObject({
      ok: false,
      errorCode: 'INVALID_INPUT',
      meta: { field: 'input.creditTypes' },
    });
  });
});

describe('budgetApprovedSeries', () => {
  it('editionsForTarget keeps edition year and target year distinct (P0 forecasts)', async () => {
    const series = data<{
      axis: string;
      targetYear: number;
      unit: string;
      series: { frequency: string; data: { date: string; value: string }[] };
      periods: {
        date: string;
        status: string;
        budgetYear: number;
        measureYear: number;
        measure: string;
      }[];
    }>(
      await gql(`{ budgetApprovedSeries(input: { axis: { editionsForTarget: { targetYear: 2025 } }, fund: STATE_BUDGET,
        total: EXPENDITURE_5001_STATE_BUDGET, creditType: BUDGET_CREDITS,
        period: { type: YEAR, selection: { interval: { start: "2021", end: "2025" } } } }) {
        axis targetYear unit series { frequency data { date value } } periods { date status budgetYear measureYear measure } } }`),
      'budgetApprovedSeries'
    );
    expect(series.axis).toBe('EDITIONS_FOR_TARGET');
    expect(series.targetYear).toBe(2025);
    expect(series.series).toEqual({
      frequency: 'YEAR',
      data: [
        { date: '2022', value: '346134145' },
        { date: '2023', value: '375444061' },
        { date: '2024', value: '415039725' },
        { date: '2025', value: '499582980' },
      ],
    });
    expect(
      series.periods.map((p) => [p.date, p.status, p.budgetYear, p.measureYear, p.measure])
    ).toEqual([
      ['2021', 'EDITION_NOT_LOADED', null, 2025, null],
      ['2022', 'AVAILABLE', 2022, 2025, 'FORECAST'],
      ['2023', 'AVAILABLE', 2023, 2025, 'FORECAST'],
      ['2024', 'AVAILABLE', 2024, 2025, 'FORECAST'],
      ['2025', 'AVAILABLE', 2025, 2025, 'APPROVED'],
    ]);
  });
});

describe('budgetApprovedRecords', () => {
  const RECORDS = `query Records($after: String, $input: BudgetApprovedRecordsInput!) {
    budgetApprovedRecords(input: $input, first: 2, after: $after) {
      snapshot unit pageInfo { hasNextPage endCursor }
      edges { cursor node { id recordIndex rowRole creditType authority { key code name }
        values { field measureYear value lineId } document { url sha256 } } } } }`;
  const edition = {
    source: { edition: { editionId: E2025, form: 'STATE_BUDGET_AUTHORITY_DETAIL' } },
  };

  interface Page {
    snapshot: string;
    unit: string;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    edges: {
      cursor: string;
      node: {
        recordIndex: number;
        values: { field: string; value: string | null }[];
        document: { url: string | null };
      };
    }[];
  }

  it('pages faithful native records in source order with dense slot values', async () => {
    const first = data<Page>(await gql(RECORDS, { input: edition }), 'budgetApprovedRecords');
    expect(first.unit).toBe('THOUSAND_LEI');
    expect(first.edges.map((e) => e.node.recordIndex)).toEqual([10, 11]);
    expect(first.edges[0]?.node.values.map((v) => [v.field, v.value])).toEqual([
      ['PROGRAM_2025', '0'],
      ['ESTIMARI2026', null],
      ['ESTIMARI2027', null],
      ['ESTIMARI2028', null],
    ]);
    expect(first.edges[0]?.node.document.url).toBeNull();
    expect(first.pageInfo.hasNextPage).toBe(true);
    const second = data<Page>(
      await gql(RECORDS, { input: edition, after: first.pageInfo.endCursor }),
      'budgetApprovedRecords'
    );
    expect(second.edges.map((e) => e.node.recordIndex)).toEqual([12, 13]);
    expect(second.edges[0]?.node.values[0]?.value).toBe(
      '27546712048.55000178213231265544891357421875'
    );
  });

  it('fails a continuation with SNAPSHOT_CHANGED (with the current snapshot) when the law lane moves', async () => {
    const first = data<Page>(await gql(RECORDS, { input: edition }), 'budgetApprovedRecords');
    world = makeSourceWorld({
      extraFormRows: [
        {
          budget_year: 2025,
          publication: 'law_2025_as_sent_to_monitorul_oficial',
          fund: 'health_insurance',
          form: 'health_insurance_synthesis',
          interpretation_id: 'budget-law-approved:fixture-new-load',
          line_count: 1,
          record_count: 1,
          credit_types: [],
          sources: [],
          authorities: [],
        },
      ],
    });
    const moved = firstError(
      await gql(RECORDS, { input: edition, after: first.pageInfo.endCursor })
    );
    expect(moved?.extensions).toMatchObject({
      code: 'INVALID_INPUT',
      field: 'after',
      reason: 'SNAPSHOT_CHANGED',
    });
    expect(moved?.extensions?.['currentSnapshot']).not.toBe(first.snapshot);
    const tool = await mcp('list_budget_approved_records', {
      input: edition,
      first: 2,
      after: first.pageInfo.endCursor,
    });
    expect(tool).toMatchObject({
      ok: false,
      errorCode: 'INVALID_INPUT',
      meta: { reason: 'SNAPSHOT_CHANGED' },
    });
  });

  it('refuses a cursor reused with different filters and pins interpretation IDs', async () => {
    const first = data<Page>(await gql(RECORDS, { input: edition }), 'budgetApprovedRecords');
    const mismatch = firstError(
      await gql(RECORDS, {
        input: { ...edition, authorityCode: '02' },
        after: first.pageInfo.endCursor,
      })
    );
    expect(mismatch?.message).toMatch(/mismatch/u);
    const pinned = { source: { interpretationId: INTERPRETATIONS.authority2025 } };
    const page = data<Page>(await gql(RECORDS, { input: pinned }), 'budgetApprovedRecords');
    world = makeSourceWorld({
      extraFormRows: [
        {
          budget_year: 2025,
          publication: 'law_2025_as_sent_to_monitorul_oficial',
          fund: 'health_insurance',
          form: 'health_insurance_synthesis',
          interpretation_id: 'budget-law-approved:fixture-new-load',
          line_count: 1,
          record_count: 1,
          credit_types: [],
          sources: [],
          authorities: [],
        },
      ],
    });
    // Immutable source: the continuation survives a moved lane.
    const next = data<Page>(
      await gql(RECORDS, { input: pinned, after: page.pageInfo.endCursor }),
      'budgetApprovedRecords'
    );
    expect(next.edges.map((e) => e.node.recordIndex)).toEqual([12, 13]);
  });

  it('returns NOT_FOUND for an unknown interpretation or unloaded form', async () => {
    const unknown = firstError(
      await gql(RECORDS, { input: { source: { interpretationId: 'budget-law-approved:nope' } } })
    );
    expect(unknown?.extensions).toMatchObject({ code: 'NOT_FOUND' });
    const unloaded = firstError(
      await gql(RECORDS, {
        input: {
          source: { edition: { editionId: E2025, form: 'UNEMPLOYMENT_INSURANCE_SYNTHESIS' } },
        },
      })
    );
    expect(unloaded?.extensions).toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('budgetExecutionReleases', () => {
  const RELEASES_QUERY = (months: string, revisions: number) => `{ budgetExecutionReleases(input: {
    months: { type: MONTH, selection: ${months} }, revisionsPerMonth: ${String(revisions)} }) {
    coverage { firstMonth lastMonth }
    months { month status gapReason revisionCount revisionsTruncated
      current { selectionId chainPosition release { releaseId month calendarPeriod { start end } policyVersion publicationScope factCount
        families { family presence role reason sourceFormat document { url sha256 bytes } reportCoverage { start end } } } }
      revisions { selectionId previousSelectionId chainPosition release { releaseId } } } } }`;

  interface Month {
    month: string;
    status: string;
    gapReason: string | null;
    revisionCount: number;
    revisionsTruncated: boolean;
    current: {
      selectionId: string;
      chainPosition: number;
      release: {
        releaseId: string;
        publicationScope: string | null;
        families: Record<string, unknown>[];
      };
    } | null;
    revisions: {
      selectionId: string;
      previousSelectionId: string | null;
      chainPosition: number;
      release: { releaseId: string };
    }[];
  }

  it('lists selected months, a gap without a guessed reason, and the rollback chain in order', async () => {
    const index = data<{ months: Month[] }>(
      await gql(RELEASES_QUERY('{ interval: { start: "2025-04", end: "2025-06" } }', 3)),
      'budgetExecutionReleases'
    );
    const [april, may, june] = index.months;
    expect(april?.status).toBe('SELECTED');
    expect(may).toMatchObject({
      month: '2025-05',
      status: 'NO_SELECTED_RELEASE',
      gapReason: null,
      current: null,
      revisionCount: 0,
      revisions: [],
    });
    expect(june?.revisionCount).toBe(3);
    expect(june?.revisionsTruncated).toBe(false);
    expect(
      june?.revisions.map((r) => [r.selectionId, r.chainPosition, r.release.releaseId])
    ).toEqual([
      [SELECTIONS.june2025, 3, RELEASES.june2025R1],
      [SELECTIONS.june2025Rollforward, 2, RELEASES.june2025R2],
      [SELECTIONS.june2025Root, 1, RELEASES.june2025R1],
    ]);
    const truncated = data<{ months: Month[] }>(
      await gql(RELEASES_QUERY('{ dates: ["2025-06"] }', 1)),
      'budgetExecutionReleases'
    );
    expect(truncated.months[0]).toMatchObject({ revisionCount: 3, revisionsTruncated: true });
    expect(truncated.months[0]?.revisions).toHaveLength(1);
  });

  it('projects families from the sealed contract or the release inputs, never storage fields', async () => {
    const index = data<{ months: Month[] }>(
      await gql(RELEASES_QUERY('{ dates: ["2006-07", "2025-12"] }', 1)),
      'budgetExecutionReleases'
    );
    const [july2006, december] = index.months;
    expect(july2006?.current?.release.publicationScope).toBe('historical-bgc-current-v1');
    expect(july2006?.current?.release.families).toEqual([
      {
        family: 'BGC',
        presence: 'PRESENT',
        role: 'normalization_source',
        reason: null,
        sourceFormat: 'pdf',
        document: {
          url: 'https://mfinante.gov.ro/static/10/Mfp/buget/executii/rom07_2006.zip',
          sha256: '6b43c4d8baf3ddabfb48bf16768204a245c3e8938f5259b4656658a001a46d31',
          bytes: 106523,
        },
        reportCoverage: { start: '2006-01-01', end: '2006-07-30' },
      },
      {
        family: 'NOTA',
        presence: 'FAMILY_UNRESOLVED',
        role: null,
        reason: 'none_identified_in_this_packet',
        sourceFormat: null,
        document: null,
        reportCoverage: null,
      },
      {
        family: 'SINTEZA',
        presence: 'FAMILY_UNRESOLVED',
        role: null,
        reason: 'possible_family_content_identified',
        sourceFormat: null,
        document: null,
        reportCoverage: null,
      },
    ]);
    expect(
      december?.current?.release.families.map((f) => [
        f['family'],
        f['presence'],
        (f['document'] as { sha256: string }).sha256,
      ])
    ).toEqual([
      ['BGC', 'PRESENT', '41f67ec6394f9cf69964a88e58a6dbf34ac4916e57ea26715c0e36574b117c5e'],
      ['NOTA', 'PRESENT', '0b348a419266435603f2c330bc56c22c5b22058d6f7de9caa2252ead1514b682'],
      ['SINTEZA', 'PRESENT', 'c832fdbac76a7b117717ccbbc665e73d51af1917280acaf7d8ff16ebfa0f004a'],
    ]);
  });
});

describe('budgetExecutionObservations', () => {
  const OBSERVATIONS = `query Obs($input: BudgetExecutionObservationsInput!, $first: Int, $after: String) {
    budgetExecutionObservations(input: $input, first: $first, after: $after) {
      snapshot pageInfo { hasNextPage endCursor }
      edges { cursor occurrenceId selectionId node { id releaseId month input observationKey disposition sourceState
        catalogItem { itemId } section lineItem component periodRole measure coverageKind fiscalPeriod { start end }
        referenceYear executionStatus finality value unit sourceToken reason locator { kind sheet cell page table row column } labelEvidence { cell text }
        document { url sha256 bytes } } } } }`;

  interface Connection {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    edges: {
      occurrenceId: string;
      selectionId: string;
      node: Record<string, unknown> & { id: string; observationKey: string };
    }[];
  }

  it('keeps blank, RON zero and fraction zero distinct and BGC/Sinteza separate (P0 cells)', async () => {
    const page = data<Connection>(
      await gql(OBSERVATIONS, {
        input: {
          source: { selectionIds: [SELECTIONS.december2025.toUpperCase()] },
          dispositions: ['FACT', 'BLANK'],
        },
        first: 10,
      }),
      'budgetExecutionObservations'
    );
    const byKey = new Map(
      page.edges.map((edge) => [
        `${String(edge.node['input'])}:${edge.node.observationKey}`,
        edge.node,
      ])
    );
    expect(page.edges.map((e) => `${String(e.node['input'])}:${e.node.observationKey}`)).toEqual([
      'BGC:xl/worksheets/sheet1.xml!C12',
      'BGC:xl/worksheets/sheet1.xml!R67',
      'BGC:xl/worksheets/sheet1.xml!R68',
      'BGC:xl/worksheets/sheet1.xml!S67',
      'SINTEZA:xl/worksheets/sheet1.xml!B12',
    ]);
    expect(byKey.get('BGC:xl/worksheets/sheet1.xml!R67')).toMatchObject({
      disposition: 'BLANK',
      sourceState: 'blank',
      value: null,
      unit: 'RON',
      catalogItem: { itemId: 'mfin.bgc.expenditure.loans' },
      labelEvidence: { cell: 'B67', text: 'Imprumuturi' },
    });
    expect(byKey.get('BGC:xl/worksheets/sheet1.xml!R68')).toMatchObject({
      disposition: 'FACT',
      value: '0',
      unit: 'RON',
    });
    // Workbook cells store no table/row/column: absent coordinates are null.
    expect(byKey.get('BGC:xl/worksheets/sheet1.xml!R67')?.['locator']).toEqual({
      kind: 'cell',
      sheet: 'xl/worksheets/sheet1.xml',
      cell: 'R67',
      page: null,
      table: null,
      row: null,
      column: null,
    });
    expect(byKey.get('BGC:xl/worksheets/sheet1.xml!S67')).toMatchObject({
      disposition: 'FACT',
      value: '0',
      unit: 'FRACTION',
      catalogItem: null,
    });
    expect(byKey.get('BGC:xl/worksheets/sheet1.xml!C12')).toMatchObject({
      value: '662698173101.34997',
      catalogItem: { itemId: 'mfin.bgc.revenue.total' },
      finality: 'UNKNOWN',
      locator: { kind: 'cell', sheet: 'xl/worksheets/sheet1.xml', cell: 'C12' },
      document: {
        url: 'https://mfinante.gov.ro/static/10/Mfp/buletin/executii/bgc31122025.xlsx',
        sha256: '41f67ec6394f9cf69964a88e58a6dbf34ac4916e57ea26715c0e36574b117c5e',
        bytes: 377294,
      },
    });
    expect(byKey.get('SINTEZA:xl/worksheets/sheet1.xml!B12')).toMatchObject({
      value: '662698173101.34997',
      catalogItem: null,
      finality: 'OPERATIVE',
    });
  });

  it('preserves stored PDF table/row/column coordinates (P0 July 2006) on both transports', async () => {
    const input = {
      source: { selectionIds: [SELECTIONS.july2006] },
      dispositions: ['FACT', 'BLANK'],
    };
    const page = data<Connection>(
      await gql(OBSERVATIONS, { input, first: 10 }),
      'budgetExecutionObservations'
    );
    const pdf = (row: number, pageNumber: number) => ({
      kind: 'pdf_cell',
      sheet: null,
      cell: null,
      page: pageNumber,
      table: 'bgc_national_current_amount',
      row,
      column: 0,
    });
    const expected = [
      ['national:0001', 'FACT', '59990900000', pdf(1, 1)],
      ['national:0018', 'BLANK', null, pdf(18, 1)],
      ['national:0036', 'BLANK', null, pdf(36, 2)],
    ];
    const shape = (connection: Connection) =>
      connection.edges.map((e) => [
        e.node.observationKey,
        e.node['disposition'],
        e.node['value'],
        e.node['locator'],
      ]);
    expect(shape(page)).toEqual(expected);
    // A classified blank keeps its sealed RON unit with a null value.
    expect(page.edges[1]?.node).toMatchObject({ unit: 'RON', value: null, sourceState: 'blank' });
    const tool = await mcp('list_budget_execution_observations', { input, first: 10 });
    expect(shape(tool['item'] as Connection)).toEqual(expected);
  });

  it('visits every rollback occurrence once, including the repeated release', async () => {
    const input = {
      source: {
        selectionIds: [
          SELECTIONS.june2025,
          SELECTIONS.june2025Root,
          SELECTIONS.june2025Rollforward,
        ],
      },
    };
    const seen: string[] = [];
    const nodes: string[] = [];
    let after: string | null = null;
    for (let guard = 0; guard < 5; guard++) {
      const page: Connection = data<Connection>(
        await gql(OBSERVATIONS, { input, first: 1, after }),
        'budgetExecutionObservations'
      );
      for (const edge of page.edges) {
        seen.push(edge.occurrenceId);
        nodes.push(edge.node.id);
      }
      if (!page.pageInfo.hasNextPage) break;
      after = page.pageInfo.endCursor;
    }
    expect(seen).toHaveLength(3);
    expect(new Set(seen).size).toBe(3);
    expect(new Set(nodes).size).toBe(2);
    expect(seen.map((id) => id.slice(0, 8))).toEqual(['0cda5d3a', 'c1c1c1c1', 'c2c2c2c2']);
  });

  it('reads multi-month FACTs without guessed evidence and refuses ambiguous non-FACT reads', async () => {
    const months = data<Connection>(
      await gql(OBSERVATIONS, {
        input: {
          source: { months: { type: 'MONTH', selection: { dates: ['2025-06', '2025-12'] } } },
          inputs: ['BGC'],
          itemIds: ['mfin.bgc.revenue.total'],
        },
        first: 10,
      }),
      'budgetExecutionObservations'
    );
    expect(
      months.edges.map((e) => [e.node['month'], e.node['sourceState'], e.node['locator']])
    ).toEqual([
      ['2025-06', 'number', null],
      ['2025-12', 'number', null],
    ]);
    const twoSelections = firstError(
      await gql(OBSERVATIONS, {
        input: {
          source: { months: { type: 'MONTH', selection: { dates: ['2025-06', '2025-12'] } } },
          dispositions: ['BLANK'],
        },
      })
    );
    expect(twoSelections?.extensions).toMatchObject({
      code: 'INVALID_INPUT',
      field: 'input.dispositions',
    });
  });

  it('returns NOT_FOUND for unknown or partly unknown explicit selection IDs', async () => {
    const unknown = '00000000-0000-4000-8000-000000000000';
    for (const selectionIds of [[unknown], [SELECTIONS.december2025, unknown]]) {
      const error = firstError(await gql(OBSERVATIONS, { input: { source: { selectionIds } } }));
      expect(error?.extensions).toMatchObject({ code: 'NOT_FOUND' });
    }
    const tool = await mcp('list_budget_execution_observations', {
      input: { source: { selectionIds: [unknown] } },
    });
    expect(tool).toMatchObject({ ok: false, errorCode: 'NOT_FOUND' });
  });
});

describe('budgetNationalExecutionSeries', () => {
  const SERIES = (input: string) => `{ budgetNationalExecutionSeries(input: ${input}) {
    snapshot mappingVersion derivationVersion coverage { lastMonth }
    results { item { itemId } component basis unit series { frequency data { date value } }
      periods { date periodStart periodEnd status reason valueBasis
        endpoint { month selectionId releaseId coverage { start end } executionStatus finality document { url sha256 bytes } label { text } }
        predecessor { month selectionId } } } } }`;

  interface Result {
    mappingVersion: string;
    derivationVersion: string;
    results: {
      item: { itemId: string };
      component: string;
      unit: string;
      series: { frequency: string; data: { date: string; value: string }[] };
      periods: {
        date: string;
        periodStart: string;
        periodEnd: string;
        status: string;
        reason: string | null;
        valueBasis: string | null;
        endpoint: Record<string, unknown> | null;
        predecessor: Record<string, unknown> | null;
      }[];
    }[];
  }

  it('serves Q2/Q4 differences, keeps June YTD interval and the requested item order', async () => {
    const quarters = data<Result>(
      await gql(
        SERIES(`{ itemIds: ["mfin.bgc.revenue.total"], basis: PERIOD_DIFFERENCE,
        period: { type: QUARTER, selection: { dates: ["2025-Q2", "2025-Q4"] } } }`)
      ),
      'budgetNationalExecutionSeries'
    );
    expect(quarters.mappingVersion).toBe('bgc-item-map-v1');
    expect(quarters.derivationVersion).toBe('bgc-selected-cumulative-difference-v1');
    expect(quarters.results[0]?.series).toEqual({
      frequency: 'QUARTER',
      data: [
        { date: '2025-Q2', value: '169195939317.60994' },
        { date: '2025-Q4', value: '195746159574.50995' },
      ],
    });
    expect(quarters.results[0]?.periods[0]).toMatchObject({
      periodStart: '2025-04-01',
      periodEnd: '2025-06-30',
      status: 'AVAILABLE',
      reason: null,
      valueBasis: 'DERIVED_DIFFERENCE_BETWEEN_REPORTS',
      endpoint: {
        month: '2025-06',
        selectionId: SELECTIONS.june2025,
        executionStatus: 'ACTUAL',
        finality: 'UNKNOWN',
        label: { text: 'VENITURI TOTALE' },
      },
      predecessor: { month: '2025-03', selectionId: SELECTIONS.march2025 },
    });

    const ytd = data<Result>(
      await gql(
        SERIES(`{ itemIds: ["mfin.bgc.revenue.total"], basis: YTD,
        period: { type: MONTH, selection: { dates: ["2025-06"] } } }`)
      ),
      'budgetNationalExecutionSeries'
    );
    expect(ytd.results[0]?.series.data).toEqual([{ date: '2025-06', value: '310520639938.72993' }]);
    expect(ytd.results[0]?.periods[0]).toMatchObject({
      date: '2025-06',
      periodStart: '2025-01-01',
      periodEnd: '2025-06-30',
    });

    const ordered = data<Result>(
      await gql(
        SERIES(`{ itemIds: ["mfin.bgc.revenue.total", "mfin.bgc.expenditure.total"], basis: PERIOD_DIFFERENCE,
        period: { type: QUARTER, selection: { dates: ["2025-Q2"] } } }`)
      ),
      'budgetNationalExecutionSeries'
    );
    expect(ordered.results.map((r) => r.item.itemId)).toEqual([
      'mfin.bgc.revenue.total',
      'mfin.bgc.expenditure.total',
    ]);
    expect(ordered.results[1]?.series.data).toEqual([{ date: '2025-Q2', value: '-12.5' }]);
  });

  it('keeps gaps dense with raw lowercase reasons and no DataPoint', async () => {
    const months = data<Result>(
      await gql(
        SERIES(`{ itemIds: ["mfin.bgc.revenue.total"], basis: PERIOD_DIFFERENCE,
        period: { type: MONTH, selection: { dates: ["2006-07", "2025-05", "2025-06"] } } }`)
      ),
      'budgetNationalExecutionSeries'
    );
    expect(months.results[0]?.series.data).toEqual([]);
    expect(months.results[0]?.periods.map((p) => [p.date, p.status, p.reason])).toEqual([
      ['2006-07', 'UNAVAILABLE', 'incompatible_endpoint_coverage'],
      ['2025-05', 'UNAVAILABLE', 'missing_endpoint_release'],
      ['2025-06', 'UNAVAILABLE', 'missing_predecessor_release'],
    ]);
    expect(months.results[0]?.periods[0]?.endpoint).toMatchObject({
      coverage: { start: '2006-01-01', end: '2006-07-30' },
    });

    const years = data<Result>(
      await gql(
        SERIES(`{ itemIds: ["mfin.bgc.revenue.total"], basis: FULL_YEAR,
        period: { type: YEAR, selection: { dates: ["2025", "2026"] } } }`)
      ),
      'budgetNationalExecutionSeries'
    );
    expect(
      years.results[0]?.periods.map((p) => [p.date, p.status, p.reason, p.periodStart, p.periodEnd])
    ).toEqual([
      ['2025', 'AVAILABLE', null, '2025-01-01', '2025-12-31'],
      ['2026', 'OUT_OF_COVERAGE', 'after_last_release', '2026-01-01', '2026-12-31'],
    ]);
    expect(years.results[0]?.series.data).toEqual([{ date: '2025', value: '662698173101.34997' }]);
  });

  it('refuses unknown items and reports a missing in-coverage view row as SERVICE_UNAVAILABLE', async () => {
    const unknown = firstError(
      await gql(
        SERIES(
          `{ itemIds: ["mfin.bgc.unknown"], basis: YTD, period: { type: MONTH, selection: { dates: ["2025-06"] } } }`
        )
      )
    );
    expect(unknown?.extensions).toMatchObject({ code: 'INVALID_INPUT', field: 'input.itemIds' });
    const missing = firstError(
      await gql(
        SERIES(
          `{ itemIds: ["mfin.bgc.revenue.total"], basis: YTD, period: { type: MONTH, selection: { dates: ["2025-07"] } } }`
        )
      )
    );
    expect(missing?.extensions).toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  });
});

describe('GraphQL and MCP share one payload', () => {
  it('returns the same values, snapshot and periods on both transports', async () => {
    const input = {
      itemIds: ['mfin.bgc.revenue.total'],
      basis: 'PERIOD_DIFFERENCE',
      period: { type: 'QUARTER', selection: { dates: ['2025-Q2'] } },
    };
    const graphql = data<{
      snapshot: string;
      results: { series: unknown; periods: { periodStart: string; reason: string | null }[] }[];
    }>(
      await gql(
        `query S($input: BudgetNationalExecutionSeriesInput!) { budgetNationalExecutionSeries(input: $input) {
          snapshot results { series { frequency data { date value } } periods { periodStart reason } } } }`,
        { input }
      ),
      'budgetNationalExecutionSeries'
    );
    const tool = await mcp('get_budget_national_execution_series', { input });
    const item = tool['item'] as {
      snapshot: string;
      results: { series: unknown; periods: { periodStart: string; reason: string | null }[] }[];
    };
    expect(tool['ok']).toBe(true);
    expect(item.snapshot).toBe(graphql.snapshot);
    expect(item.results[0]?.series).toEqual(graphql.results[0]?.series);
    expect(item.results[0]?.periods.map((p) => [p.periodStart, p.reason])).toEqual(
      graphql.results[0]?.periods.map((p) => [p.periodStart, p.reason])
    );
  });

  it('serves all seven tools from the module', async () => {
    const catalog = await mcp('get_budget_national_catalog', {});
    expect(catalog).toMatchObject({ ok: true, kind: 'budget_national_catalog' });
    const releases = await mcp('get_budget_execution_releases', {
      input: { months: { type: 'MONTH', selection: { dates: ['2025-06'] } } },
    });
    expect(releases['ok']).toBe(true);
    const series = await mcp('get_budget_approved_series', {
      input: {
        axis: { ownYearApprovals: {} },
        fund: 'STATE_BUDGET',
        total: 'EXPENDITURE_5001_STATE_BUDGET',
        creditType: 'BUDGET_CREDITS',
        period: { type: 'YEAR', selection: { dates: ['2025'] } },
      },
    });
    expect((series['item'] as { series: unknown }).series).toEqual({
      frequency: 'YEAR',
      data: [{ date: '2025', value: '499582980' }],
    });
  });
});

describe('MCP structural input schemas (tools/list)', () => {
  interface Schema {
    readonly [key: string]: unknown;
    readonly properties?: Record<string, Schema>;
    readonly required?: string[];
    readonly anyOf?: Schema[];
    readonly oneOf?: Schema[];
    readonly items?: Schema;
    readonly enum?: unknown[];
  }
  const alternatives = (schema: Schema | undefined): string[][] =>
    (schema?.anyOf ?? schema?.oneOf ?? []).map((alt) => Object.keys(alt.properties ?? {}));

  it('publishes domain fields, required members, enums and @oneOf alternatives', async () => {
    const listed = await rpc('tools/list', {});
    const tools = (listed.result?.['tools'] ?? []) as { name: string; inputSchema: Schema }[];
    const inputOf = (name: string): Schema => {
      const tool = tools.find((t) => t.name === name);
      expect(tool, name).toBeDefined();
      return tool?.inputSchema.properties?.['input'] ?? {};
    };
    for (const name of [
      'get_budget_approved_totals',
      'get_budget_approved_series',
      'list_budget_approved_records',
      'get_budget_execution_releases',
      'list_budget_execution_observations',
      'get_budget_national_execution_series',
    ]) {
      const input = inputOf(name);
      expect(Object.keys(input.properties ?? {}).length, name).toBeGreaterThan(1);
      expect(input.required?.length ?? 0, name).toBeGreaterThan(0);
      expect(input['additionalProperties'], name).toBe(false);
    }
    const series = inputOf('get_budget_approved_series');
    expect(series.required).toEqual(expect.arrayContaining(['axis', 'fund', 'total', 'period']));
    expect(alternatives(series.properties?.['axis'])).toEqual([
      ['targetYearsOfEdition'],
      ['editionsForTarget'],
      ['ownYearApprovals'],
    ]);
    const period = series.properties?.['period'];
    expect(period?.properties?.['type']?.enum).toEqual(['YEAR']);
    expect(alternatives(period?.properties?.['selection'])).toEqual([['interval'], ['dates']]);
    expect(
      alternatives(inputOf('list_budget_execution_observations').properties?.['source'])
    ).toEqual([['months'], ['selectionIds']]);
    expect(alternatives(inputOf('list_budget_approved_records').properties?.['source'])).toEqual([
      ['edition'],
      ['interpretationId'],
    ]);
    // A list input, with GraphQL's single-value form as an alternative.
    const totalsAlternatives =
      inputOf('get_budget_approved_totals').properties?.['totals']?.anyOf ?? [];
    const totals = totalsAlternatives[0];
    expect(totalsAlternatives[1]?.enum).toEqual(totals?.items?.enum);
    expect(totals?.items?.enum).toEqual([
      'REVENUE_TOTAL',
      'EXPENDITURE_5000_TOTAL_GENERAL',
      'EXPENDITURE_5001_STATE_BUDGET',
      'EXPENDITURE_5005_CHELTUIELI_TOTAL',
      'AUTHORITY_EXPENDITURE_5001',
    ]);
    expect(totals?.['maxItems']).toBe(5);
    const executionSeries = inputOf('get_budget_national_execution_series');
    expect(executionSeries.properties?.['basis']?.enum).toEqual([
      'YTD',
      'PERIOD_DIFFERENCE',
      'FULL_YEAR',
    ]);
    expect(executionSeries.properties?.['itemIds']?.anyOf?.[0]?.['maxItems']).toBe(12);
  });

  it('gives the same verdict as GraphQL for @oneOf nulls, UUID case and semantic errors', async () => {
    const seriesInput = (axis: unknown) => ({
      axis,
      fund: 'STATE_BUDGET',
      total: 'EXPENDITURE_5001_STATE_BUDGET',
      creditType: 'BUDGET_CREDITS',
      period: { type: 'YEAR', selection: { dates: ['2025'] } },
    });
    const SERIES =
      'query S($input: BudgetApprovedSeriesInput!) { budgetApprovedSeries(input: $input) { snapshot } }';
    const cases: [string, unknown, boolean][] = [
      ['selected only', { ownYearApprovals: {} }, true],
      ['selected + other null', { targetYearsOfEdition: E2025, ownYearApprovals: null }, false],
      ['only null', { ownYearApprovals: null }, false],
      ['empty', {}, false],
    ];
    for (const [label, axis, valid] of cases) {
      const graphql = await gql(SERIES, { input: seriesInput(axis) });
      expect([label, (graphql.errors ?? []).length === 0]).toEqual([label, valid]);
      const refused = await mcpRefused('get_budget_approved_series', { input: seriesInput(axis) });
      expect([label, !refused]).toEqual([label, valid]);
    }
    // GraphQL list coercion: a single value is a one-element list on both transports.
    const singleton = {
      totals: 'REVENUE_TOTAL',
      funds: 'HEALTH_INSURANCE',
      editionIds: E2025,
      measureYears: 2025,
    };
    const TOTALS =
      'query T($input: BudgetApprovedTotalsInput!) { budgetApprovedTotals(input: $input) { cells { value } } }';
    const graphqlSingleton = data<{ cells: { value: string }[] }>(
      await gql(TOTALS, { input: singleton }),
      'budgetApprovedTotals'
    );
    const toolSingleton = await mcp('get_budget_approved_totals', { input: singleton });
    const toolCells = (toolSingleton['item'] as { cells: { value: string }[] }).cells;
    expect(graphqlSingleton.cells.map((cell) => cell.value)).toEqual(['77220381']);
    expect(toolCells.map((cell) => cell.value)).toEqual(['77220381']);
    // Selection IDs: any case on both transports (the core canonicalises).
    const upper = { source: { selectionIds: [SELECTIONS.december2025.toUpperCase()] } };
    expect(await mcpRefused('list_budget_execution_observations', { input: upper })).toBe(false);
    // Structurally valid, semantically invalid: the core answers on both, naming the field.
    const revenueWithCredit = { ...seriesInput({ ownYearApprovals: {} }), total: 'REVENUE_TOTAL' };
    const graphqlError = firstError(await gql(SERIES, { input: revenueWithCredit }));
    expect(graphqlError?.extensions).toMatchObject({
      code: 'INVALID_INPUT',
      field: 'input.creditType',
    });
    const tool = await mcp('get_budget_approved_series', { input: revenueWithCredit });
    expect(tool).toMatchObject({
      ok: false,
      errorCode: 'INVALID_INPUT',
      meta: { field: 'input.creditType' },
    });
  });
});

describe('no internal source fields leak on either transport', () => {
  it('never serialises storage, gate, raw-origin or parse attributes', () => {
    const body = responses.join('\n');
    expect(responses.length).toBeGreaterThan(20);
    for (const marker of [
      'storage',
      'bucket',
      'versionId',
      'object_key',
      'objectKey',
      'rawOrigin',
      'raw_origin',
      'rawAuthority',
      'raw_authority',
      'griffin',
      'transparenta-eu-etl-sources',
      'gate_artifact',
      'gateArtifact',
      'lexical',
      'semantic_parse',
      'load_run',
      'loaded_at',
      'packetAssessment',
    ]) {
      expect(body, marker).not.toContain(marker);
    }
    expect(SELECTION_ROWS.length).toBeGreaterThan(0);
  });
});
