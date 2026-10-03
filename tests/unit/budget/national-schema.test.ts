import { readFileSync } from 'node:fs';

import { buildSchema, Kind, parse, print, validateSchema } from 'graphql';
import { ok } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import { makeBudgetModule, type FactorSource } from '@/modules/budget/index.js';
import { NATIONAL_ROOTS, nationalTypeDefs } from '@/modules/budget/shell/graphql/national.js';
import {
  baseTypeDefs,
  mergeGraphqlSlices,
  type ContributorRegistry,
} from '@/modules/shared/index.js';

import { makeCapturingDb } from '../../fixtures/capturing-db.js';

const fixture = readFileSync(
  new URL('../../fixtures/national-budget/schema-v3.graphql', import.meta.url),
  'utf8'
);

const definitions = (sdl: string): string[] => parse(sdl).definitions.map((def) => print(def));

const factors: FactorSource = { yearly: () => Promise.resolve(ok(null)) };
const registry: ContributorRegistry = {
  register: () => undefined,
  list: () => [],
  get: () => undefined,
};

describe('national GraphQL slice', () => {
  it('serves exactly the reviewed v3 SDL plus the approved authorityCode delta', () => {
    expect(definitions(nationalTypeDefs)).toEqual(definitions(fixture));
  });

  it('is composed into the budget slice once, with the canonical series and seven roots', () => {
    const budget = makeBudgetModule({
      db: makeCapturingDb([]),
      registry,
      legacyFactors: factors,
      nationalCache: null,
    });
    const merged = mergeGraphqlSlices(baseTypeDefs, [budget.graphqlSlice]).typeDefs;
    const schema = buildSchema(merged);
    expect(validateSchema(schema)).toEqual([]);
    const count = (name: string) =>
      parse(merged).definitions.filter(
        (def) => def.kind === Kind.OBJECT_TYPE_DEFINITION && def.name.value === name
      ).length;
    expect(count('DataSeries')).toBe(1);
    expect(count('DataPoint')).toBe(1);
    const query = schema.getQueryType()?.getFields() ?? {};
    for (const root of NATIONAL_ROOTS) expect(Object.keys(query)).toContain(root);
    const resolvers = budget.graphqlResolvers['Query'] as Record<string, unknown>;
    for (const root of NATIONAL_ROOTS) expect(typeof resolvers[root]).toBe('function');
    expect(budget.mcpTools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        'get_budget_national_catalog',
        'get_budget_approved_totals',
        'get_budget_approved_series',
        'list_budget_approved_records',
        'get_budget_execution_releases',
        'list_budget_execution_observations',
        'get_budget_national_execution_series',
      ])
    );
  });

  it('declares no lazy field resolvers: only Query roots', () => {
    const budget = makeBudgetModule({
      db: makeCapturingDb([]),
      registry,
      legacyFactors: factors,
      nationalCache: null,
    });
    const nationalTypes = parse(nationalTypeDefs)
      .definitions.filter((def) => def.kind === Kind.OBJECT_TYPE_DEFINITION)
      .map((def) => ('name' in def && def.name !== undefined ? def.name.value : ''));
    for (const type of nationalTypes) expect(budget.graphqlResolvers[type]).toBeUndefined();
  });
});
