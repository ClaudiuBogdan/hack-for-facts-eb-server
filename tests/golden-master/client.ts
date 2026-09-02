/**
 * Golden Master GraphQL Client
 *
 * Dual-mode client that can operate in:
 * - API Mode: Direct HTTP requests to external GraphQL endpoint (for snapshot generation)
 * - Database Mode: In-process Fastify with real database connection (for CI/development)
 *
 * Mode is selected based on environment variables:
 * - TEST_GM_API_URL: Use API mode (external endpoint)
 * - TEST_GM_DATABASE_URL: Use Database mode (in-process Fastify)
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
 * Transport rules (both modes): the body is parsed LOSSLESSLY (numbers keep
 * their wire text, envelope.ts) and validated as a GraphQL envelope — a
 * Fastify 404 body, non-JSON, a non-finite number, a redirect or a timeout
 * throw instead of producing an envelope. `query()` returns PLAIN data
 * (`toPlain`, numbers as JS numbers) for the existing specs.
 */

import { expect } from 'vitest';

import { createDatasetRepo } from '@/modules/datasets/index.js';

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

import type { AppConfig } from '@/infra/config/index.js';
import type { FastifyInstance } from 'fastify';

export type { GraphQLEnvelope, GraphQLErrorShape } from './envelope.js';

// =============================================================================
// Types
// =============================================================================

