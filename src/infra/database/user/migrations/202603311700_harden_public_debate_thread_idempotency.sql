WITH ranked_platform_send AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY entity_cui, COALESCE(campaign_key, record->>'campaignKey', record->>'campaign', '')
      ORDER BY created_at DESC, id DESC
    ) AS duplicate_rank
  FROM InstitutionEmailThreads
  WHERE record->>'submissionPath' = 'platform_send'
    AND phase <> 'failed'
)
UPDATE InstitutionEmailThreads
SET phase = 'failed',
    updated_at = NOW()
WHERE id IN (
  SELECT id
  FROM ranked_platform_send
  WHERE duplicate_rank > 1
);

WITH ranked_self_send AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY
        entity_cui,
        COALESCE(campaign_key, record->>'campaignKey', record->>'campaign', ''),
        record->'metadata'->>'interactionKey'
      ORDER BY created_at DESC, id DESC
    ) AS duplicate_rank
  FROM InstitutionEmailThreads
  WHERE record->>'submissionPath' = 'self_send_cc'
    AND record->'metadata'->>'interactionKey' IS NOT NULL
)
UPDATE InstitutionEmailThreads AS thread
SET phase = 'failed',
    updated_at = NOW(),
    record = jsonb_set(
      thread.record,
      '{metadata,interactionKey}',
      to_jsonb((thread.record->'metadata'->>'interactionKey') || '#deduped:' || thread.id),
      true
    )
WHERE thread.id IN (
  SELECT id
  FROM ranked_self_send
  WHERE duplicate_rank > 1
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_institution_email_threads_platform_send_active_unique
ON InstitutionEmailThreads(
  entity_cui,
  COALESCE(campaign_key, record->>'campaignKey', record->>'campaign', '')
)
WHERE record->>'submissionPath' = 'platform_send' AND phase <> 'failed';

CREATE UNIQUE INDEX IF NOT EXISTS idx_institution_email_threads_self_send_interaction_unique
ON InstitutionEmailThreads(
  entity_cui,
  COALESCE(campaign_key, record->>'campaignKey', record->>'campaign', ''),
  (record->'metadata'->>'interactionKey')
)
WHERE record->>'submissionPath' = 'self_send_cc'
  AND record->'metadata'->>'interactionKey' IS NOT NULL;
