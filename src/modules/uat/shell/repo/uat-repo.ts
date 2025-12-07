/**
 * UAT Repository Implementation
 *
 * Kysely-based repository for UAT data access with pg_trgm search support.
 */

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any -- Kysely dynamic query builder requires type flexibility */
import { sql } from 'kysely';
import { ok, err, type Result } from 'neverthrow';

import {
  createDatabaseError,
  createTimeoutError,
  isTimeoutError,
  type UATError,
} from '../../core/errors.js';
import {
  UAT_SIMILARITY_THRESHOLD,
  type UAT,
  type UATConnection,
  type UATFilter,
} from '../../core/types.js';

import type { UATRepository } from '../../core/ports.js';
import type { BudgetDbClient } from '@/infra/database/client.js';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const QUERY_TIMEOUT_MS = 30_000;

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Raw row from uats table.
 */
interface UATRow {
  id: number;
  uat_key: string;
  uat_code: string;
  siruta_code: string;
  name: string;
  county_code: string;
  county_name: string;
  region: string;
  population: number | null;
  total_count?: string;
  relevance?: number;
}

/**
 * Kysely dynamic query type.
 */
type DynamicQuery = any;

// ─────────────────────────────────────────────────────────────────────────────
// Helper Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Escapes special characters for ILIKE pattern matching.
 */
