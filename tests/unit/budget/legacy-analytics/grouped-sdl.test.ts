import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import { makeExecutableSchema } from '@graphql-tools/schema';
import { buildSchema, parse, print, validateSchema, visit } from 'graphql';
import { ok } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import { CommonTypes } from '@/infra/graphql/common/types.js';
import { makeBudgetGroupedResolvers } from '@/modules/budget/shell/graphql/legacy/grouped-resolvers.js';
import { budgetGroupedTypeDefs } from '@/modules/budget/shell/graphql/legacy/grouped-typedefs.js';
import {
  budgetLegacyTypeDefs,
  budgetLegacyCollisionTypeDefs,
} from '@/modules/budget/shell/graphql/legacy/typedefs.js';
import { budgetTypeDefs } from '@/modules/budget/shell/graphql/typedefs.js';
import { baseTypeDefs, mergeGraphqlSlices, scalarResolvers } from '@/modules/shared/index.js';

import { extractDefinitions } from './extract-sdl.js';

const EntityAnalyticsSchema = readFileSync(
  new URL('./fixtures/legacy-entity-analytics.graphql', import.meta.url),
  'utf8'
);

const AggregatedLineItemsSchema = readFileSync(
  new URL('./fixtures/legacy-aggregated-line-items.graphql', import.meta.url),
  'utf8'
);

// @graphql-tools/schema uses CommonJS graphql; execute with that same runtime instance.
const { graphql } = createRequire(import.meta.url)('graphql') as typeof import('graphql');

const withoutDescriptions = (sdl: string): string =>
  print(
    visit(parse(sdl), {
      enter: (node) => ('description' in node ? { ...node, description: undefined } : undefined),
    })
  );
const merged = () =>
  mergeGraphqlSlices(baseTypeDefs, [
    {
      source: 'budget',
      typeDefs: [
        budgetTypeDefs,
        budgetLegacyTypeDefs,
        budgetLegacyCollisionTypeDefs,
        budgetGroupedTypeDefs,
      ].join('\n'),
    },
  ]).typeDefs;

describe('native grouped root contract', () => {
  it('preserves carried wire shapes except the approved nullable per-capita field', () => {
    const expected = extractDefinitions(
      withoutDescriptions(
        [
          EntityAnalyticsSchema.replace('per_capita_amount: Float!', 'per_capita_amount: Float'),
          AggregatedLineItemsSchema,
        ].join('\n')
      )
    );
    const actual = extractDefinitions(withoutDescriptions(budgetGroupedTypeDefs));
    expect(actual.size).toBe(expected.size + 1);
    for (const [key, value] of expected) expect(actual.get(key)).toBe(value);
    expect(extractDefinitions(budgetGroupedTypeDefs).get('input SortOrder')).toBe(
      extractDefinitions(CommonTypes).get('input SortOrder')
    );
  });
  it('boots on the standalone kernel and preserves count on an empty wire page', async () => {
    const typeDefs = merged();
    expect(validateSchema(buildSchema(typeDefs))).toEqual([]);
    const page = {
      nodes: [],
      pageInfo: { totalCount: 17, hasNextPage: true, hasPreviousPage: false },
    };
    const schema = makeExecutableSchema({
      typeDefs,
      resolvers: {
        ...scalarResolvers,
        ...makeBudgetGroupedResolvers({
          grouped: {
            entities: () => Promise.resolve(ok(page)),
            classifications: () => Promise.resolve(ok(page)),
          },
          factors: { yearly: () => Promise.resolve(ok(null)) },
          population: { scopedPopulation: () => Promise.resolve(ok(null)) },
        }),
      },
    });
    const result = await graphql({
      schema,
      source:
        '{ entityAnalytics(filter: { account_category: ch, report_period: { type: YEAR, selection: { dates: ["2024"] } } }, limit: 0) { nodes { entity_cui } pageInfo { totalCount hasNextPage } } }',
    });
    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({
      entityAnalytics: { nodes: [], pageInfo: { totalCount: 17, hasNextPage: true } },
    });
  });
});
