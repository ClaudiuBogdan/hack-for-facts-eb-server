UPDATE notificationoutbox
SET metadata = '{}'::jsonb
WHERE metadata IS NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'notificationoutbox'
      AND column_name = 'period_key'
  ) AND NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'notificationoutbox'
      AND column_name = 'scope_key'
  ) THEN
    EXECUTE 'ALTER TABLE notificationoutbox RENAME COLUMN period_key TO scope_key';
  END IF;
END $$;

ALTER TABLE notificationoutbox
ALTER COLUMN notification_type TYPE VARCHAR(50);

ALTER TABLE notificationoutbox
ALTER COLUMN status TYPE VARCHAR(32);

ALTER TABLE notificationoutbox
ALTER COLUMN metadata SET DEFAULT '{}'::jsonb;

ALTER TABLE notificationoutbox
ALTER COLUMN metadata SET NOT NULL;

ALTER TABLE notificationoutbox
DROP CONSTRAINT IF EXISTS notification_outbox_status_check;

ALTER TABLE notificationoutbox
ADD CONSTRAINT notification_outbox_status_check
CHECK (status IN (
  'pending', 'composing', 'sending', 'sent', 'delivered', 'webhook_timeout',
  'failed_transient', 'failed_permanent',
  'suppressed', 'skipped_unsubscribed', 'skipped_no_email'
));

WITH ranked AS (
  SELECT
    ctid,
    row_number() OVER (
      PARTITION BY user_id, notification_type
      ORDER BY updated_at DESC, created_at DESC, id DESC
    ) AS row_num
  FROM notifications
  WHERE notification_type = 'global_unsubscribe'
)
DELETE FROM notifications
WHERE ctid IN (
  SELECT ctid
  FROM ranked
  WHERE row_num > 1
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_global_unsubscribe_user
ON notifications(user_id, notification_type)
WHERE notification_type = 'global_unsubscribe';

ALTER INDEX IF EXISTS idx_notification_outbox_period_type_reference
RENAME TO idx_notification_outbox_scope_type_reference;

CREATE INDEX IF NOT EXISTS idx_notification_outbox_scope_type_reference
ON notificationoutbox(scope_key, notification_type, reference_id)
WHERE reference_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_notification_outbox_user_sent_at_desc
ON notificationoutbox(user_id, sent_at DESC, created_at DESC)
WHERE sent_at IS NOT NULL;

DO $$
DECLARE
  delivery_key_attnum SMALLINT;
  constraint_index_name TEXT;
BEGIN
  SELECT attnum
  INTO delivery_key_attnum
  FROM pg_attribute
  WHERE attrelid = 'notificationoutbox'::regclass
    AND attname = 'delivery_key'
    AND NOT attisdropped;

  IF delivery_key_attnum IS NULL THEN
    RAISE EXCEPTION 'notificationoutbox.delivery_key column not found while hardening delivery_key constraint';
  END IF;

  SELECT idx.relname
  INTO constraint_index_name
  FROM pg_constraint con
  JOIN pg_class idx
    ON idx.oid = con.conindid
  WHERE con.conrelid = 'notificationoutbox'::regclass
    AND con.contype = 'u'
    AND con.conkey = ARRAY[delivery_key_attnum];

  IF constraint_index_name IS NULL THEN
    IF to_regclass('public.idx_notification_outbox_delivery_key_unique') IS NOT NULL THEN
      EXECUTE '
        ALTER TABLE notificationoutbox
        ADD CONSTRAINT notificationoutbox_delivery_key_key
        UNIQUE USING INDEX idx_notification_outbox_delivery_key_unique
      ';
      constraint_index_name := 'idx_notification_outbox_delivery_key_unique';
    ELSE
      EXECUTE '
        ALTER TABLE notificationoutbox
        ADD CONSTRAINT notificationoutbox_delivery_key_key
        UNIQUE (delivery_key)
      ';

      SELECT idx.relname
      INTO constraint_index_name
      FROM pg_constraint con
      JOIN pg_class idx
        ON idx.oid = con.conindid
      WHERE con.conrelid = 'notificationoutbox'::regclass
        AND con.contype = 'u'
        AND con.conkey = ARRAY[delivery_key_attnum];
    END IF;
  END IF;

  IF to_regclass('public.idx_notification_outbox_delivery_key_unique') IS NOT NULL
     AND constraint_index_name IS NOT NULL
     AND constraint_index_name <> 'idx_notification_outbox_delivery_key_unique' THEN
    EXECUTE 'DROP INDEX idx_notification_outbox_delivery_key_unique';
  END IF;
END $$;
