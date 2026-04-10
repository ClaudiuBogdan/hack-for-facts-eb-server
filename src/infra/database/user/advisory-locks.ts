import { sql, type Transaction } from 'kysely';

import type { UserDatabase } from './types.js';
import type { UserDbClient } from '../client.js';

type UserDbConnection = UserDbClient | Transaction<UserDatabase>;

const ADVANCED_MAP_DATASET_LOCK_NAMESPACE = 20_260_409;

function normalizeDatasetIds(datasetIds: readonly string[]): string[] {
  return Array.from(
    new Set(datasetIds.map((datasetId) => datasetId.trim()).filter((datasetId) => datasetId !== ''))
  ).sort((left, right) => left.localeCompare(right));
}

export async function acquireAdvancedMapDatasetTransactionLocks(
  db: UserDbConnection,
  datasetIds: readonly string[]
): Promise<void> {
  // Uploaded dataset / map consistency is serialized per dataset ID using
  // transaction-scoped advisory locks. See:
  // docs/specs/specs-202604091600-advanced-map-dataset-consistency-boundary.md
  const normalizedDatasetIds = normalizeDatasetIds(datasetIds);

  for (const datasetId of normalizedDatasetIds) {
    await sql`
      select pg_advisory_xact_lock(
        ${ADVANCED_MAP_DATASET_LOCK_NAMESPACE},
        hashtext(${datasetId})
      )
    `.execute(db);
  }
}
