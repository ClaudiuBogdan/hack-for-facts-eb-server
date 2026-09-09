/**
 * Golden Master GraphQL Client
 *
 * HTTP client against a running GraphQL endpoint (`TEST_GM_API_URL`). The
 * former in-process "database mode" (`TEST_GM_DATABASE_URL`, an `app.inject`
 * client over the legacy `/graphql` endpoint) was retired with that endpoint in
 * slice 1 (2026-09-09): setting the variable now fails fast instead of posting
 * to a route that no longer exists.
 *
 * Comparison mode (orthogonal, API mode only):
 * - TEST_GM_BASELINE_URL unset → SNAPSHOT mode: today's behaviour, specs compare
 *   `data` against the stored `snapshots/**.snap.json`.
 * - TEST_GM_BASELINE_URL set   → CUTOVER mode: every document+variables is sent
 *   to BOTH the baseline (expected, today's `/graphql`) and the target
 *   (`TEST_GM_API_URL`, the new `/api/v1/graphql`) and the full envelopes are
 *   compared (see compare.ts / cutover.ts). `query()` becomes the gate: it
 *   throws on any defect, contract-break or non-allowlisted data-parity
 *   difference and returns the TARGET data, so the 12 existing spec files
 *   participate without edits; `toMatchNormalizedSnapshot` short-circuits
 *   (setup.ts) because the stored snapshots were recorded against a different
 *   database.
 *
 * Transport rules: the body is parsed LOSSLESSLY (numbers keep
 * their wire text, envelope.ts) and validated as a GraphQL envelope — a
 * Fastify 404 body, non-JSON, a non-finite number, a redirect or a timeout
 * throw instead of producing an envelope. `query()` returns PLAIN data
 * (`toPlain`, numbers as JS numbers) for the existing specs.
 */

import { expect } from 'vitest';

import { loadAllowlist, type AllowlistFile } from './allowlist.js';
import { computeCaseKey } from './corpus.js';
import {
  DEFAULT_FETCH_TIMEOUT_MS,
  describeFailure,
  fetchTimeoutForCase,
  runCutoverCase,
  type QueryEnvelopeOptions,
} from './cutover.js';
import { redactEndpoint, sameEndpoint } from './endpoint.js';
import { EnvelopeError, parseEnvelope, toPlain, type GraphQLEnvelope } from './envelope.js';
import { resolveRunId } from './report.js';

export type { GraphQLEnvelope, GraphQLErrorShape } from './envelope.js';

// =============================================================================
// Types
// =============================================================================

export interface GoldenMasterClient {
  /**
   * The endpoint this client posts to (API mode, userinfo redacted) or
   * Safe to print and to write into reports.
   */
  readonly url: string;

  /**
   * Execute a GraphQL query and return the data portion of the response as
   * PLAIN JSON (numbers as JS numbers). Throws on GraphQL errors, non-200,
   * null data. In CUTOVER mode it also runs the same document against the
   * baseline, compares the envelopes and throws on a blocking difference
   * (see module doc).
   */
  query<T = unknown>(gql: string, variables?: Record<string, unknown>): Promise<T>;

  /**
   * Execute a GraphQL query and return the FULL envelope `{ status, url, data,
   * errors }` verbatim with LOSSLESS numbers — never throws on `errors[]` or
   * on a non-2xx status, so the four documents that are invalid against
   * today's SDL have a recordable expectation. Throws (`EnvelopeError`,
   * `TimeoutError`, fetch errors) only when there is no GraphQL envelope.
   */
  queryEnvelope<T = unknown>(
    gql: string,
    variables?: Record<string, unknown>,
    options?: QueryEnvelopeOptions
  ): Promise<GraphQLEnvelope<T>>;

  /**
   * Close the client and release resources.
   */
  close(): Promise<void>;
}

