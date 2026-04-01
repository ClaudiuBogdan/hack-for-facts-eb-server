DO $$
BEGIN
  IF to_regclass('public.notificationoutbox') IS NOT NULL
     AND to_regclass('public.notificationsoutbox') IS NULL THEN
    EXECUTE 'ALTER TABLE notificationoutbox RENAME TO notificationsoutbox';
  END IF;
END $$;

DO $$
DECLARE
  notifications_outbox_regclass REGCLASS := to_regclass('public.notificationsoutbox');
BEGIN
  IF notifications_outbox_regclass IS NOT NULL
     AND EXISTS (
       SELECT 1
       FROM pg_constraint
       WHERE conname = 'notificationoutbox_delivery_key_key'
         AND conrelid = notifications_outbox_regclass
     ) THEN
    EXECUTE '
      ALTER TABLE notificationsoutbox
      RENAME CONSTRAINT notificationoutbox_delivery_key_key
      TO notificationsoutbox_delivery_key_key
    ';
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public.notificationsoutbox') IS NOT NULL THEN
    EXECUTE $comment$
      COMMENT ON TABLE notificationsoutbox IS
      'Durable notification outbox used for deduplication, compose/send lifecycle, audit, and recovery.'
    $comment$;
  END IF;
END $$;

COMMENT ON TABLE notifications IS
'User-owned notification preferences and subscriptions. Sent or queued notification records live in NotificationsOutbox.';
