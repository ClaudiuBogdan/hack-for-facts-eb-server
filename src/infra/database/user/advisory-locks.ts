import { sql, type Transaction } from 'kysely';

import type { UserDatabase } from './types.js';
import type { UserDbClient } from '../client.js';

type UserDbConnection = UserDbClient | Transaction<UserDatabase>;

const ADVANCED_MAP_DATASET_LOCK_NAMESPACE = 20_260_409;
const LEARNING_PROGRESS_AUTO_REVIEW_REUSE_LOCK_NAMESPACE = 20_260_416;
const CAMPAIGN_ENTITY_CONFIG_LOCK_NAMESPACE = 20_260_418;

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

function normalizeLearningProgressAutoReviewReuseIdentity(input: { recordKey: string }): string {
  return input.recordKey.trim();
}

export async function acquireLearningProgressAutoReviewReuseTransactionLock(
  db: UserDbConnection,
  input: { recordKey: string }
): Promise<void> {
  // Auto-review reuse is serialized per logical record key so pending syncs,
  // human reviews, and auto-approvals observe a single authoritative ordering
  // even if the row's entity-scoped identity changes before the locked reread.
  const normalizedIdentity = normalizeLearningProgressAutoReviewReuseIdentity(input);

  await sql`
    select pg_advisory_xact_lock(
      ${LEARNING_PROGRESS_AUTO_REVIEW_REUSE_LOCK_NAMESPACE},
      hashtext(${normalizedIdentity})
    )
  `.execute(db);
}

function normalizeCampaignEntityConfigIdentity(input: {
  campaignKey: string;
  entityCui: string;
}): string {
  return `${input.campaignKey.trim()}::${input.entityCui.trim()}`;
}

export async function acquireCampaignEntityConfigTransactionLock(
  db: UserDbConnection,
  input: { campaignKey: string; entityCui: string }
): Promise<void> {
  const normalizedIdentity = normalizeCampaignEntityConfigIdentity(input);

  await sql`
    select pg_advisory_xact_lock(
      ${CAMPAIGN_ENTITY_CONFIG_LOCK_NAMESPACE},
      hashtext(${normalizedIdentity})
    )
  `.execute(db);
}
