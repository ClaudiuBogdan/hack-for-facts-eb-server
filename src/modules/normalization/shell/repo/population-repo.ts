/* eslint-disable @typescript-eslint/no-unsafe-assignment -- Kysely dynamic query builder requires any typing */
import { Decimal } from 'decimal.js';
import { sql } from 'kysely';
import { ok, err, type Result } from 'neverthrow';

import { setStatementTimeout } from '@/infra/database/query-builders/index.js';
import { toNumericIds } from '@/infra/database/query-filters/index.js';

import type { PopulationRepository, PopulationError } from '../../core/ports.js';
import type { AnalyticsFilter } from '@/common/types/analytics.js';
import type { BudgetDbClient } from '@/infra/database/client.js';

// ============================================================================
// Constants
// ============================================================================

/**
 * Bucharest's special SIRUTA code for municipality-level population.
 * Bucharest (county_code = 'B') uses this code instead of county-level.
 */
const BUCHAREST_SIRUTA_CODE = '179132';

/** Query timeout in milliseconds (15 seconds) */
const QUERY_TIMEOUT_MS = 15_000;

// ============================================================================
// Repository Implementation
// ============================================================================

/**
 * Kysely-based implementation of PopulationRepository.
 *
 * This repository computes filter-dependent population denominators
 * for per_capita normalization.
 *
 * IMPORTANT: Population is computed from current UAT data, not historical.
 * In the future, this may be extended to support year-specific population.
 *
 * Population Computation Rules:
 * -----------------------------
 * 1. Country total: Sum of county-level UATs (avoids double-counting sub-municipal)
 *    - Bucharest: Use SIRUTA 179132 (municipality level)
 *    - Other counties: Use county-level UAT (siruta_code = county_code)
 *
 * 2. Filtered: Based on filter constraints
 *    - entity_cuis → resolve to UAT IDs → sum populations
 *    - uat_ids → sum populations directly
 *    - county_codes → use county-level populations
 *    - admin_county_council → map to county population
 */
export class KyselyPopulationRepo implements PopulationRepository {
  constructor(private readonly db: BudgetDbClient) {}

  /**
   * Gets total country population (sum of county-level populations).
   *
   * SQL Logic:
   * - For Bucharest (county_code = 'B'): Use SIRUTA 179132
   * - For other counties: Use county-level UAT (siruta_code = county_code)
   *
   * This avoids double-counting sub-municipal UATs within counties.
   */
  async getCountryPopulation(): Promise<Result<Decimal, PopulationError>> {
    try {
      await setStatementTimeout(this.db, QUERY_TIMEOUT_MS);

      // Sum county-level populations
      // Bucharest is handled specially via SIRUTA code
      // Use raw SQL for the complex condition
      const result = await sql<{ total_population: string }>`
        SELECT COALESCE(SUM(u.population), 0) AS total_population
        FROM uats u
        WHERE (u.county_code = 'B' AND u.siruta_code = ${BUCHAREST_SIRUTA_CODE})
           OR (u.county_code != 'B' AND u.siruta_code = u.county_code)
      `.execute(this.db);

      const row = result.rows[0];
      const population = row?.total_population ?? '0';
      return ok(new Decimal(population));
    } catch (error) {
      return this.handleError('Failed to fetch country population', error);
    }
  }

  /**
   * Gets population for entities/UATs matching the filter.
   *
   * Handles:
   * - Entity CUIs → resolve to UAT IDs
   * - UAT IDs → direct lookup
   * - County codes → county-level populations
   * - Entity types (admin_county_council) → county populations
   *
   * Deduplication is handled automatically by using DISTINCT entity populations.
   */
  async getFilteredPopulation(filter: AnalyticsFilter): Promise<Result<Decimal, PopulationError>> {
    try {
      await setStatementTimeout(this.db, QUERY_TIMEOUT_MS);

      // Build the population query based on filter
      const population = await this.computeFilteredPopulation(filter);
      return ok(population);
    } catch (error) {
      return this.handleError('Failed to fetch filtered population', error);
    }
  }

  // ==========================================================================
  // Private Methods
  // ==========================================================================

  /**
   * Computes filtered population based on filter criteria.
   *
   * Strategy:
   * 1. If entity_cuis specified: sum populations of their UATs
   * 2. If uat_ids specified: sum populations directly
   * 3. If county_codes specified: sum county-level populations
   * 4. If entity_types includes admin_county_council: handle county council special case
   * 5. If is_uat specified: filter by UAT flag
   *
   * Multiple filters are combined (intersection).
   */
  private async computeFilteredPopulation(filter: AnalyticsFilter): Promise<Decimal> {
    const entityCuis = filter.entity_cuis;
    const uatIds = filter.uat_ids;
    const countyCodes = filter.county_codes;
    const entityTypes = filter.entity_types;
    const isUat = filter.is_uat;

    // Priority-based resolution
    // If specific entities are given, use their populations
    if (entityCuis !== undefined && entityCuis.length > 0) {
      return this.getPopulationByEntityCuis(entityCuis);
    }

    // If specific UAT IDs given, use their populations
    if (uatIds !== undefined && uatIds.length > 0) {
      return this.getPopulationByUatIds(uatIds);
    }

    // If county codes given, use county-level populations
    if (countyCodes !== undefined && countyCodes.length > 0) {
      return this.getPopulationByCountyCodes(countyCodes);
    }

    // If entity type filter (e.g., admin_county_council), handle specially
    if (entityTypes !== undefined && entityTypes.length > 0) {
      return this.getPopulationByEntityTypes(entityTypes, isUat);
    }

    // If only is_uat filter, sum all UAT populations
    if (isUat === true) {
      return this.getPopulationOfAllUats();
    }

    // Fallback to country population (no specific filter)
    const countryResult = await this.getCountryPopulation();
    if (countryResult.isErr()) {
      return new Decimal(0);
    }
    return countryResult.value;
  }

