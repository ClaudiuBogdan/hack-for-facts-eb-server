import { GraphQLError } from 'graphql';

import { GRAPHQL_ERROR_CODE, type ApiError } from '@/modules/shared/index.js';

import {
  groupedEntityAnalytics,
  groupedClassificationAnalytics,
  type GroupedAnalyticsDeps,
} from '../../../core/legacy-analytics/grouped-usecase.js';

import type { GroupedInput } from '../../../core/legacy-analytics/grouped-types.js';
import type { Result } from 'neverthrow';

// Same envelope as the legacy resolvers (doc 13 §7 delta 13): code / type / field.
const unwrap = <T>(result: Result<T, ApiError>): T => {
  if (result.isErr()) {
    const error = result.error;
    throw new GraphQLError(error.message, {
      extensions: {
        code: GRAPHQL_ERROR_CODE[error.type],
        type: error.type,
        ...(error.type === 'InvalidInput' && error.field !== undefined && { field: error.field }),
      },
    });
  }
  return result.value;
};

/** Decimal-to-Float conversion is confined to this compatibility wire boundary. */
export const makeBudgetGroupedResolvers = (
  deps: GroupedAnalyticsDeps & {
    readonly entityAnalytics?: (input: GroupedInput) => ReturnType<typeof groupedEntityAnalytics>;
    readonly classificationAnalytics?: (
      input: GroupedInput
    ) => ReturnType<typeof groupedClassificationAnalytics>;
  }
): Record<string, unknown> => ({
  Query: {
    entityAnalytics: async (_: unknown, args: GroupedInput) => {
      const page = unwrap(
        await (deps.entityAnalytics?.(args) ?? groupedEntityAnalytics(deps, args))
      );
      return {
        ...page,
        nodes: page.nodes.map((row) => ({
          ...row,
          amount: row.amount.toNumber(),
          total_amount: row.total_amount.toNumber(),
          per_capita_amount: row.per_capita_amount?.toNumber() ?? null,
        })),
      };
    },
    aggregatedLineItems: async (_: unknown, args: GroupedInput) => {
      const page = unwrap(
        await (deps.classificationAnalytics?.(args) ?? groupedClassificationAnalytics(deps, args))
      );
      return {
        ...page,
        nodes: page.nodes.map((row) => ({
          ...row,
          amount: row.amount.toNumber(),
          economic_code: row.economic_code ?? '00.00.00',
          economic_name: row.economic_name ?? 'Unknown economic classification',
        })),
      };
    },
  },
});
