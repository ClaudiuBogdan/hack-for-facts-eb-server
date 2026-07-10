import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildRedesignApp } from '@/app/build-redesign-app.js';

import type { FastifyInstance } from 'fastify';

interface GraphQLResponse {
  readonly data?: Record<string, unknown> | null;
  readonly errors?: readonly {
    readonly message: string;
    readonly extensions?: Readonly<Record<string, unknown>>;
  }[];
}

describe('redesign GraphQL security policy', () => {
  let app: FastifyInstance;
  const previousNodeEnv = process.env['NODE_ENV'];

  beforeAll(async () => {
    process.env['NODE_ENV'] = 'production';
    const built = await buildRedesignApp({
      logLevel: 'silent',
      modules: [],
      kernelConfig: {
        prodDatabaseUrl: 'postgres://unused:unused@127.0.0.1:1/unused',
        meiliHost: '',
        meiliApiKey: '',
        opensearchUrl: '',
      },
      graphqlSlices: [
        {
          source: 'security-test',
          typeDefs: 'extend type Query { securityTestFailure: String! }',
        },
      ],
      graphqlResolvers: {
        Query: {
          securityTestFailure: () => {
            throw new Error('sensitive database detail');
          },
        },
      },
    });
    app = built.app;
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    if (previousNodeEnv === undefined) delete process.env['NODE_ENV'];
    else process.env['NODE_ENV'] = previousNodeEnv;
  });

  const query = async (source: string): Promise<GraphQLResponse> => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/graphql',
      payload: { query: source },
    });
    expect(response.statusCode).toBe(200);
    return response.json<GraphQLResponse>();
  };

  it('blocks introspection in production', async () => {
    const response = await query('{ __schema { queryType { name } } }');
    expect(response.data).toBeNull();
    expect(response.errors?.[0]).toMatchObject({
      message: 'Internal server error',
    });
  });

  it('blocks shallow alias fan-out before resolvers execute', async () => {
    const aliases = Array.from(
      { length: 51 },
      (_, index) => `health${String(index)}: health { overall }`
    ).join('\n');
    const response = await query(`query AliasFanOut { ${aliases} }`);
    expect(response.data).toBeNull();
    expect(response.errors?.[0]).toMatchObject({
      message: 'Internal server error',
    });
  });

  it('redacts internal resolver errors in production', async () => {
    const response = await query('{ securityTestFailure }');
    expect(response.errors?.[0]?.message).toBe('Internal server error');
    expect(JSON.stringify(response.errors)).not.toContain('sensitive database detail');
  });
});
