import { Decimal } from 'decimal.js';
import { err, ok, type Result } from 'neverthrow';

import { isMetricAvailableForPeriod, type CommitmentsMetric } from '@/common/types/commitments.js';
import { Frequency, extractYearRangeFromSelection } from '@/common/types/temporal.js';

import { createDatabaseError, createValidationError, type CommitmentsError } from '../errors.js';
import { computeMultiplier, needsNormalization } from '../normalization.js';

import type { CommitmentsRepository } from '../ports.js';
import type {
  CommitmentExecutionComparison,
  CommitmentExecutionComparisonInput,
  CommitmentExecutionDataPoint,
} from '../types.js';
import type { AnalyticsFilter } from '@/common/types/analytics.js';
import type { PopulationRepository, NormalizationFactors } from '@/modules/normalization/index.js';

export interface NormalizationFactorProvider {
  generateFactors(
    frequency: Frequency,
    startYear: number,
    endYear: number
  ): Promise<NormalizationFactors>;
}

export interface GetCommitmentVsExecutionDeps {
  repo: CommitmentsRepository;
  normalization: NormalizationFactorProvider;
  populationRepo: PopulationRepository;
}

const monthKey = (year: number, month: number): string =>
  `${String(year)}-${String(month).padStart(2, '0')}`;

const quarterFromMonth = (month: number): number => Math.floor((month - 1) / 3) + 1;

async function getFilterPopulationDenominator(
  input: {
    normalization: string;
    report_period: AnalyticsFilter['report_period'];
    entity_cuis?: string[];
    uat_ids?: string[];
    county_codes?: string[];
    is_uat?: boolean;
    entity_types?: string[];
  },
  populationRepo: PopulationRepository
): Promise<Decimal | undefined> {
  if (input.normalization !== 'per_capita') return undefined;

  const hasEntityCuis = input.entity_cuis !== undefined && input.entity_cuis.length > 0;
  const hasUatIds = input.uat_ids !== undefined && input.uat_ids.length > 0;
  const hasCountyCodes = input.county_codes !== undefined && input.county_codes.length > 0;
  const hasIsUat = input.is_uat !== undefined;
  const hasEntityTypes = input.entity_types !== undefined && input.entity_types.length > 0;

  const hasEntityFilter =
    hasEntityCuis || hasUatIds || hasCountyCodes || hasIsUat || hasEntityTypes;

  if (!hasEntityFilter) {
    const countryResult = await populationRepo.getCountryPopulation();
    return countryResult.isOk() ? countryResult.value : undefined;
  }

  const fakeFilter: AnalyticsFilter = {
    account_category: 'ch',
    report_period: input.report_period,
    ...(input.entity_cuis !== undefined && { entity_cuis: input.entity_cuis }),
    ...(input.uat_ids !== undefined && { uat_ids: input.uat_ids }),
    ...(input.county_codes !== undefined && { county_codes: input.county_codes }),
    ...(input.is_uat !== undefined && { is_uat: input.is_uat }),
    ...(input.entity_types !== undefined && { entity_types: input.entity_types }),
  };

  const filteredResult = await populationRepo.getFilteredPopulation(fakeFilter);
  return filteredResult.isOk() ? filteredResult.value : undefined;
}

const safePercent = (num: Decimal, denom: Decimal): Decimal | null => {
  if (denom.isZero()) return null;
  return num.div(denom).mul(100);
};

function computeGrowthPercent(curr: Decimal, prev: Decimal): Decimal | null {
  if (prev.isZero()) return null;
  return curr.minus(prev).div(prev).mul(100);
}

