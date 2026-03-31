DO $$
BEGIN
  IF to_regclass('public.notificationdeliveries') IS NOT NULL
     AND to_regclass('public.notificationoutbox') IS NULL THEN
    EXECUTE 'ALTER TABLE notificationdeliveries RENAME TO notificationoutbox';
  END IF;
END $$;

ALTER TABLE notificationoutbox
ADD COLUMN IF NOT EXISTS notification_type TEXT;

ALTER TABLE notificationoutbox
ADD COLUMN IF NOT EXISTS reference_id TEXT;

ALTER TABLE notificationoutbox
ADD COLUMN IF NOT EXISTS status TEXT;

ALTER TABLE notificationoutbox
ADD COLUMN IF NOT EXISTS rendered_subject TEXT;

ALTER TABLE notificationoutbox
ADD COLUMN IF NOT EXISTS rendered_html TEXT;

ALTER TABLE notificationoutbox
ADD COLUMN IF NOT EXISTS rendered_text TEXT;

ALTER TABLE notificationoutbox
ADD COLUMN IF NOT EXISTS content_hash TEXT;

ALTER TABLE notificationoutbox
ADD COLUMN IF NOT EXISTS template_name TEXT;

ALTER TABLE notificationoutbox
ADD COLUMN IF NOT EXISTS template_version TEXT;

ALTER TABLE notificationoutbox
ADD COLUMN IF NOT EXISTS to_email TEXT;

ALTER TABLE notificationoutbox
ADD COLUMN IF NOT EXISTS resend_email_id TEXT;

ALTER TABLE notificationoutbox
ADD COLUMN IF NOT EXISTS last_error TEXT;

ALTER TABLE notificationoutbox
ADD COLUMN IF NOT EXISTS attempt_count INT;

ALTER TABLE notificationoutbox
ADD COLUMN IF NOT EXISTS last_attempt_at TIMESTAMPTZ;

ALTER TABLE notificationoutbox
ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb;

ALTER TABLE notificationoutbox
ALTER COLUMN metadata SET DEFAULT '{}'::jsonb;

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

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'notificationoutbox'
      AND column_name = 'notification_id'
  ) THEN
    EXECUTE '
      UPDATE notificationoutbox
      SET reference_id = notification_id::text
      WHERE reference_id IS NULL
    ';

    EXECUTE '
      UPDATE notificationoutbox outbox
      SET notification_type = notifications.notification_type
      FROM notifications
      WHERE outbox.notification_type IS NULL
        AND outbox.notification_id = notifications.id
    ';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'notificationoutbox'
      AND column_name = 'email_batch_id'
  ) THEN
    EXECUTE '
      UPDATE notificationoutbox
      SET metadata = jsonb_set(
        COALESCE(metadata, ''{}''::jsonb),
        ''{legacyEmailBatchId}'',
        to_jsonb(email_batch_id::text),
        true
      )
      WHERE email_batch_id IS NOT NULL
        AND NOT (COALESCE(metadata, ''{}''::jsonb) ? ''legacyEmailBatchId'')
    ';
  END IF;
END $$;

UPDATE notificationoutbox
SET metadata = '{}'::jsonb
WHERE metadata IS NULL;

UPDATE notificationoutbox
SET status = CASE
  WHEN sent_at IS NOT NULL THEN 'sent'
  ELSE 'pending'
END
WHERE status IS NULL;

UPDATE notificationoutbox
SET attempt_count = CASE
  WHEN sent_at IS NOT NULL THEN 1
  ELSE 0
END
WHERE attempt_count IS NULL;

UPDATE notificationoutbox
SET last_attempt_at = sent_at
WHERE last_attempt_at IS NULL
  AND sent_at IS NOT NULL;

ALTER TABLE notificationoutbox
ALTER COLUMN status SET DEFAULT 'pending';

ALTER TABLE notificationoutbox
ALTER COLUMN status SET NOT NULL;

ALTER TABLE notificationoutbox
ALTER COLUMN attempt_count SET DEFAULT 0;

ALTER TABLE notificationoutbox
ALTER COLUMN attempt_count SET NOT NULL;

ALTER TABLE notificationoutbox
DROP CONSTRAINT IF EXISTS notificationdeliveries_notification_id_fkey;

ALTER TABLE notificationoutbox
DROP CONSTRAINT IF EXISTS notificationoutbox_notification_id_fkey;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'notificationoutbox'
      AND column_name = 'notification_id'
  ) THEN
    EXECUTE 'ALTER TABLE notificationoutbox DROP COLUMN notification_id';
  END IF;
