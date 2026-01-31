import { Decimal } from 'decimal.js';
import { err, type Result } from 'neverthrow';

import { isMetricAvailableForPeriod, type CommitmentsMetric } from '@/common/types/commitments.js';
import {
  Frequency,
  extractYearRangeFromSelection,
  generatePeriodLabels,
} from '@/common/types/temporal.js';

import { createDatabaseError, createValidationError, type CommitmentsError } from '../errors.js';
import { computeMultiplier, needsNormalization } from '../normalization.js';
import {
  MAX_LIMIT,
  type CommitmentsAggregatedConnection,
  type CommitmentsAggregatedInput,
  type CommitmentsFilter,
} from '../types.js';

import type { AggregateFilters, CommitmentsRepository, PeriodFactorMap } from '../ports.js';
import type { AnalyticsFilter } from '@/common/types/analytics.js';
import type { PopulationRepository, NormalizationFactors } from '@/modules/normalization/index.js';

export interface NormalizationFactorProvider {
  generateFactors(
    frequency: Frequency,
    startYear: number,
    endYear: number
  ): Promise<NormalizationFactors>;
}

export interface GetCommitmentsAggregatedDeps {
  repo: CommitmentsRepository;
  normalization: NormalizationFactorProvider;
  populationRepo: PopulationRepository;
}

async function getFilterPopulationDenominator(
  filter: Pick<
    CommitmentsFilter,
    | 'normalization'
    | 'report_period'
    | 'entity_cuis'
    | 'uat_ids'
    | 'county_codes'
    | 'is_uat'
    | 'entity_types'
  >,
  populationRepo: PopulationRepository
): Promise<Decimal | undefined> {
  if (filter.normalization !== 'per_capita') return undefined;

  const hasEntityCuis = filter.entity_cuis !== undefined && filter.entity_cuis.length > 0;
  const hasUatIds = filter.uat_ids !== undefined && filter.uat_ids.length > 0;
  const hasCountyCodes = filter.county_codes !== undefined && filter.county_codes.length > 0;
  const hasIsUat = filter.is_uat !== undefined;
  const hasEntityTypes = filter.entity_types !== undefined && filter.entity_types.length > 0;

  const hasEntityFilter =
    hasEntityCuis || hasUatIds || hasCountyCodes || hasIsUat || hasEntityTypes;

  if (!hasEntityFilter) {
    const countryResult = await populationRepo.getCountryPopulation();
    return countryResult.isOk() ? countryResult.value : undefined;
  }

  const fakeFilter: AnalyticsFilter = {
    account_category: 'ch',
    report_period: filter.report_period,
    ...(filter.entity_cuis !== undefined && { entity_cuis: filter.entity_cuis }),
    ...(filter.uat_ids !== undefined && { uat_ids: filter.uat_ids }),
    ...(filter.county_codes !== undefined && { county_codes: filter.county_codes }),
    ...(filter.is_uat !== undefined && { is_uat: filter.is_uat }),
    ...(filter.entity_types !== undefined && { entity_types: filter.entity_types }),
  };

  const filteredResult = await populationRepo.getFilteredPopulation(fakeFilter);
  return filteredResult.isOk() ? filteredResult.value : undefined;
}

function buildAggregateFilters(filter: CommitmentsFilter): AggregateFilters | undefined {
  // NOTE: For commitmentsAggregated, thresholds apply to the selected metric.
  const min = filter.aggregate_min_amount;
  const max = filter.aggregate_max_amount;

  const out: AggregateFilters = {};

  if (min !== undefined && min !== null) out.minAmount = new Decimal(min);
  if (max !== undefined && max !== null) out.maxAmount = new Decimal(max);

  return Object.keys(out).length > 0 ? out : undefined;
}

export async function getCommitmentsAggregated(
  deps: GetCommitmentsAggregatedDeps,
  input: CommitmentsAggregatedInput
): Promise<Result<CommitmentsAggregatedConnection, CommitmentsError>> {
  const limit = Math.min(Math.max(input.limit, 0), MAX_LIMIT);
  const offset = Math.max(input.offset, 0);

  // NOTE: show_period_growth is ignored for aggregated by spec decision.
  const filter: CommitmentsFilter = { ...input.filter, show_period_growth: false };

  const frequency = filter.report_period.type;
  const metric: CommitmentsMetric = input.metric;

  if (!isMetricAvailableForPeriod(metric, frequency)) {
    return err(
      createValidationError('Metric is not available for the requested period type', 'metric', {
        metric,
        period_type: frequency,
      })
    );
  }

  const config = {
    normalization: filter.normalization,
    currency: filter.currency,
    inflation_adjusted: filter.inflation_adjusted,
  } as const;

  const { startYear, endYear } = extractYearRangeFromSelection(filter.report_period.selection);
  const periodLabels = generatePeriodLabels(startYear, endYear, frequency);

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

  const needsFactors = needsNormalization(config);

  let factors: NormalizationFactors;
  if (needsFactors) {
    try {
      factors = await deps.normalization.generateFactors(frequency, startYear, endYear);
    } catch (error) {
      return err(createDatabaseError('Failed to generate normalization factors', error));
    }
  } else {
    // Per-capita only: factors are unused (no inflation/currency/%GDP).
    factors = {
      cpi: new Map(),
      eur: new Map(),
      usd: new Map(),
      gdp: new Map(),
      population: new Map(),
    };
  }

  const factorMap: PeriodFactorMap = new Map(
    periodLabels.map((label) => [label, computeMultiplier(label, config, factors, populationDenom)])
  );

  const aggregateFilters = buildAggregateFilters(filter);

  return deps.repo.getAggregated(filter, metric, factorMap, { limit, offset }, aggregateFilters);
}
