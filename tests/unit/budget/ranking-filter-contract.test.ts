import { ok } from 'neverthrow';
import { describe, expect, it, vi } from 'vitest';

import { budgetRankingFilterSpec } from '@/modules/budget/core/filters.js';
import {
  parseRankingFilter,
  makeBudgetResolvers,
} from '@/modules/budget/shell/graphql/resolvers.js';
import { makeBudgetMcpTools } from '@/modules/budget/shell/mcp/tools.js';
import { createContributorRegistry } from '@/modules/shared/core/usecases/registry.js';
import { kernelToolInputSchema, type FilterInput } from '@/modules/shared/index.js';

import type { BudgetDiscoveryRepo, BudgetRepo } from '@/modules/budget/core/ports.js';

interface FilterCase {
  readonly key: string;
  readonly filter: FilterInput;
  readonly expected?: Record<string, unknown>;
  readonly rejectedField?: string;
}

const CASES: readonly FilterCase[] = [
  { key: 'year.eq', filter: { year: { eq: 2025 } }, expected: { year: 2025 } },
  {
    key: 'reportType.eq',
    filter: { year: { eq: 2025 }, reportType: { eq: 'EXECUTION_AGG_PRINCIPAL' } },
    expected: { reportType: 'EXECUTION_AGG_PRINCIPAL' },
  },
  {
    key: 'frequency.eq',
    filter: { year: { eq: 2025 }, frequency: { eq: 'QUARTER' } },
    expected: { frequency: 'QUARTER' },
  },
  {
    key: 'month.eq',
    filter: { year: { eq: 2025 }, month: { eq: 5 } },
    expected: { month: 5 },
  },
  {
    key: 'quarter.eq',
    filter: { year: { eq: 2025 }, quarter: { eq: 2 } },
    expected: { quarter: 2 },
  },
  {
    key: 'entityCuis.eq',
    filter: { year: { eq: 2025 }, entityCuis: { eq: '111' } },
    expected: { entityCuis: ['111'] },
  },
  {
    key: 'entityCuis.in',
    filter: { year: { eq: 2025 }, entityCuis: { in: ['111', '222'] } },
    expected: { entityCuis: ['111', '222'] },
  },
  {
    key: 'mainCreditorCui.eq',
    filter: { year: { eq: 2025 }, mainCreditorCui: { eq: '999' } },
    expected: { mainCreditorCui: '999' },
  },
  {
    key: 'excludeEntityCuis.in',
    filter: { year: { eq: 2025 }, excludeEntityCuis: { in: ['999'] } },
    expected: { excludeEntityCuis: ['999'] },
  },
  {
    key: 'countyCodes.eq',
    filter: { year: { eq: 2025 }, countyCodes: { eq: 'SB' } },
    expected: { countyCodes: ['SB'] },
  },
  {
    key: 'countyCodes.in',
    filter: { year: { eq: 2025 }, countyCodes: { in: ['SB', 'CJ'] } },
    expected: { countyCodes: ['SB', 'CJ'] },
  },
  {
    key: 'regions.eq',
    filter: { year: { eq: 2025 }, regions: { eq: 'Centru' } },
    expected: { regions: ['Centru'] },
  },
  {
    key: 'regions.in',
    filter: { year: { eq: 2025 }, regions: { in: ['Centru', 'Nord-Vest'] } },
    expected: { regions: ['Centru', 'Nord-Vest'] },
  },
  {
    key: 'isUat.eq',
    filter: { year: { eq: 2025 }, isUat: { eq: true } },
    expected: { isUat: true },
  },
  {
    key: 'isTerritorialExecutive.eq',
    filter: { year: { eq: 2025 }, isTerritorialExecutive: { eq: false } },
    expected: { isTerritorialExecutive: false },
  },
  {
    key: 'minPopulation.gte',
    filter: { year: { eq: 2025 }, minPopulation: { gte: 10_000 } },
    expected: { minPopulation: 10_000 },
  },
  {
    key: 'maxPopulation.lte',
    filter: { year: { eq: 2025 }, maxPopulation: { lte: 500_000 } },
    expected: { maxPopulation: 500_000 },
  },
] as const;

