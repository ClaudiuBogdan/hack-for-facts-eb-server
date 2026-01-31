import { Decimal } from 'decimal.js';
import { err, ok } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import { Frequency } from '@/common/types/temporal.js';
import { createDatabaseError } from '@/modules/commitments/core/errors.js';
import { getCommitmentsAnalytics } from '@/modules/commitments/core/usecases/get-commitments-analytics.js';

import type { CommitmentsRepository } from '@/modules/commitments/core/ports.js';
import type { CommitmentsFilter } from '@/modules/commitments/core/types.js';
import type { NormalizationFactors, PopulationRepository } from '@/modules/normalization/index.js';

const emptyFactors = (): NormalizationFactors => ({
  cpi: new Map(),
  eur: new Map(),
  usd: new Map(),
  gdp: new Map(),
  population: new Map(),
});

const makeBaseFilter = (overrides?: Partial<CommitmentsFilter>): CommitmentsFilter => ({
  report_period: { type: Frequency.MONTH, selection: { dates: ['2024-01', '2024-02'] } },
  normalization: 'total',
  currency: 'RON',
  inflation_adjusted: false,
  show_period_growth: false,
  exclude_transfers: true,
  ...overrides,
});

describe('getCommitmentsAnalytics', () => {
  it('adds growth_percent when show_period_growth is enabled', async () => {
    const repo: CommitmentsRepository = {
      listSummary: async () => err(createDatabaseError('not used')),
      listLineItems: async () => err(createDatabaseError('not used')),
      getAggregated: async () => err(createDatabaseError('not used')),
      getCommitmentVsExecutionMonthData: async () => err(createDatabaseError('not used')),
      getAnalyticsSeries: async () =>
        ok({
          frequency: Frequency.MONTH,
          data: [
            { date: '2024-01', value: new Decimal(10) },
            { date: '2024-02', value: new Decimal(20) },
          ],
        }),
    };

    const populationRepo: PopulationRepository = {
      getCountryPopulation: async () => ok(new Decimal(0)),
      getFilteredPopulation: async () => ok(new Decimal(0)),
    };

    const result = await getCommitmentsAnalytics(
      { repo, normalization: { generateFactors: async () => emptyFactors() }, populationRepo },
      [{ filter: makeBaseFilter({ show_period_growth: true }), metric: 'PLATI_TREZOR' }]
    );

    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;

    expect(result.value).toHaveLength(1);
    const series = result.value[0];
    expect(series?.data).toHaveLength(2);
    expect(series?.data[0]?.growth_percent).toBeNull();
    expect(series?.data[1]?.growth_percent).toBeCloseTo(100);
  });

  it('returns ValidationError when metric is not available for the requested period type', async () => {
    let repoCalled = false;

    const repo: CommitmentsRepository = {
      listSummary: async () => err(createDatabaseError('not used')),
      listLineItems: async () => err(createDatabaseError('not used')),
      getAggregated: async () => err(createDatabaseError('not used')),
      getCommitmentVsExecutionMonthData: async () => err(createDatabaseError('not used')),
      getAnalyticsSeries: async () => {
        repoCalled = true;
        return err(createDatabaseError('not used'));
      },
    };

    const populationRepo: PopulationRepository = {
      getCountryPopulation: async () => ok(new Decimal(0)),
      getFilteredPopulation: async () => ok(new Decimal(0)),
    };

    const result = await getCommitmentsAnalytics(
      { repo, normalization: { generateFactors: async () => emptyFactors() }, populationRepo },
      [{ filter: makeBaseFilter(), metric: 'LIMITA_CREDIT_ANGAJAMENT' }]
    );

    expect(repoCalled).toBe(false);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe('ValidationError');
    }
  });
});
