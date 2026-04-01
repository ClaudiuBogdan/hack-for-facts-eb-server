DO $$
BEGIN
  IF to_regclass('public.shortlinks') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE shortlinks ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ';
    EXECUTE 'UPDATE shortlinks SET created_at = COALESCE(last_access_at, NOW()) WHERE created_at IS NULL';
    EXECUTE 'ALTER TABLE shortlinks ALTER COLUMN created_at SET NOT NULL';
    EXECUTE 'ALTER TABLE shortlinks ALTER COLUMN created_at SET DEFAULT NOW()';
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public.notifications') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE notifications ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ';
    EXECUTE 'UPDATE notifications SET created_at = COALESCE(updated_at, NOW()) WHERE created_at IS NULL';
    EXECUTE 'ALTER TABLE notifications ALTER COLUMN created_at SET NOT NULL';
    EXECUTE 'ALTER TABLE notifications ALTER COLUMN created_at SET DEFAULT NOW()';
  END IF;
END $$;

DO $$
DECLARE
  outbox_table REGCLASS := COALESCE(
    to_regclass('public.notificationsoutbox'),
    to_regclass('public.notificationoutbox')
  );
BEGIN
  IF outbox_table IS NOT NULL THEN
    EXECUTE format(
      'ALTER TABLE %s ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ',
      outbox_table::text
    );
    EXECUTE format(
      'UPDATE %s SET created_at = COALESCE(sent_at, last_attempt_at, NOW()) WHERE created_at IS NULL',
      outbox_table::text
    );
    EXECUTE format('ALTER TABLE %s ALTER COLUMN created_at SET NOT NULL', outbox_table::text);
    EXECUTE format('ALTER TABLE %s ALTER COLUMN created_at SET DEFAULT NOW()', outbox_table::text);
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public.userinteractions') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE userinteractions ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ';
    EXECUTE 'UPDATE userinteractions SET created_at = COALESCE(updated_at, NOW()) WHERE created_at IS NULL';
    EXECUTE 'ALTER TABLE userinteractions ALTER COLUMN created_at SET NOT NULL';
    EXECUTE 'ALTER TABLE userinteractions ALTER COLUMN created_at SET DEFAULT NOW()';
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public.institutionemailthreads') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE institutionemailthreads ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ';
    EXECUTE '
      UPDATE institutionemailthreads
      SET created_at = COALESCE(updated_at, last_email_at, last_reply_at, next_action_at, NOW())
      WHERE created_at IS NULL
    ';
    EXECUTE 'ALTER TABLE institutionemailthreads ALTER COLUMN created_at SET NOT NULL';
    EXECUTE 'ALTER TABLE institutionemailthreads ALTER COLUMN created_at SET DEFAULT NOW()';
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public.advancedmapanalyticsmaps') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE advancedmapanalyticsmaps ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ';
    EXECUTE '
      UPDATE advancedmapanalyticsmaps
      SET created_at = COALESCE(updated_at, deleted_at, NOW())
      WHERE created_at IS NULL
    ';
    EXECUTE 'ALTER TABLE advancedmapanalyticsmaps ALTER COLUMN created_at SET NOT NULL';
    EXECUTE 'ALTER TABLE advancedmapanalyticsmaps ALTER COLUMN created_at SET DEFAULT NOW()';
  END IF;
END $$;
