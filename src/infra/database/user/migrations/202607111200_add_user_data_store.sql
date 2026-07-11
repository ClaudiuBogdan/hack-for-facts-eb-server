-- User Data Store v2 persistence. Mirrors the user-data section in schema.sql
-- and is safe when schema.sql has already created the objects.

CREATE TABLE IF NOT EXISTS user_data_records (
  record_id           UUID PRIMARY KEY,
  owner_id            TEXT NOT NULL,
  category            TEXT NOT NULL,
  logical_key         TEXT NOT NULL,
  target_type         TEXT,
  target_id           TEXT,
  schema_version      INTEGER NOT NULL,
  schema_hash         TEXT NOT NULL,
  revision            BIGINT NOT NULL CHECK (revision > 0),
  status              TEXT NOT NULL CHECK (status IN ('active', 'deleted')),
  payload             JSONB,
  annotations         JSONB,
  last_event_seq      BIGINT NOT NULL,
  last_event_id       UUID NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL,
  updated_at          TIMESTAMPTZ NOT NULL,
  deleted_at          TIMESTAMPTZ,
  privacy_redacted_at TIMESTAMPTZ,
  CONSTRAINT user_data_records_identity UNIQUE (owner_id, category, logical_key),
  CONSTRAINT user_data_records_lifecycle CHECK (
    (status = 'active' AND payload IS NOT NULL AND jsonb_typeof(payload) = 'object' AND deleted_at IS NULL)
    OR
    (status = 'deleted' AND payload IS NULL AND annotations IS NULL AND deleted_at IS NOT NULL)
  ),
  CONSTRAINT user_data_records_target CHECK ((target_type IS NULL) = (target_id IS NULL)),
  CONSTRAINT user_data_records_annotations CHECK (annotations IS NULL OR jsonb_typeof(annotations) = 'object'),
  CONSTRAINT user_data_records_payload_size CHECK (payload IS NULL OR pg_column_size(payload) <= 65536)
);

CREATE INDEX IF NOT EXISTS user_data_records_sync_idx
ON user_data_records (owner_id, last_event_seq);

CREATE INDEX IF NOT EXISTS user_data_records_list_idx
ON user_data_records (owner_id, category, record_id);

CREATE INDEX IF NOT EXISTS user_data_records_target_idx
ON user_data_records (owner_id, category, target_type, target_id)
WHERE target_type IS NOT NULL;

CREATE INDEX IF NOT EXISTS user_data_records_funky_interaction_id_idx
ON user_data_records ((payload->>'interactionId'))
WHERE category = 'funky.interaction';

CREATE INDEX IF NOT EXISTS user_data_records_funky_phase_idx
ON user_data_records ((payload->>'phase'))
WHERE category = 'funky.interaction';

CREATE SEQUENCE IF NOT EXISTS user_data_event_seq;

CREATE TABLE IF NOT EXISTS user_data_events (
  event_seq            BIGINT PRIMARY KEY,
  event_id             UUID NOT NULL UNIQUE,
  record_id            UUID NOT NULL REFERENCES user_data_records (record_id),
  owner_id             TEXT NOT NULL,
  category             TEXT NOT NULL,
  logical_key          TEXT NOT NULL,
  target_type          TEXT,
  target_id            TEXT,
  revision             BIGINT NOT NULL,
  operation            TEXT NOT NULL CHECK (operation IN ('create','replace','annotate','delete','restore','migrate','legacy_import')),
  scope                TEXT NOT NULL CHECK (scope IN ('payload','annotation')),
  annotation_namespace TEXT,
  schema_version       INTEGER NOT NULL,
  schema_hash          TEXT NOT NULL,
  payload              JSONB,
  annotations          JSONB,
  actor_type           TEXT NOT NULL CHECK (actor_type IN ('owner','system','admin')),
  actor_id             TEXT,
  actor_reason         TEXT,
  provenance           TEXT NOT NULL CHECK (provenance IN ('live','legacy')),
  integrity            TEXT NOT NULL CHECK (integrity IN ('verified','unverified')),
  recorded_at          TIMESTAMPTZ NOT NULL,
  client_occurred_at   TIMESTAMPTZ,
  source_event_id      TEXT,
  source_occurred_at   TIMESTAMPTZ,
  privacy_redacted_at  TIMESTAMPTZ,
  CONSTRAINT user_data_events_record_revision UNIQUE (record_id, revision),
  CONSTRAINT user_data_events_annotate_ns CHECK ((scope = 'annotation') = (annotation_namespace IS NOT NULL)),
  CONSTRAINT user_data_events_admin_attrib CHECK (actor_type <> 'admin' OR (actor_id IS NOT NULL AND actor_reason IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS user_data_events_owner_idx
ON user_data_events (owner_id, event_seq);

CREATE TABLE IF NOT EXISTS user_data_idempotency_receipts (
  requester_id           TEXT NOT NULL,
  idempotency_key_hash   TEXT NOT NULL,
  canonical_request_hash TEXT NOT NULL,
  event_id               UUID NOT NULL,
  event_seq              BIGINT NOT NULL,
  created_at             TIMESTAMPTZ NOT NULL,
  expires_at             TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (requester_id, idempotency_key_hash)
);

CREATE OR REPLACE FUNCTION user_data_events_append_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'user_data_events is append-only';
  END IF;
  IF current_setting('app.user_data_maintenance', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'user_data_events may only be updated by the maintenance path';
  END IF;
  IF NEW.privacy_redacted_at IS NULL THEN
    RAISE EXCEPTION 'user_data_events update must record privacy redaction';
  END IF;
  IF NEW.event_seq IS DISTINCT FROM OLD.event_seq
     OR NEW.event_id IS DISTINCT FROM OLD.event_id
     OR NEW.record_id IS DISTINCT FROM OLD.record_id
     OR NEW.category IS DISTINCT FROM OLD.category
     OR NEW.logical_key IS DISTINCT FROM OLD.logical_key
     OR NEW.revision IS DISTINCT FROM OLD.revision
     OR NEW.operation IS DISTINCT FROM OLD.operation
     OR NEW.scope IS DISTINCT FROM OLD.scope
     OR NEW.annotation_namespace IS DISTINCT FROM OLD.annotation_namespace
     OR NEW.schema_version IS DISTINCT FROM OLD.schema_version
     OR NEW.schema_hash IS DISTINCT FROM OLD.schema_hash
     OR NEW.actor_type IS DISTINCT FROM OLD.actor_type
     OR NEW.actor_reason IS DISTINCT FROM OLD.actor_reason
     OR NEW.provenance IS DISTINCT FROM OLD.provenance
     OR NEW.integrity IS DISTINCT FROM OLD.integrity
     OR NEW.recorded_at IS DISTINCT FROM OLD.recorded_at THEN
    RAISE EXCEPTION 'user_data_events update touches immutable columns';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS user_data_events_append_only ON user_data_events;
CREATE TRIGGER user_data_events_append_only
  BEFORE UPDATE OR DELETE ON user_data_events
  FOR EACH ROW EXECUTE FUNCTION user_data_events_append_only();
