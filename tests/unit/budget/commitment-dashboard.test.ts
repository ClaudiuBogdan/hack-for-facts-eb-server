import { makeExecutableSchema } from '@graphql-tools/schema';
import { graphql } from 'graphql';
import { ok } from 'neverthrow';
import { describe, expect, it, vi } from 'vitest';

import {
  commitmentDashboard,
  type CommitmentDashboardQuery,
} from '@/modules/budget/core/commitment-dashboard.js';
import {
  commitmentDashboardTypeDefs,
  makeCommitmentDashboardResolvers,
} from '@/modules/budget/shell/graphql/commitment-dashboard.js';
import { makeCommitmentDashboardTool } from '@/modules/budget/shell/mcp/commitment-dashboard.js';
const args: CommitmentDashboardQuery = {
  cui: '123',
  detailYear: 2025,
  yearFrom: 2016,
  yearTo: 2026,
  frequency: 'YEAR',
  reportType: 'COMMITMENT_DETAILED',
  normalization: 'TOTAL',
};
describe('entity commitment dashboard contract', () => {
  it.each([
    { yearFrom: 2000, yearTo: 2026 },
    { yearFrom: 2026, yearTo: 2025 },
    { detailYear: 2027 },
    { mainCreditorCui: 'bad' },
    { cui: '123 OR TRUE' },
  ])('rejects invalid or unbounded inputs before SQL: %j', async (extra) => {
    const read = vi.fn();
    const result = await commitmentDashboard({ read }, { ...args, ...extra });
    expect(result.isErr()).toBe(true);
    expect(read).not.toHaveBeenCalled();
  });
  it('shares defaults and exact nullable amounts between GraphQL and MCP', async () => {
    const data = {
      rows: [
        {
          year: 2025,
          period: 1,
          functionalCode: '65',
          economicCode: null,
          firstReportMonth: 7,
          lastReportMonth: 12,
          budget: '90071992547409.91',
          authority: null,
          committed: '0',
          paidTreasury: '-1.25',
          paidNonTreasury: null,
        },
      ],
      unavailableYears: [],
    };
    const read = vi.fn().mockResolvedValue(ok(data));
    const schema = makeExecutableSchema({
      typeDefs: `scalar CUI\nscalar Money\nenum BudgetCommitmentReportType {COMMITMENT_DETAILED}\nenum BudgetFrequency {YEAR}\nenum BudgetNormalization {TOTAL}\nenum BudgetCurrency {RON EUR USD}\ntype Query {ping:Boolean}\n${commitmentDashboardTypeDefs}`,
      resolvers: makeCommitmentDashboardResolvers({ read }),
    });
    const result = await graphql({
      schema,
      source:
        '{budgetCommitmentDashboard(cui:"123",detailYear:2025,yearFrom:2016,yearTo:2026,frequency:YEAR,reportType:COMMITMENT_DETAILED){rows{budget authority committed paidTreasury paidNonTreasury}}}',
    });
    expect(result.errors).toBeUndefined();
    expect(read).toHaveBeenCalledWith(args);
    expect(result.data).toMatchObject({
      budgetCommitmentDashboard: {
        rows: [
          {
            budget: '90071992547409.91',
            authority: null,
            committed: '0',
            paidTreasury: '-1.25',
            paidNonTreasury: null,
          },
        ],
      },
    });
    expect(
      await makeCommitmentDashboardTool({ read }).handler({ ...args, mainCreditorCui: '456' })
    ).toMatchObject({ ok: true, item: data });
    expect(read).toHaveBeenLastCalledWith({ ...args, mainCreditorCui: '456' });
  });
});
