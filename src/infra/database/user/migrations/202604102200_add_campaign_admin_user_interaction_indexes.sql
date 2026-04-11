CREATE INDEX IF NOT EXISTS idx_userinteractions_funky_review_updated_at
ON userinteractions(updated_at DESC, user_id, record_key)
WHERE record->>'interactionId' IN (
  'funky:interaction:public_debate_request',
  'funky:interaction:city_hall_website',
  'funky:interaction:budget_document',
  'funky:interaction:budget_publication_date',
  'funky:interaction:budget_status',
  'funky:interaction:city_hall_contact',
  'funky:interaction:funky_participation',
  'funky:interaction:budget_contestation'
);

CREATE INDEX IF NOT EXISTS idx_userinteractions_funky_review_entity_updated_at
ON userinteractions(
  ((record->'scope'->>'entityCui')),
  updated_at DESC,
  user_id,
  record_key
)
WHERE record->>'interactionId' IN (
    'funky:interaction:public_debate_request',
    'funky:interaction:city_hall_website',
    'funky:interaction:budget_document',
    'funky:interaction:budget_publication_date',
    'funky:interaction:budget_status',
    'funky:interaction:city_hall_contact',
    'funky:interaction:funky_participation',
    'funky:interaction:budget_contestation'
  )
  AND record->'scope'->>'type' = 'entity';

CREATE INDEX IF NOT EXISTS idx_userinteractions_funky_review_submission_path_updated_at
ON userinteractions(
  ((record->'value'->'json'->'value'->>'submissionPath')),
  updated_at DESC,
  user_id,
  record_key
)
WHERE record->>'interactionId' IN (
    'funky:interaction:public_debate_request',
    'funky:interaction:budget_contestation'
  )
  AND record->'value'->>'kind' = 'json';
