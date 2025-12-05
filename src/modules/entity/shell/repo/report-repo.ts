/**
 * Report Repository Implementation
 *
 * Kysely-based repository for Report data access.
 */

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access -- Kysely dynamic query builder requires type flexibility */
import { sql, type ExpressionBuilder } from 'kysely';
import { ok, err, type Result } from 'neverthrow';

import {
  createDatabaseError,
  createTimeoutError,
  isTimeoutError,
  type EntityError,
} from '../../core/errors.js';
import {
  GQL_TO_DB_REPORT_TYPE,
  type Report,
  type ReportConnection,
  type ReportFilter,
  type ReportSort,
  type DbReportType,
} from '../../core/types.js';

import type { ReportRepository } from '../../core/ports.js';
import type { BudgetDbClient } from '@/infra/database/client.js';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const QUERY_TIMEOUT_MS = 30_000;

/** Valid sort columns */
const VALID_SORT_COLUMNS = new Set(['report_date']);

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Kysely dynamic query builder
type DynamicQuery = any;

interface ReportRow {
  report_id: string;
  entity_cui: string;
  report_type: string;
  main_creditor_cui: string | null;
  report_date: Date;
  reporting_year: number;
  reporting_period: string;
  budget_sector_id: number;
  file_source: string | null;
  download_links: string[] | null;
  import_timestamp: unknown; // Kysely Timestamp type - handled in mapRowToReport
  total_count?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Escapes special characters for ILIKE pattern matching.
 */
function escapeILikePattern(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

/**
 * Converts a Kysely Timestamp or Date to a Date object.
 */
function toDate(value: unknown): Date {
  if (value instanceof Date) {
    return value;
  }
  // Kysely Timestamp type has a toDate() method
  if (typeof value === 'object' && value !== null && 'toDate' in value) {
    return (value as { toDate: () => Date }).toDate();
  }
  // Fallback for string dates
  return new Date(value as string);
}

/**
 * Maps a database row to a Report domain object.
 */
function mapRowToReport(row: ReportRow): Report {
  return {
    report_id: row.report_id,
    entity_cui: row.entity_cui,
    report_type: row.report_type as DbReportType,
    main_creditor_cui: row.main_creditor_cui,
    report_date: row.report_date,
    reporting_year: row.reporting_year,
    reporting_period: row.reporting_period,
    budget_sector_id: row.budget_sector_id,
    file_source: row.file_source,
    download_links: row.download_links ?? [],
    import_timestamp: toDate(row.import_timestamp),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Repository Implementation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Kysely-based Report Repository.
 */
class KyselyReportRepo implements ReportRepository {
  constructor(private readonly db: BudgetDbClient) {}

  async getById(reportId: string): Promise<Result<Report | null, EntityError>> {
    try {
      const row = await this.db
        .selectFrom('reports')
        .select([
          'report_id',
          'entity_cui',
          'report_type',
          'main_creditor_cui',
          'report_date',
          'reporting_year',
          'reporting_period',
          'budget_sector_id',
          'file_source',
          'download_links',
          'import_timestamp',
        ])
        .where('report_id', '=', reportId)
        .executeTakeFirst();

      if (row === undefined) {
        return ok(null);
      }

      return ok(mapRowToReport(row as ReportRow));
    } catch (error) {
      if (isTimeoutError(error)) {
        return err(createTimeoutError('Report getById query timed out', error));
      }
      return err(createDatabaseError('Failed to fetch report by ID', error));
    }
  }

  async getByEntityAndDate(
    entityCui: string,
    reportDate: Date
  ): Promise<Result<Report | null, EntityError>> {
    try {
      const row = await this.db
        .selectFrom('reports')
        .select([
          'report_id',
          'entity_cui',
          'report_type',
          'main_creditor_cui',
          'report_date',
          'reporting_year',
          'reporting_period',
          'budget_sector_id',
          'file_source',
          'download_links',
          'import_timestamp',
        ])
        .where('entity_cui', '=', entityCui)
        .where('report_date', '=', reportDate)
        .executeTakeFirst();

      if (row === undefined) {
        return ok(null);
      }

      return ok(mapRowToReport(row as ReportRow));
    } catch (error) {
      if (isTimeoutError(error)) {
        return err(createTimeoutError('Report getByEntityAndDate query timed out', error));
      }
      return err(createDatabaseError('Failed to fetch report by entity and date', error));
    }
  }

  async list(
    filter: ReportFilter,
    sort: ReportSort | undefined,
    limit: number,
    offset: number
  ): Promise<Result<ReportConnection, EntityError>> {
    try {
      // Set statement timeout
      await sql`SET LOCAL statement_timeout = ${sql.raw(String(QUERY_TIMEOUT_MS))}`.execute(
        this.db
      );

      // Check if we need to join entities table for search
      const needsEntityJoin = filter.search !== undefined && filter.search.trim() !== '';

      // Build base query
      let query: DynamicQuery = this.db
        .selectFrom('reports as r')
        .select([
          'r.report_id',
          'r.entity_cui',
          'r.report_type',
          'r.main_creditor_cui',
          'r.report_date',
          'r.reporting_year',
          'r.reporting_period',
          'r.budget_sector_id',
          'r.file_source',
          'r.download_links',
          'r.import_timestamp',
          sql<string>`COUNT(*) OVER()`.as('total_count'),
        ]);

      // Join entities table if needed for search
      if (needsEntityJoin) {
        query = query.leftJoin('entities as e', 'r.entity_cui', 'e.cui');
      }

      // Apply filters
      query = this.applyFilters(query, filter, needsEntityJoin);

      // Apply sorting
      query = this.applySorting(query, sort);

      // Apply pagination
      query = query.limit(limit).offset(offset);

      const rows: ReportRow[] = await query.execute();

      return ok(this.mapToConnection(rows, limit, offset));
    } catch (error) {
      if (isTimeoutError(error)) {
        return err(createTimeoutError('Report list query timed out', error));
      }
      return err(createDatabaseError('Failed to fetch reports', error));
    }
  }

  async count(filter: ReportFilter): Promise<Result<number, EntityError>> {
    try {
      // Set statement timeout
      await sql`SET LOCAL statement_timeout = ${sql.raw(String(QUERY_TIMEOUT_MS))}`.execute(
        this.db
      );

      // Check if we need to join entities table for search
      const needsEntityJoin = filter.search !== undefined && filter.search.trim() !== '';

      // Build count query
      let query: DynamicQuery = this.db
        .selectFrom('reports as r')
        .select(sql<string>`COUNT(DISTINCT r.report_id)`.as('count'));

      // Join entities table if needed for search
      if (needsEntityJoin) {
        query = query.leftJoin('entities as e', 'r.entity_cui', 'e.cui');
      }

      // Apply filters
      query = this.applyFilters(query, filter, needsEntityJoin);

      const result = await query.executeTakeFirst();
      const countStr: string = result?.count ?? '0';
      const count = Number.parseInt(countStr, 10);

      return ok(count);
    } catch (error) {
      if (isTimeoutError(error)) {
        return err(createTimeoutError('Report count query timed out', error));
      }
      return err(createDatabaseError('Failed to count reports', error));
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Private Helper Methods
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Applies all filters to the query.
   */
  private applyFilters(
    query: DynamicQuery,
    filter: ReportFilter,
    needsEntityJoin: boolean
  ): DynamicQuery {
    // Entity CUI filter
    if (filter.entity_cui !== undefined) {
      query = query.where('r.entity_cui', '=', filter.entity_cui);
    }

    // Reporting year filter
    if (filter.reporting_year !== undefined) {
      query = query.where('r.reporting_year', '=', filter.reporting_year);
    }

    // Reporting period filter
    if (filter.reporting_period !== undefined) {
      query = query.where('r.reporting_period', '=', filter.reporting_period);
    }

    // Report date range filters
    if (filter.report_date_start !== undefined) {
      query = query.where('r.report_date', '>=', filter.report_date_start);
    }

    if (filter.report_date_end !== undefined) {
      query = query.where('r.report_date', '<=', filter.report_date_end);
    }

    // Report type filter (convert from GQL enum to DB value)
    if (filter.report_type !== undefined) {
      const dbReportType = GQL_TO_DB_REPORT_TYPE[filter.report_type];
      query = query.where('r.report_type', '=', dbReportType);
    }

    // Main creditor CUI filter
    if (filter.main_creditor_cui !== undefined) {
      query = query.where('r.main_creditor_cui', '=', filter.main_creditor_cui);
    }

    // Search filter (ILIKE on entity name and download_links)
    if (needsEntityJoin && filter.search !== undefined && filter.search.trim() !== '') {
      const escapedSearch = escapeILikePattern(filter.search.trim());
      const searchPattern = `%${escapedSearch}%`;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Kysely ExpressionBuilder type
      query = query.where((eb: ExpressionBuilder<any, any>) =>
        eb.or([
          eb('e.name', 'ilike', searchPattern),
          eb(sql`COALESCE(array_to_string(r.download_links, ' '), '')`, 'ilike', searchPattern),
        ])
      );
    }

    return query;
  }

  /**
   * Applies sorting to the query.
   * Only 'report_date' is allowed as a sort field; defaults to report_date DESC.
   */
  private applySorting(query: DynamicQuery, sort: ReportSort | undefined): DynamicQuery {
    if (sort !== undefined && VALID_SORT_COLUMNS.has(sort.by)) {
      const direction = sort.order.toLowerCase() as 'asc' | 'desc';
      query = query.orderBy(`r.${sort.by}`, direction);
      // Add tie-breaker
      query = query.orderBy('r.report_id', direction);
    } else {
      // Default sort: report_date DESC, report_id DESC
      query = query.orderBy('r.report_date', 'desc');
      query = query.orderBy('r.report_id', 'desc');
    }

    return query;
  }

  /**
   * Maps query results to paginated connection.
   */
  private mapToConnection(rows: ReportRow[], limit: number, offset: number): ReportConnection {
    const firstRow = rows[0];
    const totalCount =
      firstRow?.total_count !== undefined ? Number.parseInt(firstRow.total_count, 10) : 0;

    const nodes: Report[] = rows.map((row) => mapRowToReport(row));

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
 * Creates a ReportRepository instance.
 */
export const makeReportRepo = (db: BudgetDbClient): ReportRepository => {
  return new KyselyReportRepo(db);
};
