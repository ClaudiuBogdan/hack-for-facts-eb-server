-- ============================================================================
-- INS Tempo Statistical Data - PostgreSQL Schema
-- ============================================================================
-- Two-layer architecture:
--   1. Canonical    - Normalized, deduplicated entities
--   2. API Views    - Optimized for REST/GraphQL consumption
-- ============================================================================

-- Extensions
CREATE EXTENSION IF NOT EXISTS ltree;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS unaccent;

-- ============================================================================
-- ENUMS
-- ============================================================================

CREATE TYPE periodicity AS ENUM ('ANNUAL', 'QUARTERLY', 'MONTHLY');
CREATE TYPE territory_level AS ENUM ('NATIONAL', 'NUTS1', 'NUTS2', 'NUTS3', 'LAU');
CREATE TYPE sync_status AS ENUM ('PENDING', 'SYNCING', 'SYNCED', 'FAILED', 'STALE');
CREATE TYPE dimension_type AS ENUM ('TEMPORAL', 'TERRITORIAL', 'CLASSIFICATION', 'UNIT_OF_MEASURE');

-- ============================================================================
-- CANONICAL LAYER - Normalized entities
-- ============================================================================

-- Contexts (domain hierarchy)
CREATE TABLE contexts (
    id SERIAL PRIMARY KEY,
    ins_code TEXT NOT NULL UNIQUE,
    names JSONB NOT NULL DEFAULT '{}',  -- {"ro": "...", "en": "..."}
    level SMALLINT DEFAULT 0,
    parent_id INTEGER REFERENCES contexts(id),
    path ltree NOT NULL UNIQUE,  -- Unique path ensures hierarchy integrity
    children_type TEXT DEFAULT 'context',  -- 'context' or 'matrix'
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT chk_context_children_type
      CHECK (children_type IN ('context', 'matrix'))
);

CREATE INDEX idx_contexts_path ON contexts USING gist(path);
CREATE INDEX idx_contexts_parent ON contexts(parent_id);
CREATE INDEX idx_contexts_names ON contexts USING gin(names);

