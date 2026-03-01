import { describe, expect, it } from 'vitest';

import { makeDbAdvancedMapAnalyticsGroupedSeriesProvider } from '@/modules/advanced-map-analytics/index.js';

import type { BudgetDbClient } from '@/infra/database/client.js';
import type { CommitmentsRepository } from '@/modules/commitments/index.js';
import type { InsRepository } from '@/modules/ins/index.js';
import type { NormalizationService } from '@/modules/normalization/index.js';
import type { UATAnalyticsRepository } from '@/modules/uat-analytics/index.js';

function makeBudgetDb(sirutaCodes: string[]): BudgetDbClient {
  const query = {
    select: () => ({
      where: () => ({
        orderBy: () => ({
          execute: async () =>
            sirutaCodes.map((sirutaCode) => ({
              siruta_code: sirutaCode,
            })),
        }),
      }),
    }),
  };

  return {
    selectFrom: () => query,
  } as unknown as BudgetDbClient;
}

describe('makeDbAdvancedMapAnalyticsGroupedSeriesProvider', () => {
  it('returns full non-county siruta universe and sparse vectors when series has soft warnings', async () => {
    const provider = makeDbAdvancedMapAnalyticsGroupedSeriesProvider({
      budgetDb: makeBudgetDb(['1001', '1002', '1003']),
      commitmentsRepo: {} as unknown as CommitmentsRepository,
      insRepo: {} as unknown as InsRepository,
      normalizationService: {} as unknown as NormalizationService,
      uatAnalyticsRepo: {} as unknown as UATAnalyticsRepository,
    });

    const result = await provider.fetchGroupedSeriesVectors({
      granularity: 'UAT',
      series: [
        {
          id: 's-ins-missing',
          type: 'ins-series',
        },
      ],
    });

    expect(result.isOk()).toBe(true);
    if (result.isErr()) {
      return;
    }

    expect(result.value.sirutaUniverse).toEqual(['1001', '1002', '1003']);
    expect(result.value.vectors).toHaveLength(1);
    expect(result.value.vectors[0]?.seriesId).toBe('s-ins-missing');
    expect(result.value.vectors[0]?.valuesBySirutaCode.size).toBe(0);
    expect(result.value.warnings.some((warning) => warning.type === 'missing_dataset_code')).toBe(
      true
    );
  });
});
