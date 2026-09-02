/**
 * Golden Master — the legacy `executionAnalytics` root served by the KERNEL
 * endpoint (docs/server-redesign/13 §5 step 2, §6).
 *
 * Replays the exact documents + variables of `execution-analytics.gm.test.ts`
 * against `TEST_GM_API_URL`, which may now point at `/api/v1/graphql`, and
 * asserts against the SAME snapshot files the legacy endpoint recorded. Run:
 *
 *   TEST_GM_API_URL=http://localhost:3001/api/v1/graphql \
 *     pnpm exec vitest run tests/golden-master/specs/legacy-execution-analytics-kernel.gm.test.ts \
 *     --config vitest.gm.config.ts
 *
 * Never point it at production. Every replay asserts the FULL envelope: the
 * endpoint must return NO `errors[]` (13 §6 "no new errors") and `data` must
 * match the legacy snapshot at 2 dp. The envelope is fetched by a LOCAL helper
 * (`executeEnvelope`) — `tests/golden-master/client.ts` is owned by the
 * `gm-cutover-harness` worktree and is not touched here; when that harness
 * lands, this spec is classified gating / extended by it. Expected, documented deltas (13 §7):
 * `yearly-per-capita` / `quarterly-per-capita` move by ×1.0002 (country
 * population = the reference dataset's latest year, 19,050,000, instead of the
 * county-row sum 19,053,815) and by ≈×2 wherever an `is_uat` / `entity_types`
 * scope was the denominator; the `(real <year>)` label follows the latest CPI
 * year. Those cases fail here BY DESIGN until the snapshots are re-baselined
 * with the recorded before/after numbers — the dual-endpoint cutover harness
 * (worktree `gm-cutover-harness`) is the gate that classifies them.
 */

import { beforeAll, describe, expect, it } from 'vitest';

interface GraphQLEnvelope<T> {
  readonly data?: T | null;
  readonly errors?: readonly { readonly message: string; readonly path?: readonly unknown[] }[];
  /** HTTP status the envelope came with (mercurius answers validation errors with 400). */
  readonly status: number;
}

/**
 * POST one document to `TEST_GM_API_URL` and return the envelope as the endpoint
 * sent it — `data` AND `errors` — never throwing on GraphQL errors, and keeping
 * a non-2xx body when it is an envelope. API mode only: this spec replays
 * against a running kernel server (the in-process database mode is the
 * harness's concern).
 */
