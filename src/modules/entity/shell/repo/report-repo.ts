/**
 * Report Repository Implementation (Stub)
 *
 * Placeholder implementation for Report data access.
 * Full implementation will be in separate module.
 */

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access -- Kysely dynamic query builder requires type flexibility */
import { sql } from 'kysely';
import { ok, err, type Result } from 'neverthrow';

import {
  createDatabaseError,
  createTimeoutError,
  isTimeoutError,
  type EntityError,
} from '../../core/errors.js';

import type { ReportRepository } from '../../core/ports.js';
import type {
  Report,
  ReportConnection,
  ReportFilter,
  ReportSort,
  GqlReportType,
} from '../../core/types.js';
import type { BudgetDbClient } from '@/infra/database/client.js';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const QUERY_TIMEOUT_MS = 30_000;

/** Map GraphQL ReportType to DB value */
const GQL_TO_DB_REPORT_TYPE: Record<GqlReportType, string> = {
  PRINCIPAL_AGGREGATED: 'Executie bugetara agregata la nivel de ordonator principal',
  SECONDARY_AGGREGATED: 'Executie bugetara agregata la nivel de ordonator secundar',
  DETAILED: 'Executie bugetara detaliata',
};

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
  total_count?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Repository Implementation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Kysely-based Report Repository (Stub).
 */
class KyselyReportRepo implements ReportRepository {
  constructor(private readonly db: BudgetDbClient) {}

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

      let query: DynamicQuery = this.db
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
          sql<string>`COUNT(*) OVER()`.as('total_count'),
        ])
        .where('entity_cui', '=', filter.entity_cui);

      // Apply filters
      if (filter.year !== undefined) {
        query = query.where('reporting_year', '=', filter.year);
      }

      if (filter.period !== undefined) {
        query = query.where('reporting_period', '=', filter.period);
      }

      if (filter.type !== undefined) {
        const dbType = GQL_TO_DB_REPORT_TYPE[filter.type];
        query = query.where('report_type', '=', dbType);
      }

      if (filter.main_creditor_cui !== undefined) {
        query = query.where('main_creditor_cui', '=', filter.main_creditor_cui);
      }

      // Apply sorting
      if (sort !== undefined) {
        const sortField = sort.by as keyof ReportRow;
        query = query.orderBy(sortField, sort.order.toLowerCase());
      } else {
        query = query.orderBy('report_date', 'desc');
      }

      // Apply pagination
      query = query.limit(limit).offset(offset);

      const rows: ReportRow[] = await query.execute();

      const firstRow = rows[0];
      const totalCount =
        rows.length > 0 && firstRow?.total_count !== undefined
          ? Number.parseInt(firstRow.total_count, 10)
          : 0;

      const nodes: Report[] = rows.map((row) => ({
        report_id: row.report_id,
        entity_cui: row.entity_cui,
        report_type: row.report_type as Report['report_type'],
        main_creditor_cui: row.main_creditor_cui,
        report_date: row.report_date,
        reporting_year: row.reporting_year,
        reporting_period: row.reporting_period,
        budget_sector_id: row.budget_sector_id,
        file_source: row.file_source,
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
      if (isTimeoutError(error)) {
        return err(createTimeoutError('Report list query timed out', error));
      }
      return err(createDatabaseError('Report list failed', error));
    }
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
