import { execSync } from 'node:child_process';

import { sql } from 'kysely';

import type { UserDbClient } from '@/infra/database/client.js';

export const isDockerAvailable = (): boolean => {
  try {
    execSync('docker info', { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
};

export const truncatePlatformTables = async (db: UserDbClient): Promise<void> => {
  await sql`
    TRUNCATE TABLE
      notification_audit_log,
      notification_digest_members,
      notification_delivery_attempts,
      notification_deliveries,
      notification_digest_batches,
      notification_channel_destinations,
      logical_notifications,
      notification_channel_preferences,
      notification_global_preferences,
      notification_subscriptions,
      notification_source_watermarks,
      notification_events
    RESTART IDENTITY CASCADE
  `.execute(db);
};

export const seedContractEvent = async (db: UserDbClient, eventId: string): Promise<void> => {
  const now = new Date('2026-07-10T09:00:00.000Z');
  await db
    .insertInto('notification_events')
    .values({
      id: eventId,
      source: `seed-${eventId}`,
      event_type: 'contract.seed',
      event_schema_version: 1,
      occurrence_key: eventId,
      occurred_at: now,
      facts: {},
      payload_hash: `hash-${eventId}`,
      correlation_id: null,
      causation_id: null,
      stream_key: null,
      stream_sequence: null,
      status: 'resolved',
      resolution_cursor: null,
      claim_token: null,
      claim_expires_at: null,
      created_at: now,
      updated_at: now,
      resolved_at: now,
      retention_expires_at: new Date('2028-07-10T09:00:00.000Z'),
    })
    .onConflict((conflict) => conflict.column('id').doNothing())
    .execute();
};

export const seedContractLogical = async (
  db: UserDbClient,
  input: { id: string; eventId: string; kindId: string; userId: string }
): Promise<void> => {
  const now = new Date('2026-07-10T09:00:00.000Z');
  await db
    .insertInto('logical_notifications')
    .values({
      id: input.id,
      event_id: input.eventId,
      kind_id: input.kindId,
      kind_version: 1,
      user_id: input.userId,
      eligibility_reason: 'contract-seed',
      locale: 'ro',
      recipient_facts: null,
      inbox_template_id: 'contract-seed',
      inbox_template_version: 'v1',
      inbox_title: 'Contract seed',
      inbox_body: 'Contract seed',
      inbox_action_url: null,
      inbox_visible: true,
      read_at: null,
      archived_at: null,
      stream_key: null,
      stream_sequence: null,
      created_at: now,
      retention_expires_at: new Date('2028-07-10T09:00:00.000Z'),
    })
    .onConflict((conflict) => conflict.column('id').doNothing())
    .execute();
};
