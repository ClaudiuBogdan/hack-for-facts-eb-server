/**
 * Entity Repository Implementation
 *
 * Kysely-based implementation with pg_trgm search support.
 */

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-return -- Kysely dynamic query builder requires type flexibility */
import { sql } from 'kysely';
import { ok, err, type Result } from 'neverthrow';

import {
  createDatabaseError,
  createTimeoutError,
  isTimeoutError,
  type EntityError,
} from '../../core/errors.js';

import type { EntityRepository } from '../../core/ports.js';
import type { Entity, EntityConnection, EntityFilter, DbReportType } from '../../core/types.js';
import type { BudgetDbClient } from '@/infra/database/client.js';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const SIMILARITY_THRESHOLD_VALUE = 0.1;
const QUERY_TIMEOUT_MS = 30_000;

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Raw row from entities table.
 * Note: last_updated is typed as unknown because Kysely returns a Timestamp object.
 */
interface EntityRow {
  cui: string;
  name: string;
  entity_type: string | null;
  default_report_type: DbReportType | null;
  uat_id: number | null;
  is_uat: boolean;
  address: string | null;
  last_updated: unknown;
  main_creditor_1_cui: string | null;
  main_creditor_2_cui: string | null;
  total_count?: string;
  relevance?: number;
}

/**
 * Kysely dynamic query type.
 */
type DynamicQuery = any;

// ─────────────────────────────────────────────────────────────────────────────
// Repository Implementation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Kysely-based Entity Repository.
 */
class KyselyEntityRepo implements EntityRepository {
  constructor(private readonly db: BudgetDbClient) {}

  async getById(cui: string): Promise<Result<Entity | null, EntityError>> {
    try {
      const row = await this.db
        .selectFrom('entities')
        .select([
          'cui',
          'name',
          'entity_type',
          'default_report_type',
          'uat_id',
          'is_uat',
          'address',
          'last_updated',
          'main_creditor_1_cui',
          'main_creditor_2_cui',
        ])
        .where('cui', '=', cui)
        .executeTakeFirst();

      if (row === undefined) {
        return ok(null);
      }

      return ok(this.mapRowToEntity(row as unknown as EntityRow));
    } catch (error) {
      return this.handleQueryError(error, 'getById');
    }
  }

  async getByIds(cuis: string[]): Promise<Result<Map<string, Entity>, EntityError>> {
    if (cuis.length === 0) {
      return ok(new Map());
    }

    try {
      const rows = await this.db
        .selectFrom('entities')
        .select([
          'cui',
          'name',
          'entity_type',
          'default_report_type',
          'uat_id',
          'is_uat',
          'address',
          'last_updated',
          'main_creditor_1_cui',
          'main_creditor_2_cui',
        ])
        .where('cui', 'in', cuis)
        .execute();

      const map = new Map<string, Entity>();
      for (const row of rows) {
        map.set(row.cui, this.mapRowToEntity(row as unknown as EntityRow));
      }

      return ok(map);
    } catch (error) {
      return this.handleQueryError(error, 'getByIds');
    }
  }