function escapeILikePattern(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

// ─────────────────────────────────────────────────────────────────────────────
// Repository Implementation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Kysely-based UAT Repository.
 */
class KyselyUATRepo implements UATRepository {
  constructor(private readonly db: BudgetDbClient) {}

  async getById(id: number): Promise<Result<UAT | null, UATError>> {
    try {
      // Set statement timeout
      await sql`SET LOCAL statement_timeout = ${sql.raw(String(QUERY_TIMEOUT_MS))}`.execute(
        this.db
      );

      const row = await this.db
        .selectFrom('uats')
        .select([
          'id',
          'uat_key',
          'uat_code',
          'siruta_code',
          'name',
          'county_code',
          'county_name',
          'region',
          'population',
        ])
        .where('id', '=', id)
        .executeTakeFirst();

      if (row === undefined) {
        return ok(null);
      }

      return ok(this.mapRowToUAT(row as UATRow));
    } catch (error) {
      if (isTimeoutError(error)) {
        return err(createTimeoutError('UAT getById query timed out', error));
      }
      return err(createDatabaseError('UAT getById failed', error));
    }
  }

  async getByIds(ids: number[]): Promise<Result<Map<number, UAT>, UATError>> {
    if (ids.length === 0) {
      return ok(new Map());
    }

    try {
      // Set statement timeout
      await sql`SET LOCAL statement_timeout = ${sql.raw(String(QUERY_TIMEOUT_MS))}`.execute(
        this.db
      );

      const rows = await this.db
        .selectFrom('uats')
        .select([
          'id',
          'uat_key',
          'uat_code',
          'siruta_code',
          'name',
          'county_code',
          'county_name',
          'region',
          'population',
        ])
        .where('id', 'in', ids)
        .execute();

      const map = new Map<number, UAT>();
      for (const row of rows) {
        map.set(row.id, this.mapRowToUAT(row as UATRow));
      }

      return ok(map);
    } catch (error) {
      if (isTimeoutError(error)) {
        return err(createTimeoutError('UAT getByIds query timed out', error));
      }
      return err(createDatabaseError('UAT getByIds failed', error));
    }
  }

  async getAll(
    filter: UATFilter,
    limit: number,
    offset: number
  ): Promise<Result<UATConnection, UATError>> {
    try {
      // Set statement timeout
      await sql`SET LOCAL statement_timeout = ${sql.raw(String(QUERY_TIMEOUT_MS))}`.execute(
        this.db
      );

      // Build base query
      let query: DynamicQuery = this.db
        .selectFrom('uats')
        .select([
          'id',
          'uat_key',
          'uat_code',
          'siruta_code',
          'name',
          'county_code',
          'county_name',
          'region',
          'population',
          sql<string>`COUNT(*) OVER()`.as('total_count'),
        ]);

      // Apply search or regular filters
      if (filter.search !== undefined && filter.search.trim() !== '') {
        query = this.applySearchFilter(query, filter.search);
      } else {
        query = this.applyRegularFilters(query, filter);
      }

      // Apply exact match filters (always applied)
      query = this.applyExactFilters(query, filter);

      // Apply is_county filter
      query = this.applyIsCountyFilter(query, filter);

      // Apply pagination
      query = query.limit(limit).offset(offset);

      const rows: UATRow[] = await query.execute();

      return ok(this.mapToConnection(rows, limit, offset));
    } catch (error) {
      if (isTimeoutError(error)) {
        return err(createTimeoutError('UAT getAll query timed out', error));
      }
      return err(createDatabaseError('UAT getAll failed', error));
    }
  }

  async count(filter: UATFilter): Promise<Result<number, UATError>> {
    try {
      // Set statement timeout
      await sql`SET LOCAL statement_timeout = ${sql.raw(String(QUERY_TIMEOUT_MS))}`.execute(
        this.db
      );

      // Build count query
      let query: DynamicQuery = this.db
        .selectFrom('uats')
        .select(sql<string>`COUNT(*)`.as('count'));

      // Apply search or regular filters
      if (filter.search !== undefined && filter.search.trim() !== '') {
        query = this.applySearchFilterForCount(query, filter.search);
      } else {
        query = this.applyRegularFiltersForCount(query, filter);
      }

      // Apply exact match filters
      query = this.applyExactFilters(query, filter);

      // Apply is_county filter
      query = this.applyIsCountyFilter(query, filter);

      const result = await query.executeTakeFirst();
      const countStr: string = result?.count ?? '0';
      const count = Number.parseInt(countStr, 10);

      return ok(count);
    } catch (error) {
      if (isTimeoutError(error)) {
        return err(createTimeoutError('UAT count query timed out', error));
      }
      return err(createDatabaseError('UAT count failed', error));
    }
  }

  async getCountyPopulation(countyCode: string): Promise<Result<number | null, UATError>> {
    try {
      // Set statement timeout
      await sql`SET LOCAL statement_timeout = ${sql.raw(String(QUERY_TIMEOUT_MS))}`.execute(
        this.db
      );

      // Sum all UAT populations in the county
      const result = await this.db
        .selectFrom('uats')
        .select(sql<string>`COALESCE(SUM(population), 0)`.as('total_population'))
        .where('county_code', '=', countyCode)
        .executeTakeFirst();

      if (result === undefined) {
        return ok(null);
      }

      const totalPopulation = Number.parseInt(result.total_population, 10);
      return ok(totalPopulation > 0 ? totalPopulation : null);
    } catch (error) {
      if (isTimeoutError(error)) {
        return err(createTimeoutError('UAT getCountyPopulation query timed out', error));
      }
      return err(createDatabaseError('UAT getCountyPopulation failed', error));
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Private Methods - Filter Building
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Applies pg_trgm search filter with relevance scoring.
   */
  private applySearchFilter(query: DynamicQuery, search: string): DynamicQuery {
    const searchTerm = search.trim();

    // Add relevance column using GREATEST of similarities
    const relevance = sql<number>`GREATEST(
      similarity(name, ${searchTerm}),
      similarity(county_name, ${searchTerm})
    )`;

    return query
      .select(relevance.as('relevance'))
      .where(
        sql`GREATEST(
          similarity(name, ${searchTerm}),
          similarity(county_name, ${searchTerm})
        ) > ${UAT_SIMILARITY_THRESHOLD}`
      )
      .orderBy(relevance, 'desc')
      .orderBy('name', 'asc')
      .orderBy('id', 'asc');
  }

  /**
   * Applies pg_trgm search filter for count query (no ordering needed).
   */
  private applySearchFilterForCount(query: DynamicQuery, search: string): DynamicQuery {
    const searchTerm = search.trim();

    return query.where(
      sql`GREATEST(
        similarity(name, ${searchTerm}),
        similarity(county_name, ${searchTerm})
      ) > ${UAT_SIMILARITY_THRESHOLD}`
    );
  }

  /**
   * Applies ILIKE filters when search is not present.
   */
  private applyRegularFilters(query: DynamicQuery, filter: UATFilter): DynamicQuery {
    let q = query;

    if (filter.name !== undefined && filter.name.trim() !== '') {
      const escapedName = escapeILikePattern(filter.name.trim());
      q = q.where('name', 'ilike', `%${escapedName}%`);
    }

    if (filter.county_name !== undefined && filter.county_name.trim() !== '') {
      const escapedCountyName = escapeILikePattern(filter.county_name.trim());
      q = q.where('county_name', 'ilike', `%${escapedCountyName}%`);
    }

    // Default ordering when no search
    q = q.orderBy('name', 'asc').orderBy('id', 'asc');

    return q;
  }

  /**
   * Applies ILIKE filters for count query (no ordering needed).
   */
  private applyRegularFiltersForCount(query: DynamicQuery, filter: UATFilter): DynamicQuery {
    let q = query;

    if (filter.name !== undefined && filter.name.trim() !== '') {
      const escapedName = escapeILikePattern(filter.name.trim());
      q = q.where('name', 'ilike', `%${escapedName}%`);
    }

    if (filter.county_name !== undefined && filter.county_name.trim() !== '') {
      const escapedCountyName = escapeILikePattern(filter.county_name.trim());
      q = q.where('county_name', 'ilike', `%${escapedCountyName}%`);
    }

    return q;
  }

  /**
   * Applies exact match filters (always applied regardless of search).
   */
  private applyExactFilters(query: DynamicQuery, filter: UATFilter): DynamicQuery {
    let q = query;

    if (filter.id !== undefined) {
      q = q.where('id', '=', filter.id);
    }

    if (filter.ids !== undefined && filter.ids.length > 0) {
      q = q.where('id', 'in', filter.ids);
    }

    if (filter.uat_key !== undefined) {
      q = q.where('uat_key', '=', filter.uat_key);
    }

    if (filter.uat_code !== undefined) {
      q = q.where('uat_code', '=', filter.uat_code);
    }

    if (filter.county_code !== undefined) {
      q = q.where('county_code', '=', filter.county_code);
    }

    if (filter.region !== undefined) {
      q = q.where('region', '=', filter.region);
    }

    return q;
  }

  /**
   * Applies is_county filter.
   * County-level UATs are identified by:
   * - siruta_code = county_code, OR
   * - county_code = 'B' AND siruta_code = '179132' (Bucharest special case)
   */
  private applyIsCountyFilter(query: DynamicQuery, filter: UATFilter): DynamicQuery {
    if (filter.is_county === undefined) {
      return query;
    }

    // County condition: siruta_code = county_code OR (Bucharest special case)
    const countyCondition = sql`(
      siruta_code = county_code
      OR (county_code = 'B' AND siruta_code = '179132')
    )`;

    if (filter.is_county) {
      // Filter TO counties only
      return query.where(countyCondition);
    } else {
      // Filter OUT counties (non-county UATs)
      return query.where(sql`NOT ${countyCondition}`);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Private Methods - Mapping
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Maps a database row to UAT domain type.
   */
  private mapRowToUAT(row: UATRow): UAT {
    return {
      id: row.id,
      uat_key: row.uat_key,
      uat_code: row.uat_code,
      siruta_code: row.siruta_code,
      name: row.name,
      county_code: row.county_code,
      county_name: row.county_name,
      region: row.region,
      population: row.population,
    };
  }

  /**
   * Maps query results to paginated connection.
   */
  private mapToConnection(rows: UATRow[], limit: number, offset: number): UATConnection {
    const firstRow = rows[0];
    const totalCount =
      firstRow?.total_count !== undefined ? Number.parseInt(firstRow.total_count, 10) : 0;

    const nodes: UAT[] = rows.map((row) => this.mapRowToUAT(row));

    return {
      nodes,
      pageInfo: {
        totalCount,
        hasNextPage: offset + limit < totalCount,
        hasPreviousPage: offset > 0,
      },
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory Function
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates a UATRepository instance.
 */
export const makeUATRepo = (db: BudgetDbClient): UATRepository => {
  return new KyselyUATRepo(db);
};
