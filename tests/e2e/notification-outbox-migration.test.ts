import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { PostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

const dockerAvailable = (() => {
  try {
    execSync('docker info', { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
})();

let containerRuntimeAvailable = dockerAvailable;
let containerRuntimeUnavailableReason: string | undefined;

const LEGACY_NOTIFICATION_DELIVERIES_SCHEMA = `
CREATE TABLE Notifications (
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

CREATE TABLE NotificationDeliveries (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  notification_id UUID NOT NULL REFERENCES Notifications(id) ON DELETE CASCADE,
  period_key TEXT NOT NULL,
  delivery_key TEXT UNIQUE NOT NULL,
  email_batch_id UUID NOT NULL,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_deliveries_delivery_key ON NotificationDeliveries(delivery_key);
CREATE INDEX idx_deliveries_user_period ON NotificationDeliveries(user_id, period_key);
CREATE INDEX idx_deliveries_created_at ON NotificationDeliveries(created_at DESC);
CREATE INDEX idx_deliveries_notification ON NotificationDeliveries(notification_id);
CREATE INDEX idx_deliveries_email_batch ON NotificationDeliveries(email_batch_id);
`;

const PARTIALLY_APPLIED_NOTIFICATION_OUTBOX_SCHEMA = `
CREATE TABLE Notifications (
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

CREATE TABLE NotificationOutbox (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  notification_type TEXT NOT NULL,
  reference_id TEXT,
  period_key TEXT NOT NULL,
  delivery_key TEXT UNIQUE NOT NULL,
  email_batch_id UUID NOT NULL,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_deliveries_delivery_key ON NotificationOutbox(delivery_key);
CREATE INDEX idx_deliveries_user_period ON NotificationOutbox(user_id, period_key);
CREATE INDEX idx_deliveries_created_at ON NotificationOutbox(created_at DESC);
CREATE INDEX idx_deliveries_email_batch ON NotificationOutbox(email_batch_id);
`;

const NOTIFICATION_OUTBOX_MIGRATION = fs.readFileSync(
  path.join(
    process.cwd(),
    'src/infra/database/user/migrations/202603281800_refactor_notification_deliveries_to_outbox.sql'
  ),
  'utf-8'
);

const DROP_UNSUBSCRIBE_TOKENS_MIGRATION = fs.readFileSync(
  path.join(
    process.cwd(),
    'src/infra/database/user/migrations/202603300100_drop_unsubscribe_tokens_table.sql'
  ),
  'utf-8'
);

const HARDEN_NOTIFICATION_OUTBOX_MIGRATION = fs.readFileSync(
  path.join(
    process.cwd(),
    'src/infra/database/user/migrations/202603311100_harden_notification_outbox_and_unsubscribe.sql'
  ),
  'utf-8'
);

const NAMESPACE_ANAF_FOREXEBUG_DIGEST_SCOPE_MIGRATION = fs.readFileSync(
  path.join(
    process.cwd(),
    'src/infra/database/user/migrations/202603311300_namespace_anaf_forexebug_digest_scope.sql'
  ),
  'utf-8'
);

const RENAME_NOTIFICATION_OUTBOX_MIGRATION = fs.readFileSync(
  path.join(
    process.cwd(),
    'src/infra/database/user/migrations/202604011200_rename_notification_outbox_to_notifications_outbox.sql'
  ),
  'utf-8'
);

const UNSUBSCRIBE_TOKEN_LEGACY_SCHEMA = `
CREATE TABLE Notifications (
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

CREATE TABLE UnsubscribeTokens (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  notification_id UUID NOT NULL REFERENCES Notifications(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '1 year'),
  used_at TIMESTAMPTZ
);

CREATE INDEX idx_unsubscribe_tokens_user ON UnsubscribeTokens(user_id) WHERE used_at IS NULL;
CREATE INDEX idx_unsubscribe_tokens_expires ON UnsubscribeTokens(expires_at) WHERE used_at IS NULL;
CREATE INDEX idx_unsubscribe_tokens_notification ON UnsubscribeTokens(notification_id);

CREATE TABLE NotificationOutbox (
  id UUID PRIMARY KEY,
  user_id TEXT NOT NULL,
  notification_type VARCHAR(50) NOT NULL,
  reference_id TEXT,
  scope_key TEXT NOT NULL,
  delivery_key TEXT UNIQUE NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'pending',
  unsubscribe_token TEXT REFERENCES UnsubscribeTokens(token) ON DELETE SET NULL,
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
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;

interface StartedTestDatabase {
  connectionString: string;
  stop: () => Promise<void>;
}

interface OutboxRow {
  notification_type: string;
  reference_id: string | null;
  status: string;
  attempt_count: number;
  legacy_email_batch_id: string | null;
  metadata_source: string | null;
  last_attempt_matches_sent: boolean;
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

async function assertMigratedOutbox(
  client: pg.Client,
  expectedNotificationId: string,
  expectedNotificationType: string,
  expectedLegacyEmailBatchId: string,
  expectedMetadataSource: string
): Promise<void> {
  const tables = await client.query<{ notifications: string | null; outbox: string | null }>(
    `
      SELECT
        to_regclass('public.notificationdeliveries') AS notifications,
        to_regclass('public.notificationsoutbox') AS outbox
    `
  );

  expect(tables.rows[0]?.notifications).toBeNull();
  expect(tables.rows[0]?.outbox).toBe('notificationsoutbox');

  const rows = await client.query<OutboxRow>(
    `
      SELECT
        notification_type,
        reference_id,
        status,
        attempt_count,
        metadata->>'legacyEmailBatchId' AS legacy_email_batch_id,
        metadata->>'source' AS metadata_source,
        last_attempt_at = sent_at AS last_attempt_matches_sent
      FROM NotificationsOutbox
    `
  );

  expect(rows.rows).toHaveLength(1);
  expect(rows.rows[0]).toEqual({
    notification_type: expectedNotificationType,
    reference_id: expectedNotificationId,
    status: 'sent',
    attempt_count: 1,
    legacy_email_batch_id: expectedLegacyEmailBatchId,
    metadata_source: expectedMetadataSource,
    last_attempt_matches_sent: true,
  });

  const columns = await client.query<{ column_name: string }>(
    `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'notificationsoutbox'
        AND column_name IN (
          'notification_id',
          'email_batch_id',
          'notification_type',
          'reference_id',
          'scope_key',
          'period_key',
          'status',
          'attempt_count'
        )
      ORDER BY column_name
    `
  );

  expect(columns.rows.map((row) => row.column_name)).toEqual([
    'attempt_count',
    'notification_type',
    'reference_id',
    'scope_key',
    'status',
  ]);

  const columnTypes = await client.query<{
    column_name: string;
    data_type: string;
    character_maximum_length: number | null;
    is_nullable: 'YES' | 'NO';
  }>(
    `
      SELECT column_name, data_type, character_maximum_length, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'notificationsoutbox'
        AND column_name IN ('notification_type', 'status', 'metadata')
      ORDER BY column_name
    `
  );

  expect(columnTypes.rows).toEqual([
    {
      column_name: 'metadata',
      data_type: 'jsonb',
      character_maximum_length: null,
      is_nullable: 'NO',
    },
    {
      column_name: 'notification_type',
      data_type: 'character varying',
      character_maximum_length: 50,
      is_nullable: 'NO',
    },
    {
      column_name: 'status',
      data_type: 'character varying',
      character_maximum_length: 32,
      is_nullable: 'NO',
    },
  ]);

  const indexes = await client.query<{ indexname: string }>(
    `
      SELECT indexname
      FROM pg_indexes
      WHERE tablename = 'notificationsoutbox'
        AND indexname IN (
          'idx_notification_outbox_delivery_key_unique',
          'idx_notification_outbox_user_scope',
          'idx_notification_outbox_created_at',
          'idx_notification_outbox_reference',
          'idx_notification_outbox_scope_type_reference',
          'idx_notification_outbox_status_pending',
          'idx_notification_outbox_sending_stuck',
          'idx_notification_outbox_resend_email_id',
          'idx_notification_outbox_user_sent_at_desc'
        )
      ORDER BY indexname
    `
  );

  expect(indexes.rows.map((row) => row.indexname)).toEqual([
    'idx_notification_outbox_created_at',
    'idx_notification_outbox_delivery_key_unique',
    'idx_notification_outbox_scope_type_reference',
    'idx_notification_outbox_reference',
    'idx_notification_outbox_resend_email_id',
    'idx_notification_outbox_sending_stuck',
    'idx_notification_outbox_status_pending',
    'idx_notification_outbox_user_sent_at_desc',
    'idx_notification_outbox_user_scope',
  ]);

  const constraints = await client.query<{ conname: string }>(
    `
      SELECT conname
      FROM pg_constraint
      WHERE conrelid = 'notificationsoutbox'::regclass
        AND contype = 'u'
      ORDER BY conname
    `
  );

  expect(constraints.rows.map((row) => row.conname)).toContain(
    'notificationsoutbox_delivery_key_key'
  );

  const unsubscribeColumns = await client.query<{ column_name: string }>(
    `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'notificationsoutbox'
        AND column_name = 'unsubscribe_token'
    `
  );

  expect(unsubscribeColumns.rows).toHaveLength(0);

  const globalUnsubscribeIndex = await client.query<{ indexname: string }>(
    `
      SELECT indexname
      FROM pg_indexes
      WHERE tablename = 'notifications'
        AND indexname = 'idx_notifications_global_unsubscribe_user'
    `
  );

  expect(globalUnsubscribeIndex.rows).toEqual([
    { indexname: 'idx_notifications_global_unsubscribe_user' },
  ]);
}

async function assertUnsubscribeArtifactsRemoved(client: pg.Client): Promise<void> {
  const tables = await client.query<{ unsubscribetokens: string | null }>(
    `
      SELECT to_regclass('public.unsubscribetokens') AS unsubscribetokens
    `
  );

  expect(tables.rows[0]?.unsubscribetokens).toBeNull();

  const columns = await client.query<{ column_name: string }>(
    `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'notificationoutbox'
        AND column_name = 'unsubscribe_token'
    `
  );

  expect(columns.rows).toHaveLength(0);
}

describe('NotificationOutbox migration', () => {
  beforeAll(async () => {
    if (!dockerAvailable) {
      containerRuntimeAvailable = false;
      containerRuntimeUnavailableReason = 'Docker is not available';
      return;
    }

    try {
      const database = await startTestDatabase();
      await database.stop();
      containerRuntimeAvailable = true;
      containerRuntimeUnavailableReason = undefined;
    } catch (error) {
      containerRuntimeAvailable = false;
      containerRuntimeUnavailableReason =
        error instanceof Error ? error.message : 'Container runtime is unavailable';
    }
  });

  beforeEach((context) => {
    if (!containerRuntimeAvailable) {
      context.skip(containerRuntimeUnavailableReason ?? 'Container runtime is unavailable');
    }
  });

  it('migrates the legacy successful-deliveries table into the durable outbox schema', async () => {
    const database = await startTestDatabase();

    try {
      await withPgClient(database.connectionString, async (client) => {
        await client.query(LEGACY_NOTIFICATION_DELIVERIES_SCHEMA);

        const notificationId = '11111111-1111-1111-1111-111111111111';
        const emailBatchId = '22222222-2222-2222-2222-222222222222';
        const notificationType = 'newsletter_entity_monthly';

        await client.query(
          `
            INSERT INTO Notifications (
              id,
              user_id,
              entity_cui,
              notification_type,
              hash
            )
            VALUES ($1::uuid, 'user-1', '4305857', $2, 'hash-1')
          `,
          [notificationId, notificationType]
        );

        await client.query(
          `
            INSERT INTO NotificationDeliveries (
              user_id,
              notification_id,
              period_key,
              delivery_key,
              email_batch_id,
              sent_at,
              metadata,
              created_at
            )
            VALUES (
              'user-1',
              $1::uuid,
              '2026-03',
              'user-1:11111111-1111-1111-1111-111111111111:2026-03',
              $2::uuid,
              '2026-03-28T18:00:00.000Z'::timestamptz,
              '{"source":"legacy-table"}'::jsonb,
              '2026-03-28T18:00:00.000Z'::timestamptz
            )
          `,
          [notificationId, emailBatchId]
        );

        await client.query(NOTIFICATION_OUTBOX_MIGRATION);
        await client.query(HARDEN_NOTIFICATION_OUTBOX_MIGRATION);
        await client.query(NAMESPACE_ANAF_FOREXEBUG_DIGEST_SCOPE_MIGRATION);
        await client.query(NOTIFICATION_OUTBOX_MIGRATION);
        await client.query(HARDEN_NOTIFICATION_OUTBOX_MIGRATION);
        await client.query(NAMESPACE_ANAF_FOREXEBUG_DIGEST_SCOPE_MIGRATION);
        await client.query(RENAME_NOTIFICATION_OUTBOX_MIGRATION);
        await client.query(RENAME_NOTIFICATION_OUTBOX_MIGRATION);

        await assertMigratedOutbox(
          client,
          notificationId,
          notificationType,
          emailBatchId,
          'legacy-table'
        );
      });
    } finally {
      await database.stop();
    }
  });

  it('repairs a partially applied rename that already dropped notification_id', async () => {
    const database = await startTestDatabase();

    try {
      await withPgClient(database.connectionString, async (client) => {
        await client.query(PARTIALLY_APPLIED_NOTIFICATION_OUTBOX_SCHEMA);

        const notificationId = '33333333-3333-3333-3333-333333333333';
        const emailBatchId = '44444444-4444-4444-4444-444444444444';
        const notificationType = 'alert_budget_threshold';

        await client.query(
          `
            INSERT INTO Notifications (
              id,
              user_id,
              entity_cui,
              notification_type,
              hash
            )
            VALUES ($1::uuid, 'user-2', '4305857', $2, 'hash-2')
          `,
          [notificationId, notificationType]
        );

        await client.query(
          `
            INSERT INTO NotificationOutbox (
              user_id,
              notification_type,
              reference_id,
              period_key,
              delivery_key,
              email_batch_id,
              sent_at,
              metadata,
              created_at
            )
            VALUES (
              'user-2',
              $1,
              $2,
              '2026-03',
              'user-2:33333333-3333-3333-3333-333333333333:2026-03',
              $3::uuid,
              '2026-03-28T19:00:00.000Z'::timestamptz,
              '{"source":"partial-run"}'::jsonb,
              '2026-03-28T19:00:00.000Z'::timestamptz
            )
          `,
          [notificationType, notificationId, emailBatchId]
        );

        await client.query(NOTIFICATION_OUTBOX_MIGRATION);
        await client.query(HARDEN_NOTIFICATION_OUTBOX_MIGRATION);
        await client.query(NAMESPACE_ANAF_FOREXEBUG_DIGEST_SCOPE_MIGRATION);
        await client.query(RENAME_NOTIFICATION_OUTBOX_MIGRATION);

        await assertMigratedOutbox(
          client,
          notificationId,
          notificationType,
          emailBatchId,
          'partial-run'
        );
      });
    } finally {
      await database.stop();
    }
  });

  it('drops legacy unsubscribe token artifacts idempotently', async () => {
    const database = await startTestDatabase();

    try {
      await withPgClient(database.connectionString, async (client) => {
        await client.query(UNSUBSCRIBE_TOKEN_LEGACY_SCHEMA);

        const notificationId = '55555555-5555-5555-5555-555555555555';
        const outboxId = '66666666-6666-6666-6666-666666666666';

        await client.query(
          `
            INSERT INTO Notifications (
              id,
              user_id,
              entity_cui,
              notification_type,
              hash
            )
            VALUES ($1::uuid, 'user-legacy', NULL, 'newsletter_entity_monthly', 'hash-legacy')
          `,
          [notificationId]
        );

        await client.query(
          `
            INSERT INTO UnsubscribeTokens (
              token,
              user_id,
              notification_id
            )
            VALUES ('legacy-token', 'user-legacy', $1::uuid)
          `,
          [notificationId]
        );

        await client.query(
          `
            INSERT INTO NotificationOutbox (
              id,
              user_id,
              notification_type,
              reference_id,
              scope_key,
              delivery_key,
              unsubscribe_token
            )
            VALUES (
              $1::uuid,
              'user-legacy',
              'newsletter_entity_monthly',
              $2::text,
              '2026-03',
              'user-legacy:notification-legacy:2026-03',
              'legacy-token'
            )
          `,
          [outboxId, notificationId]
        );

        await client.query(DROP_UNSUBSCRIBE_TOKENS_MIGRATION);
        await client.query(DROP_UNSUBSCRIBE_TOKENS_MIGRATION);

        await assertUnsubscribeArtifactsRemoved(client);

        const outboxRows = await client.query<{ id: string }>('SELECT id FROM NotificationOutbox');
        expect(outboxRows.rows).toEqual([{ id: outboxId }]);
      });
    } finally {
      await database.stop();
    }
  });

  it('deduplicates global_unsubscribe rows and normalizes NULL metadata during hardening', async () => {
    const database = await startTestDatabase();

    try {
      await withPgClient(database.connectionString, async (client) => {
        await client.query(`
          CREATE TABLE Notifications (
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

          CREATE TABLE NotificationOutbox (
            id UUID PRIMARY KEY,
            user_id TEXT NOT NULL,
            notification_type TEXT NOT NULL,
            reference_id TEXT,
            period_key TEXT NOT NULL,
            delivery_key TEXT UNIQUE NOT NULL,
            status VARCHAR(20) NOT NULL DEFAULT 'pending',
            metadata JSONB,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
        `);

        await client.query(`
          INSERT INTO Notifications (id, user_id, entity_cui, notification_type, is_active, config, hash, created_at, updated_at)
          VALUES
            ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'user-1', NULL, 'global_unsubscribe', FALSE, '{"channels":{"email":false}}'::jsonb, 'hash-old', '2026-03-30T10:00:00.000Z', '2026-03-30T10:00:00.000Z'),
            ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'user-1', NULL, 'global_unsubscribe', FALSE, '{"channels":{"email":false}}'::jsonb, 'hash-new', '2026-03-31T10:00:00.000Z', '2026-03-31T10:00:00.000Z')
        `);

        await client.query(`
          INSERT INTO NotificationOutbox (id, user_id, notification_type, reference_id, period_key, delivery_key, status, metadata, created_at)
          VALUES (
            'cccccccc-cccc-cccc-cccc-cccccccccccc',
            'user-1',
            'newsletter_entity_monthly',
            'notification-1',
            '2026-03',
            'user-1:notification-1:2026-03',
            'pending',
            NULL,
            '2026-03-31T09:00:00.000Z'
          )
        `);

        await client.query(HARDEN_NOTIFICATION_OUTBOX_MIGRATION);

        const duplicateRows = await client.query<{ count: string }>(
          `
            SELECT COUNT(*)::text AS count
            FROM Notifications
            WHERE user_id = 'user-1'
              AND notification_type = 'global_unsubscribe'
          `
        );

        expect(duplicateRows.rows).toEqual([{ count: '1' }]);

        const metadataRows = await client.query<{ metadata: Record<string, unknown> }>(
          `SELECT metadata FROM NotificationOutbox WHERE id = 'cccccccc-cccc-cccc-cccc-cccccccccccc'::uuid`
        );

        expect(metadataRows.rows[0]?.metadata).toEqual({});
      });
    } finally {
      await database.stop();
    }
  });

  it('backfills legacy ANAF / Forexebug digest scopes idempotently', async () => {
    const database = await startTestDatabase();

    try {
      await withPgClient(database.connectionString, async (client) => {
        await client.query(`
          CREATE TABLE NotificationOutbox (
            id UUID PRIMARY KEY,
            user_id TEXT NOT NULL,
            notification_type TEXT NOT NULL,
            reference_id TEXT,
            scope_key TEXT NOT NULL,
            delivery_key TEXT UNIQUE NOT NULL,
            status VARCHAR(20) NOT NULL DEFAULT 'pending',
            metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
        `);

        await client.query(`
          INSERT INTO NotificationOutbox (id, user_id, notification_type, reference_id, scope_key, delivery_key)
          VALUES
            (
              'dddddddd-dddd-dddd-dddd-dddddddddddd',
              'user-1',
              'anaf_forexebug_digest',
              NULL,
              '2026-03',
              'digest:anaf_forexebug:user-1:2026-03'
            ),
            (
              'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
              'user-2',
              'anaf_forexebug_digest',
              NULL,
              'digest:anaf_forexebug:2026-04',
              'digest:anaf_forexebug:user-2:2026-04'
            ),
            (
              'ffffffff-ffff-ffff-ffff-ffffffffffff',
              'user-3',
              'newsletter_entity_monthly',
              'notification-3',
              '2026-03',
              'user-3:notification-3:2026-03'
            )
        `);

        await client.query(NAMESPACE_ANAF_FOREXEBUG_DIGEST_SCOPE_MIGRATION);
        await client.query(NAMESPACE_ANAF_FOREXEBUG_DIGEST_SCOPE_MIGRATION);

        const rows = await client.query<{ id: string; scope_key: string }>(`
          SELECT id, scope_key
          FROM NotificationOutbox
          ORDER BY id
        `);

        expect(rows.rows).toEqual([
          {
            id: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
            scope_key: 'digest:anaf_forexebug:2026-03',
          },
          {
            id: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
            scope_key: 'digest:anaf_forexebug:2026-04',
          },
          {
            id: 'ffffffff-ffff-ffff-ffff-ffffffffffff',
            scope_key: '2026-03',
          },
        ]);
      });
    } finally {
      await database.stop();
    }
  });

  it('fails explicitly when delivery_key is missing during hardening', async () => {
    const database = await startTestDatabase();

    try {
      await withPgClient(database.connectionString, async (client) => {
        await client.query(`
          CREATE TABLE NotificationOutbox (
            id UUID PRIMARY KEY,
            user_id TEXT NOT NULL,
            notification_type TEXT NOT NULL,
            reference_id TEXT,
            scope_key TEXT NOT NULL,
            status VARCHAR(20) NOT NULL DEFAULT 'pending',
            metadata JSONB
          );

          CREATE TABLE Notifications (
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
        `);

        await expect(client.query(HARDEN_NOTIFICATION_OUTBOX_MIGRATION)).rejects.toThrow(
          'notificationoutbox.delivery_key column not found while hardening delivery_key constraint'
        );
      });
    } finally {
      await database.stop();
    }
  });
});
