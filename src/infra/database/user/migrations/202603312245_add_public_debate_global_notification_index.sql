CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_funky_global_user
ON Notifications(user_id, notification_type)
WHERE notification_type = 'funky:notification:global';
