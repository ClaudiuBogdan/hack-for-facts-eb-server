CREATE TABLE IF NOT EXISTS advancedmapdatasets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id UUID NOT NULL UNIQUE,
  user_id TEXT NOT NULL,
  title VARCHAR(255) NOT NULL,
  description VARCHAR(2000) NULL,
  markdown_text TEXT NULL,
  unit VARCHAR(100) NULL,
  visibility TEXT NOT NULL DEFAULT 'private',
  row_count INT NOT NULL DEFAULT 0,
  reference_count INT NOT NULL DEFAULT 0,
  replaced_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ NULL,
  CONSTRAINT advanced_map_datasets_visibility_check
    CHECK (visibility IN ('private', 'unlisted', 'public')),
  CONSTRAINT advanced_map_datasets_row_count_check
    CHECK (row_count >= 0),
  CONSTRAINT advanced_map_datasets_reference_count_check
    CHECK (reference_count >= 0)
);

CREATE INDEX IF NOT EXISTS idx_advanced_map_datasets_user_updated
ON advancedmapdatasets(user_id, updated_at DESC)
WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_advanced_map_datasets_public_visibility_updated
ON advancedmapdatasets(visibility, updated_at DESC)
WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS advancedmapdatasetrows (
  dataset_id UUID NOT NULL REFERENCES advancedmapdatasets(id) ON DELETE CASCADE,
  siruta_code VARCHAR(20) NOT NULL,
  value_number NUMERIC NULL,
  value_json JSONB NULL,
  CONSTRAINT advanced_map_dataset_rows_value_presence_check
    CHECK (value_number IS NOT NULL OR value_json IS NOT NULL),
  PRIMARY KEY (dataset_id, siruta_code)
);

CREATE OR REPLACE FUNCTION is_valid_advanced_map_dataset_row_payload(payload JSONB)
RETURNS BOOLEAN AS $$
  SELECT
    payload IS NULL OR (
      jsonb_typeof(payload) = 'object'
      AND payload ?& ARRAY['type', 'value']
      AND NOT EXISTS (
        SELECT 1
        FROM jsonb_object_keys(payload) AS top_key(key)
        WHERE top_key.key NOT IN ('type', 'value')
      )
      AND jsonb_typeof(payload->'type') = 'string'
      AND CASE payload->>'type'
        WHEN 'text' THEN
          jsonb_typeof(payload->'value') = 'object'
          AND (payload->'value') ? 'text'
          AND NOT EXISTS (
            SELECT 1
            FROM jsonb_object_keys(payload->'value') AS text_key(key)
            WHERE text_key.key <> 'text'
          )
          AND jsonb_typeof(payload->'value'->'text') = 'string'
          AND btrim(payload->'value'->>'text') <> ''
        WHEN 'markdown' THEN
          jsonb_typeof(payload->'value') = 'object'
          AND (payload->'value') ? 'markdown'
          AND NOT EXISTS (
            SELECT 1
            FROM jsonb_object_keys(payload->'value') AS markdown_key(key)
            WHERE markdown_key.key <> 'markdown'
          )
          AND jsonb_typeof(payload->'value'->'markdown') = 'string'
          AND btrim(payload->'value'->>'markdown') <> ''
        WHEN 'link' THEN
          jsonb_typeof(payload->'value') = 'object'
          AND (payload->'value') ? 'url'
          AND (payload->'value') ? 'label'
          AND NOT EXISTS (
            SELECT 1
            FROM jsonb_object_keys(payload->'value') AS link_key(key)
            WHERE link_key.key NOT IN ('url', 'label')
          )
          AND jsonb_typeof(payload->'value'->'url') = 'string'
          AND btrim(payload->'value'->>'url') ~* '^https?://'
          AND (
            payload->'value'->'label' = 'null'::jsonb
            OR jsonb_typeof(payload->'value'->'label') = 'string'
          )
        ELSE FALSE
      END
    );
$$ LANGUAGE sql IMMUTABLE;
ALTER TABLE advancedmapdatasetrows
ADD CONSTRAINT advanced_map_dataset_rows_value_json_payload_check
CHECK (is_valid_advanced_map_dataset_row_payload(value_json));

CREATE INDEX IF NOT EXISTS idx_advanced_map_dataset_rows_dataset
ON advancedmapdatasetrows(dataset_id);
