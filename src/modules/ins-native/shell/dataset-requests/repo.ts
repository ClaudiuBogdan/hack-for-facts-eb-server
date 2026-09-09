/**
 * INS dataset-request adapters: the Kysely repository over the server-owned
 * user database (the write side; the INS domain tables are read-only) and the
 * catalog reader over the native Chronos repository.
 */

import { err, ok, type Result } from 'neverthrow';

import {
  createDatabaseError,
  createTimeoutError,
  type DatasetRequestError,
} from '../../core/dataset-requests/errors.js';

import type {
  InsDatasetCatalogReader,
  InsDatasetRequestRepository,
} from '../../core/dataset-requests/ports.js';
import type {
  InsDatasetRequest,
  InsDatasetRequestInput,
} from '../../core/dataset-requests/types.js';
import type { InsReadSession } from '../repo/read-session.js';
import type { UserDbClient } from '@/infra/database/client.js';
import type { ApiError } from '@/modules/shared/index.js';

/**
 * `returning()` hands back the column's `ColumnType` rather than its select
 * type, so `created_at` arrives typed as `Timestamp` and must be narrowed.
 */
const toDate = (value: unknown): Date => (value instanceof Date ? value : new Date(String(value)));

class KyselyInsDatasetRequestRepo implements InsDatasetRequestRepository {
  constructor(private readonly db: UserDbClient) {}

  async create(
    input: InsDatasetRequestInput
  ): Promise<Result<InsDatasetRequest, DatasetRequestError>> {
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

const toRequestError = (error: ApiError, what: string): DatasetRequestError =>
  error.type === 'Timeout'
    ? createTimeoutError(`INS ${what} timed out`, error)
    : createDatabaseError(`INS ${what} failed: ${error.message}`, error);

/**
 * Backs {@link InsDatasetCatalogReader} with the native repository's
 * `getDataset`, whose FROM clause is `ins.datasets` with LEFT JOINs only
 * (`publication.ts` `datasetPublicationFrom`), so every catalog row resolves
 * whether or not its facts are loaded — the legacy reader's `matrices` (not
 * `v_matrices`) contract. Each check opens and closes one bounded read
 * session; there is no shared cache in front of it (the legacy reader went
 * through the Redis-wrapped repo until slice 1 commit 2 removed the wrappers).
 */
export const makeInsNativeDatasetCatalogReader = (
  createReadSession: () => InsReadSession
): InsDatasetCatalogReader => ({
  datasetExists: async (code) => {
    const session = createReadSession();
    try {
      const repo = await session.getRepo();
      if (repo.isErr()) return err(toRequestError(repo.error, 'catalog session'));
      const dataset = await repo.value.getDataset(code);
      if (dataset.isErr()) return err(toRequestError(dataset.error, 'catalog lookup'));
      return ok(dataset.value !== null);
    } finally {
      await session.close();
    }
  },
});
