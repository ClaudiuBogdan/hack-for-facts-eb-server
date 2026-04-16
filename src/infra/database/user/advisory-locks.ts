import { sql, type Transaction } from 'kysely';

import type { UserDatabase } from './types.js';
import type { UserDbClient } from '../client.js';

type UserDbConnection = UserDbClient | Transaction<UserDatabase>;

const ADVANCED_MAP_DATASET_LOCK_NAMESPACE = 20_260_409;
const LEARNING_PROGRESS_AUTO_REVIEW_REUSE_LOCK_NAMESPACE = 20_260_416;

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

function normalizeLearningProgressAutoReviewReuseIdentity(input: {
  recordKey: string;
  interactionId: string;
  entityCui: string;
}): string {
  return [input.recordKey.trim(), input.interactionId.trim(), input.entityCui.trim()].join(
    '\u0000'
  );
}

export async function acquireLearningProgressAutoReviewReuseTransactionLock(
  db: UserDbConnection,
  input: {
    recordKey: string;
    interactionId: string;
    entityCui: string;
  }
): Promise<void> {
  // Exact-key/entity auto-review reuse is serialized with human reviews using
  // transaction-scoped advisory locks so precedent lookup and review writes
  // observe a single authoritative ordering without widening isolation.
  const normalizedIdentity = normalizeLearningProgressAutoReviewReuseIdentity(input);

  await sql`
    select pg_advisory_xact_lock(
      ${LEARNING_PROGRESS_AUTO_REVIEW_REUSE_LOCK_NAMESPACE},
      hashtext(${normalizedIdentity})
    )
  `.execute(db);
}
