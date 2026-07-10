/**
 * INS Dataset Request Repository
 *
 * Writes to the server-owned user database (the INS domain tables are read-only).
 */

import { err, ok, type Result } from 'neverthrow';

import { createDatabaseError, type InsError } from '../../core/errors.js';

import type { InsDatasetRequest, InsDatasetRequestInput } from '../../core/dataset-requests.js';
import type {
  InsDatasetCatalogReader,
  InsDatasetRequestRepository,
  InsRepository,
} from '../../core/ports.js';
import type { UserDbClient } from '@/infra/database/client.js';

/**
 * `returning()` hands back the column's `ColumnType` rather than its select
 * type, so `created_at` arrives typed as `Timestamp` and must be narrowed.
 */
const toDate = (value: unknown): Date => (value instanceof Date ? value : new Date(String(value)));

class KyselyInsDatasetRequestRepo implements InsDatasetRequestRepository {
  constructor(private readonly db: UserDbClient) {}

  async create(input: InsDatasetRequestInput): Promise<Result<InsDatasetRequest, InsError>> {
    try {
      const row = await this.db
        .insertInto('ins_dataset_requests')
        .values({
          dataset_code: input.dataset_code,
          siruta: input.siruta ?? null,
          contact_email: input.contact_email ?? null,
          note: input.note ?? null,
          clerk_user_id: input.clerk_user_id ?? null,
        })
        .returning(['id', 'dataset_code', 'siruta', 'created_at'])
        .executeTakeFirstOrThrow();

      return ok({
        id: row.id,
        dataset_code: row.dataset_code,
        siruta: row.siruta,
        created_at: toDate(row.created_at),
      });
    } catch (error) {
      return err(createDatabaseError('INS createDatasetRequest failed', error));
    }
  }
}

export const makeInsDatasetRequestRepo = (db: UserDbClient): InsDatasetRequestRepository =>
  new KyselyInsDatasetRequestRepo(db);

/**
 * Backs {@link InsDatasetCatalogReader} with `getDatasetByCode`, which reads the
 * full `matrices` catalog (not `v_matrices`), so CATALOG_ONLY codes resolve.
 * Pass the cache-wrapped repo so the lookup is served from Redis.
 */
export const makeInsDatasetCatalogReader = (insRepo: InsRepository): InsDatasetCatalogReader => ({
  datasetExists: async (code) => {
    const result = await insRepo.getDatasetByCode(code);
    return result.map((dataset) => dataset !== null);
  },
});
