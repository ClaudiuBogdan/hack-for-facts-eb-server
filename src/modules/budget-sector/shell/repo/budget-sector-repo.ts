/**
 * Kysely repository implementation for budget sectors.
 */

import { sql } from 'kysely';
import { ok, err, type Result } from 'neverthrow';

import { createDatabaseError, type BudgetSectorError } from '../../core/errors.js';
import {
  SIMILARITY_THRESHOLD,
  type BudgetSector,
  type BudgetSectorFilter,
  type BudgetSectorConnection,
} from '../../core/types.js';

import type { BudgetSectorRepository } from '../../core/ports.js';
import type { BudgetDbClient } from '@/infra/database/client.js';

/**
 * Escapes special characters in LIKE patterns.
 * Prevents SQL injection and ensures literal matching of wildcards.
 */
const escapeLikePattern = (str: string): string => {
  return str.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
};

/**
 * Kysely-based implementation of BudgetSectorRepository.
 */
class KyselyBudgetSectorRepo implements BudgetSectorRepository {
  constructor(private readonly db: BudgetDbClient) {}

  async findById(id: number): Promise<Result<BudgetSector | null, BudgetSectorError>> {
    try {
      const row = await this.db
        .selectFrom('budgetsectors')
        .select(['sector_id', 'sector_description'])
        .where('sector_id', '=', id)
        .executeTakeFirst();

      if (row === undefined) {
        return ok(null);
      }

      return ok({
        sector_id: row.sector_id,
        sector_description: row.sector_description,
      });
    } catch (error) {
      return err(createDatabaseError('Failed to fetch budget sector by ID', error));
    }
  }

  async list(
    filter: BudgetSectorFilter | undefined,
    limit: number,
    offset: number
  ): Promise<Result<BudgetSectorConnection, BudgetSectorError>> {
    try {
      let query = this.db
        .selectFrom('budgetsectors')
        .select([
          'sector_id',
          'sector_description',
          sql<string>`COUNT(*) OVER()`.as('total_count'),
        ]);

      // Apply search filter (ILIKE OR pg_trgm similarity)
      if (filter?.search !== undefined && filter.search.trim() !== '') {
        const searchTerm = filter.search.trim();
        const likePattern = `%${escapeLikePattern(searchTerm)}%`;

        query = query.where((eb) =>
          eb.or([
            eb('sector_description', 'ilike', likePattern),
            sql<boolean>`similarity(sector_description, ${searchTerm}) > ${SIMILARITY_THRESHOLD}`,
          ])
        );
      }

      // Apply sector_ids filter
      if (filter?.sector_ids !== undefined && filter.sector_ids.length > 0) {
        query = query.where('sector_id', 'in', filter.sector_ids);
      }

      // Order by sector_id for deterministic pagination
      query = query.orderBy('sector_id', 'asc').limit(limit).offset(offset);

      const rows = await query.execute();

      // Extract total count from window function
      const firstRow = rows[0];
      const totalCount = firstRow !== undefined ? Number.parseInt(firstRow.total_count, 10) : 0;

      // Map to domain types
      const nodes: BudgetSector[] = rows.map((row) => ({
        sector_id: row.sector_id,
        sector_description: row.sector_description,
      }));

      return ok({
        nodes,
        pageInfo: {
          totalCount,
          hasNextPage: offset + limit < totalCount,
          hasPreviousPage: offset > 0,
        },
      });
    } catch (error) {
      return err(createDatabaseError('Failed to list budget sectors', error));
    }
  }
}

/**
 * Factory function to create BudgetSectorRepository.
 *
 * @param db - Kysely database client for budget database
 * @returns Repository implementation
 */
export const makeBudgetSectorRepo = (db: BudgetDbClient): BudgetSectorRepository => {
  return new KyselyBudgetSectorRepo(db);
};
