import fs from 'node:fs';
import path from 'node:path';

import { PostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { describe, expect, it } from 'vitest';

import { dockerAvailable } from './setup.js';

const LEGACY_MAIN_USER_SCHEMA = `
CREATE TABLE shortlinks (
  id BIGSERIAL PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  user_ids TEXT[] NOT NULL,
  original_url TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  access_count INTEGER NOT NULL DEFAULT 0,
  last_access_at TIMESTAMPTZ,
  metadata JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX idx_shortlinks_user_ids ON shortlinks USING GIN(user_ids);
CREATE INDEX idx_shortlinks_code ON shortlinks(code);
CREATE INDEX idx_shortlinks_original_url ON shortlinks(original_url);
CREATE INDEX idx_shortlinks_created_at ON shortlinks(created_at);

CREATE TABLE notifications (
  id UUID PRIMARY KEY,
  user_id TEXT NOT NULL,
  entity_cui VARCHAR(20) NULL,
  notification_type VARCHAR(50) NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  config JSONB,
  hash TEXT UNIQUE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_notifications_user_active ON notifications(user_id) WHERE is_active = TRUE;
CREATE INDEX idx_notifications_entity ON notifications(entity_cui) WHERE is_active = TRUE;
CREATE INDEX idx_notifications_type_active ON notifications(notification_type) WHERE is_active = TRUE;
CREATE INDEX idx_notifications_hash ON notifications(hash);

CREATE TABLE unsubscribetokens (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  notification_id UUID NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '1 year'),
  used_at TIMESTAMPTZ
);

CREATE INDEX idx_unsubscribe_tokens_user ON unsubscribetokens(user_id) WHERE used_at IS NULL;
CREATE INDEX idx_unsubscribe_tokens_expires ON unsubscribetokens(expires_at) WHERE used_at IS NULL;
CREATE INDEX idx_unsubscribe_tokens_notification ON unsubscribetokens(notification_id);

CREATE TABLE notificationdeliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  notification_id UUID NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  period_key TEXT NOT NULL,
  delivery_key TEXT UNIQUE NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  unsubscribe_token TEXT REFERENCES unsubscribetokens(token) ON DELETE SET NULL,
  rendered_subject TEXT,
  rendered_html TEXT,
  rendered_text TEXT,
  content_hash TEXT,
  template_name TEXT,
  template_version TEXT,
  to_email TEXT,
  resend_email_id TEXT,
  last_error TEXT,
  attempt_count INT NOT NULL DEFAULT 0,
  last_attempt_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE notificationdeliveries
ADD CONSTRAINT deliveries_status_check
CHECK (status IN (
  'pending', 'sending', 'sent', 'delivered',
  'failed_transient', 'failed_permanent',
  'suppressed', 'skipped_unsubscribed', 'skipped_no_email'
));

CREATE UNIQUE INDEX idx_deliveries_delivery_key_unique
ON notificationdeliveries(delivery_key);

CREATE INDEX idx_deliveries_user_period ON notificationdeliveries(user_id, period_key);
CREATE INDEX idx_deliveries_created_at ON notificationdeliveries(created_at DESC);
CREATE INDEX idx_deliveries_notification ON notificationdeliveries(notification_id);
CREATE INDEX idx_deliveries_status_pending
ON notificationdeliveries(status) WHERE status IN ('pending', 'failed_transient');
CREATE INDEX idx_deliveries_sending_stuck
ON notificationdeliveries(last_attempt_at) WHERE status = 'sending';
CREATE INDEX idx_deliveries_resend_email_id
ON notificationdeliveries(resend_email_id) WHERE resend_email_id IS NOT NULL;

CREATE TABLE learningprogress (
  user_id TEXT PRIMARY KEY,
  events JSONB NOT NULL DEFAULT '[]'::jsonb,
  last_event_at TIMESTAMPTZ,
  event_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE resendwebhookevents (
  id BIGSERIAL PRIMARY KEY,
  svix_id TEXT UNIQUE NOT NULL,
  event_type TEXT NOT NULL,
  resend_email_id TEXT NOT NULL,
  delivery_id UUID,
  payload JSONB NOT NULL,
  processed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_resend_events_email_id ON resendwebhookevents(resend_email_id);
CREATE INDEX idx_resend_events_delivery_id
ON resendwebhookevents(delivery_id)
WHERE delivery_id IS NOT NULL;
CREATE INDEX idx_resend_events_unprocessed
ON resendwebhookevents(created_at)
WHERE processed_at IS NULL;

CREATE TABLE advancedmapanalyticsmaps (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NULL,
  visibility TEXT NOT NULL DEFAULT 'private',
  public_id TEXT UNIQUE,
  last_snapshot JSONB NULL,
  last_snapshot_id TEXT NULL,
  snapshot_count INT NOT NULL DEFAULT 0,
  public_view_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ NULL
);

ALTER TABLE advancedmapanalyticsmaps
ADD CONSTRAINT advanced_map_analytics_maps_visibility_check
CHECK (visibility IN ('private', 'public'));

ALTER TABLE advancedmapanalyticsmaps
ADD CONSTRAINT advanced_map_analytics_maps_snapshot_count_check
CHECK (snapshot_count >= 0);

ALTER TABLE advancedmapanalyticsmaps
ADD CONSTRAINT advanced_map_analytics_maps_public_view_count_check
CHECK (public_view_count >= 0);

CREATE INDEX idx_advanced_map_analytics_maps_user_updated
ON advancedmapanalyticsmaps(user_id, updated_at DESC)
WHERE deleted_at IS NULL;

CREATE INDEX idx_advanced_map_analytics_maps_public_id
ON advancedmapanalyticsmaps(public_id)
WHERE public_id IS NOT NULL AND deleted_at IS NULL;

CREATE TABLE advancedmapanalyticssnapshots (
  id TEXT PRIMARY KEY,
  map_id TEXT NOT NULL REFERENCES advancedmapanalyticsmaps(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NULL,
  snapshot JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_advanced_map_analytics_snapshots_map_created_at
ON advancedmapanalyticssnapshots(map_id, created_at DESC);
`;

const CURRENT_USER_SCHEMA = fs.readFileSync(
  path.join(process.cwd(), 'src/infra/database/user/schema.sql'),
  'utf-8'
);

const UNIFIED_PRODUCTION_MIGRATION = fs.readFileSync(
  path.join(
    process.cwd(),
    'src/infra/database/user/migrations/202604021100_unify_production_user_schema.sql'
  ),
  'utf-8'
);

interface StartedTestDatabase {
  connectionString: string;
  stop: () => Promise<void>;
}

interface ColumnSnapshotRow {
  table_name: string;
  column_name: string;
  data_type: string;
  udt_name: string;
  is_nullable: 'YES' | 'NO';
  column_default: string | null;
  character_maximum_length: number | null;
}

interface ConstraintSnapshotRow {
  table_name: string;
  conname: string;
  contype: string;
  definition: string;
}

interface IndexSnapshotRow {
  tablename: string;
  indexname: string;
  indexdef: string;
}

interface SequenceSnapshotRow {
  sequencename: string;
  data_type: string;
  start_value: string;
  min_value: string;
  max_value: string;
  increment_by: string;
  cycle: boolean;
}

interface TableCommentRow {
  table_name: string;
  comment: string | null;
}

interface SchemaSnapshot {
  tables: string[];
  columns: ColumnSnapshotRow[];
  constraints: ConstraintSnapshotRow[];
  indexes: IndexSnapshotRow[];
  sequences: SequenceSnapshotRow[];
  tableComments: TableCommentRow[];
}

async function startTestDatabase(): Promise<StartedTestDatabase> {
  const container = await new PostgreSqlContainer('postgres:16-alpine').start();
  return {
    connectionString: container.getConnectionUri(),
    stop: async () => {
      await container.stop();
    },
  };
}

async function withPgClient<T>(
  connectionString: string,
  callback: (client: pg.Client) => Promise<T>
): Promise<T> {
  const client = new pg.Client({ connectionString });
  await client.connect();

  try {
    return await callback(client);
  } finally {
    await client.end();
  }
}

async function getSchemaSnapshot(client: pg.Client): Promise<SchemaSnapshot> {
  const tables = await client.query<{ tablename: string }>(
    `
      SELECT tablename
      FROM pg_tables
      WHERE schemaname = 'public'
      ORDER BY tablename ASC
    `
  );

  const columns = await client.query<ColumnSnapshotRow>(
    `
      SELECT
        table_name,
        column_name,
        data_type,
        udt_name,
        is_nullable,
        column_default,
        character_maximum_length
      FROM information_schema.columns
      WHERE table_schema = 'public'
      ORDER BY table_name ASC, ordinal_position ASC
    `
  );

  const constraints = await client.query<ConstraintSnapshotRow>(
    `
      SELECT
        cls.relname AS table_name,
        con.conname,
        con.contype,
        pg_get_constraintdef(con.oid) AS definition
      FROM pg_constraint AS con
      JOIN pg_class AS cls
        ON cls.oid = con.conrelid
      JOIN pg_namespace AS nsp
        ON nsp.oid = cls.relnamespace
      WHERE nsp.nspname = 'public'
        AND cls.relkind = 'r'
      ORDER BY cls.relname ASC, con.conname ASC
    `
  );

  const indexes = await client.query<IndexSnapshotRow>(
    `
      SELECT tablename, indexname, indexdef
      FROM pg_indexes
      WHERE schemaname = 'public'
      ORDER BY tablename ASC, indexname ASC
    `
  );

  const sequences = await client.query<SequenceSnapshotRow>(
    `
      SELECT
        sequencename,
        data_type,
        start_value::text AS start_value,
        min_value::text AS min_value,
        max_value::text AS max_value,
        increment_by::text AS increment_by,
        cycle
      FROM pg_sequences
      WHERE schemaname = 'public'
      ORDER BY sequencename ASC
    `
  );

  const tableComments = await client.query<TableCommentRow>(
    `
      SELECT
        cls.relname AS table_name,
        obj_description(cls.oid, 'pg_class') AS comment
      FROM pg_class AS cls
      JOIN pg_namespace AS nsp
        ON nsp.oid = cls.relnamespace
      WHERE nsp.nspname = 'public'
        AND cls.relkind = 'r'
      ORDER BY cls.relname ASC
    `
  );

  return {
    tables: tables.rows.map((row) => row.tablename),
    columns: columns.rows,
    constraints: constraints.rows,
    indexes: indexes.rows,
    sequences: sequences.rows,
    tableComments: tableComments.rows,
  };
}

describe('Unified production user DB migration', () => {
  it('preserves shortlinks and notifications while rebuilding the rest to the current dev schema', async () => {
    if (!dockerAvailable) {
      return;
    }

    const migratedDatabase = await startTestDatabase();
    const expectedDatabase = await startTestDatabase();

    try {
      await withPgClient(migratedDatabase.connectionString, async (client) => {
        await client.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
        await client.query(LEGACY_MAIN_USER_SCHEMA);

        await client.query(
          `
            INSERT INTO shortlinks (
              code,
              user_ids,
              original_url,
              created_at,
              access_count,
              last_access_at,
              metadata
            )
            VALUES (
              'share-1',
              ARRAY['user-1', 'user-2']::text[],
              'https://example.com/share-1',
              '2026-03-10T09:00:00.000Z'::timestamptz,
              7,
              '2026-04-01T12:00:00.000Z'::timestamptz,
              '{"source":"prod"}'::jsonb
            )
          `
        );

        await client.query(
          `
            INSERT INTO notifications (
              id,
              user_id,
              entity_cui,
              notification_type,
              is_active,
              config,
              hash,
              created_at,
              updated_at
            )
            VALUES
              (
                '11111111-1111-1111-1111-111111111111'::uuid,
                'user-newsletter',
                '4305857',
                'newsletter_entity_monthly',
                TRUE,
                '{"channels":{"email":true}}'::jsonb,
                'hash-newsletter',
                '2026-03-10T10:00:00.000Z'::timestamptz,
                '2026-03-10T10:00:00.000Z'::timestamptz
              ),
              (
                'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid,
                'user-unsub',
                NULL,
                'global_unsubscribe',
                FALSE,
                '{"channels":{"email":false},"source":"old"}'::jsonb,
                'hash-unsub-old',
                '2026-03-30T10:00:00.000Z'::timestamptz,
                '2026-03-30T10:00:00.000Z'::timestamptz
              ),
              (
                'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'::uuid,
                'user-unsub',
                NULL,
                'global_unsubscribe',
                FALSE,
                '{"channels":{"email":false},"source":"new"}'::jsonb,
                'hash-unsub-new',
                '2026-03-31T10:00:00.000Z'::timestamptz,
                '2026-03-31T10:00:00.000Z'::timestamptz
              ),
              (
                'cccccccc-cccc-cccc-cccc-cccccccccccc'::uuid,
                'user-debate',
                NULL,
                'funky:notification:global',
                TRUE,
                NULL,
                'hash-debate-old',
                '2026-03-30T11:00:00.000Z'::timestamptz,
                '2026-03-30T11:00:00.000Z'::timestamptz
              ),
              (
                'dddddddd-dddd-dddd-dddd-dddddddddddd'::uuid,
                'user-debate',
                NULL,
                'funky:notification:global',
                TRUE,
                NULL,
                'hash-debate-new',
                '2026-04-01T11:00:00.000Z'::timestamptz,
                '2026-04-01T11:00:00.000Z'::timestamptz
              )
          `
        );

        await client.query(
          `
            INSERT INTO unsubscribetokens (
              token,
              user_id,
              notification_id,
              created_at,
              expires_at
            )
            VALUES (
              'legacy-token-1',
              'user-newsletter',
              '11111111-1111-1111-1111-111111111111'::uuid,
              '2026-03-12T10:00:00.000Z'::timestamptz,
              '2027-03-12T10:00:00.000Z'::timestamptz
            )
          `
        );

        await client.query(
          `
            INSERT INTO notificationdeliveries (
              user_id,
              notification_id,
              period_key,
              delivery_key,
              status,
              unsubscribe_token,
              rendered_subject,
              to_email,
              attempt_count,
              sent_at,
              metadata,
              created_at
            )
            VALUES (
              'user-newsletter',
              '11111111-1111-1111-1111-111111111111'::uuid,
              '2026-03',
              'delivery-key-1',
              'sent',
              'legacy-token-1',
              'Legacy newsletter',
              'user@example.com',
              1,
              '2026-03-12T10:05:00.000Z'::timestamptz,
              '{"source":"legacy-delivery"}'::jsonb,
              '2026-03-12T10:05:00.000Z'::timestamptz
            )
          `
        );

        await client.query(
          `
            INSERT INTO learningprogress (
              user_id,
              events,
              last_event_at,
              event_count,
              created_at,
              updated_at
            )
            VALUES (
              'user-learning',
              '[{"eventId":"event-1","type":"answered"}]'::jsonb,
              '2026-03-20T08:00:00.000Z'::timestamptz,
              1,
              '2026-03-20T08:00:00.000Z'::timestamptz,
              '2026-03-20T08:00:00.000Z'::timestamptz
            )
          `
        );

        await client.query(
          `
            INSERT INTO resendwebhookevents (
              svix_id,
              event_type,
              resend_email_id,
              delivery_id,
              payload,
              processed_at,
              created_at
            )
            VALUES (
              'svix-1',
              'email.sent',
              'resend-1',
              NULL,
              '{"id":"evt-1"}'::jsonb,
              '2026-03-20T08:05:00.000Z'::timestamptz,
              '2026-03-20T08:05:00.000Z'::timestamptz
            )
          `
        );

        await client.query(
          `
            INSERT INTO advancedmapanalyticsmaps (
              id,
              user_id,
              title,
              description,
              visibility,
              public_id,
              last_snapshot,
              last_snapshot_id,
              snapshot_count,
              public_view_count,
              created_at,
              updated_at,
              deleted_at
            )
            VALUES (
              'legacy-map-1',
              'user-map',
              'Legacy map',
              'legacy description',
              'private',
              'legacy-public-id',
              '{"version":1}'::jsonb,
              'legacy-snapshot-1',
              1,
              3,
              '2026-03-21T09:00:00.000Z'::timestamptz,
              '2026-03-21T09:00:00.000Z'::timestamptz,
              NULL
            )
          `
        );

        await client.query(
          `
            INSERT INTO advancedmapanalyticssnapshots (
              id,
              map_id,
              title,
              description,
              snapshot,
              created_at
            )
            VALUES (
              'legacy-snapshot-1',
              'legacy-map-1',
              'Legacy snapshot',
              'legacy snapshot description',
              '{"filters":[]}'::jsonb,
              '2026-03-21T09:01:00.000Z'::timestamptz
            )
          `
        );

        await client.query(UNIFIED_PRODUCTION_MIGRATION);

        const shortLinks = await client.query<{
          code: string;
          user_ids: string[];
          original_url: string;
          created_at: Date;
          access_count: number;
          last_access_at: Date | null;
          metadata: { source: string } | null;
        }>(
          `
            SELECT
              code,
              user_ids,
              original_url,
              created_at,
              access_count,
              last_access_at,
              metadata
            FROM shortlinks
          `
        );

        expect(shortLinks.rows).toHaveLength(1);
        expect(shortLinks.rows[0]).toEqual({
          code: 'share-1',
          user_ids: ['user-1', 'user-2'],
          original_url: 'https://example.com/share-1',
          created_at: new Date('2026-03-10T09:00:00.000Z'),
          access_count: 7,
          last_access_at: new Date('2026-04-01T12:00:00.000Z'),
          metadata: { source: 'prod' },
        });

        const notifications = await client.query<{
          id: string;
          user_id: string;
          notification_type: string;
          is_active: boolean;
          config: Record<string, unknown> | null;
          hash: string;
        }>(
          `
            SELECT id, user_id, notification_type, is_active, config, hash
            FROM notifications
            ORDER BY user_id ASC, notification_type ASC, id ASC
          `
        );

        expect(notifications.rows).toEqual([
          {
            id: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
            user_id: 'user-debate',
            notification_type: 'funky:notification:global',
            is_active: true,
            config: null,
            hash: 'hash-debate-new',
          },
          {
            id: '11111111-1111-1111-1111-111111111111',
            user_id: 'user-newsletter',
            notification_type: 'newsletter_entity_monthly',
            is_active: true,
            config: { channels: { email: true } },
            hash: 'hash-newsletter',
          },
          {
            id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
            user_id: 'user-unsub',
            notification_type: 'global_unsubscribe',
            is_active: false,
            config: { channels: { email: false }, source: 'new' },
            hash: 'hash-unsub-new',
          },
        ]);

        const rebuiltTables = await client.query<{ table_name: string; row_count: string }>(
          `
            SELECT table_name, row_count
            FROM (
              SELECT 'notificationsoutbox' AS table_name, (SELECT COUNT(*)::text FROM notificationsoutbox) AS row_count
              UNION ALL
              SELECT 'userinteractions' AS table_name, (SELECT COUNT(*)::text FROM userinteractions) AS row_count
              UNION ALL
              SELECT 'institutionemailthreads' AS table_name, (SELECT COUNT(*)::text FROM institutionemailthreads) AS row_count
              UNION ALL
              SELECT 'resend_wh_emails' AS table_name, (SELECT COUNT(*)::text FROM resend_wh_emails) AS row_count
              UNION ALL
              SELECT 'advancedmapanalyticsmaps' AS table_name, (SELECT COUNT(*)::text FROM advancedmapanalyticsmaps) AS row_count
              UNION ALL
              SELECT 'advancedmapanalyticssnapshots' AS table_name, (SELECT COUNT(*)::text FROM advancedmapanalyticssnapshots) AS row_count
            ) AS counts
            ORDER BY table_name ASC
          `
        );

        expect(rebuiltTables.rows).toEqual([
          { table_name: 'advancedmapanalyticsmaps', row_count: '0' },
          { table_name: 'advancedmapanalyticssnapshots', row_count: '0' },
          { table_name: 'institutionemailthreads', row_count: '0' },
          { table_name: 'notificationsoutbox', row_count: '0' },
          { table_name: 'resend_wh_emails', row_count: '0' },
          { table_name: 'userinteractions', row_count: '0' },
        ]);

        const redundantIndexes = await client.query<{ indexname: string }>(
          `
            SELECT indexname
            FROM pg_indexes
            WHERE schemaname = 'public'
              AND indexname IN (
                'idx_shortlinks_code',
                'idx_shortlinks_original_url',
                'idx_notifications_hash'
              )
            ORDER BY indexname ASC
          `
        );

        expect(redundantIndexes.rows).toEqual([]);
      });

      let migratedSnapshot: SchemaSnapshot | undefined;
      await withPgClient(migratedDatabase.connectionString, async (client) => {
        migratedSnapshot = await getSchemaSnapshot(client);
      });

      let expectedSnapshot: SchemaSnapshot | undefined;
      await withPgClient(expectedDatabase.connectionString, async (client) => {
        await client.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
        await client.query(CURRENT_USER_SCHEMA);
        expectedSnapshot = await getSchemaSnapshot(client);
      });

      expect(migratedSnapshot).toEqual(expectedSnapshot);
    } finally {
      await migratedDatabase.stop();
      await expectedDatabase.stop();
    }
  });
});
