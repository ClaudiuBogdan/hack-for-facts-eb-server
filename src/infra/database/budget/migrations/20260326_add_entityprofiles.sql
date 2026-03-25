CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS EntityProfiles (
    cui VARCHAR(20) PRIMARY KEY,
    profile_type VARCHAR(10) NOT NULL CHECK (profile_type IN ('uat', 'public')),
    institution_name TEXT,
    institution_type VARCHAR(50),
    website_url TEXT,
    official_email TEXT,
    phone_primary TEXT,
    address_raw TEXT,
    address_locality TEXT,
    county_code CHAR(2),
    county_name VARCHAR(50),
    leader_name TEXT,
    leader_title TEXT,
    leader_party TEXT,
    scraped_at TIMESTAMPTZ NOT NULL,
    extraction_confidence NUMERIC(3, 2) CHECK (extraction_confidence BETWEEN 0 AND 1),
    full_profile JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (cui) REFERENCES Entities(cui) ON DELETE CASCADE
);

COMMENT ON TABLE EntityProfiles IS 'Latest scraped entity website profile data. One row per entity, with curated fields promoted for API reads.';
COMMENT ON COLUMN EntityProfiles.cui IS 'FK to Entities(cui). Also serves as PK since we store one profile snapshot per entity.';
COMMENT ON COLUMN EntityProfiles.profile_type IS 'Relational discriminator for the stored full_profile shape. Mirrors full_profile.type and is limited to uat or public.';
COMMENT ON COLUMN EntityProfiles.institution_type IS 'Self-reported institution type from the scraped website, distinct from Entities.entity_type.';
COMMENT ON COLUMN EntityProfiles.county_code IS 'Canonical county code for filtering, sourced from entity metadata/UAT linkage, never from scraped address text.';
COMMENT ON COLUMN EntityProfiles.county_name IS 'Canonical county name for display/debugging, sourced from entity metadata/UAT linkage, never from scraped address text.';
COMMENT ON COLUMN EntityProfiles.full_profile IS 'Complete normalized scraper payload kept for internal/audit use. Not exposed directly through the API.';

ALTER TABLE EntityProfiles
    ADD COLUMN IF NOT EXISTS profile_type VARCHAR(10);

UPDATE EntityProfiles
SET profile_type = full_profile->>'type'
WHERE profile_type IS NULL
  AND full_profile ? 'type'
  AND full_profile->>'type' IN ('uat', 'public');

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'entityprofiles_profile_type_check'
      AND conrelid = 'entityprofiles'::regclass
  ) THEN
    ALTER TABLE EntityProfiles
      ADD CONSTRAINT entityprofiles_profile_type_check
      CHECK (profile_type IN ('uat', 'public'));
  END IF;
END $$;

ALTER TABLE EntityProfiles
    ALTER COLUMN profile_type SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_entity_profiles_profile_type ON EntityProfiles (profile_type);
CREATE INDEX IF NOT EXISTS idx_entity_profiles_county_code ON EntityProfiles (county_code)
    WHERE county_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_entity_profiles_institution_type ON EntityProfiles (institution_type)
    WHERE institution_type IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_entity_profiles_county_code_type ON EntityProfiles (county_code, institution_type)
    WHERE county_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_entity_profiles_scraped_at ON EntityProfiles (scraped_at);
CREATE INDEX IF NOT EXISTS idx_entity_profiles_full_profile_gin ON EntityProfiles USING gin (full_profile jsonb_path_ops);
CREATE INDEX IF NOT EXISTS idx_gin_entity_profiles_name ON EntityProfiles USING gin (institution_name gin_trgm_ops);
