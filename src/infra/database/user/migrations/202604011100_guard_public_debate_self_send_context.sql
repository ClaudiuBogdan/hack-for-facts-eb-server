DO $$
DECLARE
  legacy_record RECORD;
BEGIN
  SELECT user_id, record_key
  INTO legacy_record
  FROM UserInteractions
  WHERE record->>'interactionId' = 'campaign:debate-request'
    AND COALESCE(record->'value'->'json'->'value'->>'submissionPath', '') = 'send_yourself'
    AND (
      NULLIF(BTRIM(COALESCE(record->'value'->'json'->'value'->>'ngoSenderEmail', '')), '') IS NULL
      OR NULLIF(BTRIM(COALESCE(record->'value'->'json'->'value'->>'preparedSubject', '')), '') IS NULL
    )
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION 'Public debate self-send rollout blocked: found send_yourself interactions missing ngoSenderEmail or preparedSubject.'
      USING DETAIL = FORMAT(
        'user_id=%s record_key=%s',
        legacy_record.user_id,
        legacy_record.record_key
      );
  END IF;
END $$;
