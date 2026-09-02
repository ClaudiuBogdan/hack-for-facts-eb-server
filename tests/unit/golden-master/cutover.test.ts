import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  CASE_TIMEOUT_MARGIN_MS,
  DEFAULT_FETCH_TIMEOUT_MS,
  describeFailure,
  fetchTimeoutForCase,
  isUsableAnswer,
  judgeCase,
  MIN_FETCH_TIMEOUT_MS,
  runCutoverCase,
  type EnvelopeSource,
} from '../../golden-master/cutover.js';
import { EnvelopeError, parseEnvelope } from '../../golden-master/envelope.js';

import type { Difference, GraphQLEnvelope } from '../../golden-master/compare.js';

const DOCUMENT = 'query Q { entities(limit: 1) { nodes { cui } pageInfo { totalCount } } }';
const KEY = `${'a'.repeat(64)}:${'b'.repeat(64)}`;
const okEnvelope: GraphQLEnvelope = {
  status: 200,
  data: { entities: { nodes: [{ cui: '1' }], pageInfo: { totalCount: 1 } } },
};
const errorEnvelope: GraphQLEnvelope = {
  status: 400,
  errors: [
    { message: 'Variable "$ids" of type "[String!]" used in position expecting type "[ID!]".' },
  ],
};
const FASTIFY_404 =
  '{"message":"Route POST:/graphql not found","error":"Not Found","statusCode":404}';

function source(
  url: string,
  envelope: GraphQLEnvelope
): EnvelopeSource & {
  calls: { gql: string; variables: unknown; timeoutMs: number | undefined }[];
} {
  const calls: { gql: string; variables: unknown; timeoutMs: number | undefined }[] = [];
  return {
    url,
    calls,
    queryEnvelope: async (gql, variables, options) => {
      calls.push({ gql, variables, timeoutMs: options?.timeoutMs });
      return structuredClone(envelope);
    },
  };
}

/** A side whose HTTP body is `text` — goes through the real envelope parser like client.ts. */
function raw(url: string, status: number, text: string): EnvelopeSource {
  return {
    url,
    queryEnvelope: async () => parseEnvelope(text, status, url),
  };
}

const baseInput = {
  id: 'entities-first',
  key: KEY,
  documentHash: 'a'.repeat(64),
  variablesHash: 'b'.repeat(64),
  operationName: 'Q',
  status: 'live' as const,
  source: 'src/x.ts:1-2',
  document: DOCUMENT,
  variables: {},
};

function judge(params: {
  status?: 'live' | 'dead' | 'invalid-today';
  baseline?: GraphQLEnvelope;
  target?: GraphQLEnvelope;
  differences?: Difference[];
  warnings?: { kind: 'extra-key'; path: string; message: string }[];
  allowlist?: { entries: never[] };
}) {
  return judgeCase({
    status: params.status ?? 'live',
    baseline: params.baseline ?? okEnvelope,
    target: params.target ?? okEnvelope,
    differences: params.differences ?? [],
    warnings: params.warnings ?? [],
    allowlist: params.allowlist ?? { entries: [] },
    caseKey: KEY,
  });
}

describe('golden-master cutover: usable answers', () => {
  it('requires 200 + non-null object data + no errors', () => {
    expect(isUsableAnswer(okEnvelope)).toBe(true);
    expect(isUsableAnswer({ status: 200, data: {} })).toBe(true);
    expect(isUsableAnswer({ status: 200, data: {}, errors: [] })).toBe(true);
    expect(isUsableAnswer({ status: 503 })).toBe(false);
    expect(isUsableAnswer({ status: 404 })).toBe(false);
    expect(isUsableAnswer({ status: 200 })).toBe(false);
    expect(isUsableAnswer({ status: 200, data: null })).toBe(false);
    expect(isUsableAnswer({ status: 200, data: {}, errors: [{ message: 'partial' }] })).toBe(false);
    expect(isUsableAnswer({ status: 500, data: { a: 1 } })).toBe(false);
  });
});