export async function getCommitmentVsExecution(
  deps: GetCommitmentVsExecutionDeps,
  input: CommitmentExecutionComparisonInput
): Promise<Result<CommitmentExecutionComparison, CommitmentsError>> {
  const filter = input.filter;
  const metric: CommitmentsMetric = input.commitments_metric;

  if (filter.report_type === undefined) {
    return err(
      createValidationError("Required field 'report_type' is missing", 'report_type', null)
    );
  }

  const requestedFrequency = filter.report_period.type;

  if (!isMetricAvailableForPeriod(metric, requestedFrequency)) {
    return err(
      createValidationError('Metric is not available for the requested period type', 'metric', {
        metric,
        period_type: requestedFrequency,
      })
    );
  }

  // Fetch month-grain joined totals (already pre-aggregated and joined in SQL).
  const res = await deps.repo.getCommitmentVsExecutionMonthData(filter, metric);
  if (res.isErr()) return err(res.error);

  const { rows, counts } = res.value;

  const config = {
    normalization: filter.normalization,
    currency: filter.currency,
    inflation_adjusted: filter.inflation_adjusted,
  } as const;

  const needsFactors = needsNormalization(config);
  const { startYear, endYear } = extractYearRangeFromSelection(filter.report_period.selection);

  const populationDenom = await getFilterPopulationDenominator(
    {
      normalization: filter.normalization,
      report_period: filter.report_period,
      ...(filter.entity_cuis !== undefined && { entity_cuis: filter.entity_cuis }),
      ...(filter.uat_ids !== undefined && { uat_ids: filter.uat_ids }),
      ...(filter.county_codes !== undefined && { county_codes: filter.county_codes }),
      ...(filter.is_uat !== undefined && { is_uat: filter.is_uat }),
      ...(filter.entity_types !== undefined && { entity_types: filter.entity_types }),
    },
    deps.populationRepo
  );

  let factors: NormalizationFactors;
  if (needsFactors) {
    try {
      // For the comparison we normalize at month-grain first (more accurate for partial quarters/years).
      factors = await deps.normalization.generateFactors(Frequency.MONTH, startYear, endYear);
    } catch (error) {
      return err(createDatabaseError('Failed to generate normalization factors', error));
    }
  } else {
    factors = {
      cpi: new Map(),
      eur: new Map(),
      usd: new Map(),
      gdp: new Map(),
      population: new Map(),
    };
  }

  // Normalize month totals first.
  const monthTotals = rows
    .map((r) => {
      const label = monthKey(r.year, r.month);
      const mult = computeMultiplier(label, config, factors, populationDenom);
      return {
        year: r.year,
        month: r.month,
        label,
        commitment: r.commitment_value.mul(mult),
        execution: r.execution_value.mul(mult),
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label));

  // Roll up to requested frequency.
  const grouped = new Map<
    string,
    { commitment: Decimal; execution: Decimal; year: number; quarter?: number }
  >();

  for (const row of monthTotals) {
    let key: string;
    const year = row.year;
    let quarter: number | undefined;

    if (requestedFrequency === Frequency.MONTH) {
      key = row.label;
    } else if (requestedFrequency === Frequency.QUARTER) {
      quarter = quarterFromMonth(row.month);
      key = `${String(year)}-Q${String(quarter)}`;
    } else {
      key = String(year);
    }

    const existing = grouped.get(key);
    if (existing === undefined) {
      grouped.set(key, {
        commitment: row.commitment,
        execution: row.execution,
        year,
        ...(quarter !== undefined && { quarter }),
      });
    } else {
      grouped.set(key, {
        ...existing,
        commitment: existing.commitment.add(row.commitment),
        execution: existing.execution.add(row.execution),
      });
    }
  }

  const points: CommitmentExecutionDataPoint[] = Array.from(grouped.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([period, agg]) => {
      const difference = agg.commitment.minus(agg.execution);
      const differencePercent = safePercent(difference, agg.commitment);

      return {
        period,
        commitment_value: agg.commitment,
        execution_value: agg.execution,
        difference,
        difference_percent: differencePercent,
      };
    });

  // Totals (computed from output points).
  const totalCommitment = points.reduce((acc, p) => acc.add(p.commitment_value), new Decimal(0));
  const totalExecution = points.reduce((acc, p) => acc.add(p.execution_value), new Decimal(0));
  const totalDifference = totalCommitment.minus(totalExecution);

  // TODO(review): Denominator choice: using commitment answers "how much of commitment is not executed".
  // Using execution would answer a different question ("how much execution exceeds commitment").
  const overallDifferencePercent = safePercent(totalDifference, totalCommitment);

  if (filter.show_period_growth) {
    for (let i = 0; i < points.length; i++) {
      const curr = points[i];
      const prev = i > 0 ? points[i - 1] : undefined;
      if (curr === undefined) continue;

      if (prev === undefined) {
        curr.commitment_growth_percent = null;
        curr.execution_growth_percent = null;
        curr.difference_growth_percent = null;
        continue;
      }

      curr.commitment_growth_percent = computeGrowthPercent(
        curr.commitment_value,
        prev.commitment_value
      );
      curr.execution_growth_percent = computeGrowthPercent(
        curr.execution_value,
        prev.execution_value
      );
      curr.difference_growth_percent = computeGrowthPercent(curr.difference, prev.difference);
    }
  }

  return ok({
    frequency: requestedFrequency,
    data: points,
    total_commitment: totalCommitment,
    total_execution: totalExecution,
    total_difference: totalDifference,
    overall_difference_percent: overallDifferencePercent,
    matched_count: counts.matched_count,
    unmatched_commitment_count: counts.unmatched_commitment_count,
    unmatched_execution_count: counts.unmatched_execution_count,
  });
}
