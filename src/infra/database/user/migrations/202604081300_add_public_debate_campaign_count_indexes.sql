CREATE INDEX IF NOT EXISTS idx_notifications_funky_global_active_type_user
ON notifications(notification_type, user_id)
WHERE notification_type = 'funky:notification:global'
  AND is_active = TRUE;

CREATE INDEX IF NOT EXISTS idx_notifications_funky_entity_active_type_entity_user
ON notifications(notification_type, entity_cui, user_id)
WHERE notification_type = 'funky:notification:entity_updates'
  AND is_active = TRUE
  AND entity_cui IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_notifications_global_unsubscribe_type_user
ON notifications(notification_type, user_id)
WHERE notification_type = 'global_unsubscribe';
