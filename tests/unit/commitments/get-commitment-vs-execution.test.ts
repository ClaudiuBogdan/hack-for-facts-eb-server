import { Decimal } from 'decimal.js';
import { err, ok } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import { Frequency } from '@/common/types/temporal.js';
import { createDatabaseError } from '@/modules/commitments/core/errors.js';
import { getCommitmentVsExecution } from '@/modules/commitments/core/usecases/get-commitment-vs-execution.js';

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

const populationRepo: PopulationRepository = {
  getCountryPopulation: async () => ok(new Decimal(0)),
  getFilteredPopulation: async () => ok(new Decimal(0)),
};

const baseFilter: CommitmentsFilter = {
  report_period: { type: Frequency.QUARTER, selection: { dates: ['2025-Q1', '2025-Q2'] } },
  report_type: 'Executie - Angajamente bugetare agregat principal',
  normalization: 'total',
  currency: 'RON',
  inflation_adjusted: false,
  show_period_growth: true,
  exclude_transfers: true,
};

describe('getCommitmentVsExecution', () => {
  it("returns ValidationError when 'report_type' is missing", async () => {
    const repo: CommitmentsRepository = {
      listSummary: async () => err(createDatabaseError('not used')),
      listLineItems: async () => err(createDatabaseError('not used')),
      getAnalyticsSeries: async () => err(createDatabaseError('not used')),
      getAggregated: async () => err(createDatabaseError('not used')),
      getCommitmentVsExecutionMonthData: async () => err(createDatabaseError('not used')),
    };

    const { report_type: reportType, ...filterWithoutReportType } = baseFilter;
    void reportType;

    const result = await getCommitmentVsExecution(
      { repo, normalization: { generateFactors: async () => emptyFactors() }, populationRepo },
      { filter: filterWithoutReportType, commitments_metric: 'PLATI_TREZOR' }
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe('ValidationError');
    }
  });

  it('rolls up from month-grain join data and computes growth percent (QUARTER)', async () => {
    const repo: CommitmentsRepository = {
      listSummary: async () => err(createDatabaseError('not used')),
      listLineItems: async () => err(createDatabaseError('not used')),
      getAnalyticsSeries: async () => err(createDatabaseError('not used')),
      getAggregated: async () => err(createDatabaseError('not used')),
      getCommitmentVsExecutionMonthData: async () =>
        ok({
          rows: [
            {
              year: 2025,
              month: 1,
              commitment_value: new Decimal(100),
              execution_value: new Decimal(50),
            }, // Q1
            {
              year: 2025,
              month: 4,
              commitment_value: new Decimal(200),
              execution_value: new Decimal(100),
            }, // Q2
          ],
          counts: { matched_count: 2, unmatched_commitment_count: 0, unmatched_execution_count: 0 },
        }),
    };

    const result = await getCommitmentVsExecution(
      { repo, normalization: { generateFactors: async () => emptyFactors() }, populationRepo },
      { filter: baseFilter, commitments_metric: 'PLATI_TREZOR' }
    );

    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;

    expect(result.value.frequency).toBe(Frequency.QUARTER);
    expect(result.value.data).toHaveLength(2);

    const p1 = result.value.data[0];
    const p2 = result.value.data[1];

    expect(p1?.period).toBe('2025-Q1');
    expect(p1?.commitment_value.toNumber()).toBe(100);
    expect(p1?.execution_value.toNumber()).toBe(50);
    expect(p1?.difference.toNumber()).toBe(50);
    expect(p1?.difference_percent?.toNumber()).toBe(50);
    expect(p1?.commitment_growth_percent).toBeNull();
    expect(p1?.execution_growth_percent).toBeNull();
    expect(p1?.difference_growth_percent).toBeNull();

    expect(p2?.period).toBe('2025-Q2');
    expect(p2?.commitment_value.toNumber()).toBe(200);
    expect(p2?.execution_value.toNumber()).toBe(100);
    expect(p2?.difference.toNumber()).toBe(100);
    expect(p2?.difference_percent?.toNumber()).toBe(50);
    expect(p2?.commitment_growth_percent?.toNumber()).toBe(100);
    expect(p2?.execution_growth_percent?.toNumber()).toBe(100);
    expect(p2?.difference_growth_percent?.toNumber()).toBe(100);

    expect(result.value.total_commitment.toNumber()).toBe(300);
    expect(result.value.total_execution.toNumber()).toBe(150);
    expect(result.value.total_difference.toNumber()).toBe(150);
    expect(result.value.overall_difference_percent?.toNumber()).toBe(50);

    expect(result.value.matched_count).toBe(2);
    expect(result.value.unmatched_commitment_count).toBe(0);
    expect(result.value.unmatched_execution_count).toBe(0);
  });
});