describe('golden-master cutover: judgeCase', () => {
  it('passes a live case with identical usable envelopes', () => {
    const verdict = judge({});
    expect(verdict.verdict).toBe('pass');
    expect(verdict.defects).toEqual([]);
  });

  it('never passes a live case on two identical UNUSABLE answers', () => {
    for (const envelope of [
      { status: 503 },
      { status: 404 },
      { status: 200 },
      { status: 200, data: null },
      { status: 500, data: { a: 1 } },
    ] satisfies GraphQLEnvelope[]) {
      const verdict = judge({ baseline: envelope, target: envelope });
      expect(verdict.verdict, JSON.stringify(envelope)).toBe('fail');
      expect(verdict.defects.map((d) => d.kind)).toEqual(['no-data', 'no-data']);
    }
  });

  it('fails a live case whose BASELINE returns errors, even when the target agrees', () => {
    const verdict = judge({ baseline: errorEnvelope, target: errorEnvelope });
    expect(verdict.verdict).toBe('fail');
    expect(verdict.defects.map((d) => d.kind)).toEqual(['baseline-error', 'no-data']);
  });

  it('fails a live case whose target alone is unusable', () => {
    const verdict = judge({ target: { status: 200, data: null } });
    expect(verdict.defects.map((d) => d.kind)).toEqual(['no-data']);
    expect(verdict.defects[0]?.message).toContain('target did not answer');
  });

  it('passes an invalid-today case when both sides return the same error envelope', () => {
    const verdict = judge({
      status: 'invalid-today',
      baseline: errorEnvelope,
      target: errorEnvelope,
    });
    expect(verdict.verdict).toBe('pass');
  });

  it('fails an invalid-today case the baseline now accepts (stale status)', () => {
    const verdict = judge({ status: 'invalid-today' });
    expect(verdict.defects.map((d) => d.kind)).toEqual(['baseline-unexpectedly-valid']);
    expect(verdict.verdict).toBe('fail');
  });

  it('turns extra-key-only warnings into pass-with-warnings', () => {
    const verdict = judge({
      warnings: [{ kind: 'extra-key', path: '$.data.entities.nodes[0].extra', message: 'm' }],
    });
    expect(verdict.verdict).toBe('pass-with-warnings');
  });

  it('fails on any contract-break, and on data-parity unless pinned; rounding only warns', () => {
    const parity: Difference = {
      class: 'data-parity',
      kind: 'value-change',
      path: '$.data.a',
      expected: 1,
      actual: 2,
      message: 'm',
    };
    const rounding: Difference = {
      class: 'rounding',
      kind: 'value-change',
      path: '$.data.b',
      message: 'm',
    };
    const breakDiff: Difference = {
      class: 'contract-break',
      kind: 'missing-key',
      path: '$.data.c',
      message: 'm',
    };
    const orderBreak: Difference = {
      class: 'contract-break',
      kind: 'array-order',
      path: '$.data.nodes',
      message: 'm',
    };

    expect(judge({ differences: [rounding] }).verdict).toBe('pass-with-warnings');
    expect(judge({ differences: [parity] }).verdict).toBe('fail');

    const allowed = judgeCase({
      status: 'live',
      baseline: okEnvelope,
      target: okEnvelope,
      differences: [parity, rounding],
      warnings: [],
      allowlist: {
        entries: [
          {
            type: 'pinned',
            key: KEY,
            path: '$.data.a',
            kind: 'value-change',
            before: 1,
            after: 2,
            reason: 'known',
          },
        ],
      },
      caseKey: KEY,
    });
    expect(allowed.verdict).toBe('pass-with-warnings');
    expect(allowed.allowed).toHaveLength(1);
    expect(allowed.informational).toEqual([rounding]);

    const broken = judge({ differences: [breakDiff] });
    expect(broken.verdict).toBe('fail');
    expect(broken.blocking).toEqual([breakDiff]);

    // Array order is a contract-break and blocks like any break.
    expect(judge({ differences: [orderBreak] }).verdict).toBe('fail');
  });
});

describe('golden-master cutover: fetch timeout', () => {
  it('derives a per-side timeout that lets both sequential fetches abort inside the case timeout', () => {
    expect(fetchTimeoutForCase(30_000)).toBe(14_000);
    expect(fetchTimeoutForCase(300_000)).toBe(149_000);
    expect(2 * fetchTimeoutForCase(30_000) + CASE_TIMEOUT_MARGIN_MS).toBeLessThanOrEqual(30_000);
    expect(fetchTimeoutForCase(1_000)).toBe(MIN_FETCH_TIMEOUT_MS);
    expect(DEFAULT_FETCH_TIMEOUT_MS).toBe(30_000);
  });
});

