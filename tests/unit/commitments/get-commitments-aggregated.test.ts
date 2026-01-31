import { Decimal } from 'decimal.js';
import { err, ok } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import { Frequency } from '@/common/types/temporal.js';
import { createDatabaseError } from '@/modules/commitments/core/errors.js';
import { getCommitmentsAggregated } from '@/modules/commitments/core/usecases/get-commitments-aggregated.js';

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
  report_period: { type: Frequency.YEAR, selection: { dates: ['2024', '2025'] } },
  normalization: 'total',
  currency: 'RON',
  inflation_adjusted: false,
  show_period_growth: true,
  exclude_transfers: true,
  ...overrides,
});

describe('getCommitmentsAggregated', () => {
  it('returns ValidationError when metric is not available for the requested period type', async () => {
    let repoCalled = false;

    const repo: CommitmentsRepository = {
      listSummary: async () => err(createDatabaseError('not used')),
      listLineItems: async () => err(createDatabaseError('not used')),
      getAnalyticsSeries: async () => err(createDatabaseError('not used')),
      getCommitmentVsExecutionMonthData: async () => err(createDatabaseError('not used')),
      getAggregated: async () => {
        repoCalled = true;
        return err(createDatabaseError('not used'));
      },
    };

    const populationRepo: PopulationRepository = {
      getCountryPopulation: async () => ok(new Decimal(0)),
      getFilteredPopulation: async () => ok(new Decimal(0)),
    };

    const result = await getCommitmentsAggregated(
      { repo, normalization: { generateFactors: async () => emptyFactors() }, populationRepo },
      {
        filter: makeBaseFilter({
          report_period: { type: Frequency.MONTH, selection: { dates: ['2024-01'] } },
        }),
        metric: 'LIMITA_CREDIT_ANGAJAMENT',
        limit: 50,
        offset: 0,
      }
    );

    expect(repoCalled).toBe(false);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe('ValidationError');
    }
  });

  it('builds factorMap (per_capita uses country population) and ignores show_period_growth', async () => {
    let countryCalls = 0;
    let filteredCalls = 0;

    const populationRepo: PopulationRepository = {
      getCountryPopulation: async () => {
        countryCalls += 1;
        return ok(new Decimal(100));
      },
      getFilteredPopulation: async () => {
        filteredCalls += 1;
        return ok(new Decimal(0));
      },
    };

    const repo: CommitmentsRepository = {
      listSummary: async () => err(createDatabaseError('not used')),
      listLineItems: async () => err(createDatabaseError('not used')),
      getAnalyticsSeries: async () => err(createDatabaseError('not used')),
      getCommitmentVsExecutionMonthData: async () => err(createDatabaseError('not used')),
      getAggregated: async (filter, metric, factorMap, pagination, aggregateFilters) => {
        expect(filter.show_period_growth).toBe(false);
        expect(metric).toBe('PLATI_TREZOR');
        expect(pagination.limit).toBe(10);
        expect(pagination.offset).toBe(5);

        expect(aggregateFilters?.minAmount?.toString()).toBe('1');
        expect(aggregateFilters?.maxAmount?.toString()).toBe('2');

        expect(factorMap.get('2024')?.toNumber()).toBeCloseTo(0.01);
        expect(factorMap.get('2025')?.toNumber()).toBeCloseTo(0.01);

        return ok({
          nodes: [],
          pageInfo: { totalCount: 0, hasNextPage: false, hasPreviousPage: false },
        });
      },
    };

    const result = await getCommitmentsAggregated(
      { repo, normalization: { generateFactors: async () => emptyFactors() }, populationRepo },
      {
        filter: makeBaseFilter({
          normalization: 'per_capita',
          aggregate_min_amount: 1,
          aggregate_max_amount: 2,
        }),
        metric: 'PLATI_TREZOR',
        limit: 10,
        offset: 5,
      }
    );

    expect(result.isOk()).toBe(true);
    expect(countryCalls).toBe(1);
    expect(filteredCalls).toBe(0);
  });
});
