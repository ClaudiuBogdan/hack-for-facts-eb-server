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
 */

import { createDatasetRepo } from '@/modules/datasets/index.js';

import type { FastifyInstance } from 'fastify';

// =============================================================================
// Types
// =============================================================================

export interface GoldenMasterClient {
  /**
   * Execute a GraphQL query and return the data portion of the response.
   * Throws on GraphQL errors.
   */
  query<T = unknown>(gql: string, variables?: Record<string, unknown>): Promise<T>;

  /**
   * Close the client and release resources.
   */
  close(): Promise<void>;
}

interface GraphQLResponse<T = unknown> {
  data?: T;
  errors?: {
    message: string;
    locations?: { line: number; column: number }[];
    path?: (string | number)[];
  }[];
}

// =============================================================================
// API Mode Client
// =============================================================================

/**
 * Creates a client that sends HTTP requests to an external GraphQL API.
 * Used for generating snapshots from production.
 */
function createApiClient(apiUrl: string): GoldenMasterClient {
  return {
    async query<T = unknown>(gql: string, variables?: Record<string, unknown>): Promise<T> {
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
      });

      if (!response.ok) {
        throw new Error(`HTTP error: ${String(response.status)} ${response.statusText}`);
      }

      const body = (await response.json()) as GraphQLResponse<T>;

      if (body.errors !== undefined && body.errors.length > 0) {
        const errorMessages = body.errors.map((e) => e.message).join('; ');
        throw new Error(`GraphQL errors: ${errorMessages}`);
      }

      if (body.data === undefined) {
        throw new Error('GraphQL response has no data');
      }

      return body.data;
    },

    async close(): Promise<void> {
      // No-op for API client
    },
  };
}

// =============================================================================
// Database Mode Client
// =============================================================================

/**
 * Creates a client that uses Fastify's inject method for in-process testing.
 * Used for CI/CD and local development.
 */
function createDbClient(app: FastifyInstance): GoldenMasterClient {
  return {
    async query<T = unknown>(gql: string, variables?: Record<string, unknown>): Promise<T> {
      const response = await app.inject({
        method: 'POST',
        url: '/graphql',
        payload: {
          query: gql,
          variables,
        },
      });

      if (response.statusCode !== 200) {
        throw new Error(`HTTP error: ${String(response.statusCode)} ${response.body}`);
      }

      const body = response.json<GraphQLResponse<T>>();

      if (body.errors !== undefined && body.errors.length > 0) {
        const errorMessages = body.errors.map((e) => e.message).join('; ');
        throw new Error(`GraphQL errors: ${errorMessages}`);
      }

      if (body.data === undefined) {
        throw new Error('GraphQL response has no data');
      }

      return body.data;
    },

    async close(): Promise<void> {
      await app.close();
    },
  };
}

// =============================================================================
// Client Factory
// =============================================================================

// Singleton instance
let clientInstance: GoldenMasterClient | null = null;
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
    console.log(`[Golden Master] API Mode: ${apiUrl}`);
    clientInstance = createApiClient(apiUrl);
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
    const config = {
      server: {
        port: 0,
        host: '127.0.0.1',
        isDevelopment: false,
        isProduction: false,
        isTest: true,
      },
      logger: { level: 'silent' as const, pretty: false },
      database: {
        budgetUrl: dbUrl,
        insUrl: dbUrl,
        userUrl: dbUrl,
      },
      redis: { url: undefined, password: undefined, prefix: undefined },
      cors: {
        allowedOrigins: undefined,
        clientBaseUrl: undefined,
        publicClientBaseUrl: undefined,
      },
      auth: {
        clerkSecretKey: undefined,
        clerkJwtKey: undefined,
        clerkAuthorizedParties: undefined,
        enabled: false,
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
      gpt: {
        apiKey: undefined,
      },
      email: {
        apiKey: undefined,
        webhookSecret: undefined,
        fromAddress: 'noreply@test.example.com',
        previewEnabled: false,
        maxRps: 2,
        enabled: false,
      },
      jobs: {
        enabled: false,
        concurrency: 5,
        prefix: 'test:jobs',
        processRole: 'both' as const,
      },
      notifications: {
        triggerApiKey: undefined,
        platformBaseUrl: 'https://test.example.com',
        enabled: false,
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
}
