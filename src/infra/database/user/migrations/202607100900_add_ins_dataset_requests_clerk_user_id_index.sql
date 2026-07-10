-- Every Clerk user.deleted anonymization runs
--   UPDATE ins_dataset_requests ... WHERE clerk_user_id IN (...)
-- which had no supporting index. Partial, because anonymous rows store no
-- clerk_user_id and are never matched by that lookup.

CREATE INDEX IF NOT EXISTS idx_ins_dataset_requests_clerk_user_id
ON ins_dataset_requests(clerk_user_id)
WHERE clerk_user_id IS NOT NULL;