/** Shared `query()` semantics on top of a `queryEnvelope()` result. */
function dataFromEnvelope<T>(envelope: GraphQLEnvelope<T>): T {
  if (envelope.errors !== undefined && envelope.errors.length > 0) {
    const errorMessages = envelope.errors.map((e) => e.message).join('; ');
    throw new Error(`GraphQL errors: ${errorMessages}`);
  }

  if (envelope.status !== 200) {
    throw new Error(`HTTP error: ${String(envelope.status)}`);
  }

  if (envelope.data === undefined || envelope.data === null) {
    throw new Error('GraphQL response has no data');
  }

  return envelope.data;
}

// =============================================================================
// API Mode Client
// =============================================================================

/**
 * Creates a client that sends HTTP requests to an external GraphQL API.
 * Used for generating snapshots from production and for the cutover run.
 */
function createApiClient(apiUrl: string): GoldenMasterClient {
  const displayUrl = redactEndpoint(apiUrl);

  const client: GoldenMasterClient = {
    url: displayUrl,

    async queryEnvelope<T = unknown>(
      gql: string,
      variables?: Record<string, unknown>,
      options?: QueryEnvelopeOptions
    ): Promise<GraphQLEnvelope<T>> {
      const timeoutMs = options?.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          query: gql,
          variables,
        }),
        // A redirect would silently compare some OTHER endpoint (e.g.
        // /api/v1/graphql → /graphql, the baseline against itself).
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        throw new EnvelopeError(
          'redirect',
          `HTTP ${String(response.status)} redirect from ${displayUrl}${
            location === null ? '' : ` to ${redactEndpoint(location)}`
          } — the endpoint under test must answer directly`
        );
      }

      const text = await response.text();
      const finalUrl = response.url.length > 0 ? redactEndpoint(response.url) : displayUrl;
      return parseEnvelope<T>(text, response.status, finalUrl);
    },

    async query<T = unknown>(gql: string, variables?: Record<string, unknown>): Promise<T> {
      return toPlain(dataFromEnvelope(await client.queryEnvelope<T>(gql, variables))) as T;
    },

    async close(): Promise<void> {
      // No-op for API client
    },
  };
  return client;
}

// =============================================================================
// Execution / comparison mode
// =============================================================================

// =============================================================================
// Cutover Mode Client (target + baseline, compared on every query())
// =============================================================================

let allowlistCache: AllowlistFile | null = null;

/**
 * The legacy specs run under `vitest.gm.config.ts` `testTimeout: 30_000`; the
 * per-side fetch timeout is derived from it so a hanging side is recorded as
 * a `transport-error` (with a case file) before vitest kills the test.
 */
const LEGACY_SPEC_CASE_TIMEOUT_MS = 30_000;

function getAllowlist(): AllowlistFile {
  allowlistCache ??= loadAllowlist();
  return allowlistCache;
}

/**
 * Wraps the target client so that `query()` also runs the document against the
 * baseline and asserts envelope equivalence. `queryEnvelope()` is NOT wrapped:
 * it returns the plain target envelope, and callers that want an explicit
 * comparison (specs/client-documents.gm.test.ts) call `runCutoverCase` with
 * `getBaselineClient()` themselves.
 */
function createCutoverClient(
  target: GoldenMasterClient,
  baseline: GoldenMasterClient
): GoldenMasterClient {
  return {
    url: target.url,

    async queryEnvelope<T = unknown>(
      gql: string,
      variables?: Record<string, unknown>,
      options?: QueryEnvelopeOptions
    ): Promise<GraphQLEnvelope<T>> {
      return target.queryEnvelope<T>(gql, variables, options);
    },

    close: () => target.close(),

    async query<T = unknown>(gql: string, variables?: Record<string, unknown>): Promise<T> {
      const vars = variables ?? {};
      const keys = computeCaseKey(gql, vars);
      const testName =
        expect.getState().currentTestName ?? `document ${keys.documentHash.slice(0, 12)}`;

      const result = await runCutoverCase(
        {
          id: testName,
          ...keys,
          operationName: null,
          status: 'live',
          source: null,
          document: gql,
          variables: vars,
        },
        {
          baseline,
          target,
          allowlist: getAllowlist(),
          runId: resolveRunId(),
          fetchTimeoutMs: fetchTimeoutForCase(LEGACY_SPEC_CASE_TIMEOUT_MS),
        }
      );

      if (result.report.verdict === 'fail') {
        throw new Error(describeFailure(result));
      }

      // Same semantics as snapshot-mode query(): the target must have answered.
      return toPlain(dataFromEnvelope(result.target as GraphQLEnvelope<T>)) as T;
    },
  };
}