describe('budget ranking filter contract', () => {
  it('tests every advertised field/operator pair', () => {
    const advertised = budgetRankingFilterSpec.fields
      .flatMap((field) => field.ops.map((operation) => `${field.name}.${operation}`))
      .sort();
    expect(CASES.map((entry) => entry.key).sort()).toEqual(advertised);
  });

  it.each(CASES)('$key is honored or explicitly rejected', (entry) => {
    if (entry.rejectedField !== undefined) {
      expect(() => parseRankingFilter(entry.filter)).toThrow(
        expect.objectContaining({
          extensions: expect.objectContaining({
            code: 'INVALID_INPUT',
            field: entry.rejectedField,
          }),
        })
      );
      return;
    }

    expect(parseRankingFilter(entry.filter)).toMatchObject(entry.expected ?? {});
  });

  it.each([
    [{ year: { between: { from: 2024, to: 2025 } } }, 'year'],
    [{ year: { eq: 2025 }, month: { in: [4, 5] } }, 'month'],
    [{ year: { eq: 2025 }, quarter: { in: [1, 2] } }, 'quarter'],
  ] as const)('defensively rejects unsupported single-period operations', (filter, field) => {
    expect(() => parseRankingFilter(filter)).toThrow(
      expect.objectContaining({
        extensions: expect.objectContaining({ code: 'INVALID_INPUT', field }),
      })
    );
  });

  it('preserves empty and intersected inclusion semantics', () => {
    expect(parseRankingFilter({ year: { eq: 2025 }, entityCuis: { in: [] } })).toMatchObject({
      entityCuis: [],
    });
    expect(
      parseRankingFilter({
        year: { eq: 2025 },
        entityCuis: { eq: '111', in: ['111', '222'] },
      })
    ).toMatchObject({ entityCuis: ['111'] });
    expect(
      parseRankingFilter({
        year: { eq: 2025 },
        countyCodes: { eq: 'SB', in: ['CJ'] },
      })
    ).toMatchObject({ countyCodes: [] });
  });

  it('reads exclusion filters from the generated nested exclude input', () => {
    expect(
      parseRankingFilter({
        year: { eq: 2025 },
        exclude: { excludeEntityCuis: { in: ['111', '222'] } },
      })
    ).toMatchObject({ excludeEntityCuis: ['111', '222'] });
  });

  it.each([
    [{ year: { eq: 2025 }, reportType: { eq: 'UNKNOWN' } }, 'reportType'],
    [{ year: { eq: 2025 }, frequency: { eq: 'WEEK' } }, 'frequency'],
    [{ year: { eq: 0 } }, 'year'],
    [{ year: { eq: -1 } }, 'year'],
    [{ year: { eq: 2025 }, mainCreditorCui: { eq: '' } }, 'mainCreditorCui'],
  ] as const)('rejects invalid ranking filter values', (filter, field) => {
    expect(() => parseRankingFilter(filter)).toThrow(
      expect.objectContaining({
        extensions: expect.objectContaining({
          code: 'INVALID_INPUT',
          field,
        }),
      })
    );
  });

  it('forwards the same entity scope through GraphQL and MCP', async () => {
    const rankEntities = vi.fn(async () => ok([]));
    const repo = { rankEntities } as unknown as BudgetRepo;
    const resolvers = makeBudgetResolvers({
      repo,
      discovery: {} as BudgetDiscoveryRepo,
      registry: createContributorRegistry(),
    }) as {
      Query: {
        budgetEntityRanking: (
          root: unknown,
          args: {
            filter: FilterInput;
            metric: 'BALANCE';
            normalization: 'PER_CAPITA';
            ascending: boolean;
            limit: number;
          }
        ) => Promise<readonly unknown[]>;
      };
    };
    const filter: FilterInput = {
      year: { eq: 2025 },
      reportType: { eq: 'EXECUTION_DETAILED' },
      frequency: { eq: 'QUARTER' },
      quarter: { eq: 2 },
      entityCuis: { in: ['111', '222'] },
      mainCreditorCui: { eq: '999' },
      exclude: { excludeEntityCuis: { in: ['999'] } },
      countyCodes: { in: ['SB', 'CJ'] },
      regions: { eq: 'Centru' },
      isUat: { eq: true },
      minPopulation: { gte: 10_000 },
      maxPopulation: { lte: 500_000 },
    };

    await resolvers.Query.budgetEntityRanking(null, {
      filter,
      metric: 'BALANCE',
      normalization: 'PER_CAPITA',
      ascending: true,
      limit: 5,
    });

    const tool = makeBudgetMcpTools({
      repo,
      discovery: {} as BudgetDiscoveryRepo,
      clientBaseUrl: 'https://transparenta.eu',
    }).find((candidate) => candidate.name === 'rank_budget_entities');
    expect(tool).toBeDefined();
    expect(() => kernelToolInputSchema(tool!).parse({ year: 2025, frequency: 'WEEK' })).toThrow();
    expect(() => kernelToolInputSchema(tool!).parse({ year: 2025, mainCreditorCui: '' })).toThrow();
    await tool!.handler({
      year: 2025,
      reportType: 'EXECUTION_DETAILED',
      frequency: 'QUARTER',
      quarter: 2,
      entityCuis: ['111', '222'],
      mainCreditorCui: '999',
      excludeEntityCuis: ['999'],
      countyCodes: ['SB', 'CJ'],
      regions: ['Centru'],
      isUat: true,
      minPopulation: 10_000,
      maxPopulation: 500_000,
      ascending: true,
      metric: 'BALANCE',
      normalization: 'PER_CAPITA',
      limit: 5,
    });

    const expected = expect.objectContaining({
      year: 2025,
      reportType: 'EXECUTION_DETAILED',
      frequency: 'QUARTER',
      quarter: 2,
      entityCuis: ['111', '222'],
      mainCreditorCui: '999',
      excludeEntityCuis: ['999'],
      countyCodes: ['SB', 'CJ'],
      regions: ['Centru'],
      isUat: true,
      minPopulation: 10_000,
      maxPopulation: 500_000,
      ascending: true,
      metric: 'BALANCE',
      normalization: 'PER_CAPITA',
      limit: 5,
    });
    expect(rankEntities).toHaveBeenNthCalledWith(1, expected);
    expect(rankEntities).toHaveBeenNthCalledWith(2, expected);
  });
});
