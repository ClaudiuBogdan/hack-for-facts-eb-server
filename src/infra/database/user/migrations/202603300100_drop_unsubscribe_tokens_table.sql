-- Migration: Remove UnsubscribeTokens table and related FK
--
-- Unsubscribe links will use signed HMAC tokens instead of database rows.
-- The user's global_unsubscribe Notification row (is_active column) is the
-- single source of truth for opt-out state.

-- 1. Drop the FK column from NotificationOutbox
ALTER TABLE NotificationOutbox
  DROP COLUMN IF EXISTS unsubscribe_token;

-- 2. Drop the UnsubscribeTokens table and its indexes
DROP INDEX IF EXISTS idx_unsubscribe_tokens_user;
DROP INDEX IF EXISTS idx_unsubscribe_tokens_expires;
DROP INDEX IF EXISTS idx_unsubscribe_tokens_notification;
DROP TABLE IF EXISTS UnsubscribeTokens;