  /**
   * Gets population sum for entities by their CUIs.
   * Resolves entities to their UATs and sums populations.
   */
  private async getPopulationByEntityCuis(cuis: string[]): Promise<Decimal> {
    const result = await this.db
      .selectFrom('entities as e')
      .innerJoin('uats as u', 'e.uat_id', 'u.id')
      .select(sql<string>`COALESCE(SUM(DISTINCT u.population), 0)`.as('total_population'))
      .where('e.cui', 'in', cuis)
      .executeTakeFirst();

    return new Decimal(result?.total_population ?? '0');
  }

  /**
   * Gets population sum for UATs by their IDs.
   */
  private async getPopulationByUatIds(uatIds: string[]): Promise<Decimal> {
    const numericIds = toNumericIds(uatIds);
    if (numericIds.length === 0) {
      return new Decimal(0);
    }

    const result = await this.db
      .selectFrom('uats as u')
      .select(sql<string>`COALESCE(SUM(u.population), 0)`.as('total_population'))
      .where('u.id', 'in', numericIds)
      .executeTakeFirst();

    return new Decimal(result?.total_population ?? '0');
  }

  /**
   * Gets population sum for county codes.
   * Uses county-level UAT populations (avoids sub-municipal double-counting).
   */
  private async getPopulationByCountyCodes(countyCodes: string[]): Promise<Decimal> {
    if (countyCodes.length === 0) {
      return new Decimal(0);
    }

    // Use parameterized query with ANY() for SQL injection prevention
    const result = await sql<{ total_population: string }>`
      SELECT COALESCE(SUM(u.population), 0) AS total_population
      FROM uats u
      WHERE u.county_code = ANY(${countyCodes})
        AND ((u.county_code = 'B' AND u.siruta_code = ${BUCHAREST_SIRUTA_CODE})
             OR (u.county_code != 'B' AND u.siruta_code = u.county_code))
    `.execute(this.db);

    const row = result.rows[0];
    return new Decimal(row?.total_population ?? '0');
  }

  /**
   * Gets population sum based on entity types.
   *
   * Special handling for admin_county_council:
   * - Maps to county population (not individual UAT)
   */
  private async getPopulationByEntityTypes(
    entityTypes: string[],
    isUat?: boolean
  ): Promise<Decimal> {
    // Check if admin_county_council is in the types
    const hasCountyCouncil = entityTypes.includes('admin_county_council');

    if (hasCountyCouncil) {
      // For county councils, we need county-level populations
      // Get distinct counties for county council entities and sum their populations
      const result = await this.db
        .selectFrom('entities as e')
        .innerJoin('uats as u', 'e.uat_id', 'u.id')
        .select(sql<string>`ARRAY_AGG(DISTINCT u.county_code)`.as('counties'))
        .where('e.entity_type', '=', 'admin_county_council')
        .executeTakeFirst();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Kysely returns arrays as unknown
      const counties = (result?.counties as any) ?? [];
      if (Array.isArray(counties) && counties.length > 0) {
        return this.getPopulationByCountyCodes(counties as string[]);
      }
      return new Decimal(0);
    }

    // For other entity types, sum their UAT populations
    if (isUat !== undefined) {
      const result = await this.db
        .selectFrom('entities as e')
        .innerJoin('uats as u', 'e.uat_id', 'u.id')
        .select(sql<string>`COALESCE(SUM(DISTINCT u.population), 0)`.as('total_population'))
        .where('e.entity_type', 'in', entityTypes)
        .where('e.is_uat', '=', isUat)
        .executeTakeFirst();

      return new Decimal(result?.total_population ?? '0');
    }

    const result = await this.db
      .selectFrom('entities as e')
      .innerJoin('uats as u', 'e.uat_id', 'u.id')
      .select(sql<string>`COALESCE(SUM(DISTINCT u.population), 0)`.as('total_population'))
      .where('e.entity_type', 'in', entityTypes)
      .executeTakeFirst();

    return new Decimal(result?.total_population ?? '0');
  }

  /**
   * Gets population sum for all UAT entities.
   */
  private async getPopulationOfAllUats(): Promise<Decimal> {
    const result = await this.db
      .selectFrom('entities as e')
      .innerJoin('uats as u', 'e.uat_id', 'u.id')
      .select(sql<string>`COALESCE(SUM(DISTINCT u.population), 0)`.as('total_population'))
      .where('e.is_uat', '=', true)
      .executeTakeFirst();

    return new Decimal(result?.total_population ?? '0');
  }

  /**
   * Handles errors and returns appropriate error type.
   */
  private handleError(message: string, error: unknown): Result<Decimal, PopulationError> {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return err({
      type: 'DatabaseError',
      message: `${message}: ${errorMessage}`,
      retryable: true,
    });
  }
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Creates a PopulationRepository instance.
 */
export const makePopulationRepo = (db: BudgetDbClient): PopulationRepository => {
  return new KyselyPopulationRepo(db);
};