// =============================================================================
// Client Factory
// =============================================================================

// Singleton instance
let clientInstance: GoldenMasterClient | null = null;
let baselineInstance: GoldenMasterClient | null = null;
/**
 * Detect execution mode from environment variables.
 */
export function getExecutionMode(): 'api' {
  if (process.env['TEST_GM_DATABASE_URL'] !== undefined) {
    throw new Error(
      'TEST_GM_DATABASE_URL (in-process database mode) was retired with the legacy /graphql endpoint (slice 1, 2026-09-09); point TEST_GM_API_URL at the endpoint the spec set targets (see tests/golden-master/README.md)'
    );
  }
  if (process.env['TEST_GM_API_URL'] === undefined) {
    throw new Error('Golden Master tests require the TEST_GM_API_URL environment variable');
  }
  return 'api';
}

/**
 * Detect comparison mode. A half-configured environment throws rather than silently
 * running in snapshot mode, and so does a pair of URLs that canonicalize to
 * the same endpoint (host case, default port, trailing slash, userinfo).
 */
export function getComparisonMode(env: NodeJS.ProcessEnv = process.env): 'snapshot' | 'cutover' {
  const baseline = env['TEST_GM_BASELINE_URL'];
  if (baseline === undefined) {
    return 'snapshot';
  }
  if (baseline.length === 0) {
    throw new Error('TEST_GM_BASELINE_URL is set but empty');
  }
  const target = env['TEST_GM_API_URL'];
  if (target === undefined) {
    throw new Error(
      'TEST_GM_BASELINE_URL requires TEST_GM_API_URL (the target endpoint) — cutover mode compares two HTTP endpoints'
    );
  }
  if (sameEndpoint(baseline, target)) {
    throw new Error(
      `TEST_GM_BASELINE_URL and TEST_GM_API_URL canonicalize to the same endpoint (${redactEndpoint(baseline)} vs ${redactEndpoint(target)}) — nothing to compare`
    );
  }
  return 'cutover';
}

/**
 * The baseline (expected) client in cutover mode; `null` in snapshot mode.
 */
export function getBaselineClient(): GoldenMasterClient | null {
  if (getComparisonMode() === 'snapshot') {
    return null;
  }
  baselineInstance ??= createApiClient(process.env['TEST_GM_BASELINE_URL']!);
  return baselineInstance;
}

/**
 * Get or create the Golden Master client.
 * Uses singleton pattern to share connection across tests.
 */
export async function getClient(): Promise<GoldenMasterClient> {
  if (clientInstance !== null) {
    return clientInstance;
  }

  getExecutionMode();
  const apiUrl = process.env['TEST_GM_API_URL']!;
  const baseline = getBaselineClient();
  const target = createApiClient(apiUrl);
  if (baseline !== null) {
    console.log(`[Golden Master] CUTOVER mode: baseline ${baseline.url} → target ${target.url}`);
    clientInstance = createCutoverClient(target, baseline);
  } else {
    console.log(`[Golden Master] API Mode: ${target.url}`);
    clientInstance = target;
  }
  return clientInstance;
}

/**
 * Close the client and release resources.
 * Should be called in afterAll hook.
 */
export async function closeClient(): Promise<void> {
  if (clientInstance !== null) {
    await clientInstance.close();
    clientInstance = null;
  }
  if (baselineInstance !== null) {
    await baselineInstance.close();
    baselineInstance = null;
  }
  allowlistCache = null;
}
