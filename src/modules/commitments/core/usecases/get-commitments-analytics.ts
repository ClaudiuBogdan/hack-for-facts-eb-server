import { Decimal } from 'decimal.js';
import { err, ok, type Result } from 'neverthrow';

import { isMetricAvailableForPeriod, type CommitmentsMetric } from '@/common/types/commitments.js';
import { Frequency, extractYearRangeFromSelection } from '@/common/types/temporal.js';

import { createDatabaseError, createValidationError, type CommitmentsError } from '../errors.js';
import { computeMultiplier, needsNormalization } from '../normalization.js';

import type { CommitmentsRepository } from '../ports.js';
import type { CommitmentsAnalyticsInput, CommitmentsAnalyticsSeries } from '../types.js';
import type { AnalyticsFilter, Axis, Currency } from '@/common/types/analytics.js';
import type { PopulationRepository, NormalizationFactors } from '@/modules/normalization/index.js';

export interface NormalizationFactorProvider {
  generateFactors(
    frequency: Frequency,
    startYear: number,
    endYear: number
  ): Promise<NormalizationFactors>;
}

export interface GetCommitmentsAnalyticsDeps {
  repo: CommitmentsRepository;
  normalization: NormalizationFactorProvider;
  populationRepo: PopulationRepository;
}

function getXAxisMetadata(frequency: Frequency): Axis {
  switch (frequency) {
    case Frequency.YEAR:
      return { name: 'Year', type: 'INTEGER', unit: 'year' };
    case Frequency.QUARTER:
      return { name: 'Quarter', type: 'STRING', unit: 'quarter' };
    case Frequency.MONTH:
    default:
      return { name: 'Month', type: 'STRING', unit: 'month' };
  }
}

function getYAxisMetadata(filter: {
  normalization: string;
  currency: Currency;
  inflation_adjusted: boolean;
}): Axis {
  if (filter.normalization === 'percent_gdp') {
    return { name: 'Share of GDP', type: 'FLOAT', unit: '% of GDP' };
  }

  const realSuffix = filter.inflation_adjusted ? ' (real 2024)' : '';
  const capitaSuffix = filter.normalization === 'per_capita' ? '/capita' : '';

  return {
    name: 'Amount',
    type: 'FLOAT',
    unit: `${filter.currency}${capitaSuffix}${realSuffix}`,
  };
}

async function getFilterPopulationDenominator(
  input: { normalization: string } & Pick<
    AnalyticsFilter,
    'report_period' | 'entity_cuis' | 'uat_ids' | 'county_codes' | 'is_uat' | 'entity_types'
  >,
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

  // PopulationRepository expects an AnalyticsFilter shape; only entity-related fields are used.
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

export async function getCommitmentsAnalytics(
  deps: GetCommitmentsAnalyticsDeps,
  inputs: CommitmentsAnalyticsInput[]
): Promise<Result<CommitmentsAnalyticsSeries[], CommitmentsError>> {
  const results: CommitmentsAnalyticsSeries[] = [];

  for (const input of inputs) {
    const frequency = input.filter.report_period.type;
    const metric: CommitmentsMetric = input.metric;

    if (!isMetricAvailableForPeriod(metric, frequency)) {
      return err(
        createValidationError('Metric is not available for the requested period type', 'metric', {
          metric,
          period_type: frequency,
        })
      );
    }

    const seriesResult = await deps.repo.getAnalyticsSeries(input.filter, metric);
    if (seriesResult.isErr()) return err(seriesResult.error);

    const rawSeries = seriesResult.value;

    const config = {
      normalization: input.filter.normalization,
      currency: input.filter.currency,
      inflation_adjusted: input.filter.inflation_adjusted,
    } as const;

    const needsFactors = needsNormalization(config);

    const { startYear, endYear } = extractYearRangeFromSelection(
      input.filter.report_period.selection
    );

    const populationDenom = await getFilterPopulationDenominator(
      {
        normalization: input.filter.normalization,
        report_period: input.filter.report_period,
        ...(input.filter.entity_cuis !== undefined && { entity_cuis: input.filter.entity_cuis }),
        ...(input.filter.uat_ids !== undefined && { uat_ids: input.filter.uat_ids }),
        ...(input.filter.county_codes !== undefined && { county_codes: input.filter.county_codes }),
        ...(input.filter.is_uat !== undefined && { is_uat: input.filter.is_uat }),
        ...(input.filter.entity_types !== undefined && { entity_types: input.filter.entity_types }),
      },
      deps.populationRepo
    );

    let factors: NormalizationFactors;
    if (needsFactors) {
      try {
        factors = await deps.normalization.generateFactors(frequency, startYear, endYear);
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

    // Apply normalization per point (aggregate-after-normalize pattern).
    const normalizedPoints = rawSeries.data
      .map((p) => {
        const mult = computeMultiplier(p.date, config, factors, populationDenom);
        return { x: p.date, y: p.value.mul(mult) };
      })
      .sort((a, b) => a.x.localeCompare(b.x));

    const growthLookup = new Map<string, number | null>();
    if (input.filter.show_period_growth) {
      for (let i = 0; i < normalizedPoints.length; i++) {
        const curr = normalizedPoints[i];
        const prev = i > 0 ? normalizedPoints[i - 1] : undefined;

        if (curr === undefined || prev === undefined) {
          growthLookup.set(curr?.x ?? '', null);
          continue;
        }

        if (prev.y.isZero()) {
          growthLookup.set(curr.x, null);
          continue;
        }

        const growth = curr.y.minus(prev.y).div(prev.y).mul(100);
        growthLookup.set(curr.x, growth.toNumber());
      }
    }

    results.push({
      seriesId: input.seriesId ?? metric,
      metric,
      xAxis: getXAxisMetadata(frequency),
      yAxis: getYAxisMetadata({
        normalization: input.filter.normalization,
        currency: input.filter.currency,
        inflation_adjusted: input.filter.inflation_adjusted,
      }),
      data: normalizedPoints.map((p, index) => ({
        x: p.x,
        y: p.y.toNumber(),
        ...(input.filter.show_period_growth
          ? {
              growth_percent: index === 0 ? null : (growthLookup.get(p.x) ?? null),
            }
          : {}),
      })),
    });
  }

  return ok(results);
}
