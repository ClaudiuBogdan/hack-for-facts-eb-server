import { GraphQLError } from 'graphql';

import { GRAPHQL_ERROR_CODE } from '@/modules/shared/index.js';

import {
  listCommitmentPeriods,
  type BudgetPeriodRepo,
  type CommitmentPeriodQuery,
} from '../../core/commitment-periods.js';

export const commitmentPeriodTypeDefs = /* GraphQL */ `
  "Amounts in nominal RON, excluding transfers. Null means no admitted financial observation."
  type BudgetCommitmentPeriodAmount {
    metric: String!
    interval: Money
    ytd: Money
  }
  type BudgetCommitmentPeriod {
    reportId: ID!
    sectorId: Int!
    creditorCui: CUI
    sourceUrl: String!
    startMonth: Int
    endMonth: Int!
    monthsCovered: Int
    observation: String!
    continuity: String!
    isQuarterly: Boolean!
    isLatestYtd: Boolean!
    isYearEnd: Boolean!
    amounts: [BudgetCommitmentPeriodAmount!]!
  }
  type BudgetCommitmentPeriodPage {
    metadataAvailable: Boolean!
    total: Int!
    "Earliest/latest financial terminal across published entity/year sectors, independent of paging."
    earliestTerminalMonth: Int
    latestTerminalMonth: Int
    items: [BudgetCommitmentPeriod!]!
  }
  extend type Query {
    "Source report intervals in nominal RON, excluding transfers. Month bounds select report ENDPOINTS; amounts retain their complete original interval. No sum across overlapping ranges."
    budgetCommitmentPeriods(
      cui: CUI!
      year: Int!
      reportType: BudgetCommitmentReportType!
      startMonth: Int! = 1
      endMonth: Int! = 12
      page: Int! = 1
      pageSize: Int! = 25
    ): BudgetCommitmentPeriodPage!
  }
`;

export const makeCommitmentPeriodResolvers = (repo: BudgetPeriodRepo) => ({
  Query: {
    async budgetCommitmentPeriods(_parent: unknown, args: CommitmentPeriodQuery) {
      const result = await listCommitmentPeriods(repo, args);
      if (result.isErr())
        throw new GraphQLError(result.error.message, {
          extensions: { code: GRAPHQL_ERROR_CODE[result.error.type] },
        });
      return result.value;
    },
  },
});