-- Territories (NUTS + LAU hierarchy)
CREATE TABLE territories (
    id SERIAL PRIMARY KEY,
    code TEXT NOT NULL UNIQUE,
    siruta_code TEXT UNIQUE,
    level territory_level NOT NULL,
    path ltree NOT NULL UNIQUE,  -- Unique path ensures hierarchy integrity
    parent_id INTEGER REFERENCES territories(id),
    name TEXT NOT NULL,  -- Romanian name (use normalize function for comparisons)
    siruta_metadata JSONB,  -- Additional SIRUTA data (type, rang, etc.)
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_territories_path ON territories USING gist(path);
CREATE INDEX idx_territories_parent ON territories(parent_id);
CREATE INDEX idx_territories_name ON territories(name);
CREATE INDEX idx_territories_name_lower ON territories(LOWER(name));
CREATE INDEX idx_territories_level ON territories(level);
CREATE INDEX idx_territories_siruta ON territories(siruta_code) WHERE siruta_code IS NOT NULL;

-- Time periods
CREATE TABLE time_periods (
    id SERIAL PRIMARY KEY,
    year SMALLINT NOT NULL,
    quarter SMALLINT,
    month SMALLINT,
    periodicity periodicity NOT NULL,
    period_start DATE NOT NULL,
    period_end DATE NOT NULL,
    labels JSONB NOT NULL DEFAULT '{}',  -- {"ro": "Anul 2023", "en": "Year 2023"}
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (year, quarter, month, periodicity),
    CONSTRAINT valid_periodicity CHECK (
        (periodicity = 'ANNUAL' AND quarter IS NULL AND month IS NULL) OR
        (periodicity = 'QUARTERLY' AND quarter BETWEEN 1 AND 4 AND month IS NULL) OR
        (periodicity = 'MONTHLY' AND month BETWEEN 1 AND 12 AND quarter IS NULL)
    ),
    CONSTRAINT valid_quarter CHECK (quarter IS NULL OR quarter BETWEEN 1 AND 4),
    CONSTRAINT valid_month CHECK (month IS NULL OR month BETWEEN 1 AND 12)
);

CREATE INDEX idx_time_periods_year ON time_periods(year);
CREATE INDEX idx_time_periods_periodicity ON time_periods(periodicity);

-- Classification types (e.g., "Sexe", "Medii de rezidență", "Grupe de vârstă")
CREATE TABLE classification_types (
    id SERIAL PRIMARY KEY,
    code TEXT NOT NULL UNIQUE,
    names JSONB NOT NULL DEFAULT '{}',  -- {"ro": "Sexe", "en": "Sex"}
    is_hierarchical BOOLEAN DEFAULT FALSE,
    label_patterns TEXT[] DEFAULT '{}',  -- Patterns to identify this classification type
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_classification_types_names ON classification_types USING gin(names);

-- Classification values (actual values like "Masculin", "Urban", etc.)
CREATE TABLE classification_values (
    id SERIAL PRIMARY KEY,
    type_id INTEGER NOT NULL REFERENCES classification_types(id) ON DELETE CASCADE,
    code TEXT NOT NULL,
    content_hash TEXT NOT NULL,  -- SHA256 of normalized content for deduplication
    path ltree,                   -- For hierarchical classifications
    parent_id INTEGER REFERENCES classification_values(id),
    level SMALLINT DEFAULT 0,
    names JSONB NOT NULL DEFAULT '{}',  -- {"ro": "...", "en": "...", "normalized": "..."}
    sort_order INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (type_id, content_hash)
);

CREATE INDEX idx_classification_values_type ON classification_values(type_id);
CREATE INDEX idx_classification_values_path ON classification_values USING gist(path);
CREATE INDEX idx_classification_values_parent ON classification_values(parent_id);
CREATE INDEX idx_classification_values_names ON classification_values USING gin(names);
CREATE INDEX idx_classification_values_code ON classification_values(type_id, code);

-- Units of measure
CREATE TABLE units_of_measure (
    id SERIAL PRIMARY KEY,
    code TEXT NOT NULL UNIQUE,
    symbol TEXT,
    names JSONB NOT NULL DEFAULT '{}',  -- {"ro": "...", "en": "...", "normalized": "..."}
    label_patterns TEXT[] DEFAULT '{}', -- Patterns to identify this unit
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_units_names ON units_of_measure USING gin(names);

-- Matrices (datasets)
CREATE TABLE matrices (
    id SERIAL PRIMARY KEY,
    ins_code TEXT NOT NULL UNIQUE,
    context_id INTEGER REFERENCES contexts(id),
    metadata JSONB NOT NULL DEFAULT '{}',  -- Names, definitions, flags, etc.
    dimensions JSONB DEFAULT '[]',         -- Dimension summary
    sync_status sync_status DEFAULT 'PENDING',
    last_sync_at TIMESTAMPTZ,
    sync_error TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON COLUMN matrices.metadata IS 'Structure: {
  "names": {"ro": "...", "en": "..."},
  "definitions": {"ro": "...", "en": "..."},
  "methodologies": {"ro": "...", "en": "..."},
  "observations": {"ro": "...", "en": "..."},
  "periodicity": ["ANNUAL", "QUARTERLY"],
  "yearRange": [2010, 2024],
  "flags": {
    "hasUatData": boolean,
    "hasCountyData": boolean,
    "hasSiruta": boolean,
    "hasCaenRev1": boolean,
    "hasCaenRev2": boolean
  },
  "details": {...}
}';

CREATE INDEX idx_matrices_context ON matrices(context_id);
CREATE INDEX idx_matrices_metadata ON matrices USING gin(metadata);
CREATE INDEX idx_matrices_sync_status ON matrices(sync_status);

-- Matrix dimensions (defines each dimension of a matrix)
CREATE TABLE matrix_dimensions (
    id SERIAL PRIMARY KEY,
    matrix_id INTEGER NOT NULL REFERENCES matrices(id) ON DELETE CASCADE,
    dim_index SMALLINT NOT NULL,
    dimension_type dimension_type NOT NULL,
    labels JSONB NOT NULL DEFAULT '{}',  -- {"ro": "...", "en": "..."}
    classification_type_id INTEGER REFERENCES classification_types(id),
    is_hierarchical BOOLEAN DEFAULT FALSE,
    option_count INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT chk_matrix_dimensions_type CHECK (
        (dimension_type = 'CLASSIFICATION' AND classification_type_id IS NOT NULL) OR
        (dimension_type <> 'CLASSIFICATION' AND classification_type_id IS NULL)
    ),
    UNIQUE (matrix_id, dim_index)
);

CREATE INDEX idx_matrix_dimensions_matrix ON matrix_dimensions(matrix_id);
CREATE INDEX idx_matrix_dimensions_classification ON matrix_dimensions(classification_type_id);

-- Matrix nomItemId mappings (links INS IDs to canonical entities)
CREATE TABLE matrix_nom_items (
    id SERIAL PRIMARY KEY,
    matrix_id INTEGER NOT NULL REFERENCES matrices(id) ON DELETE CASCADE,
    dim_index SMALLINT NOT NULL,
    nom_item_id INTEGER NOT NULL,
    dimension_type dimension_type NOT NULL,  -- MEDIUM FIX: Now NOT NULL - we always know the type
    territory_id INTEGER REFERENCES territories(id),
    time_period_id INTEGER REFERENCES time_periods(id),
    classification_value_id INTEGER REFERENCES classification_values(id),
    unit_id INTEGER REFERENCES units_of_measure(id),
    labels JSONB NOT NULL DEFAULT '{}',  -- {"ro": "...", "en": "..."}
    parent_nom_item_id INTEGER,
    offset_order INTEGER NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (matrix_id, dim_index, nom_item_id),
    -- MEDIUM FIX: FK to matrix_dimensions ensures nom items belong to valid dimensions
    FOREIGN KEY (matrix_id, dim_index) REFERENCES matrix_dimensions(matrix_id, dim_index) ON DELETE CASCADE,
    -- Ensure that the target matches the dimension type (allows unresolved items with all NULLs)
    CONSTRAINT chk_nom_item_target CHECK (
        (dimension_type = 'TERRITORIAL' AND time_period_id IS NULL AND classification_value_id IS NULL AND unit_id IS NULL) OR
        (dimension_type = 'TEMPORAL' AND territory_id IS NULL AND classification_value_id IS NULL AND unit_id IS NULL) OR
        (dimension_type = 'CLASSIFICATION' AND territory_id IS NULL AND time_period_id IS NULL AND unit_id IS NULL) OR
        (dimension_type = 'UNIT_OF_MEASURE' AND territory_id IS NULL AND time_period_id IS NULL AND classification_value_id IS NULL)
    )
);

CREATE INDEX idx_matrix_nom_items_matrix ON matrix_nom_items(matrix_id);
CREATE INDEX idx_matrix_nom_items_dim ON matrix_nom_items(matrix_id, dim_index);
CREATE INDEX idx_matrix_nom_items_territory ON matrix_nom_items(territory_id);
CREATE INDEX idx_matrix_nom_items_time ON matrix_nom_items(time_period_id);
CREATE INDEX idx_matrix_nom_items_classification ON matrix_nom_items(classification_value_id);
CREATE INDEX idx_matrix_nom_items_parent ON matrix_nom_items(parent_nom_item_id);
CREATE INDEX idx_matrix_nom_items_offset ON matrix_nom_items(matrix_id, dim_index, offset_order);

-- ============================================================================
-- ENTITY RESOLUTION LAYER
-- ============================================================================

-- Label mappings for auditable entity resolution
CREATE TABLE label_mappings (
    id SERIAL PRIMARY KEY,
    label_normalized TEXT NOT NULL,
    label_original TEXT NOT NULL,
    context_type TEXT NOT NULL,  -- 'TERRITORY', 'TIME_PERIOD', 'CLASSIFICATION', 'UNIT'
    context_hint TEXT NOT NULL DEFAULT '',  -- Additional context (empty string = no hint)

    -- Resolved target (exactly one should be non-null if resolved)
    territory_id INTEGER REFERENCES territories(id),
    time_period_id INTEGER REFERENCES time_periods(id),
    classification_value_id INTEGER REFERENCES classification_values(id),
    unit_id INTEGER REFERENCES units_of_measure(id),

    -- Resolution metadata
    resolution_method TEXT,      -- 'EXACT', 'PATTERN', 'FUZZY', 'MANUAL', 'SIRUTA'
    confidence NUMERIC(3,2),     -- 0.00 to 1.00

    -- For unresolvable labels
    is_unresolvable BOOLEAN NOT NULL DEFAULT FALSE,
    unresolvable_reason TEXT,

    created_at TIMESTAMPTZ DEFAULT NOW(),
    resolved_at TIMESTAMPTZ,

    CONSTRAINT chk_label_mappings_target CHECK (
        (is_unresolvable = TRUE AND territory_id IS NULL AND time_period_id IS NULL AND classification_value_id IS NULL AND unit_id IS NULL)
        OR
        (is_unresolvable = FALSE AND num_nonnulls(territory_id, time_period_id, classification_value_id, unit_id) = 1)
    ),
    -- CRITICAL: Unique constraint allows ON CONFLICT in code to work correctly
    UNIQUE (label_normalized, context_type, context_hint)
);

CREATE INDEX idx_label_mappings_label ON label_mappings(label_normalized);
CREATE INDEX idx_label_mappings_type ON label_mappings(context_type);
CREATE INDEX idx_label_mappings_context ON label_mappings(context_type, context_hint);
CREATE INDEX idx_label_mappings_unresolved ON label_mappings(is_unresolvable) WHERE is_unresolvable;

-- ============================================================================
-- FACT TABLES (Partitioned by matrix_id)
-- ============================================================================

-- Statistics fact table
CREATE TABLE statistics (
    id BIGSERIAL,
    matrix_id INTEGER NOT NULL REFERENCES matrices(id) ON DELETE CASCADE,
    territory_id INTEGER REFERENCES territories(id),
    time_period_id INTEGER NOT NULL REFERENCES time_periods(id),
    unit_id INTEGER REFERENCES units_of_measure(id),
    value NUMERIC,
    value_status TEXT,           -- ':' for missing, 'c' for confidential, etc.
    natural_key_hash TEXT NOT NULL,  -- Hash of all dimension values for dedup
    source_enc_query TEXT,       -- Original encQuery for traceability
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    version INTEGER DEFAULT 1,
    PRIMARY KEY (matrix_id, id)
) PARTITION BY LIST (matrix_id);

-- Default partition for new matrices
CREATE TABLE statistics_default PARTITION OF statistics DEFAULT;

CREATE INDEX idx_statistics_territory ON statistics(territory_id) WHERE territory_id IS NOT NULL;
CREATE INDEX idx_statistics_time ON statistics(time_period_id);
CREATE INDEX idx_statistics_unit ON statistics(unit_id) WHERE unit_id IS NOT NULL;
CREATE INDEX idx_statistics_star ON statistics(matrix_id, territory_id, time_period_id);
CREATE INDEX idx_statistics_created ON statistics(created_at);
CREATE INDEX idx_statistics_updated ON statistics(updated_at);

-- Classification junction table (many-to-many: statistic <-> classification_value)
CREATE TABLE statistic_classifications (
    matrix_id INTEGER NOT NULL REFERENCES matrices(id) ON DELETE CASCADE,
    statistic_id BIGINT NOT NULL,
    classification_value_id INTEGER NOT NULL REFERENCES classification_values(id),
    PRIMARY KEY (matrix_id, statistic_id, classification_value_id)
) PARTITION BY LIST (matrix_id);

CREATE TABLE statistic_classifications_default PARTITION OF statistic_classifications DEFAULT;

CREATE INDEX idx_statistic_classifications_value ON statistic_classifications(classification_value_id);
CREATE INDEX idx_statistic_classifications_statistic ON statistic_classifications(matrix_id, statistic_id);

-- ============================================================================
-- SYNC SYSTEM - Unified task and chunk tracking
-- ============================================================================

-- Status enum for sync tasks (matrix-level work requests)
CREATE TYPE sync_task_status AS ENUM (
    'PENDING',    -- Waiting to be processed
    'PLANNING',   -- Generating chunks
    'RUNNING',    -- Processing chunks
    'COMPLETED',  -- All chunks done
    'FAILED',     -- Unrecoverable error or max retries exceeded
    'CANCELLED'   -- Manually cancelled
);

-- Status enum for sync chunks (individual API calls)
CREATE TYPE sync_chunk_status AS ENUM (
    'PENDING',    -- Not yet attempted
    'RUNNING',    -- Currently fetching
    'COMPLETED',  -- Successfully synced
    'FAILED',     -- Failed, will retry
    'EXHAUSTED',  -- Max retries exceeded
    'SKIPPED'     -- Already up-to-date (resume mode)
);

-- Sync tasks - one per matrix sync request (replaces sync_jobs)
CREATE TABLE sync_tasks (
    id SERIAL PRIMARY KEY,
    matrix_id INTEGER NOT NULL REFERENCES matrices(id) ON DELETE CASCADE,

    -- Request parameters (immutable after creation)
    year_from SMALLINT NOT NULL,
    year_to SMALLINT NOT NULL,
    classification_mode TEXT NOT NULL DEFAULT 'totals-only',
    county_code TEXT,  -- Optional filter

    -- Status
    status sync_task_status NOT NULL DEFAULT 'PENDING',
    priority SMALLINT NOT NULL DEFAULT 0,  -- Higher = more urgent

    -- Progress (updated as chunks complete)
    chunks_total INTEGER,  -- Set after planning
    chunks_completed INTEGER DEFAULT 0,
    chunks_failed INTEGER DEFAULT 0,
    rows_inserted INTEGER DEFAULT 0,
    rows_updated INTEGER DEFAULT 0,

    -- Timing
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,

    -- Error info
    error_message TEXT,

    -- Lease-based locking
    locked_until TIMESTAMPTZ,
    locked_by TEXT,

    -- Tracking
    created_by TEXT NOT NULL DEFAULT 'cli'  -- 'cli' or 'api'
);

COMMENT ON TABLE sync_tasks IS 'Queue table for data sync tasks. One task per matrix sync request. Default year range: 2020-current year.';

-- Index for finding next task to process
CREATE INDEX idx_sync_tasks_queue ON sync_tasks (priority DESC, created_at ASC)
    WHERE status = 'PENDING';

-- Index for finding running tasks (stale lock detection)
CREATE INDEX idx_sync_tasks_running ON sync_tasks (locked_until)
    WHERE status IN ('PLANNING', 'RUNNING');

-- Index for matrix lookup
CREATE INDEX idx_sync_tasks_matrix ON sync_tasks (matrix_id);

-- Index for status filtering
CREATE INDEX idx_sync_tasks_status ON sync_tasks (status);

-- Prevent duplicate active tasks for same matrix with same parameters
CREATE UNIQUE INDEX idx_sync_tasks_active ON sync_tasks (matrix_id, year_from, year_to, classification_mode, COALESCE(county_code, ''))
    WHERE status IN ('PENDING', 'PLANNING', 'RUNNING');

-- Sync checkpoints - one per chunk within a task (or standalone for direct CLI syncs)
CREATE TABLE sync_checkpoints (
    id SERIAL PRIMARY KEY,
    task_id INTEGER REFERENCES sync_tasks(id) ON DELETE CASCADE,  -- NULL for direct CLI syncs
    matrix_id INTEGER NOT NULL REFERENCES matrices(id) ON DELETE CASCADE,

    -- Chunk identification
    chunk_hash TEXT NOT NULL,
    chunk_index SMALLINT NOT NULL,  -- Order within task (1, 2, 3...)

    -- Chunk description (for debugging/display)
    chunk_name TEXT NOT NULL,  -- e.g., "AB-2020-totals"

    -- Chunk parameters
    county_code TEXT,
    year_from SMALLINT,
    year_to SMALLINT,
    cells_estimated INTEGER NOT NULL,

    -- Status
    status sync_chunk_status NOT NULL DEFAULT 'PENDING',

    -- Results (set on completion)
    cells_returned INTEGER,
    rows_synced INTEGER,

    -- Timing
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,

    -- Error handling
    error_message TEXT,
    retry_count SMALLINT NOT NULL DEFAULT 0,
    next_retry_at TIMESTAMPTZ,  -- NULL = ready to retry now

    -- Lease-based locking
    locked_until TIMESTAMPTZ,
    locked_by TEXT,

    UNIQUE (matrix_id, chunk_hash)
);

-- Index for finding next chunk to process within a task
CREATE INDEX idx_sync_checkpoints_queue ON sync_checkpoints (task_id, chunk_index)
    WHERE status IN ('PENDING', 'FAILED');

-- Index for finding chunks ready to retry
CREATE INDEX idx_sync_checkpoints_retry ON sync_checkpoints (next_retry_at)
    WHERE status = 'FAILED' AND next_retry_at IS NOT NULL;

-- Index for task progress queries
CREATE INDEX idx_sync_checkpoints_task ON sync_checkpoints (task_id);

-- Index for matrix lookup
CREATE INDEX idx_sync_checkpoints_matrix ON sync_checkpoints (matrix_id);

-- Sync rate limiter - single row for global INS API lock
CREATE TABLE sync_rate_limiter (
    id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),  -- Ensures single row

    -- Current lock
    locked_until TIMESTAMPTZ,
    locked_by TEXT,

    -- Rate limit config
    min_interval_ms INTEGER NOT NULL DEFAULT 750,

    -- Stats
    last_call_at TIMESTAMPTZ,
    calls_today INTEGER NOT NULL DEFAULT 0,
    stats_reset_at DATE NOT NULL DEFAULT CURRENT_DATE
);

-- Initialize rate limiter row
INSERT INTO sync_rate_limiter (id) VALUES (1) ON CONFLICT DO NOTHING;

-- ============================================================================
-- HELPER FUNCTIONS
-- ============================================================================

-- Normalize text for matching (removes accents, extra spaces, uppercases)
CREATE OR REPLACE FUNCTION normalize_label(input TEXT) RETURNS TEXT AS $$
BEGIN
    RETURN upper(trim(regexp_replace(unaccent(coalesce(input, '')), '\s+', ' ', 'g')));
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Generate content hash for deduplication
CREATE OR REPLACE FUNCTION content_hash(content TEXT) RETURNS TEXT AS $$
BEGIN
    RETURN encode(sha256(normalize_label(content)::bytea), 'hex');
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Ensure classification content hash stays consistent
CREATE OR REPLACE FUNCTION set_classification_value_content_hash()
RETURNS TRIGGER AS $$
BEGIN
    NEW.content_hash := content_hash(
        COALESCE(NEW.names->>'normalized', NEW.names->>'ro', NEW.names->>'en', NEW.code, '')
    );
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_classification_values_content_hash
BEFORE INSERT OR UPDATE OF names, code, content_hash ON classification_values
FOR EACH ROW EXECUTE FUNCTION set_classification_value_content_hash();

-- Create statistics partition for a matrix
CREATE OR REPLACE FUNCTION create_statistics_partition(p_matrix_id INTEGER) RETURNS TEXT AS $$
DECLARE
    v_partition_name TEXT;
    v_class_partition_name TEXT;
    v_hash_index_name TEXT;
BEGIN
    v_partition_name := 'statistics_matrix_' || p_matrix_id;
    v_class_partition_name := 'statistic_classifications_matrix_' || p_matrix_id;
    v_hash_index_name := 'idx_' || v_partition_name || '_natural_key';

    -- Create statistics partition
    IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE tablename = v_partition_name) THEN
        EXECUTE format(
            'CREATE TABLE %I PARTITION OF statistics FOR VALUES IN (%s)',
            v_partition_name, p_matrix_id
        );
    END IF;

    -- Ensure unique index for upserts
    IF NOT EXISTS (
        SELECT 1 FROM pg_class WHERE relname = v_hash_index_name
    ) THEN
        EXECUTE format(
            'CREATE UNIQUE INDEX %I ON %I (natural_key_hash) WHERE natural_key_hash IS NOT NULL',
            v_hash_index_name, v_partition_name
        );
    END IF;

    -- Create classifications partition
    IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE tablename = v_class_partition_name) THEN
        EXECUTE format(
            'CREATE TABLE %I PARTITION OF statistic_classifications FOR VALUES IN (%s)',
            v_class_partition_name, p_matrix_id
        );
    END IF;

    RETURN 'Created partitions for matrix ' || p_matrix_id;