  async getAll(
    filter: EntityFilter,
    limit: number,
    offset: number
  ): Promise<Result<EntityConnection, EntityError>> {
    try {
      // Set statement timeout
      await sql`SET LOCAL statement_timeout = ${sql.raw(String(QUERY_TIMEOUT_MS))}`.execute(
        this.db
      );

      // Build and execute query
      let query: DynamicQuery = this.db
        .selectFrom('entities')
        .select([
          'cui',
          'name',
          'entity_type',
          'default_report_type',
          'uat_id',
          'is_uat',
          'address',
          'last_updated',
          'main_creditor_1_cui',
          'main_creditor_2_cui',
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

      // Apply pagination
      query = query.limit(limit).offset(offset);

      const rows: EntityRow[] = await query.execute();

      const firstRow = rows[0];
      const totalCount =
        rows.length > 0 && firstRow?.total_count !== undefined
          ? Number.parseInt(firstRow.total_count, 10)
          : 0;

      const entities = rows.map((row) => this.mapRowToEntity(row));

      return ok({
        nodes: entities,
        pageInfo: {
          totalCount,
          hasNextPage: offset + limit < totalCount,
          hasPreviousPage: offset > 0,
        },
      });
    } catch (error) {
      return this.handleQueryError(error, 'getAll');
    }
  }

  async getChildren(cui: string): Promise<Result<Entity[], EntityError>> {
    try {
      const rows = await this.db
        .selectFrom('entities')
        .select([
          'cui',
          'name',
          'entity_type',
          'default_report_type',
          'uat_id',
          'is_uat',
          'address',
          'last_updated',
          'main_creditor_1_cui',
          'main_creditor_2_cui',
        ])
        .where((eb) =>
          eb.or([eb('main_creditor_1_cui', '=', cui), eb('main_creditor_2_cui', '=', cui)])
        )
        .execute();

      return ok(rows.map((row) => this.mapRowToEntity(row as unknown as EntityRow)));
    } catch (error) {
      return this.handleQueryError(error, 'getChildren');
    }
  }

  async getParents(cui: string): Promise<Result<Entity[], EntityError>> {
    try {
      // First get the entity to find its main_creditor CUIs
      const entity = await this.db
        .selectFrom('entities')
        .select(['main_creditor_1_cui', 'main_creditor_2_cui'])
        .where('cui', '=', cui)
        .executeTakeFirst();

      if (entity === undefined) {
        return ok([]);
      }

      const parentCuis: string[] = [];
      if (entity.main_creditor_1_cui !== null) {
        parentCuis.push(entity.main_creditor_1_cui);
      }
      if (entity.main_creditor_2_cui !== null) {
        parentCuis.push(entity.main_creditor_2_cui);
      }

      if (parentCuis.length === 0) {
        return ok([]);
      }

      const rows = await this.db
        .selectFrom('entities')
        .select([
          'cui',
          'name',
          'entity_type',
          'default_report_type',
          'uat_id',
          'is_uat',
          'address',
          'last_updated',
          'main_creditor_1_cui',
          'main_creditor_2_cui',
        ])
        .where('cui', 'in', parentCuis)
        .execute();

      return ok(rows.map((row) => this.mapRowToEntity(row as unknown as EntityRow)));
    } catch (error) {
      return this.handleQueryError(error, 'getParents');
    }
  }

  async getCountyEntity(countyCode: string | null): Promise<Result<Entity | null, EntityError>> {
    if (countyCode === null) {
      return ok(null);
    }

    try {
      const row = await this.db
        .selectFrom('entities as e')
        .innerJoin('uats as u', 'e.uat_id', 'u.id')
        .select([
          'e.cui',
          'e.name',
          'e.entity_type',
          'e.default_report_type',
          'e.uat_id',
          'e.is_uat',
          'e.address',
          'e.last_updated',
          'e.main_creditor_1_cui',
          'e.main_creditor_2_cui',
        ])
        .where('u.county_code', '=', countyCode)
        .where((eb) =>
          eb.or([eb('e.entity_type', '=', 'admin_county_council'), eb('e.cui', '=', '179132')])
        )
        .executeTakeFirst();

      if (row === undefined) {
        return ok(null);
      }

      return ok(this.mapRowToEntity(row as unknown as EntityRow));
    } catch (error) {
      return this.handleQueryError(error, 'getCountyEntity');
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

    // Add relevance column
    const relevance = sql<number>`GREATEST(
      similarity('cui:' || cui || ' ' || name, ${searchTerm}),
      similarity(COALESCE(address, ''), ${searchTerm})
    )`;

    // FIXME: Added deterministic tie-breakers (name, cui) to match prod API ordering.
    // When multiple entities have the same relevance score, the order was non-deterministic.
    // Review if this matches prod behavior exactly.
    return query
      .select(relevance.as('relevance'))
      .where(
        sql`GREATEST(
          similarity('cui:' || cui || ' ' || name, ${searchTerm}),
          similarity(COALESCE(address, ''), ${searchTerm})
        ) > ${SIMILARITY_THRESHOLD_VALUE}`
      )
      .orderBy(
        sql`CASE WHEN 'cui:' || cui || ' ' || name ILIKE ${searchTerm + '%'} THEN 0 ELSE 1 END`,
        'asc'
      )
      .orderBy(relevance, 'desc')
      .orderBy('name', 'asc')
      .orderBy('cui', 'asc');
  }

  /**
   * Applies ILIKE filters when search is not present.
   */
  private applyRegularFilters(query: DynamicQuery, filter: EntityFilter): DynamicQuery {
    let q = query;

    if (filter.name !== undefined && filter.name.trim() !== '') {
      q = q.where('name', 'ilike', `%${filter.name}%`);
    }

    if (filter.address !== undefined && filter.address.trim() !== '') {
      q = q.where('address', 'ilike', `%${filter.address}%`);
    }

    // Default ordering when no search
    q = q.orderBy('cui', 'asc');

    return q;
  }

  /**
   * Applies exact match filters (always applied regardless of search).
   */
  private applyExactFilters(query: DynamicQuery, filter: EntityFilter): DynamicQuery {
    let q = query;

    if (filter.cui !== undefined) {
      q = q.where('cui', '=', filter.cui);
    }

    if (filter.cuis !== undefined && filter.cuis.length > 0) {
      q = q.where('cui', 'in', filter.cuis);
    }

    if (filter.parents !== undefined && filter.parents.length > 0) {
      q = q.where((eb: any) =>
        eb.or([
          eb('main_creditor_1_cui', 'in', filter.parents),
          eb('main_creditor_2_cui', 'in', filter.parents),
        ])
      );
    }

    if (filter.entity_type !== undefined) {
      q = q.where('entity_type', '=', filter.entity_type);
    }

    if (filter.uat_id !== undefined) {
      q = q.where('uat_id', '=', filter.uat_id);
    }

    if (filter.is_uat !== undefined) {
      q = q.where('is_uat', '=', filter.is_uat);
    }

    return q;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Private Methods - Helpers
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Maps a database row to Entity domain type.
   */
  private mapRowToEntity(row: EntityRow): Entity {
    // Convert Kysely Timestamp to Date or null
    let lastUpdated: Date | null = null;
    if (row.last_updated !== null && row.last_updated !== undefined) {
      if (row.last_updated instanceof Date) {
        lastUpdated = row.last_updated;
      } else if (typeof row.last_updated === 'object' && 'toISOString' in row.last_updated) {
        // Handle Kysely Timestamp object
        lastUpdated = new Date((row.last_updated as { toISOString: () => string }).toISOString());
      }
    }

    return {
      cui: row.cui,
      name: row.name,
      entity_type: row.entity_type,
      default_report_type: row.default_report_type ?? 'Executie bugetara detaliata',
      uat_id: row.uat_id,
      is_uat: row.is_uat,
      address: row.address,
      last_updated: lastUpdated,
      main_creditor_1_cui: row.main_creditor_1_cui,
      main_creditor_2_cui: row.main_creditor_2_cui,
    };
  }

  /**
   * Handles query errors and converts to domain errors.
   */
  private handleQueryError(error: unknown, operation: string): Result<never, EntityError> {
    if (isTimeoutError(error)) {
      return err(createTimeoutError(`Entity ${operation} query timed out`, error));
    }
    return err(createDatabaseError(`Entity ${operation} failed`, error));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory Function
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates an EntityRepository instance.
 */
export const makeEntityRepo = (db: BudgetDbClient): EntityRepository => {
  return new KyselyEntityRepo(db);
};
