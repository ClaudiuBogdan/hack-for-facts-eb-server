-- Rewrite legacy learning-progress `error` phases to `failed` so runtime
-- types and repository mapping can drop compatibility shims.

UPDATE UserInteractions
SET record = jsonb_set(record, '{phase}', '"failed"'::jsonb)
WHERE record->>'phase' = 'error';

UPDATE UserInteractions
SET audit_events = COALESCE(
  (
    SELECT jsonb_agg(
      CASE
        WHEN audit_event->>'type' = 'evaluated' AND audit_event->>'phase' = 'error'
          THEN jsonb_set(audit_event, '{phase}', '"failed"'::jsonb)
        ELSE audit_event
      END
      ORDER BY ordinality
    )
    FROM jsonb_array_elements(audit_events) WITH ORDINALITY AS events(audit_event, ordinality)
  ),
  '[]'::jsonb
)
WHERE EXISTS (
  SELECT 1
  FROM jsonb_array_elements(audit_events) AS events(audit_event)
  WHERE events.audit_event->>'type' = 'evaluated'
    AND events.audit_event->>'phase' = 'error'
);
