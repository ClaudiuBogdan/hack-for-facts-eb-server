import { makeAnalyticsService, type AnalyticsServiceDeps } from '../../core/logic.js';

import type { AnalyticsInput } from '../../core/types.js';
import type { IResolvers } from 'mercurius';

export const makeExecutionAnalyticsResolvers = (deps: AnalyticsServiceDeps): IResolvers => {
  const service = makeAnalyticsService(deps);

  return {
    PeriodDate: {
      // Simple scalar implementation, treating as string for now
      serialize: (value: unknown) => value,
      parseValue: (value: unknown) => value,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- Accessing AST value without full AST type definition */
      parseLiteral: (ast: any) => ast.value,
    },
    Query: {
      executionAnalytics: async (_: unknown, { inputs }: { inputs: AnalyticsInput[] }) => {
        const result = await service.getAnalyticsSeries(inputs);
        if (result.isErr()) {
          throw new Error(result.error.message);
        }
        return result.value;
      },
    },
  };
};
