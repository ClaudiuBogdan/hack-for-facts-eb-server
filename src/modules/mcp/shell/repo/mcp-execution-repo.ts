/**
 * MCP Execution Repository Adapter
 *
 * Provides yearly snapshot totals for entities using the existing database.
 */

import { Decimal } from 'decimal.js';
import { sql } from 'kysely';
import { ok, err, type Result } from 'neverthrow';

import { databaseError, timeoutError, type McpError } from '../../core/errors.js';

import type { McpExecutionRepo, YearlySnapshotTotals } from '../../core/ports.js';
import type { BudgetDbClient } from '@/infra/database/client.js';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Query timeout in milliseconds (10 seconds) */
const QUERY_TIMEOUT_MS = 10_000;

/** Default report type for aggregated data */
const DEFAULT_REPORT_TYPE = 'Executie bugetara agregata la nivel de ordonator principal';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface RawTotalsRow {
  total_income: string | null;
  total_expenses: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Implementation
// ─────────────────────────────────────────────────────────────────────────────

class KyselyMcpExecutionRepo implements McpExecutionRepo {
  constructor(private readonly db: BudgetDbClient) {}

  async getYearlySnapshotTotals(
    entityCui: string,
    year: number,
    reportType?: string
  ): Promise<Result<YearlySnapshotTotals, McpError>> {
    try {
      // Set statement timeout
      await sql`SET LOCAL statement_timeout = ${sql.raw(String(QUERY_TIMEOUT_MS))}`.execute(
        this.db
      );

      const effectiveReportType = reportType ?? DEFAULT_REPORT_TYPE;

      // Query to get total income and expenses for the entity in the given year
      // Uses conditional aggregation to separate income (vn) from expenses (ch)
      // Use raw SQL for the entire query to avoid Kysely type issues with report_type enum
      const result = await sql<RawTotalsRow>`
        SELECT
          COALESCE(SUM(CASE WHEN account_category = 'vn' THEN ytd_amount ELSE 0 END), 0) AS total_income,
          COALESCE(SUM(CASE WHEN account_category = 'ch' THEN ytd_amount ELSE 0 END), 0) AS total_expenses
        FROM executionlineitems
        WHERE entity_cui = ${entityCui}
          AND year = ${year}
          AND report_type = ${effectiveReportType}
          AND is_yearly = true
      `.execute(this.db);

      const row = result.rows[0];
      if (row === undefined) {
        // No data found - return zeros
        return ok({
          totalIncome: new Decimal(0),
          totalExpenses: new Decimal(0),
        });
      }

      return ok({
        totalIncome: new Decimal(row.total_income ?? '0'),
        totalExpenses: new Decimal(row.total_expenses ?? '0'),
      });
    } catch (error) {
      // Check for timeout errors
      if (error instanceof Error) {
        const msg = error.message.toLowerCase();
        if (msg.includes('timeout') || msg.includes('canceling statement')) {
          return err(timeoutError());
        }
      }
      return err(databaseError());
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates an MCP execution repository.
 */
export const makeMcpExecutionRepo = (db: BudgetDbClient): McpExecutionRepo => {
  return new KyselyMcpExecutionRepo(db);
};
