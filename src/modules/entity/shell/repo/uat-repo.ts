/**
 * UAT Repository Implementation (Stub)
 *
 * Placeholder implementation for UAT data access.
 * Full implementation will be in separate module.
 */

import { sql } from 'kysely';
import { ok, err, type Result } from 'neverthrow';

import {
  createDatabaseError,
  createTimeoutError,
  isTimeoutError,
  type EntityError,
} from '../../core/errors.js';

import type { UATRepository } from '../../core/ports.js';
import type { UAT } from '../../core/types.js';
import type { BudgetDbClient } from '@/infra/database/client.js';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const QUERY_TIMEOUT_MS = 30_000;

// ─────────────────────────────────────────────────────────────────────────────
// Repository Implementation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Kysely-based UAT Repository (Stub).
 */
class KyselyUATRepo implements UATRepository {
  constructor(private readonly db: BudgetDbClient) {}

  async getById(id: number): Promise<Result<UAT | null, EntityError>> {
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

      return ok({
        id: row.id,
        uat_key: row.uat_key,
        uat_code: row.uat_code,
        siruta_code: row.siruta_code,
        name: row.name,
        county_code: row.county_code,
        county_name: row.county_name,
        region: row.region,
        population: row.population,
      });
    } catch (error) {
      if (isTimeoutError(error)) {
        return err(createTimeoutError('UAT getById query timed out', error));
      }
      return err(createDatabaseError('UAT getById failed', error));
    }
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