describe('golden-master cutover: runCutoverCase', () => {
  let dir: string;
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('sends the same document+variables (and timeout) to both sides and writes a case report', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'gm-cutover-'));
    const baseline = source('http://b/graphql', okEnvelope);
    const target = source('http://t/api/v1/graphql', {
      status: 200,
      data: { entities: { nodes: [{ cui: '1', extra: true }], pageInfo: { totalCount: 1 } } },
    });

    const result = await runCutoverCase(
      { ...baseInput, variables: { limit: 1 } },
      {
        baseline,
        target,
        allowlist: { entries: [] },
        runId: 'run-1',
        reportDir: dir,
        fetchTimeoutMs: 14_000,
      }
    );

    expect(baseline.calls).toEqual([{ gql: DOCUMENT, variables: { limit: 1 }, timeoutMs: 14_000 }]);
    expect(target.calls).toEqual([{ gql: DOCUMENT, variables: { limit: 1 }, timeoutMs: 14_000 }]);
    expect(result.report.verdict).toBe('pass-with-warnings');
    expect(result.report.warnings.map((w) => w.path)).toEqual(['$.data.entities.nodes[0].extra']);
    expect(result.report.leavesCompared).toBe(2);
    expect(result.report.allowedByEntry).toEqual([]);
    expect(result.report.allowedEntryIds).toEqual([]);
    expect(result.report.sides.baseline.rootShape).toEqual({
      entities: { kind: 'connection', length: 1, totalCount: '1' },
    });
    expect(result.reportPath).toBe(
      path.join(dir, 'run-1', 'cases', `entities-first.${'a'.repeat(8)}-${'b'.repeat(8)}.json`)
    );

    // eslint-disable-next-line no-restricted-syntax -- reading back a file this test wrote
    const written = JSON.parse(readFileSync(result.reportPath, 'utf8')) as {
      key: string;
      baselineUrl: string;
      sides: { target: { url: string; status: number } };
    };
    expect(written.key).toBe(KEY);
    expect(written.baselineUrl).toBe('http://b/graphql');
    expect(written.sides.target).toMatchObject({ url: 'http://t/api/v1/graphql', status: 200 });
  });

  it('writes a failing report with a transport-error defect when a side does not answer', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'gm-cutover-'));
    const down: EnvelopeSource = {
      url: 'http://t/api/v1/graphql',
      queryEnvelope: async () => {
        throw new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED') });
      },
    };
    const result = await runCutoverCase(baseInput, {
      baseline: source('http://b/graphql', okEnvelope),
      target: down,
      allowlist: { entries: [] },
      runId: 'run-3',
      reportDir: dir,
    });
    expect(result.report.verdict).toBe('fail');
    expect(result.report.defects).toEqual([
      {
        kind: 'transport-error',
        message:
          'target http://t/api/v1/graphql did not answer with a GraphQL envelope: TypeError: fetch failed (connect ECONNREFUSED)',
      },
    ]);
    expect(result.report.counts).toEqual({ 'contract-break': 0, 'data-parity': 0, rounding: 0 });
    expect(result.target).toEqual({ status: 0 });
    expect(readFileSync(result.reportPath, 'utf8')).toContain('"transport-error"');
    expect(describeFailure(result)).toContain('defect transport-error');
  });

  it("fails with transport-error on BOTH sides when both answer Fastify's 404 body (no endpoint mounted)", async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'gm-cutover-'));
    const result = await runCutoverCase(baseInput, {
      baseline: raw('http://b/graphql', 404, FASTIFY_404),
      target: raw('http://t/api/v1/graphql', 404, FASTIFY_404),
      allowlist: { entries: [] },
      runId: 'run-404',
      reportDir: dir,
    });
    expect(result.report.verdict).toBe('fail');
    expect(result.report.defects.map((d) => d.kind)).toEqual([
      'transport-error',
      'transport-error',
    ]);
    expect(result.report.defects[0]?.message).toContain(
      'EnvelopeError: HTTP 404 body is not a GraphQL envelope'
    );
  });

  it('records a redirect and a timeout as transport errors', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'gm-cutover-'));
    const redirecting: EnvelopeSource = {
      url: 'http://t/api/v1/graphql',
      queryEnvelope: async () => {
        throw new EnvelopeError(
          'redirect',
          'HTTP 307 redirect from http://t/api/v1/graphql to http://t/graphql'
        );
      },
    };
    const hanging: EnvelopeSource = {
      url: 'http://b/graphql',
      queryEnvelope: async () => {
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      },
    };
    const result = await runCutoverCase(baseInput, {
      baseline: hanging,
      target: redirecting,
      allowlist: { entries: [] },
      runId: 'run-redirect',
      reportDir: dir,
    });
    expect(result.report.defects.map((d) => d.message)).toEqual([
      'baseline http://b/graphql did not answer with a GraphQL envelope: TimeoutError: The operation was aborted due to timeout',
      'target http://t/api/v1/graphql did not answer with a GraphQL envelope: EnvelopeError: HTTP 307 redirect from http://t/api/v1/graphql to http://t/graphql',
    ]);
  });

  it('fails a live case with no-data when both sides answer 200 with data: null', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'gm-cutover-'));
    const result = await runCutoverCase(baseInput, {
      baseline: raw('http://b/graphql', 200, '{"data":null}'),
      target: raw('http://t/api/v1/graphql', 200, '{"data":null}'),
      allowlist: { entries: [] },
      runId: 'run-null',
      reportDir: dir,
    });
    expect(result.report.verdict).toBe('fail');
    expect(result.report.defects.map((d) => d.kind)).toEqual(['no-data', 'no-data']);
  });

  it('fails on a contract-break and names it in the failure text', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'gm-cutover-'));
    const result = await runCutoverCase(baseInput, {
      baseline: source('http://b', okEnvelope),
      target: source('http://t', {
        status: 200,
        data: { entities: { nodes: [{ cui: '1' }], pageInfo: { totalCount: 2 } } },
      }),
      allowlist: { entries: [] },
      runId: 'run-2',
      reportDir: dir,
    });
    expect(result.report.verdict).toBe('fail');
    const text = describeFailure(result);
    expect(text).toContain('contract-break/total-count-change $.data.entities.pageInfo.totalCount');
    expect(text).toContain(`key ${KEY}`);
    expect(text).toContain(result.reportPath);
  });

  it('applies a systematic entry, records per-entry aggregates, and lists at most 25 records per array in the file', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'gm-cutover-'));
    const rows = 40;
    const baseline = source('http://b', {
      status: 200,
      data: {
        entityAnalytics: {
          nodes: Array.from({ length: rows }, (_, i) => ({ per_capita_amount: 100 + i })),
        },
      },
    });
    const target = source('http://t', {
      status: 200,
      data: {
        entityAnalytics: {
          nodes: Array.from({ length: rows }, (_, i) => ({ per_capita_amount: (100 + i) * 1.9 })),
        },
      },
    });
    const result = await runCutoverCase(baseInput, {
      baseline,
      target,
      allowlist: {
        entries: [
          {
            type: 'systematic',
            deltaId: 'per-capita-denominator',
            root: 'entityAnalytics',
            pathPattern: 'nodes[*].per_capita_amount',
            kind: 'value-change',
            predicate: { ratio: { min: 1.85, max: 1.95 } },
            reason: 'resident vs domicile population',
          },
        ],
      },
      runId: 'run-delta',
      reportDir: dir,
    });
    expect(result.report.verdict).toBe('pass-with-warnings');
    expect(result.report.counts).toEqual({ 'contract-break': 0, 'data-parity': rows, rounding: 0 });
    expect(result.report.allowed).toHaveLength(rows);
    expect(result.report.allowedByEntry).toHaveLength(1);
    expect(result.report.allowedByEntry[0]).toMatchObject({
      entryId:
        'systematic|per-capita-denominator|entityAnalytics|nodes[*].per_capita_amount|value-change',
      type: 'systematic',
      deltaId: 'per-capita-denominator',
      matches: rows,
      maxRelativeDifferencePath: '$.data.entityAnalytics.nodes[0].per_capita_amount',
    });
    expect(result.report.allowedByEntry[0]?.maxRelativeDifference).toBeCloseTo(0.4736842, 6);

    // eslint-disable-next-line no-restricted-syntax -- reading back a file this test wrote
    const written = JSON.parse(readFileSync(result.reportPath, 'utf8')) as {
      allowed: { difference: { kind: string; path: string } }[];
      hidden: Record<string, number>;
      counts: Record<string, number>;
    };
    expect(written.counts['data-parity']).toBe(rows);
    expect(written.allowed).toHaveLength(26);
    expect(written.allowed[25]?.difference).toMatchObject({
      kind: 'array-diff-truncated',
      path: '$.data.entityAnalytics.nodes',
    });
    expect(written.hidden).toEqual({ 'contract-break': 0, 'data-parity': rows - 25, rounding: 0 });
  });

  it('warns when every list-bearing root field is empty on the baseline', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'gm-cutover-'));
    const empty: GraphQLEnvelope = {
      status: 200,
      data: { entities: { nodes: [], pageInfo: { totalCount: 0 } } },
    };
    const result = await runCutoverCase(baseInput, {
      baseline: source('http://b', empty),
      target: source('http://t', empty),
      allowlist: { entries: [] },
      runId: 'run-empty',
      reportDir: dir,
    });
    expect(result.report.verdict).toBe('pass-with-warnings');
    expect(result.report.warnings.map((w) => w.kind)).toEqual(['baseline-empty']);
  });
});
