DROP INDEX IF EXISTS idx_learningprogress_review_pending_updated_at;
DROP INDEX IF EXISTS idx_learningprogress_review_status_updated_at;
DROP INDEX IF EXISTS idx_learningprogress_user_updated_seq;
DROP TABLE IF EXISTS LearningProgress CASCADE;
DROP SEQUENCE IF EXISTS learningprogress_updated_seq;

CREATE SEQUENCE IF NOT EXISTS userinteractions_updated_seq;

CREATE TABLE IF NOT EXISTS UserInteractions (
  user_id TEXT NOT NULL,
  record_key TEXT NOT NULL,
  record JSONB NOT NULL,
  audit_events JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_seq BIGINT NOT NULL DEFAULT nextval('userinteractions_updated_seq'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, record_key)
);

CREATE INDEX IF NOT EXISTS idx_userinteractions_user_updated_seq
ON UserInteractions(user_id, updated_seq);

CREATE INDEX IF NOT EXISTS idx_userinteractions_user_record_key_prefix
ON UserInteractions(user_id, record_key text_pattern_ops);

CREATE INDEX IF NOT EXISTS idx_userinteractions_record_key_prefix
ON UserInteractions(record_key text_pattern_ops);

DROP INDEX IF EXISTS idx_userinteractions_review_pending_updated_at;
DROP INDEX IF EXISTS idx_userinteractions_review_status_updated_at;

CREATE INDEX IF NOT EXISTS idx_userinteractions_review_pending_updated_at
ON UserInteractions(updated_at DESC, user_id, record_key)
WHERE record->>'phase' = 'pending';

CREATE INDEX IF NOT EXISTS idx_userinteractions_review_status_updated_at
ON UserInteractions (
  ((record->'review'->>'status')),
  updated_at DESC,
  user_id,
  record_key
)
WHERE record ? 'review';
