CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_public_debate_global_user
ON Notifications(user_id, notification_type)
WHERE notification_type = 'campaign_public_debate_global';
