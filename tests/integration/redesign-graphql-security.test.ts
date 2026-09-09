import { buildSchema, Kind, parse, validate } from 'graphql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildRedesignApp } from '@/app/build-redesign-app.js';
import { HEAVY_BUDGET_FIELD_NAMES, makeGraphQLValidationRules } from '@/infra/graphql/security.js';
import { budgetTypeDefs } from '@/modules/budget/shell/graphql/typedefs.js';

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
  let factAggregateExecutions = 0;
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
          typeDefs:
            'extend type Query { securityTestFailure: String!, budgetAggregateByClassification: String!, budgetAggregateTimeseries: String!, budgetUatHeatmap: String! }',
        },
      ],
      graphqlResolvers: {
        Query: {
          securityTestFailure: () => {
            throw new Error('sensitive database detail');
          },
          budgetAggregateByClassification: () => {
            factAggregateExecutions += 1;
            return 'ok';
          },
          budgetAggregateTimeseries: () => {
            factAggregateExecutions += 1;
            return 'ok';
          },
          budgetUatHeatmap: () => {
            factAggregateExecutions += 1;
            return 'ok';
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

  const query = async (source: string, expectedStatus = 200): Promise<GraphQLResponse> => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/graphql',
      payload: { query: source },
    });
    expect(response.statusCode).toBe(expectedStatus);
    return response.json<GraphQLResponse>();
  };

  it('blocks introspection in production', async () => {
    const response = await query('{ __schema { queryType { name } } }');
    expect(response.data).toBeNull();
    // Validation errors are written for the client and pass through unredacted.
    expect(response.errors?.[0]?.message).toContain('introspection has been disabled');
    expect(response.errors?.[0]?.extensions).toBeUndefined();
  });

  it('blocks shallow alias fan-out before resolvers execute', async () => {
    const aliases = Array.from(
      { length: 51 },
      (_, index) => `health${String(index)}: health { overall }`
    ).join('\n');
    // mercurius answers validation failures with 400.
    const response = await query(`query AliasFanOut { ${aliases} }`, 400);
    expect(response.data).toBeNull();
    expect(response.errors?.[0]?.message).toBe('Query exceeds maximum alias count of 50.');
  });

  it('allows two heavy budget fields', () => {
    const schema = buildSchema(`type Query {
      budgetAggregateByClassification: String!
      budgetAggregateTimeseries: String!
    }`);
    const errors = validate(
      schema,
      parse(`query BoundedBudgetWork {
        first: budgetAggregateByClassification
        second: budgetAggregateTimeseries
      }`),
      makeGraphQLValidationRules(false)
    );
    expect(errors).toEqual([]);
  });

  it('keeps every configured heavy field tied to the budget SDL', () => {
    const document = parse(budgetTypeDefs);
    const queryFields = new Set(
      document.definitions.flatMap((definition) =>
        definition.kind === Kind.OBJECT_TYPE_EXTENSION && definition.name.value === 'Query'
          ? (definition.fields ?? []).map((field) => field.name.value)
          : []
      )
    );
    for (const fieldName of HEAVY_BUDGET_FIELD_NAMES) {
      expect(queryFields.has(fieldName), fieldName).toBe(true);
    }
  });

  it('blocks mixed heavy budget fields before execution', async () => {
    factAggregateExecutions = 0;
    const response = await query(
      `query FactFanOut {
      first: budgetAggregateByClassification
      second: budgetAggregateTimeseries
      third: budgetUatHeatmap
    }`,
      400
    );
    expect(response.data).toBeNull();
    expect(response.errors?.[0]?.message).toBe(
      'Query exceeds maximum heavy budget field count of 2.'
    );
    expect(factAggregateExecutions).toBe(0);
  });

  it('redacts internal resolver errors in production', async () => {
    const response = await query('{ securityTestFailure }');
    expect(response.errors?.[0]).toMatchObject({
      message: 'Internal server error',
      path: ['securityTestFailure'],
    });
    expect(JSON.stringify(response.errors)).not.toContain('sensitive database detail');
  });
});
