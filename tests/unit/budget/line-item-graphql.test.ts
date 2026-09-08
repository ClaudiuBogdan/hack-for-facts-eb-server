import { buildSchema, graphql, isScalarType, type GraphQLFieldResolver } from 'graphql';
import { err, ok, type Result } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import { makeBudgetResolvers } from '@/modules/budget/shell/graphql/resolvers.js';
import { budgetTypeDefs } from '@/modules/budget/shell/graphql/typedefs.js';
import {
  baseTypeDefs,
  scalarResolvers,
  createContributorRegistry,
  type ApiError,
  type CursorPage,
} from '@/modules/shared/index.js';

import type { BudgetRepo, BudgetDiscoveryRepo } from '@/modules/budget/core/ports.js';
import type { BudgetFactQuery, ExecutionLineItem } from '@/modules/budget/core/types.js';

const document = `query($n:BudgetNormalization!){budgetExecutionLineItems(normalization:$n,filter:{reportingYear:{eq:2025},entityCuis:{in:["991"]}}){edges{node{executionLineItemId ytdAmount normalizedAmounts{ytdAmount monthlyAmount quarterlyAmount}}}pageInfo{hasNextPage}}}`;
function fixture(result: Result<CursorPage<ExecutionLineItem>, ApiError>) {
  let received: BudgetFactQuery | undefined;
  const repo = {
    listExecutionLineItems: (q: BudgetFactQuery) => {
      received = q;
      return Promise.resolve(result);
    },
  } as BudgetRepo;
  const resolvers = makeBudgetResolvers({
    repo,
    discovery: {} as BudgetDiscoveryRepo,
    registry: createContributorRegistry(),
  });
  const schema = buildSchema(`${baseTypeDefs}\n${budgetTypeDefs}`);
  const money = schema.getType('Money');
  if (!isScalarType(money)) throw new Error('Money scalar missing');
  money.serialize = scalarResolvers.Money.serialize;
  const field = schema.getQueryType()?.getFields()['budgetExecutionLineItems'];
  if (field === undefined) throw new Error('Line-item query missing');
  const resolve = (resolvers['Query'] as Record<string, GraphQLFieldResolver<unknown, unknown>>)[
    'budgetExecutionLineItems'
  ];
  if (resolve === undefined) throw new Error('Line-item resolver missing');
  field.resolve = resolve;
  return { schema, received: () => received };
}
describe('line-item GraphQL contract', () => {
  it('serializes exact decimal strings and nullable normalized amounts through the production SDL/resolver', async () => {
    const row = {
      executionLineItemId: '1',
      ytdAmount: '9007199254740993.01',
      normalizedAmounts: {
        ytdAmount: '0.123456789012345678901',
        monthlyAmount: '0',
        quarterlyAmount: null,
      },
    } as ExecutionLineItem;
    const f = fixture(
      ok({
        items: [row, { ...row, executionLineItemId: '2', normalizedAmounts: null }],
        next: null,
      })
    );
    const result = await graphql({
      schema: f.schema,
      source: document,
      variableValues: { n: 'PER_CAPITA' },
    });
    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({
      budgetExecutionLineItems: {
        edges: [
          {
            node: {
              executionLineItemId: '1',
              ytdAmount: row.ytdAmount,
              normalizedAmounts: row.normalizedAmounts,
            },
          },
          { node: { executionLineItemId: '2', ytdAmount: row.ytdAmount, normalizedAmounts: null } },
        ],
        pageInfo: { hasNextPage: false },
      },
    });
    expect(f.received()?.normalization).toBe('PER_CAPITA');
  });
  it('propagates failed source admission rather than serializing it as missing coverage', async () => {
    const f = fixture(err({ type: 'ServiceUnavailable', message: 'Unadmitted annual source' }));
    const result = await graphql({
      schema: f.schema,
      source: document,
      variableValues: { n: 'PER_CAPITA' },
    });
    expect(result.errors?.[0]?.message).toBe('Unadmitted annual source');
    expect(result.errors?.[0]?.extensions['code']).toBe('SERVICE_UNAVAILABLE');
  });
});