export interface GoldenMasterClient {
  /**
   * The endpoint this client posts to (API mode, userinfo redacted) or
   * `inject:/graphql` (DB mode). Safe to print and to write into reports.
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
// Database Mode Client
// =============================================================================

/**
 * Creates a client that uses Fastify's inject method for in-process testing.
 * Used for CI/CD and local development.
 */
function createDbClient(app: FastifyInstance): GoldenMasterClient {
  const client: GoldenMasterClient = {
    url: 'inject:/graphql',

    async queryEnvelope<T = unknown>(
      gql: string,
      variables?: Record<string, unknown>
    ): Promise<GraphQLEnvelope<T>> {
      const response = await app.inject({
        method: 'POST',
        url: '/graphql',
        payload: {
          query: gql,
          variables,
        },
      });

      return parseEnvelope<T>(response.body, response.statusCode, client.url);
    },

    async query<T = unknown>(gql: string, variables?: Record<string, unknown>): Promise<T> {
      return toPlain(dataFromEnvelope(await client.queryEnvelope<T>(gql, variables))) as T;
    },

    async close(): Promise<void> {
      await app.close();
    },
  };
  return client;
}

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
let fastifyApp: FastifyInstance | null = null;

/**
 * Detect execution mode from environment variables.
 */
export function getExecutionMode(): 'api' | 'database' {
  if (process.env['TEST_GM_API_URL'] !== undefined) {
    return 'api';
  }
  if (process.env['TEST_GM_DATABASE_URL'] !== undefined) {
    return 'database';
  }
  throw new Error(
    'Golden Master tests require either TEST_GM_API_URL or TEST_GM_DATABASE_URL environment variable'
  );
}

/**
 * Detect comparison mode. Cutover mode requires API mode: DB mode builds the
 * app with `redesignSurface.enabled: false`, so there is no second endpoint to
 * compare against. A half-configured environment throws rather than silently
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
  if (env['TEST_GM_DATABASE_URL'] !== undefined) {
    throw new Error(
      'TEST_GM_BASELINE_URL cannot be combined with TEST_GM_DATABASE_URL — cutover mode is API mode only'
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

  const mode = getExecutionMode();

  if (mode === 'api') {
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
  } else {
    const dbUrl = process.env['TEST_GM_DATABASE_URL']!;
    console.log(`[Golden Master] Database Mode: ${dbUrl.replace(/:[^:@]+@/, ':***@')}`);

    // Dynamically import to avoid circular dependencies
    const { createApp } = await import('@/app/build-app.js');
    const { initDatabases } = await import('@/infra/database/client.js');

    // Override database URL for the app
    process.env['BUDGET_DATABASE_URL'] = dbUrl;
    process.env['INS_DATABASE_URL'] = dbUrl;
    process.env['USER_DATABASE_URL'] = dbUrl;
    process.env['DATABASE_URL'] = dbUrl;

    // Create minimal config for testing
    const config: AppConfig = {
      server: {
        port: 0,
        host: '127.0.0.1',
        isDevelopment: false,
        isProduction: false,
        isTest: true,
        trustProxy: undefined,
      },
      logger: { level: 'silent' as const, pretty: false },
      database: {
        budgetUrl: dbUrl,
        insUrl: dbUrl,
        userUrl: dbUrl,
        ssl: false,
        sslRejectUnauthorized: true,
      },
      redis: { url: undefined, password: undefined, prefix: undefined },
      redesignSurface: { enabled: false },
      cache: {
        backend: 'memory',
        defaultTtlMs: 60 * 24 * 60 * 60 * 1000,
        memoryMaxEntries: 1000,
        l1MaxEntries: 500,
        redisUrl: undefined,
        redisPassword: undefined,
        keyPrefix: 'transparenta',
      },
      cors: {
        allowedOrigins: undefined,
        clientBaseUrl: undefined,
        publicClientBaseUrl: undefined,
      },
      auth: {
        clerkSecretKey: undefined,
        clerkJwtKey: undefined,
        clerkAuthorizedParties: undefined,
        clerkWebhookSigningSecret: undefined,
        enabled: false,
      },
      rateLimit: {
        max: 300,
        window: '1 minute',
        specialHeader: undefined,
        specialKey: undefined,
        specialMax: 6000,
      },
      shortLinks: {
        dailyLimit: 100,
        cacheTtlSeconds: 86400,
      },
      mcp: {
        enabled: false,
        authRequired: false,
        apiKey: undefined,
        sessionTtlSeconds: 3600,
        clientBaseUrl: '',
      },
      agent: {
        enabled: false,
        anthropicApiKey: undefined,
        openaiApiKey: undefined,
        openrouterApiKey: undefined,
        chatModel: undefined,
        titleModel: undefined,
        researchModel: undefined,
        dailyTokenBudget: 250000,
        unlimitedUserIds: [],
      },
      gpt: {
        apiKey: undefined,
      },
      email: {
        apiKey: undefined,
        webhookSecret: undefined,
        fromAddress: 'noreply@test.example.com',
        funkyFromAddress: 'campaign@test.example.com',
        funkyFromAddressCcRecipients: [],
        funkyReplyToAddress: 'debate@transparenta.test',
        previewEnabled: false,
        maxRps: 2,
        enabled: false,
      },
      jobs: {
        redisUrl: undefined,
        redisPassword: undefined,
        concurrency: 5,
        prefix: 'test:jobs',
        notificationRecoverySweepIntervalMinutes: 15,
        notificationStuckSendingThresholdMinutes: 15,
      },
      notifications: {
        triggerApiKey: undefined,
        platformBaseUrl: 'https://test.example.com',
        apiBaseUrl: 'https://api.transparenta.eu',
        unsubscribeHmacSecret: undefined,
        enabled: false,
      },
      notificationPlatform: {
        enabled: false,
        ingestionScanSeconds: 60,
        recoveryScanMinutes: 2,
        digestSweepMinutes: 5,
        recoveryThresholdMinutes: 10,
        retentionBatchLimit: 500,
        maxSendRps: 2,
        destinationFingerprintSecret: undefined,
      },
      userDataStore: {
        enabled: false,
        reconcileMinutes: 60,
        receiptCleanupCron: '0 4 * * *',
      },
      learningProgress: {
        campaignAdminEnabledCampaigns: [],
      },
      telemetry: {
        endpoint: undefined,
        headers: undefined,
        serviceName: 'transparenta-eu-server',
        disabled: true,
        sampleRate: undefined,
        resourceAttributes: undefined,
      },
    };

    const dbs = initDatabases(config);
    const datasetRepo = createDatasetRepo({ rootDir: './datasets/yaml' });

    fastifyApp = await createApp({
      fastifyOptions: { logger: false },
      deps: {
        budgetDb: dbs.budgetDb,
        insDb: dbs.insDb,
        userDb: dbs.userDb,
        datasetRepo,
        config,
      },
    });

    clientInstance = createDbClient(fastifyApp);
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
    fastifyApp = null;
  }
  if (baselineInstance !== null) {
    await baselineInstance.close();
    baselineInstance = null;
  }
  allowlistCache = null;
}
