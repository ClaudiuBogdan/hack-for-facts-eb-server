import { GraphQLError } from 'graphql';

import { GRAPHQL_ERROR_CODE } from '@/modules/shared/index.js';

import {
  commitmentDashboard,
  type CommitmentDashboardQuery,
  type CommitmentDashboardRepo,
} from '../../core/commitment-dashboard.js';
export const commitmentDashboardTypeDefs = /* GraphQL */ `
  "Entity classification rows. Budget/authority are balances at the endpoint; committed/payments are movements for MONTH/QUARTER and latest YTD for YEAR. Transfers excluded. Missing factors remain null."
  type BudgetCommitmentDashboardRow {
    year: Int!
    period: Int!
    firstReportMonth: Int
    lastReportMonth: Int
    functionalCode: String!
    economicCode: String
    budget: Money
    authority: Money
    committed: Money
    paidTreasury: Money
    paidNonTreasury: Money
  }
  type BudgetCommitmentDashboard {
    rows: [BudgetCommitmentDashboardRow!]!
    unavailableYears: [Int!]!
  }
  extend type Query {
    budgetCommitmentDashboard(
      cui: CUI!
      mainCreditorCui: CUI
      detailYear: Int!
      reportType: BudgetCommitmentReportType!
      yearFrom: Int!
      yearTo: Int!
      frequency: BudgetFrequency!
      normalization: BudgetNormalization = TOTAL
      currency: BudgetCurrency
      inflationAdjusted: Boolean
    ): BudgetCommitmentDashboard!
  }
`;
export const makeCommitmentDashboardResolvers = (repo: CommitmentDashboardRepo) => ({
  Query: {
    async budgetCommitmentDashboard(_parent: unknown, args: CommitmentDashboardQuery) {
      const result = await commitmentDashboard(repo, args);
      if (result.isErr())
        throw new GraphQLError(result.error.message, {
          extensions: { code: GRAPHQL_ERROR_CODE[result.error.type] },
        });
      return result.value;
    },
  },
});
