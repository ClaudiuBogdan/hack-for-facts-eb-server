/**
 * Kysely repository implementation for funding sources and execution line items.
 */

import { sql } from 'kysely';
import { ok, err, type Result } from 'neverthrow';

import { createDatabaseError, type FundingSourceError } from '../../core/errors.js';
import {
  SIMILARITY_THRESHOLD,
  MAX_LINE_ITEMS_LIMIT,
  type FundingSource,
  type FundingSourceFilter,
  type FundingSourceConnection,
  type ExecutionLineItem,
  type ExecutionLineItemFilter,
  type ExecutionLineItemConnection,
} from '../../core/types.js';

import type { FundingSourceRepository, ExecutionLineItemRepository } from '../../core/ports.js';
import type { BudgetDbClient } from '@/infra/database/client.js';

/**
 * Escapes special characters in LIKE patterns.
 * Prevents SQL injection and ensures literal matching of wildcards.
 */
const escapeLikePattern = (str: string): string => {
  return str.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
};

/**
 * Kysely-based implementation of FundingSourceRepository.
 */
class KyselyFundingSourceRepo implements FundingSourceRepository {
  constructor(private readonly db: BudgetDbClient) {}

  async findById(id: number): Promise<Result<FundingSource | null, FundingSourceError>> {
    try {
      const row = await this.db
        .selectFrom('fundingsources')
        .select(['source_id', 'source_description'])
        .where('source_id', '=', id)
        .executeTakeFirst();

      if (row === undefined) {
        return ok(null);
      }

      return ok({
        source_id: row.source_id,
        source_description: row.source_description,
      });
    } catch (error) {
      return err(createDatabaseError('Failed to fetch funding source by ID', error));
    }
  }

  async list(
    filter: FundingSourceFilter | undefined,
    limit: number,
    offset: number
  ): Promise<Result<FundingSourceConnection, FundingSourceError>> {
    try {
      let query = this.db
        .selectFrom('fundingsources')
        .select([
          'source_id',
          'source_description',
          sql<string>`COUNT(*) OVER()`.as('total_count'),
        ]);

      // Apply search filter (ILIKE OR pg_trgm similarity)
      if (filter?.search !== undefined && filter.search.trim() !== '') {
        const searchTerm = filter.search.trim();
        const likePattern = `%${escapeLikePattern(searchTerm)}%`;

        query = query.where((eb) =>
          eb.or([
            eb('source_description', 'ilike', likePattern),
            sql<boolean>`similarity(source_description, ${searchTerm}) > ${SIMILARITY_THRESHOLD}`,
          ])
        );
      }

      // Apply source_ids filter
      if (filter?.source_ids !== undefined && filter.source_ids.length > 0) {
        query = query.where('source_id', 'in', filter.source_ids);
      }

      // Order by source_id for deterministic pagination
      query = query.orderBy('source_id', 'asc').limit(limit).offset(offset);

      const rows = await query.execute();

      // Extract total count from window function
      const firstRow = rows[0];
      const totalCount = firstRow !== undefined ? Number.parseInt(firstRow.total_count, 10) : 0;

      // Map to domain types
      const nodes: FundingSource[] = rows.map((row) => ({
        source_id: row.source_id,
        source_description: row.source_description,
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
      return err(createDatabaseError('Failed to list funding sources', error));
    }
  }
}

/**
 * Kysely-based implementation of ExecutionLineItemRepository.
 */
class KyselyExecutionLineItemRepo implements ExecutionLineItemRepository {
  constructor(private readonly db: BudgetDbClient) {}

  async listByFundingSource(
    filter: ExecutionLineItemFilter,
    limit: number,
    offset: number
  ): Promise<Result<ExecutionLineItemConnection, FundingSourceError>> {
    try {
      // Clamp limit to max
      const safeLimit = Math.min(Math.max(1, limit), MAX_LINE_ITEMS_LIMIT);
      const safeOffset = Math.max(0, offset);

      let query = this.db
        .selectFrom('executionlineitems')
        .select([
          'line_item_id',
          'report_id',
          'year',
          'month',
          'entity_cui',
          'account_category',
          'functional_code',
          'economic_code',
          'ytd_amount',
          'monthly_amount',
          sql<string>`COUNT(*) OVER()`.as('total_count'),
        ])
        .where('funding_source_id', '=', filter.funding_source_id);

      // Apply optional report_id filter
      if (filter.report_id !== undefined) {
        query = query.where('report_id', '=', filter.report_id);
      }

      // Apply optional account_category filter
      if (filter.account_category !== undefined) {
        query = query.where('account_category', '=', filter.account_category);
      }

      // Order by year, month, line_item_id for deterministic pagination
      query = query
        .orderBy('year', 'desc')
        .orderBy('month', 'desc')
        .orderBy('line_item_id', 'asc')
        .limit(safeLimit)
        .offset(safeOffset);

      const rows = await query.execute();

      // Extract total count from window function
      const firstRow = rows[0];
      const totalCount = firstRow !== undefined ? Number.parseInt(firstRow.total_count, 10) : 0;

      // Map to domain types
      const nodes: ExecutionLineItem[] = rows.map((row) => ({
        line_item_id: row.line_item_id,
        report_id: row.report_id,
        year: row.year,
        month: row.month,
        entity_cui: row.entity_cui,
        account_category: row.account_category,
        functional_code: row.functional_code,
        economic_code: row.economic_code,
        ytd_amount: row.ytd_amount,
        monthly_amount: row.monthly_amount,
      }));

      return ok({
        nodes,
        pageInfo: {
          totalCount,
          hasNextPage: safeOffset + safeLimit < totalCount,
          hasPreviousPage: safeOffset > 0,
        },
      });
    } catch (error) {
      return err(createDatabaseError('Failed to list execution line items', error));
    }
  }
}

/**
 * Factory function to create FundingSourceRepository.
 *
 * @param db - Kysely database client for budget database
 * @returns Repository implementation
 */
export const makeFundingSourceRepo = (db: BudgetDbClient): FundingSourceRepository => {
  return new KyselyFundingSourceRepo(db);
};

/**
 * Factory function to create ExecutionLineItemRepository.
 *
 * @param db - Kysely database client for budget database
 * @returns Repository implementation
 */
export const makeExecutionLineItemRepo = (db: BudgetDbClient): ExecutionLineItemRepository => {
  return new KyselyExecutionLineItemRepo(db);
};
