UPDATE notificationoutbox
SET scope_key = 'digest:anaf_forexebug:' || scope_key
WHERE notification_type = 'anaf_forexebug_digest'
  AND scope_key !~ '^digest:anaf_forexebug:'
  AND scope_key ~ '^\d{4}-(0[1-9]|1[0-2])$';
