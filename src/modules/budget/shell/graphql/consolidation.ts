import { GraphQLError } from 'graphql';

import { readConsolidation } from '../repo/consolidation.js';

import type { Db } from '../repo/budget-repo-shared.js';

export const consolidationTypeDefs = /* GraphQL */ `
  type BudgetVerifiedTransferEstimate {
    sector: Int!
    reportedIncome: String!
    reportedSpending: String!
    income: String!
    spending: String!
    balance: String!
    eliminated: String!
    source: String!
  }

  type BudgetCreditorConsolidation {
    sectors: [Int!]!
    estimate: BudgetVerifiedTransferEstimate
  }

  extend type Query {
    "Cash totals in RON after verified transfers, for a reconciled scope."
    budgetCreditorConsolidation(
      cui: CUI!
      year: Int!
      frequency: BudgetFrequency!
    ): BudgetCreditorConsolidation
  }
`;

export const makeConsolidationResolvers = (db: Db, enabled: boolean) => ({
  Query: {
    budgetCreditorConsolidation: async (
      _root: unknown,
      args: { cui: string; year: number; frequency: 'YEAR' | 'QUARTER' | 'MONTH' }
    ) => {
      if (!enabled) return null;
      if (args.year < 1900 || args.year > 2200) {
        throw new GraphQLError('Invalid reporting year', { extensions: { code: 'INVALID_INPUT' } });
      }
      return readConsolidation(db, args.cui, args.year, args.frequency);
    },
  },
});
