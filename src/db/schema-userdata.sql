-- Short links for sharing client-approved URLs
CREATE TABLE IF NOT EXISTS ShortLinks (
  id BIGSERIAL PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  user_ids TEXT[] NOT NULL,
  original_url TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  access_count INTEGER NOT NULL DEFAULT 0,
  last_access_at TIMESTAMPTZ,
  metadata JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_shortlinks_user_ids ON ShortLinks USING GIN(user_ids);
CREATE INDEX IF NOT EXISTS idx_shortlinks_code ON ShortLinks(code);
CREATE INDEX IF NOT EXISTS idx_shortlinks_original_url ON ShortLinks(original_url);
CREATE INDEX IF NOT EXISTS idx_shortlinks_created_at ON ShortLinks(created_at);

