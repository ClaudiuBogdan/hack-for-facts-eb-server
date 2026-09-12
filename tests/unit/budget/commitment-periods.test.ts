import { makeExecutableSchema } from '@graphql-tools/schema';
import { graphql } from 'graphql';
import { ok } from 'neverthrow';
import { describe, expect, it, vi } from 'vitest';

import { type BudgetPeriodRepo } from '@/modules/budget/core/commitment-periods.js';
import {
  commitmentPeriodTypeDefs,
  makeCommitmentPeriodResolvers,
} from '@/modules/budget/shell/graphql/commitment-periods.js';
import { makeCommitmentPeriodTool } from '@/modules/budget/shell/mcp/commitment-periods.js';

const page = {
  metadataAvailable: false,
  total: 0,
  earliestTerminalMonth: null,
  latestTerminalMonth: null,
  items: [],
};
const args = {
  cui: '4505359',
  year: 2025,
  reportType: 'COMMITMENT_DETAILED',
  startMonth: 1,
  endMonth: 12,
  page: 1,
  pageSize: 25,
};

describe('commitment period GraphQL and MCP contract', () => {
  it('uses identical validated scope and pagination defaults on both surfaces', async () => {
    const method = vi.fn().mockResolvedValue(ok(page));
    const repo: BudgetPeriodRepo = { listCommitmentPeriods: method };
    const schema = makeExecutableSchema({
      typeDefs: `scalar CUI\nscalar Money\nenum BudgetCommitmentReportType { COMMITMENT_DETAILED }\ntype Query { ping: Boolean }\n${commitmentPeriodTypeDefs}`,
      resolvers: makeCommitmentPeriodResolvers(repo),
    });
    const result = await graphql({
      schema,
      source:
        '{ budgetCommitmentPeriods(cui:"4505359",year:2025,reportType:COMMITMENT_DETAILED) { metadataAvailable total items { reportId } } }',
    });
    expect(result.errors).toBeUndefined();
    expect(method).toHaveBeenCalledWith(args);
    expect(
      await makeCommitmentPeriodTool(repo).handler({
        cui: '4505359',
        year: 2025,
        reportType: 'COMMITMENT_DETAILED',
      })
    ).toEqual({ ok: true, kind: 'commitment_periods', item: page });
    expect(method).toHaveBeenLastCalledWith(args);
  });
  it('refuses bad bounds on both surfaces before calling the repository', async () => {
    const method = vi.fn().mockResolvedValue(ok(page));
    const repo: BudgetPeriodRepo = { listCommitmentPeriods: method };
    const resolver = makeCommitmentPeriodResolvers(repo).Query.budgetCommitmentPeriods;
    await expect(
      resolver(null, { ...args, reportType: 'COMMITMENT_DETAILED', startMonth: 9, endMonth: 8 })
    ).rejects.toMatchObject({ extensions: { code: 'INVALID_INPUT' } });
    expect((await makeCommitmentPeriodTool(repo).handler({ ...args, pageSize: 101 })).ok).toBe(
      false
    );
    expect(method).not.toHaveBeenCalled();
  });
});