END;
$$ LANGUAGE plpgsql;

-- Create classification partition for a matrix (compatibility helper)
CREATE OR REPLACE FUNCTION create_stat_classifications_partition(p_matrix_id INTEGER)
RETURNS VOID AS $$
DECLARE
    v_partition_name TEXT;
BEGIN
    v_partition_name := 'statistic_classifications_matrix_' || p_matrix_id;

    IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE tablename = v_partition_name) THEN
        EXECUTE format(
            'CREATE TABLE %I PARTITION OF statistic_classifications FOR VALUES IN (%s)',
            v_partition_name, p_matrix_id
        );
    END IF;
END;
$$ LANGUAGE plpgsql;

-- Get territory ancestors using ltree
CREATE OR REPLACE FUNCTION get_territory_ancestors(territory_id INTEGER)
RETURNS TABLE (
    id INTEGER,
    code TEXT,
    level territory_level,
    name_ro TEXT,
    depth INTEGER
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        t.id,
        t.code,
        t.level,
        t.name AS name_ro,
        nlevel(t.path) AS depth
    FROM territories t
    WHERE t.path @> (SELECT path FROM territories WHERE territories.id = territory_id)
    ORDER BY nlevel(t.path);
END;
$$ LANGUAGE plpgsql;

-- Get territory descendants using ltree
CREATE OR REPLACE FUNCTION get_territory_descendants(territory_id INTEGER, max_depth INTEGER DEFAULT NULL)
RETURNS TABLE (
    id INTEGER,
    code TEXT,
    level territory_level,
    name_ro TEXT,
    depth INTEGER
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        t.id,
        t.code,
        t.level,
        t.name AS name_ro,
        nlevel(t.path) AS depth
    FROM territories t
    WHERE t.path <@ (SELECT path FROM territories WHERE territories.id = territory_id)
      AND (max_depth IS NULL OR nlevel(t.path) <= nlevel((SELECT path FROM territories WHERE territories.id = territory_id)) + max_depth)
    ORDER BY nlevel(t.path), t.name;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- API VIEWS
-- ============================================================================

-- Matrix listing view (denormalized for API)
CREATE VIEW v_matrices AS
SELECT
    m.id,
    m.ins_code,
    m.metadata->'names'->>'ro' AS name_ro,
    m.metadata->'names'->>'en' AS name_en,
    m.metadata->'definitions'->>'ro' AS definition_ro,
    m.metadata->'definitions'->>'en' AS definition_en,
    (m.metadata->'yearRange'->>0)::int AS start_year,
    (m.metadata->'yearRange'->>1)::int AS end_year,
    (m.metadata->'flags'->>'hasUatData')::boolean AS has_uat_data,
    (m.metadata->'flags'->>'hasCountyData')::boolean AS has_county_data,
    (m.metadata->'flags'->>'hasSiruta')::boolean AS has_siruta,
    m.metadata->'periodicity' AS periodicity,
    jsonb_array_length(m.dimensions) AS dimension_count,
    m.sync_status,
    m.last_sync_at,
    c.ins_code AS context_code,
    c.names->>'ro' AS context_name_ro,
    c.names->>'en' AS context_name_en,
    c.path::text AS context_path
FROM matrices m
LEFT JOIN contexts c ON m.context_id = c.id;

-- Territory hierarchy view
CREATE VIEW v_territories AS
SELECT
    t.id,
    t.code,
    t.siruta_code,
    t.level,
    t.path::text AS path,
    t.name AS name_ro,
    NULL::text AS name_en,
    normalize_label(t.name) AS name_normalized,
    t.parent_id,
    p.code AS parent_code,
    p.name AS parent_name_ro,
    t.siruta_metadata
FROM territories t
LEFT JOIN territories p ON t.parent_id = p.id;

-- Context hierarchy view
CREATE VIEW v_contexts AS
SELECT
    c.id,
    c.ins_code,
    c.names->>'ro' AS name_ro,
    c.names->>'en' AS name_en,
    c.level,
    c.path::text AS path,
    c.parent_id,
    p.ins_code AS parent_code,
    p.names->>'ro' AS parent_name_ro,
    c.children_type,
    (SELECT COUNT(*) FROM contexts cc WHERE cc.parent_id = c.id) AS child_count,
    (SELECT COUNT(*) FROM matrices m WHERE m.context_id = c.id) AS matrix_count
FROM contexts c
LEFT JOIN contexts p ON c.parent_id = p.id;

-- Classification types view
CREATE VIEW v_classification_types AS
SELECT
    ct.id,
    ct.code,
    ct.names->>'ro' AS name_ro,
    ct.names->>'en' AS name_en,
    ct.is_hierarchical,
    (SELECT COUNT(*) FROM classification_values cv WHERE cv.type_id = ct.id) AS value_count
FROM classification_types ct;

-- Time periods view
CREATE VIEW v_time_periods AS
SELECT
    tp.id,
    tp.year,
    tp.quarter,
    tp.month,
    tp.periodicity,
    tp.period_start,
    tp.period_end,
    tp.labels->>'ro' AS label_ro,
    tp.labels->>'en' AS label_en,
    CASE
        WHEN tp.periodicity = 'ANNUAL' THEN tp.year::text
        WHEN tp.periodicity = 'QUARTERLY' THEN tp.year || '-Q' || tp.quarter
        WHEN tp.periodicity = 'MONTHLY' THEN tp.year || '-' || lpad(tp.month::text, 2, '0')
    END AS iso_period
FROM time_periods tp;

-- Units view
CREATE VIEW v_units AS
SELECT
    u.id,
    u.code,
    u.symbol,
    u.names->>'ro' AS name_ro,
    u.names->>'en' AS name_en,
    u.names->>'normalized' AS name_normalized
FROM units_of_measure u;

-- Unresolved labels view (for monitoring/debugging)
CREATE VIEW v_unresolved_labels AS
SELECT
    lm.id,
    lm.label_original,
    lm.label_normalized,
    lm.context_type,
    lm.context_hint,
    lm.unresolvable_reason,
    lm.created_at
FROM label_mappings lm
WHERE lm.is_unresolvable = TRUE
ORDER BY lm.created_at DESC;

-- ============================================================================
-- SYNC SYSTEM VIEWS
-- ============================================================================

-- Sync tasks view with matrix info and progress
CREATE OR REPLACE VIEW v_sync_tasks AS
SELECT
    st.id,
    st.matrix_id,
    m.ins_code as matrix_code,
    m.metadata->'names'->>'ro' as matrix_name,
    st.year_from,
    st.year_to,
    st.classification_mode,
    st.county_code,
    st.status,
    st.priority,
    st.chunks_total,
    st.chunks_completed,
    st.chunks_failed,
    CASE WHEN st.chunks_total > 0
         THEN ROUND((st.chunks_completed * 100.0 / st.chunks_total)::numeric, 1)
         ELSE 0
    END as progress_pct,
    st.rows_inserted,
    st.rows_updated,
    st.created_at,
    st.started_at,
    st.completed_at,
    st.error_message,
    st.locked_until,
    st.locked_by,
    st.created_by,
    CASE
        WHEN st.locked_until > NOW() THEN TRUE
        ELSE FALSE
    END as is_locked
FROM sync_tasks st
JOIN matrices m ON st.matrix_id = m.id;

-- Sync checkpoints view with task and matrix info
CREATE OR REPLACE VIEW v_sync_checkpoints AS
SELECT
    sc.id,
    sc.task_id,
    sc.matrix_id,
    m.ins_code as matrix_code,
    sc.chunk_hash,
    sc.chunk_index,
    sc.chunk_name,
    sc.county_code,
    sc.year_from,
    sc.year_to,
    sc.cells_estimated,
    sc.status,
    sc.cells_returned,
    sc.rows_synced,
    sc.created_at,
    sc.started_at,
    sc.completed_at,
    sc.error_message,
    sc.retry_count,
    sc.next_retry_at,
    sc.locked_until,
    sc.locked_by,
    CASE
        WHEN sc.locked_until > NOW() THEN TRUE
        ELSE FALSE
    END as is_locked
FROM sync_checkpoints sc
JOIN matrices m ON sc.matrix_id = m.id;

-- Task summary by status
CREATE OR REPLACE VIEW v_sync_task_summary AS
SELECT
    status,
    COUNT(*) as task_count,
    SUM(chunks_total) as total_chunks,
    SUM(chunks_completed) as completed_chunks,
    SUM(chunks_failed) as failed_chunks,
    SUM(rows_inserted) as total_rows_inserted,
    SUM(rows_updated) as total_rows_updated
FROM sync_tasks
GROUP BY status;

-- Failed chunks awaiting retry
CREATE OR REPLACE VIEW v_sync_failed_chunks AS
SELECT
    sc.id,
    sc.task_id,
    st.status as task_status,
    m.ins_code as matrix_code,
    sc.chunk_name,
    sc.error_message,
    sc.retry_count,
    sc.next_retry_at,
    CASE
        WHEN sc.next_retry_at IS NULL THEN TRUE
        WHEN sc.next_retry_at <= NOW() THEN TRUE
        ELSE FALSE
    END as ready_to_retry
FROM sync_checkpoints sc
JOIN sync_tasks st ON sc.task_id = st.id
JOIN matrices m ON sc.matrix_id = m.id
WHERE sc.status IN ('FAILED', 'EXHAUSTED')
ORDER BY sc.next_retry_at NULLS FIRST;

-- Matrix sync status overview (per-matrix view combining all sync info)
CREATE OR REPLACE VIEW v_matrix_sync_status AS
WITH latest_task AS (
    -- Get the most recent task per matrix
    SELECT DISTINCT ON (matrix_id)
        matrix_id,
        id as task_id,
        status as task_status,
        year_from as task_year_from,
        year_to as task_year_to,
        classification_mode,
        county_code as task_county,
        chunks_total,
        chunks_completed,
        chunks_failed,
        rows_inserted as task_rows_inserted,
        rows_updated as task_rows_updated,
        created_at as task_created_at,
        started_at as task_started_at,
        completed_at as task_completed_at,
        error_message as task_error
    FROM sync_tasks
    ORDER BY matrix_id, created_at DESC
),
data_coverage AS (
    -- Actual data in statistics table
    SELECT
        s.matrix_id,
        COUNT(*) as total_rows,
        COUNT(DISTINCT s.territory_id) as territory_count,
        MIN(tp.year) as data_year_min,
        MAX(tp.year) as data_year_max,
        COUNT(DISTINCT tp.year) as years_synced,
        MAX(s.updated_at) as data_last_updated
    FROM statistics s
    JOIN time_periods tp ON s.time_period_id = tp.id
    GROUP BY s.matrix_id
),
task_history AS (
    -- Count of tasks by status per matrix
    SELECT
        matrix_id,
        COUNT(*) FILTER (WHERE status = 'COMPLETED') as completed_tasks,
        COUNT(*) FILTER (WHERE status = 'FAILED') as failed_tasks,
        COUNT(*) FILTER (WHERE status IN ('PENDING', 'PLANNING', 'RUNNING')) as active_tasks
    FROM sync_tasks
    GROUP BY matrix_id
)
SELECT
    m.id as matrix_id,
    m.ins_code,
    m.metadata->'names'->>'ro' as name_ro,

    -- Matrix dimensions
    jsonb_array_length(m.dimensions) as dimension_count,
    (m.metadata->'flags'->>'hasUatData')::boolean as has_uat_data,
    (m.metadata->'flags'->>'hasCountyData')::boolean as has_county_data,

    -- Available year range (from metadata)
    (m.metadata->'yearRange'->>0)::int as available_year_from,
    (m.metadata->'yearRange'->>1)::int as available_year_to,

    -- Matrix sync status
    m.sync_status,
    m.last_sync_at,
    m.sync_error,

    -- Latest task info
    lt.task_id,
    lt.task_status,
    lt.task_year_from,
    lt.task_year_to,
    lt.classification_mode,
    lt.task_county,
    lt.chunks_total,
    lt.chunks_completed,
    lt.chunks_failed,
    CASE WHEN lt.chunks_total > 0
         THEN ROUND((lt.chunks_completed * 100.0 / lt.chunks_total)::numeric, 1)
         ELSE NULL
    END as task_progress_pct,
    lt.task_rows_inserted,
    lt.task_rows_updated,
    lt.task_created_at,
    lt.task_completed_at,
    lt.task_error,

    -- Actual data coverage
    COALESCE(dc.total_rows, 0) as data_rows,
    COALESCE(dc.territory_count, 0) as data_territories,
    dc.data_year_min,
    dc.data_year_max,
    COALESCE(dc.years_synced, 0) as data_years_count,
    dc.data_last_updated,

    -- Task history summary
    COALESCE(th.completed_tasks, 0) as history_completed,
    COALESCE(th.failed_tasks, 0) as history_failed,
    COALESCE(th.active_tasks, 0) as history_active,

    -- Computed status
    CASE
        WHEN lt.task_status IN ('PENDING', 'PLANNING', 'RUNNING') THEN 'SYNCING'
        WHEN dc.total_rows > 0 AND m.sync_status = 'SYNCED' THEN 'SYNCED'
        WHEN dc.total_rows > 0 THEN 'PARTIAL'
        WHEN lt.task_status = 'FAILED' THEN 'FAILED'
        ELSE 'NOT_SYNCED'
    END as overall_status

FROM matrices m
LEFT JOIN latest_task lt ON m.id = lt.matrix_id
LEFT JOIN data_coverage dc ON m.id = dc.matrix_id
LEFT JOIN task_history th ON m.id = th.matrix_id;

COMMENT ON VIEW v_matrix_sync_status IS 'Comprehensive matrix sync status combining metadata, task progress, and actual data coverage';

-- ============================================================================
-- DISCOVERY & ANALYTICS TABLES
-- ============================================================================

-- Matrix tags for discoverability
CREATE TABLE matrix_tags (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    name_en VARCHAR(100),
    slug VARCHAR(100) NOT NULL UNIQUE,
    category VARCHAR(50) NOT NULL DEFAULT 'topic',
    description TEXT,
    usage_count INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_matrix_tags_slug ON matrix_tags(slug);
CREATE INDEX idx_matrix_tags_category ON matrix_tags(category);

-- Junction table for matrix-tag assignments
CREATE TABLE matrix_tag_assignments (
    matrix_id INTEGER NOT NULL REFERENCES matrices(id) ON DELETE CASCADE,
    tag_id INTEGER NOT NULL REFERENCES matrix_tags(id) ON DELETE CASCADE,
    PRIMARY KEY (matrix_id, tag_id)
);

CREATE INDEX idx_matrix_tag_assignments_tag ON matrix_tag_assignments(tag_id);

-- Matrix relationships (for related matrices)
CREATE TABLE matrix_relationships (
    id SERIAL PRIMARY KEY,
    matrix_id INTEGER NOT NULL REFERENCES matrices(id) ON DELETE CASCADE,
    related_matrix_id INTEGER NOT NULL REFERENCES matrices(id) ON DELETE CASCADE,
    relationship_type VARCHAR(50) NOT NULL,
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (matrix_id, related_matrix_id, relationship_type)
);

CREATE INDEX idx_matrix_relationships_matrix ON matrix_relationships(matrix_id);
CREATE INDEX idx_matrix_relationships_related ON matrix_relationships(related_matrix_id);
CREATE INDEX idx_matrix_relationships_type ON matrix_relationships(relationship_type);

-- Data quality metrics
CREATE TABLE data_quality_metrics (
    id SERIAL PRIMARY KEY,
    matrix_id INTEGER NOT NULL REFERENCES matrices(id) ON DELETE CASCADE,
    territory_id INTEGER REFERENCES territories(id),
    year SMALLINT,
    expected_data_points INTEGER,
    actual_data_points INTEGER,
    null_count INTEGER DEFAULT 0,
    unavailable_count INTEGER DEFAULT 0,
    computed_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (matrix_id, territory_id, year)
);

CREATE INDEX idx_data_quality_metrics_matrix ON data_quality_metrics(matrix_id);
CREATE INDEX idx_data_quality_metrics_territory ON data_quality_metrics(territory_id);
CREATE INDEX idx_data_quality_metrics_year ON data_quality_metrics(year);

-- Saved queries
CREATE TABLE saved_queries (
    id SERIAL PRIMARY KEY,
    name VARCHAR(200) NOT NULL,
    description TEXT,
    matrix_code VARCHAR(20) NOT NULL,
    territory_filter JSONB,
    time_filter JSONB,
    classification_filter JSONB,
    options JSONB,
    is_public BOOLEAN DEFAULT FALSE,
    execution_count INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_saved_queries_matrix ON saved_queries(matrix_code);
CREATE INDEX idx_saved_queries_public ON saved_queries(is_public) WHERE is_public;
CREATE INDEX idx_saved_queries_name ON saved_queries USING gin(name gin_trgm_ops);

-- Composite indicators (calculated from multiple matrices)
CREATE TABLE composite_indicators (
    id SERIAL PRIMARY KEY,
    code VARCHAR(50) NOT NULL UNIQUE,
    name VARCHAR(200) NOT NULL,
    name_en VARCHAR(200),
    formula TEXT NOT NULL,
    unit_code VARCHAR(50),
    config JSONB NOT NULL DEFAULT '{}',
    category VARCHAR(100),
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_composite_indicators_code ON composite_indicators(code);
CREATE INDEX idx_composite_indicators_category ON composite_indicators(category);
CREATE INDEX idx_composite_indicators_active ON composite_indicators(is_active) WHERE is_active;

-- ============================================================================
-- MATERIALIZED VIEWS FOR PERFORMANCE
-- ============================================================================

-- National time series cache (aggregated at national level per year)
CREATE MATERIALIZED VIEW mv_national_timeseries AS
SELECT
    s.matrix_id,
    tp.year,
    tp.periodicity,
    COUNT(*) AS data_point_count,
    AVG(s.value) AS avg_value,
    SUM(s.value) AS sum_value,
    MIN(s.value) AS min_value,
    MAX(s.value) AS max_value,
    COUNT(*) FILTER (WHERE s.value IS NULL) AS null_count
FROM statistics s
JOIN time_periods tp ON s.time_period_id = tp.id
LEFT JOIN territories t ON s.territory_id = t.id
WHERE t.level = 'NATIONAL' OR s.territory_id IS NULL
GROUP BY s.matrix_id, tp.year, tp.periodicity;

CREATE UNIQUE INDEX idx_mv_national_timeseries_pk ON mv_national_timeseries(matrix_id, year, periodicity);

-- Annual NUTS2 totals (for regional aggregates)
CREATE MATERIALIZED VIEW mv_annual_nuts2_totals AS
SELECT
    s.matrix_id,
    t.id AS territory_id,
    t.code AS territory_code,
    t.name AS territory_name,
    tp.year,
    COUNT(*) AS data_point_count,
    SUM(s.value) AS total_value,
    AVG(s.value) AS avg_value
FROM statistics s
JOIN time_periods tp ON s.time_period_id = tp.id
JOIN territories t ON s.territory_id = t.id
WHERE t.level = 'NUTS2' AND tp.periodicity = 'ANNUAL'
GROUP BY s.matrix_id, t.id, t.code, t.name, tp.year;

CREATE UNIQUE INDEX idx_mv_annual_nuts2_totals_pk ON mv_annual_nuts2_totals(matrix_id, territory_id, year);

-- Matrix statistics summary
CREATE MATERIALIZED VIEW mv_matrix_stats AS
SELECT
    m.id AS matrix_id,
    m.ins_code,
    COUNT(DISTINCT s.id) AS total_records,
    COUNT(DISTINCT s.territory_id) AS territory_count,
    COUNT(DISTINCT s.time_period_id) AS time_period_count,
    MIN(tp.year) AS min_year,
    MAX(tp.year) AS max_year,
    COUNT(*) FILTER (WHERE s.value IS NOT NULL) AS non_null_count,
    COUNT(*) FILTER (WHERE s.value IS NULL) AS null_count,
    MAX(s.updated_at) AS last_data_update
FROM matrices m
LEFT JOIN statistics s ON m.id = s.matrix_id
LEFT JOIN time_periods tp ON s.time_period_id = tp.id
GROUP BY m.id, m.ins_code;

CREATE UNIQUE INDEX idx_mv_matrix_stats_pk ON mv_matrix_stats(matrix_id);

-- Function to refresh all materialized views
CREATE OR REPLACE FUNCTION refresh_analytics_views()
RETURNS void AS $$
BEGIN
    REFRESH MATERIALIZED VIEW CONCURRENTLY mv_national_timeseries;
    REFRESH MATERIALIZED VIEW CONCURRENTLY mv_annual_nuts2_totals;
    REFRESH MATERIALIZED VIEW CONCURRENTLY mv_matrix_stats;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- SEED DATA - Common classification types
-- ============================================================================

INSERT INTO classification_types (code, names, is_hierarchical, label_patterns) VALUES
    ('SEX', '{"ro": "Sexe", "en": "Sex"}', FALSE, ARRAY['Sexe', 'Sex', 'Sexul']),
    ('RESIDENCE', '{"ro": "Medii de rezidență", "en": "Residence area"}', FALSE, ARRAY['Medii de rezidenta', 'Medii de rezidență', 'Urban/Rural']),
    ('AGE_GROUP', '{"ro": "Grupe de vârstă", "en": "Age groups"}', TRUE, ARRAY['Grupe de varsta', 'Grupe de vârstă', 'Varste', 'Vârste']),
    ('ECONOMIC_ACTIVITY', '{"ro": "Activități economice", "en": "Economic activities"}', TRUE, ARRAY['CAEN', 'Activitati', 'Activități']),
    ('EDUCATION_LEVEL', '{"ro": "Niveluri de educație", "en": "Education levels"}', TRUE, ARRAY['Nivel de educatie', 'Nivel de instruire']),
    ('MARITAL_STATUS', '{"ro": "Stare civilă", "en": "Marital status"}', FALSE, ARRAY['Stare civila', 'Starea civilă']),
    ('CITIZENSHIP', '{"ro": "Cetățenie", "en": "Citizenship"}', FALSE, ARRAY['Cetatenie', 'Cetățenie']),
    ('ETHNICITY', '{"ro": "Etnie", "en": "Ethnicity"}', FALSE, ARRAY['Etnie', 'Nationalitate']),
    ('RELIGION', '{"ro": "Religie", "en": "Religion"}', FALSE, ARRAY['Religie', 'Confesiune']),
    ('OWNERSHIP', '{"ro": "Forme de proprietate", "en": "Ownership types"}', FALSE, ARRAY['Forme de proprietate', 'Proprietate']),
    ('SIZE_CLASS', '{"ro": "Clase de mărime", "en": "Size classes"}', TRUE, ARRAY['Clase de marime', 'Marime']),
    ('PRODUCT_TYPE', '{"ro": "Tipuri de produse", "en": "Product types"}', TRUE, ARRAY['Produse', 'Tipuri']),
    ('MISC', '{"ro": "Diverse", "en": "Miscellaneous"}', FALSE, ARRAY[]::TEXT[])
ON CONFLICT (code) DO NOTHING;

-- ============================================================================
-- SEED DATA - Units of measure (comprehensive set from old database)
-- ============================================================================

INSERT INTO units_of_measure (code, symbol, names, label_patterns) VALUES
    -- Basic Counts
    ('PERSONS', 'pers.', '{"ro": "Numar persoane", "en": "Persons", "normalized": "NUMAR PERSOANE"}', ARRAY['Numar persoane', 'Persoane']),
    ('NUMBER', 'nr.', '{"ro": "Numar", "en": "Number", "normalized": "NUMAR"}', ARRAY['Numar', 'Număr', 'Nr.', 'Nr']),
    ('THOUSAND_PERSONS', 'mii pers.', '{"ro": "Mii persoane", "en": "Thousands of persons", "normalized": "MII PERSOANE"}', ARRAY['Mii persoane']),
    ('MII', NULL, '{"ro": "Mii", "en": "Thousands", "normalized": "MII"}', ARRAY['Mii']),
    ('BUCATI', 'buc.', '{"ro": "Bucati", "en": "Pieces", "normalized": "BUCATI"}', ARRAY['Bucati']),
    ('MII_BUCATI', 'mii buc.', '{"ro": "Mii bucati", "en": "Thousands of pieces", "normalized": "MII BUCATI"}', ARRAY['Mii bucati']),
    ('LOCURI', NULL, '{"ro": "Locuri", "en": "Places/Seats", "normalized": "LOCURI"}', ARRAY['Locuri']),
    ('NUMAR_LINII', NULL, '{"ro": "Numar linii", "en": "Number of lines", "normalized": "NUMAR LINII"}', ARRAY['Numar linii']),
    ('NUMAR_LOCURIZILE', NULL, '{"ro": "Numar locuri-zile", "en": "Place-days", "normalized": "NUMAR LOCURI ZILE"}', ARRAY['Numar locuri-zile']),
    ('NUMAR_SPECTACOLE', NULL, '{"ro": "Numar spectacole", "en": "Number of shows", "normalized": "NUMAR SPECTACOLE"}', ARRAY['Numar spectacole']),
    ('NUMAR_SPECTATORI', NULL, '{"ro": "Numar spectatori", "en": "Number of spectators", "normalized": "NUMAR SPECTATORI"}', ARRAY['Numar spectatori']),
    ('MII_SPECTATORI', NULL, '{"ro": "Mii spectatori", "en": "Thousands of spectators", "normalized": "MII SPECTATORI"}', ARRAY['Mii spectatori']),
    ('MII_EXEMPLARE', NULL, '{"ro": "Mii exemplare", "en": "Thousands of copies", "normalized": "MII EXEMPLARE"}', ARRAY['Mii exemplare']),
    ('NUMAR_MEDIU_LA_100_GOSPODARII', NULL, '{"ro": "Numar mediu la 100 gospodarii", "en": "Average per 100 households", "normalized": "NUMAR MEDIU LA 100 GOSPODARII"}', ARRAY['Numar mediu la 100 gospodarii']),

    -- Percentages & Rates
    ('PERCENT', '%', '{"ro": "Procente", "en": "Percent", "normalized": "PROCENTE"}', ARRAY['Procente', 'Procent', '%']),
    ('PROMILE', '‰', '{"ro": "Promile", "en": "Per mille", "normalized": "PROMILE"}', ARRAY['Promile', 'la mie']),
    ('INDEX', NULL, '{"ro": "Indice", "en": "Index", "normalized": "INDICE"}', ARRAY['Indice', 'Indici']),
    ('RATE', NULL, '{"ro": "Rata", "en": "Rate", "normalized": "RATA"}', ARRAY['Rata', 'Rată']),
    ('COEFFICIENT', NULL, '{"ro": "Coeficient", "en": "Coefficient", "normalized": "COEFICIENT"}', ARRAY['Coeficient']),
    ('ANUL_2020', NULL, '{"ro": "Anul 2020", "en": "Year 2020 (base)", "normalized": "ANUL 2020"}', ARRAY['Anul 2020']),

    -- Demographic Rates
    ('NASCUTI_VII_LA_1000_LOCUITORI', NULL, '{"ro": "Nascuti vii la 1000 locuitori", "en": "Live births per 1000 inhabitants", "normalized": "NASCUTI VII LA 1000 LOCUITORI"}', ARRAY['Nascuti vii la 1000 locuitori']),
    ('NASCUTI_VII_LA_1000_FEMEI_IN_VARSTA_FERTILA', NULL, '{"ro": "Nascuti vii la 1000 femei in varsta fertila", "en": "Live births per 1000 women of fertile age", "normalized": "NASCUTI VII LA 1000 FEMEI IN VARSTA FERTILA"}', ARRAY['Nascuti vii la 1000 femei in varsta fertila']),
    ('NASCUTI_MORTI_LA_1000_NASCUTI', NULL, '{"ro": "Nascuti morti la 1000 nascuti", "en": "Stillbirths per 1000 births", "normalized": "NASCUTI MORTI LA 1000 NASCUTI"}', ARRAY['Nascuti morti la 1000 nascuti']),
    ('DECEDATI_LA_1000_LOCUITORI', NULL, '{"ro": "Decedati la 1000 locuitori", "en": "Deaths per 1000 inhabitants", "normalized": "DECEDATI LA 1000 LOCUITORI"}', ARRAY['Decedati la 1000 locuitori']),
    ('DECEDATI_SUB_1_AN_LA_1000_NASCUTI_VII', NULL, '{"ro": "Decedati sub 1 an la 1000 nascuti vii", "en": "Infant deaths per 1000 live births", "normalized": "DECEDATI SUB 1 AN LA 1000 NASCUTI VII"}', ARRAY['Decedati sub 1 an la 1000 nascuti vii']),
    ('CASATORII_LA_1000_LOCUITORI', NULL, '{"ro": "Casatorii la 1000 locuitori", "en": "Marriages per 1000 inhabitants", "normalized": "CASATORII LA 1000 LOCUITORI"}', ARRAY['Casatorii la 1000 locuitori']),
    ('DIVORTURI_LA_1000_LOCUITORI', NULL, '{"ro": "Divorturi la 1000 locuitori", "en": "Divorces per 1000 inhabitants", "normalized": "DIVORTURI LA 1000 LOCUITORI"}', ARRAY['Divorturi la 1000 locuitori']),
    ('SPOR_NATURAL_LA_1000_LOCUITORI', NULL, '{"ro": "Spor natural la 1000 locuitori", "en": "Natural increase per 1000 inhabitants", "normalized": "SPOR NATURAL LA 1000 LOCUITORI"}', ARRAY['Spor natural la 1000 locuitori']),
    ('LA_1000_FEMEI', NULL, '{"ro": "La 1000 femei", "en": "Per 1000 women", "normalized": "LA 1000 FEMEI"}', ARRAY['La 1000 femei']),
    ('LA_1000_NASCUTIVII', NULL, '{"ro": "La 1000 nascuti-vii", "en": "Per 1000 live births", "normalized": "LA 1000 NASCUTI VII"}', ARRAY['La 1000 nascuti-vii']),
    ('CAZURI_NOI_LA_100000_LOCUITORI', NULL, '{"ro": "Cazuri noi la 100000 locuitori", "en": "New cases per 100000 inhabitants", "normalized": "CAZURI NOI LA 100000 LOCUITORI"}', ARRAY['Cazuri noi la 100000 locuitori']),
    ('RATE_LA_1000_LOCUITORI', NULL, '{"ro": "Rate la 1000 locuitori", "en": "Rates per 1000 inhabitants", "normalized": "RATE LA 1000 LOCUITORI"}', ARRAY['Rate la 1000 locuitori']),

    -- Area & Distance
    ('HECTARES', 'ha', '{"ro": "Hectare", "en": "Hectares", "normalized": "HECTARE"}', ARRAY['Hectare', 'ha', 'Ha']),
    ('MII_HECTARE', 'mii ha', '{"ro": "Mii hectare", "en": "Thousands of hectares", "normalized": "MII HECTARE"}', ARRAY['Mii hectare']),
    ('KILOMETRI', 'km', '{"ro": "Kilometri", "en": "Kilometers", "normalized": "KILOMETRI"}', ARRAY['Kilometri']),
    ('METRI_PATRATI', 'm²', '{"ro": "Metri patrati", "en": "Square meters", "normalized": "METRI PATRATI"}', ARRAY['Metri patrati']),
    ('METRI_PATRATI_ARIE_DESFASURATA', 'm²', '{"ro": "Metri patrati arie desfasurata", "en": "Square meters (developed area)", "normalized": "METRI PATRATI ARIE DESFASURATA"}', ARRAY['Metri patrati arie desfasurata', 'm.p. arie desfasurata']),
    ('METRI_PATRATI_SUPRAFATA_UTILA', 'm²', '{"ro": "Metri patrati suprafata utila", "en": "Square meters (usable area)", "normalized": "METRI PATRATI SUPRAFATA UTILA"}', ARRAY['Metri patrati suprafata utila']),

    -- Volume
    ('LITERS', 'l', '{"ro": "Litri", "en": "Liters", "normalized": "LITRI"}', ARRAY['Litri']),
    ('THOUSAND_LITERS', 'mii l', '{"ro": "Mii litri", "en": "Thousands of liters", "normalized": "MII LITRI"}', ARRAY['Mii litri']),
    ('METRI_CUBI', 'm³', '{"ro": "Metri cubi", "en": "Cubic meters", "normalized": "METRI CUBI"}', ARRAY['Metri cubi']),
    ('MII_METRI_CUBI', 'mii m³', '{"ro": "Mii metri cubi", "en": "Thousands of cubic meters", "normalized": "MII METRI CUBI"}', ARRAY['Mii metri cubi']),
    ('MILIOANE_METRI_CUBI', 'mil. m³', '{"ro": "Milioane metri cubi", "en": "Millions of cubic meters", "normalized": "MILIOANE METRI CUBI"}', ARRAY['Milioane metri cubi']),
    ('MILIOANE_METRI_CUBI_15_GR_C_760_MM_HG', NULL, '{"ro": "Milioane metri cubi 15 Gr. C 760 mm Hg", "en": "Millions of cubic meters (15°C, 760mmHg)", "normalized": "MILIOANE METRI CUBI 15 GR C 760 MM HG"}', ARRAY['Milioane metri cubi 15 Gr. C 760 mm Hg']),
    ('METRI_CUBI_PE_ZI', 'm³/zi', '{"ro": "Metri cubi pe zi", "en": "Cubic meters per day", "normalized": "METRI CUBI PE ZI"}', ARRAY['Metri cubi pe zi']),
    ('10000_HL', '10000 hl', '{"ro": "10000 hl", "en": "10000 hectoliters", "normalized": "10000 HL"}', ARRAY['10000 hl']),

    -- Weight
    ('KG', 'kg', '{"ro": "Kilograme", "en": "Kilograms", "normalized": "KILOGRAME"}', ARRAY['Kilograme', 'kg', 'Kg']),
    ('KILOGRAME_SUBSTANTA_ACTIVA', 'kg', '{"ro": "Kilograme substanta activa", "en": "Kilograms of active substance", "normalized": "KILOGRAME SUBSTANTA ACTIVA"}', ARRAY['Kilograme substanta activa']),
    ('TONS', 't', '{"ro": "Tone", "en": "Tons", "normalized": "TONE"}', ARRAY['Tone']),
    ('THOUSAND_TONS', 'mii t', '{"ro": "Mii tone", "en": "Thousands of tons", "normalized": "MII TONE"}', ARRAY['Mii tone']),
    ('MII_TONE_GG', 'Gg', '{"ro": "Mii tone (Gg)", "en": "Thousands of tons (Gg)", "normalized": "MII TONE GG"}', ARRAY['Mii tone (Gg)']),
    ('TONE_MG', 'Mg', '{"ro": "Tone (Mg)", "en": "Tons (Mg)", "normalized": "TONE MG"}', ARRAY['Tone (Mg)']),
    ('TONE_MG_ECHIVALENT_CO2', 'Mg CO2eq', '{"ro": "Tone (Mg) echivalent CO2", "en": "Tons (Mg) CO2 equivalent", "normalized": "TONE MG ECHIVALENT CO2"}', ARRAY['Tone (Mg) echivalent CO2']),
    ('TONE_MG_ECHIVALENT_N2O', 'Mg N2O eq', '{"ro": "Tone (Mg) echivalent N2O", "en": "Tons (Mg) N2O equivalent", "normalized": "TONE MG ECHIVALENT N2O"}', ARRAY['Tone (Mg) echivalent N2O']),
    ('TONE_100_SUBSTANTA_ACTIVA', 't', '{"ro": "Tone 100% substanta activa", "en": "Tons 100% active substance", "normalized": "TONE 100 SUBSTANTA ACTIVA"}', ARRAY['Tone 100% substanta activa']),
    ('TONE_DW', 't DW', '{"ro": "Tone DW", "en": "Tons (dry weight)", "normalized": "TONE DW"}', ARRAY['Tone DW']),
    ('TONE_O2_ZI', 't O2/zi', '{"ro": "Tone O2/ zi", "en": "Tons O2 per day", "normalized": "TONE O2 ZI"}', ARRAY['Tone O2/ zi']),
    ('TONE_REGISTRU_BRUT', 'TRB', '{"ro": "Tone registru brut", "en": "Gross register tons", "normalized": "TONE REGISTRU BRUT"}', ARRAY['Tone registru brut']),
    ('TONETONE', NULL, '{"ro": "Tone/tone", "en": "Tons per tons (ratio)", "normalized": "TONE TONE"}', ARRAY['Tone/tone']),
    ('TONEMII_LEI_PRETURILE_ANULUI_2020', NULL, '{"ro": "Tone/mii lei preturile anului 2020", "en": "Tons per thousand lei (2020 prices)", "normalized": "TONE MII LEI PRETURILE ANULUI 2020"}', ARRAY['Tone/mii lei preturile anului 2020']),

    -- Currency - Romanian Lei
    ('LEI', 'lei', '{"ro": "Lei", "en": "Lei (RON)", "normalized": "LEI"}', ARRAY['Lei', 'Lei ']),
    ('LEI_RON', 'lei', '{"ro": "Lei RON", "en": "Lei (RON)", "normalized": "LEI RON"}', ARRAY['Lei RON']),
    ('THOUSAND_LEI', 'mii lei', '{"ro": "Mii lei", "en": "Thousands of lei", "normalized": "MII LEI"}', ARRAY['Mii lei']),
    ('MII_LEI_RON', 'mii lei', '{"ro": "Mii lei RON", "en": "Thousands of lei (RON)", "normalized": "MII LEI RON"}', ARRAY['Mii lei RON']),
    ('MILLION_LEI', 'mil. lei', '{"ro": "Milioane lei", "en": "Millions of lei", "normalized": "MILIOANE LEI"}', ARRAY['Milioane lei', 'Milioane lei ']),
    ('MILIOANE_LEI_RON', 'mil. lei', '{"ro": "Milioane lei RON", "en": "Millions of lei (RON)", "normalized": "MILIOANE LEI RON"}', ARRAY['Milioane lei RON']),
    ('MILIARDE_LEI', 'mld. lei', '{"ro": "Miliarde lei", "en": "Billions of lei", "normalized": "MILIARDE LEI"}', ARRAY['Miliarde lei', 'Miliarde lei ']),
    ('LEI__BUC', 'lei/buc', '{"ro": "Lei / buc", "en": "Lei per piece", "normalized": "LEI BUC"}', ARRAY['Lei / buc']),
    ('LEI__KG', 'lei/kg', '{"ro": "Lei / kg", "en": "Lei per kilogram", "normalized": "LEI KG"}', ARRAY['Lei / kg']),
    ('LEI__LITRU', 'lei/l', '{"ro": "Lei / litru", "en": "Lei per liter", "normalized": "LEI LITRU"}', ARRAY['Lei / litru']),
    ('LEI__ORA', 'lei/ora', '{"ro": "Lei / ora", "en": "Lei per hour", "normalized": "LEI ORA"}', ARRAY['Lei / ora']),
    ('LEI__PERSOANA', 'lei/pers', '{"ro": "Lei / persoana", "en": "Lei per person", "normalized": "LEI PERSOANA"}', ARRAY['Lei / persoana']),
    ('LEI__TONA', 'lei/t', '{"ro": "Lei  / tona", "en": "Lei per ton", "normalized": "LEI TONA"}', ARRAY['Lei  / tona']),
    ('LEI__10_HL', 'lei/10hl', '{"ro": "Lei  / 10 hl", "en": "Lei per 10 hectoliters", "normalized": "LEI 10 HL"}', ARRAY['Lei  / 10 hl']),
    ('LEI_FIR', 'lei/fir', '{"ro": "Lei/ fir", "en": "Lei per strand", "normalized": "LEI FIR"}', ARRAY['Lei/ fir']),
    ('MII_LEI_PRETURILE_ANULUI_2020TONA', NULL, '{"ro": "Mii lei preturile anului 2020/tona", "en": "Thousands of lei (2020 prices) per ton", "normalized": "MII LEI PRETURILE ANULUI 2020 TONA"}', ARRAY['Mii lei preturile anului 2020/tona']),

    -- Currency - Foreign
    ('EURO', '€', '{"ro": "EURO", "en": "Euro", "normalized": "EURO"}', ARRAY['EURO', 'Euro']),
    ('THOUSAND_EURO', 'mii €', '{"ro": "Mii EURO", "en": "Thousands of euro", "normalized": "MII EURO"}', ARRAY['Mii EURO']),
    ('MILLION_EURO', 'mil. €', '{"ro": "Milioane EURO", "en": "Millions of euro", "normalized": "MILIOANE EURO"}', ARRAY['Milioane EURO']),
    ('MII_DOLARI_USD', 'mii $', '{"ro": "Mii dolari (USD)", "en": "Thousands of USD", "normalized": "MII DOLARI USD"}', ARRAY['Mii dolari (USD)']),
    ('MILIOANE_DOLARI_USD', 'mil. $', '{"ro": "Milioane dolari (USD)", "en": "Millions of USD", "normalized": "MILIOANE DOLARI USD"}', ARRAY['Milioane dolari (USD)']),

    -- Time
    ('YEARS', 'ani', '{"ro": "Ani", "en": "Years", "normalized": "ANI"}', ARRAY['Ani']),
    ('MONTHS', 'luni', '{"ro": "Luni", "en": "Months", "normalized": "LUNI"}', ARRAY['Luni']),
    ('DAYS', 'zile', '{"ro": "Zile", "en": "Days", "normalized": "ZILE"}', ARRAY['Zile']),
    ('ORE', 'ore', '{"ro": "Ore", "en": "Hours", "normalized": "ORE"}', ARRAY['Ore']),
    ('MII_ORE', 'mii ore', '{"ro": "Mii ore", "en": "Thousands of hours", "normalized": "MII ORE"}', ARRAY['Mii ore']),
    ('ORE__OM', 'ore-om', '{"ro": "Ore - om", "en": "Man-hours", "normalized": "ORE OM"}', ARRAY['Ore - om']),
    ('TOURIST_DAYS', 'zile-turist', '{"ro": "Zile-turist", "en": "Tourist days", "normalized": "ZILE TURIST"}', ARRAY['Zile-turist']),

    -- Energy
    ('GIGACALORII', 'Gcal', '{"ro": "Gigacalorii", "en": "Gigacalories", "normalized": "GIGACALORII"}', ARRAY['Gigacalorii']),
    ('MII_GIGACALORII', 'mii Gcal', '{"ro": "Mii gigacalorii", "en": "Thousands of gigacalories", "normalized": "MII GIGACALORII"}', ARRAY['Mii gigacalorii']),
    ('TERRAJOULI', 'TJ', '{"ro": "Terrajouli", "en": "Terajoules", "normalized": "TERRAJOULI"}', ARRAY['Terrajouli']),
    ('MII_KILOWATTI', 'mii kW', '{"ro": "Mii kilowatti", "en": "Thousands of kilowatts", "normalized": "MII KILOWATTI"}', ARRAY['Mii kilowatti']),
    ('MILIOANE_KILOWATTIORA', 'mil. kWh', '{"ro": "Milioane kilowatti-ora", "en": "Millions of kilowatt-hours", "normalized": "MILIOANE KILOWATTI ORA"}', ARRAY['Milioane kilowatti-ora']),
    ('KG_ECHIVALENT_PETROL', 'kgep', '{"ro": "Kg echivalent petrol", "en": "Kilograms of oil equivalent", "normalized": "KG ECHIVALENT PETROL"}', ARRAY['Kg echivalent petrol']),
    ('MII_TONE_ECHIVALENT_PETROL', 'mii tep', '{"ro": "Mii tone echivalent petrol", "en": "Thousands of tons of oil equivalent", "normalized": "MII TONE ECHIVALENT PETROL"}', ARRAY['Mii tone echivalent petrol']),

    -- Transport
    ('MII_PASAGERI', 'mii pas.', '{"ro": "Mii pasageri", "en": "Thousands of passengers", "normalized": "MII PASAGERI"}', ARRAY['Mii pasageri']),
    ('MILIOANE_PASAGERIKM', 'mil. pas-km', '{"ro": "Milioane pasageri-km", "en": "Millions of passenger-kilometers", "normalized": "MILIOANE PASAGERI KM"}', ARRAY['Milioane pasageri-km']),
    ('MII_TONEKILOMETRU', 'mii t-km', '{"ro": "Mii tone-kilometru", "en": "Thousands of ton-kilometers", "normalized": "MII TONE KILOMETRU"}', ARRAY['Mii tone-kilometru']),
    ('MILIOANE_TONEKM', 'mil. t-km', '{"ro": "Milioane tone-km", "en": "Millions of ton-kilometers", "normalized": "MILIOANE TONE KM"}', ARRAY['Milioane tone-km']),
    ('MII_VEHICULEKM', 'mii veh-km', '{"ro": "Mii vehicule-km", "en": "Thousands of vehicle-kilometers", "normalized": "MII VEHICULE KM"}', ARRAY['Mii vehicule-km']),
    ('ARRIVALS', 'sosiri', '{"ro": "Numar sosiri", "en": "Arrivals", "normalized": "NUMAR SOSIRI"}', ARRAY['Numar sosiri']),
    ('OVERNIGHT_STAYS', 'înnoptări', '{"ro": "Numar innoptari", "en": "Overnight stays", "normalized": "NUMAR INNOPTARI"}', ARRAY['Numar innoptari']),

    -- Technical/Other
    ('CAI_PUTERE', 'CP', '{"ro": "Cai putere", "en": "Horsepower", "normalized": "CAI PUTERE"}', ARRAY['Cai putere']),
    ('MILIOANE_LINII_ECHIVALENTE_ECHIPATE', NULL, '{"ro": "Milioane linii echivalente echipate", "en": "Millions of equipped equivalent lines", "normalized": "MILIOANE LINII ECHIVALENTE ECHIPATE"}', ARRAY['Milioane linii echivalente echipate']),
    ('ECHIVALENT_NORMA_INTREAGAENI', 'ENI', '{"ro": "Echivalent norma intreaga(ENI)", "en": "Full-time equivalent (FTE)", "normalized": "ECHIVALENT NORMA INTREAGA ENI"}', ARRAY['Echivalent norma intreaga(ENI)']),
    ('1000_UNITATI_ANUALE_DE_MUNCA_UAM', 'mii UAM', '{"ro": "1000 unitati anuale de munca (UAM)", "en": "Thousands of annual work units (AWU)", "normalized": "1000 UNITATI ANUALE DE MUNCA UAM"}', ARRAY['1000 unitati anuale de munca (UAM)'])
ON CONFLICT (code) DO NOTHING;

-- ============================================================================
-- SEED DATA - Matrix tags for discoverability
-- ============================================================================

INSERT INTO matrix_tags (name, name_en, slug, category, description) VALUES
    -- Topic tags
    ('Populație', 'Population', 'population', 'topic', 'Date despre populația rezidentă, structura demografică, mișcarea naturală'),
    ('Demografie', 'Demographics', 'demographics', 'topic', 'Natalitate, mortalitate, speranța de viață, migrație'),
    ('Economie', 'Economy', 'economy', 'topic', 'PIB, producție industrială, comerț, servicii'),
    ('Piața muncii', 'Labor Market', 'labor-market', 'topic', 'Ocupare, șomaj, salarii, forța de muncă'),
    ('Educație', 'Education', 'education', 'topic', 'Învățământ, elevi, studenți, personal didactic'),
    ('Sănătate', 'Health', 'health', 'topic', 'Sistemul sanitar, morbiditate, personal medical'),
    ('Construcții', 'Construction', 'construction', 'topic', 'Locuințe, autorizații de construire, clădiri'),
    ('Transport', 'Transport', 'transport', 'topic', 'Infrastructură rutieră, feroviară, trafic'),
    ('Mediu', 'Environment', 'environment', 'topic', 'Calitatea aerului, apei, deșeuri, zone protejate'),
    ('Agricultură', 'Agriculture', 'agriculture', 'topic', 'Producție agricolă, suprafețe cultivate, efectiv animale'),

    -- Audience tags
    ('Cercetători', 'Researchers', 'researchers', 'audience', 'Date pentru cercetare academică și studii științifice'),
    ('Jurnaliști', 'Journalists', 'journalists', 'audience', 'Date pentru analize și reportaje jurnalistice'),
    ('Administrație', 'Public Administration', 'public-admin', 'audience', 'Date pentru politici publice și planificare'),

    -- Use case tags
    ('Serie temporală', 'Time Series', 'time-series', 'use-case', 'Date disponibile pe mai mulți ani pentru analize de tendință'),
    ('Date regionale', 'Regional Data', 'regional-data', 'use-case', 'Date disponibile la nivel de județ sau regiune'),
    ('Date locale', 'Local Data', 'local-data', 'use-case', 'Date disponibile la nivel de UAT sau localitate')
ON CONFLICT (slug) DO NOTHING;

-- ============================================================================
-- SEED DATA - Composite indicators
-- ============================================================================

INSERT INTO composite_indicators (code, name, name_en, formula, unit_code, config, category, is_active) VALUES
    (
        'population-density',
        'Densitatea populației',
        'Population Density',
        'population / area',
        'PERSONS',
        '{"numerator": {"matrixCode": "POP105A", "description": "Populație rezidentă"}, "denominator": {"matrixCode": "GEO101A", "description": "Suprafață în km²"}, "multiplier": 1}'::jsonb,
        'demographics',
        TRUE
    ),
    (
        'birth-rate',
        'Rata natalității',
        'Birth Rate',
        'births * 1000 / population',
        'PROMILE',
        '{"numerator": {"matrixCode": "POP201A", "description": "Născuți vii"}, "denominator": {"matrixCode": "POP105A", "description": "Populație rezidentă"}, "multiplier": 1000}'::jsonb,
        'demographics',
        TRUE
    ),
    (
        'dependency-ratio',
        'Rata de dependență',
        'Dependency Ratio',
        '(young + old) * 100 / working_age',
        'PERCENT',
        '{"numerator": [{"matrixCode": "POP105A", "filter": {"ageGroup": "0-14"}, "description": "Populație 0-14 ani"}, {"matrixCode": "POP105A", "filter": {"ageGroup": "65+"}, "description": "Populație 65+ ani"}], "denominator": {"matrixCode": "POP105A", "filter": {"ageGroup": "15-64"}, "description": "Populație 15-64 ani"}, "multiplier": 100}'::jsonb,
        'demographics',
        TRUE
    )
ON CONFLICT (code) DO NOTHING;

-- ============================================================================
-- PARTITION INITIALIZATION - Pre-create partitions for matrices 1-2000
-- ============================================================================
-- Creates statistics and statistic_classifications partitions for matrix IDs
-- 1 through 2000 at schema initialization time. This ensures partitions exist
-- before any data sync attempts, eliminating the need for manual partition
-- creation via CLI commands.
--
-- Currently ~1898 matrices exist in INS Tempo. 2000 provides headroom for
-- future additions. For matrices beyond ID 2000, run:
--   pnpm cli sync partitions --code <MATRIX_CODE>
--
-- NOTE: Partitions are created in batches of 100 to avoid exceeding
-- max_locks_per_transaction limit in PostgreSQL.

-- Helper function to create partitions in a batch
CREATE OR REPLACE FUNCTION create_partition_batch(start_id INTEGER, end_id INTEGER)
RETURNS void AS $$
DECLARE
    i INTEGER;
    v_partition_name TEXT;
    v_class_partition_name TEXT;
    v_hash_index_name TEXT;
BEGIN
    FOR i IN start_id..end_id LOOP
        v_partition_name := 'statistics_matrix_' || i;
        v_class_partition_name := 'statistic_classifications_matrix_' || i;
        v_hash_index_name := 'idx_' || v_partition_name || '_natural_key';

        -- Create statistics partition
        IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = v_partition_name) THEN
            EXECUTE format(
                'CREATE TABLE %I PARTITION OF statistics FOR VALUES IN (%s)',
                v_partition_name, i
            );

            -- Create unique index for upserts
            EXECUTE format(
                'CREATE UNIQUE INDEX %I ON %I (natural_key_hash) WHERE natural_key_hash IS NOT NULL',
                v_hash_index_name, v_partition_name
            );
        END IF;

        -- Create classifications partition
        IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = v_class_partition_name) THEN
            EXECUTE format(
                'CREATE TABLE %I PARTITION OF statistic_classifications FOR VALUES IN (%s)',
                v_class_partition_name, i
            );
        END IF;
    END LOOP;
END;
$$ LANGUAGE plpgsql;