END $$;

ALTER TABLE notificationoutbox
DROP COLUMN IF EXISTS email_batch_id;

ALTER TABLE notificationoutbox
ALTER COLUMN notification_type SET NOT NULL;

ALTER TABLE notificationoutbox
DROP CONSTRAINT IF EXISTS deliveries_status_check;

ALTER TABLE notificationoutbox
DROP CONSTRAINT IF EXISTS notification_outbox_status_check;

ALTER TABLE notificationoutbox
ADD CONSTRAINT notification_outbox_status_check
CHECK (status IN (
  'pending', 'sending', 'sent', 'delivered',
  'failed_transient', 'failed_permanent',
  'suppressed', 'skipped_unsubscribed', 'skipped_no_email'
));

DO $$
BEGIN
  IF to_regclass('public.idx_notification_outbox_delivery_key_unique') IS NULL THEN
    IF to_regclass('public.idx_deliveries_delivery_key_unique') IS NOT NULL THEN
      EXECUTE 'ALTER INDEX idx_deliveries_delivery_key_unique RENAME TO idx_notification_outbox_delivery_key_unique';
    ELSIF to_regclass('public.notificationdeliveries_delivery_key_key') IS NOT NULL THEN
      EXECUTE 'ALTER INDEX notificationdeliveries_delivery_key_key RENAME TO idx_notification_outbox_delivery_key_unique';
    ELSIF to_regclass('public.notificationoutbox_delivery_key_key') IS NOT NULL THEN
      EXECUTE 'ALTER INDEX notificationoutbox_delivery_key_key RENAME TO idx_notification_outbox_delivery_key_unique';
    END IF;
  END IF;
END $$;

DROP INDEX IF EXISTS idx_deliveries_delivery_key;

CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_outbox_delivery_key_unique
ON notificationoutbox(delivery_key);

DO $$
BEGIN
  IF to_regclass('public.idx_notification_outbox_user_scope') IS NULL THEN
    IF to_regclass('public.idx_deliveries_user_period') IS NOT NULL THEN
      EXECUTE 'ALTER INDEX idx_deliveries_user_period RENAME TO idx_notification_outbox_user_scope';
    ELSIF to_regclass('public.idx_notification_outbox_user_period') IS NOT NULL THEN
      EXECUTE 'ALTER INDEX idx_notification_outbox_user_period RENAME TO idx_notification_outbox_user_scope';
    ELSIF to_regclass('public.idx_deliveries_user_scope') IS NOT NULL THEN
      EXECUTE 'ALTER INDEX idx_deliveries_user_scope RENAME TO idx_notification_outbox_user_scope';
    END IF;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_notification_outbox_user_scope
ON notificationoutbox(user_id, scope_key);

ALTER INDEX IF EXISTS idx_deliveries_created_at
RENAME TO idx_notification_outbox_created_at;

CREATE INDEX IF NOT EXISTS idx_notification_outbox_created_at
ON notificationoutbox(created_at DESC);

DROP INDEX IF EXISTS idx_deliveries_notification;

DROP INDEX IF EXISTS idx_notification_outbox_reference;

CREATE INDEX IF NOT EXISTS idx_notification_outbox_reference
ON notificationoutbox(notification_type, reference_id)
WHERE reference_id IS NOT NULL;

ALTER INDEX IF EXISTS idx_deliveries_status_pending
RENAME TO idx_notification_outbox_status_pending;

CREATE INDEX IF NOT EXISTS idx_notification_outbox_status_pending
ON notificationoutbox(status)
WHERE status IN ('pending', 'failed_transient');

ALTER INDEX IF EXISTS idx_deliveries_sending_stuck
RENAME TO idx_notification_outbox_sending_stuck;

CREATE INDEX IF NOT EXISTS idx_notification_outbox_sending_stuck
ON notificationoutbox(last_attempt_at)
WHERE status = 'sending';

ALTER INDEX IF EXISTS idx_deliveries_resend_email_id
RENAME TO idx_notification_outbox_resend_email_id;

CREATE INDEX IF NOT EXISTS idx_notification_outbox_resend_email_id
ON notificationoutbox(resend_email_id)
WHERE resend_email_id IS NOT NULL;

DROP INDEX IF EXISTS idx_deliveries_email_batch;

COMMENT ON TABLE notifications IS
'User-owned notification preferences and subscriptions. Sent or queued notification records live in NotificationOutbox.';

COMMENT ON TABLE notificationoutbox IS
'Durable notification outbox used for deduplication, compose/send lifecycle, audit, and recovery.';
