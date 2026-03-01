-- Add public view counter for advanced map analytics maps.
-- Forward-only and idempotent.

ALTER TABLE AdvancedMapAnalyticsMaps
ADD COLUMN IF NOT EXISTS public_view_count INT;

UPDATE AdvancedMapAnalyticsMaps
SET public_view_count = 0
WHERE public_view_count IS NULL;

ALTER TABLE AdvancedMapAnalyticsMaps
ALTER COLUMN public_view_count SET DEFAULT 0;

ALTER TABLE AdvancedMapAnalyticsMaps
ALTER COLUMN public_view_count SET NOT NULL;

ALTER TABLE AdvancedMapAnalyticsMaps
DROP CONSTRAINT IF EXISTS advanced_map_analytics_maps_public_view_count_check;

ALTER TABLE AdvancedMapAnalyticsMaps
ADD CONSTRAINT advanced_map_analytics_maps_public_view_count_check
CHECK (public_view_count >= 0);
