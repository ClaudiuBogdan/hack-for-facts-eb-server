import type { PopulationRepository } from './ports.js';
import type { AnalyticsFilter, NormalizationOptions } from '@/common/types/analytics.js';
import type { Decimal } from 'decimal.js';

/**
 * Computes denominator population for per_capita mode.
 *
 * Population is filter-dependent (constant per query), unlike CPI/exchange
 * rates which are year-specific.
 *
 * This function determines which population to use based on filter criteria:
 * - If no entity filters: Use total country population
 * - If entity filters present: Use filtered population for those entities
 *
 * @param filter - Analytics filter to determine population scope
 * @param populationRepo - Repository for population queries
 * @returns Decimal population value, or undefined if not in per_capita mode or on error
 */
export async function getDenominatorPopulation(
  filter: AnalyticsFilter & NormalizationOptions,
  populationRepo: PopulationRepository
): Promise<Decimal | undefined> {
  // Only needed for per_capita mode
  if (filter.normalization !== 'per_capita') {
    return undefined;
  }

  const hasEntityCuis = filter.entity_cuis !== undefined && filter.entity_cuis.length > 0;
  const hasUatIds = filter.uat_ids !== undefined && filter.uat_ids.length > 0;
  const hasCountyCodes = filter.county_codes !== undefined && filter.county_codes.length > 0;
  const hasIsUat = filter.is_uat !== undefined;
  const hasEntityTypes = filter.entity_types !== undefined && filter.entity_types.length > 0;

  const hasEntityFilter =
    hasEntityCuis || hasUatIds || hasCountyCodes || hasIsUat || hasEntityTypes;

  if (!hasEntityFilter) {
    const countryResult = await populationRepo.getCountryPopulation();
    if (countryResult.isErr()) {
      // Log error but don't fail - per_capita will be disabled
      return undefined;
    }
    return countryResult.value;
  }

  const filteredResult = await populationRepo.getFilteredPopulation(filter);
  if (filteredResult.isErr()) {
    // Log error but don't fail - per_capita will be disabled
    return undefined;
  }
  return filteredResult.value;
}
