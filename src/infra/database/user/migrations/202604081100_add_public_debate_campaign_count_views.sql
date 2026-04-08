CREATE OR REPLACE VIEW v_public_debate_campaign_user_total AS
WITH globally_unsubscribed_users AS (
  SELECT DISTINCT n.user_id
  FROM notifications AS n
  WHERE n.notification_type = 'global_unsubscribe'
    AND (
      n.is_active = FALSE
      OR n.config->'channels'->>'email' = 'false'
    )
)
SELECT
  'funky'::TEXT AS campaign_key,
  COUNT(DISTINCT n.user_id) AS total_users
FROM notifications AS n
LEFT JOIN globally_unsubscribed_users AS gu ON gu.user_id = n.user_id
WHERE n.notification_type = 'funky:notification:global'
  AND n.is_active = TRUE
  AND gu.user_id IS NULL;

CREATE OR REPLACE VIEW v_public_debate_uat_user_counts AS
WITH active_public_debate_global_users AS (
  SELECT DISTINCT n.user_id
  FROM notifications AS n
  WHERE n.notification_type = 'funky:notification:global'
    AND n.is_active = TRUE
),
globally_unsubscribed_users AS (
  SELECT DISTINCT n.user_id
  FROM notifications AS n
  WHERE n.notification_type = 'global_unsubscribe'
    AND (
      n.is_active = FALSE
      OR n.config->'channels'->>'email' = 'false'
    )
)
SELECT
  'funky'::TEXT AS campaign_key,
  n.entity_cui,
  COUNT(DISTINCT n.user_id) AS total_users
FROM notifications AS n
INNER JOIN active_public_debate_global_users AS g ON g.user_id = n.user_id
LEFT JOIN globally_unsubscribed_users AS gu ON gu.user_id = n.user_id
WHERE n.notification_type = 'funky:notification:entity_updates'
  AND n.is_active = TRUE
  AND n.entity_cui IS NOT NULL
  AND gu.user_id IS NULL
GROUP BY n.entity_cui;

COMMENT ON VIEW v_public_debate_campaign_user_total IS
'Distinct active public debate campaign users, excluding globally unsubscribed users.';

COMMENT ON VIEW v_public_debate_uat_user_counts IS
'Distinct active public debate users per UAT/entity, excluding globally unsubscribed users.';