const executeEnvelope = async <T>(
  apiUrl: string,
  query: string,
  variables: Record<string, unknown>
): Promise<GraphQLEnvelope<T>> => {
  const response = await fetch(apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const text = await response.text();
  let parsed: unknown;
  try {
    // eslint-disable-next-line no-restricted-syntax -- parsing the endpoint's own response in a test
    parsed = JSON.parse(text) as unknown;
  } catch {
    parsed = undefined;
  }
  const isEnvelope =
    typeof parsed === 'object' && parsed !== null && ('data' in parsed || 'errors' in parsed);
  if (!isEnvelope) {
    throw new Error(
      `HTTP ${String(response.status)} without a GraphQL envelope: ${text.slice(0, 200)}`
    );
  }
  return { ...(parsed as Omit<GraphQLEnvelope<T>, 'status'>), status: response.status };
};

interface ExecutionAnalyticsData {
  readonly executionAnalytics: readonly {
    readonly seriesId: string;
    readonly data: readonly { readonly x: string; readonly y: number }[];
  }[];
}

const DOCUMENT = /* GraphQL */ `
  query GetExecutionLineItemsAnalytics($inputs: [AnalyticsInput!]!) {
    executionAnalytics(inputs: $inputs) {
      seriesId
      xAxis {
        name
        type
        unit
      }
      yAxis {
        name
        type
        unit
      }
      data {
        x
        y
      }
    }
  }
`;

const yearInterval = (start: string, end: string): unknown => ({
  type: 'YEAR',
  selection: { interval: { start, end } },
});

interface GmCase {
  readonly name: string;
  readonly snapshot: string;
  readonly inputs: unknown[];
}

const CASES: readonly GmCase[] = [
  {
    name: 'yearly-totals',
    snapshot: 'yearly-totals',
    inputs: [
      {
        seriesId: 'yearly-totals',
        filter: {
          account_category: 'ch',
          report_type: 'PRINCIPAL_AGGREGATED',
          report_period: yearInterval('2020', '2023'),
          normalization: 'total',
        },
      },
    ],
  },
  {
    name: 'yearly-per-capita',
    snapshot: 'yearly-per-capita',
    inputs: [
      {
        seriesId: 'yearly-per-capita',
        filter: {
          account_category: 'ch',
          report_type: 'PRINCIPAL_AGGREGATED',
          report_period: yearInterval('2016', '2024'),
          normalization: 'per_capita',
        },
      },
    ],
  },
  {
    name: 'yearly-with-economic-filter',
    snapshot: 'yearly-with-economic-filter',
    inputs: [
      {
        seriesId: 'yearly-economic-filter',
        filter: {
          account_category: 'ch',
          report_type: 'PRINCIPAL_AGGREGATED',
          report_period: yearInterval('2020', '2023'),
          normalization: 'total',
          economic_prefixes: ['10'],
        },
      },
    ],
  },
  {
    name: 'quarterly-totals',
    snapshot: 'quarterly-totals',
    inputs: [
      {
        seriesId: 'quarterly-totals',
        filter: {
          account_category: 'ch',
          report_type: 'PRINCIPAL_AGGREGATED',
          report_period: {
            type: 'QUARTER',
            selection: { interval: { start: '2022-Q1', end: '2023-Q4' } },
          },
          normalization: 'total',
        },
      },
    ],
  },
  {
    name: 'quarterly-per-capita',
    snapshot: 'quarterly-per-capita',
    inputs: [
      {
        seriesId: 'quarterly-per-capita',
        filter: {
          account_category: 'ch',
          report_type: 'PRINCIPAL_AGGREGATED',
          report_period: {
            type: 'QUARTER',
            selection: { interval: { start: '2022-Q1', end: '2023-Q4' } },
          },
          normalization: 'per_capita',
        },
      },
    ],
  },
  {
    name: 'monthly-totals',
    snapshot: 'monthly-totals',
    inputs: [
      {
        seriesId: 'monthly-totals',
        filter: {
          account_category: 'ch',
          report_type: 'PRINCIPAL_AGGREGATED',
          report_period: {
            type: 'MONTH',
            selection: {
              dates: ['2023-01', '2023-02', '2023-03', '2023-04', '2023-05', '2023-06'],
            },
          },
          normalization: 'total',
        },
      },
    ],
  },
  {
    name: 'filtered-by-county',
    snapshot: 'filtered-by-county',
    inputs: [
      {
        seriesId: 'county-cj',
        filter: {
          account_category: 'ch',
          report_type: 'PRINCIPAL_AGGREGATED',
          report_period: yearInterval('2020', '2023'),
          county_codes: ['CJ'],
          normalization: 'total',
        },
      },
    ],
  },
  {
    name: 'filtered-by-functional',
    snapshot: 'filtered-by-functional',
    inputs: [
      {
        seriesId: 'functional-education',
        filter: {
          account_category: 'ch',
          report_type: 'PRINCIPAL_AGGREGATED',
          report_period: yearInterval('2020', '2023'),
          functional_prefixes: ['65'],
          normalization: 'total',
        },
      },
    ],
  },
  {
    name: 'filtered-by-entity-type',
    snapshot: 'filtered-by-entity-type',
    inputs: [
      {
        seriesId: 'entity-type-uat',
        filter: {
          account_category: 'ch',
          report_type: 'PRINCIPAL_AGGREGATED',
          report_period: yearInterval('2020', '2023'),
          entity_types: ['uat'],
          normalization: 'total',
        },
      },
    ],
  },
  {
    name: 'yearly-total-euro',
    snapshot: 'yearly-total-euro',
    inputs: [
      {
        seriesId: 'yearly-total-euro',
        filter: {
          account_category: 'ch',
          report_type: 'PRINCIPAL_AGGREGATED',
          report_period: yearInterval('2016', '2024'),
          normalization: 'total_euro',
        },
      },
    ],
  },
  {
    name: 'income-vs-expenses',
    snapshot: 'income-vs-expenses',
    inputs: [
      {
        seriesId: 'income-yearly',
        filter: {
          account_category: 'vn',
          report_type: 'PRINCIPAL_AGGREGATED',
          report_period: yearInterval('2016', '2024'),
          normalization: 'total',
        },
      },
      {
        seriesId: 'expenses-yearly',
        filter: {
          account_category: 'ch',
          report_type: 'PRINCIPAL_AGGREGATED',
          report_period: yearInterval('2016', '2024'),
          normalization: 'total',
        },
      },
    ],
  },
  {
    name: 'multi-series',
    snapshot: 'multi-series',
    inputs: [
      {
        seriesId: 'income',
        filter: {
          account_category: 'vn',
          report_type: 'PRINCIPAL_AGGREGATED',
          report_period: yearInterval('2020', '2023'),
          normalization: 'total',
        },
      },
      {
        seriesId: 'expenses',
        filter: {
          account_category: 'ch',
          report_type: 'PRINCIPAL_AGGREGATED',
          report_period: yearInterval('2020', '2023'),
          normalization: 'total',
        },
      },
    ],
  },
  {
    name: 'quarterly-income-vs-expenses',
    snapshot: 'quarterly-income-vs-expenses',
    inputs: [
      {
        seriesId: 'quarterly-expenses',
        filter: {
          report_period: {
            type: 'QUARTER',
            selection: { interval: { start: '2016-Q1', end: '2025-Q3' } },
          },
          account_category: 'ch',
          report_type: 'PRINCIPAL_AGGREGATED',
        },
      },
      {
        seriesId: 'quarterly-income',
        filter: {
          report_period: {
            type: 'QUARTER',
            selection: { interval: { start: '2016-Q1', end: '2025-Q3' } },
          },
          account_category: 'vn',
          report_type: 'PRINCIPAL_AGGREGATED',
        },
      },
    ],
  },
  {
    name: 'monthly-income-vs-expenses',
    snapshot: 'monthly-income-vs-expenses',
    inputs: [
      {
        seriesId: 'monthly-expenses',
        filter: {
          report_period: {
            type: 'MONTH',
            selection: { interval: { start: '2016-01', end: '2025-10' } },
          },
          account_category: 'ch',
          report_type: 'PRINCIPAL_AGGREGATED',
        },
      },
      {
        seriesId: 'monthly-income',
        filter: {
          report_period: {
            type: 'MONTH',
            selection: { interval: { start: '2016-01', end: '2025-10' } },
          },
          account_category: 'vn',
          report_type: 'PRINCIPAL_AGGREGATED',
        },
      },
    ],
  },
];

describe('[Golden Master] Execution Analytics — legacy root on the kernel endpoint', () => {
  let apiUrl = '';

  beforeAll(() => {
    const url = process.env['TEST_GM_API_URL'] ?? '';
    if (url.includes('transparenta.eu')) {
      throw new Error('refusing to replay the golden master against production');
    }
    if (url === '') {
      throw new Error(
        'this spec replays against a running kernel server: set TEST_GM_API_URL=http://localhost:<port>/api/v1/graphql'
      );
    }
    apiUrl = url;
  });

  for (const gm of CASES) {
    it(`[GM/kernel] executionAnalytics - ${gm.name}`, async () => {
      const envelope = await executeEnvelope<ExecutionAnalyticsData>(apiUrl, DOCUMENT, {
        inputs: gm.inputs,
      });
      // The full envelope: HTTP 200, no errors at all, and data present — a
      // thrown summary would hide WHICH error the endpoint produced.
      expect(envelope.status).toBe(200);
      expect(envelope.errors, JSON.stringify(envelope.errors)).toBeUndefined();
      expect(envelope.data).toBeDefined();
      expect(envelope.data?.executionAnalytics.map((s) => s.seriesId)).toEqual(
        gm.inputs.map((i) => (i as { seriesId: string }).seriesId)
      );
      await expect(envelope.data).toMatchNormalizedSnapshot(
        `../snapshots/execution-analytics/${gm.snapshot}.snap.json`
      );
    });
  }
});
