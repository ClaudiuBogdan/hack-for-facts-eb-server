/**
 * Classification Repository Implementation
 *
 * Kysely implementation for functional and economic classification queries.
 */

import { ok, err, type Result } from 'neverthrow';

import { createDatabaseError, type ClassificationError } from '../../core/errors.js';

import type {
  FunctionalClassificationRepository,
  EconomicClassificationRepository,
} from '../../core/ports.js';
import type {
  FunctionalClassification,
  FunctionalClassificationConnection,
  FunctionalClassificationFilter,
  EconomicClassification,
  EconomicClassificationConnection,
  EconomicClassificationFilter,
} from '../../core/types.js';
import type { BudgetDbClient } from '@/infra/database/client.js';

// ============================================================================
// Functional Classification Repository
// ============================================================================

/**
 * Creates a Kysely-based functional classification repository.
 */
export const makeFunctionalClassificationRepo = (
  db: BudgetDbClient
): FunctionalClassificationRepository => {
  return {
    async getByCode(
      code: string
    ): Promise<Result<FunctionalClassification | null, ClassificationError>> {
      try {
        const row = await db
          .selectFrom('functionalclassifications')
          .select(['functional_code', 'functional_name'])
          .where('functional_code', '=', code)
          .executeTakeFirst();

        if (row === undefined) {
          return ok(null);
        }

        return ok({
          functional_code: row.functional_code,
          functional_name: row.functional_name,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown database error';
        return err(createDatabaseError(message));
      }
    },

    async list(
      filter: FunctionalClassificationFilter,
      limit: number,
      offset: number
    ): Promise<Result<FunctionalClassificationConnection, ClassificationError>> {
      try {
        let query = db
          .selectFrom('functionalclassifications')
          .select(['functional_code', 'functional_name']);

        // Apply search filter
        if (filter.search !== undefined && filter.search.trim() !== '') {
          const search = filter.search.trim();
          // Check if search looks like a code prefix (numeric, possibly with dots)
          const isCodeLike = /^[\d.]+$/.test(search);

          if (isCodeLike) {
            // For code-like searches, use prefix matching (starts with)
            const prefixTerm = `${search.toLowerCase()}%`;
            query = query.where('functional_code', 'ilike', prefixTerm);
          } else {
            // For text searches, use contains matching
            const searchTerm = `%${search.toLowerCase()}%`;
            query = query.where((eb) =>
              eb.or([
                eb('functional_code', 'ilike', searchTerm),
                eb('functional_name', 'ilike', searchTerm),
              ])
            );
          }
        }

        // Apply code filter
        if (filter.functional_codes !== undefined && filter.functional_codes.length > 0) {
          query = query.where('functional_code', 'in', filter.functional_codes);
        }

        // Get total count
        let countQuery = db
          .selectFrom('functionalclassifications')
          .select(db.fn.countAll().as('count'));

        if (filter.search !== undefined && filter.search.trim() !== '') {
          const searchTerm = `%${filter.search.trim().toLowerCase()}%`;
          countQuery = countQuery.where((eb) =>
            eb.or([
              eb('functional_code', 'ilike', searchTerm),
              eb('functional_name', 'ilike', searchTerm),
            ])
          );
        }

        if (filter.functional_codes !== undefined && filter.functional_codes.length > 0) {
          countQuery = countQuery.where('functional_code', 'in', filter.functional_codes);
        }

        const [rows, countResult] = await Promise.all([
          query.orderBy('functional_code', 'asc').limit(limit).offset(offset).execute(),
          countQuery.executeTakeFirst(),
        ]);

        const totalCount = Number(countResult?.count ?? 0);

        return ok({
          nodes: rows.map((row) => ({
            functional_code: row.functional_code,
            functional_name: row.functional_name,
          })),
          pageInfo: {
            hasNextPage: offset + rows.length < totalCount,
            hasPreviousPage: offset > 0,
            totalCount,
          },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown database error';
        return err(createDatabaseError(message));
      }
    },
  };
};

// ============================================================================
// Economic Classification Repository
// ============================================================================

/**
 * Creates a Kysely-based economic classification repository.
 */
export const makeEconomicClassificationRepo = (
  db: BudgetDbClient
): EconomicClassificationRepository => {
  return {
    async getByCode(
      code: string
    ): Promise<Result<EconomicClassification | null, ClassificationError>> {
      try {
        const row = await db
          .selectFrom('economicclassifications')
          .select(['economic_code', 'economic_name'])
          .where('economic_code', '=', code)
          .executeTakeFirst();

        if (row === undefined) {
          return ok(null);
        }

        return ok({
          economic_code: row.economic_code,
          economic_name: row.economic_name,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown database error';
        return err(createDatabaseError(message));
      }
    },

    async list(
      filter: EconomicClassificationFilter,
      limit: number,
      offset: number
    ): Promise<Result<EconomicClassificationConnection, ClassificationError>> {
      try {
        let query = db
          .selectFrom('economicclassifications')
          .select(['economic_code', 'economic_name']);

        // Apply search filter
        if (filter.search !== undefined && filter.search.trim() !== '') {
          const searchTerm = `%${filter.search.trim().toLowerCase()}%`;
          query = query.where((eb) =>
            eb.or([
              eb('economic_code', 'ilike', searchTerm),
              eb('economic_name', 'ilike', searchTerm),
            ])
          );
        }

        // Apply code filter
        if (filter.economic_codes !== undefined && filter.economic_codes.length > 0) {
          query = query.where('economic_code', 'in', filter.economic_codes);
        }

        // Get total count
        let countQuery = db
          .selectFrom('economicclassifications')
          .select(db.fn.countAll().as('count'));

        if (filter.search !== undefined && filter.search.trim() !== '') {
          const searchTerm = `%${filter.search.trim().toLowerCase()}%`;
          countQuery = countQuery.where((eb) =>
            eb.or([
              eb('economic_code', 'ilike', searchTerm),
              eb('economic_name', 'ilike', searchTerm),
            ])
          );
        }

        if (filter.economic_codes !== undefined && filter.economic_codes.length > 0) {
          countQuery = countQuery.where('economic_code', 'in', filter.economic_codes);
        }

        const [rows, countResult] = await Promise.all([
          query.orderBy('economic_code', 'asc').limit(limit).offset(offset).execute(),
          countQuery.executeTakeFirst(),
        ]);

        const totalCount = Number(countResult?.count ?? 0);

        return ok({
          nodes: rows.map((row) => ({
            economic_code: row.economic_code,
            economic_name: row.economic_name,
          })),
          pageInfo: {
            hasNextPage: offset + rows.length < totalCount,
            hasPreviousPage: offset > 0,
            totalCount,
          },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown database error';
        return err(createDatabaseError(message));
      }
    },
  };
};
