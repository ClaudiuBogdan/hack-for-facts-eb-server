-- Enable pg_trgm extension for similarity searches
CREATE EXTENSION IF NOT EXISTS pg_trgm;
-- ========= ENUM TYPES =========
-- Create enum for report types
CREATE TYPE report_type AS ENUM (
    'Executie bugetara agregata la nivel de ordonator principal',
    'Executie bugetara agregata la nivel de ordonator secundar',
    'Executie bugetara detaliata'
);
-- Create enum for expense types
CREATE TYPE expense_type AS ENUM (
    'dezvoltare',
    -- development
    'functionare' -- operational
);
-- Create enum for account categories
CREATE TYPE account_category AS ENUM ('vn', 'ch');
-- ========= DIMENSION TABLES =========
-- Table to store information about the UATs (Administrative Territorial Units)
CREATE TABLE UATs (
    id SERIAL PRIMARY KEY,
    uat_key VARCHAR(35) NOT NULL,
    -- uat_key is combined of county name and uat name
    uat_code VARCHAR(20) UNIQUE NOT NULL,
    -- CIF/uat_cod from uat_cif_pop_2021.csv
    siruta_code VARCHAR(20) UNIQUE NOT NULL,
    -- SIRUTA code from uat_cif_pop_2021.csv
    name TEXT NOT NULL,
    county_code VARCHAR(2) NOT NULL,
    county_name VARCHAR(50) NOT NULL,
    region VARCHAR(50) NOT NULL,
    population INT CHECK (population >= 0),
    last_updated TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
-- Add explanatory comment to UATs table
COMMENT ON TABLE UATs IS 'Administrative Territorial Units of Romania with geographic and demographic information';
COMMENT ON COLUMN UATs.uat_code IS 'Unique code identifying the UAT, corresponds to CIF/uat_cod from official data';
-- Table to store information about the reporting entities (UATs, etc.)
CREATE TABLE Entities (
    cui VARCHAR(20) PRIMARY KEY,
    name TEXT NOT NULL,
    uat_id INT,
    address TEXT,
    entity_type VARCHAR(50) DEFAULT NULL,
    default_report_type report_type DEFAULT 'Executie bugetara detaliata',
    is_uat BOOLEAN NOT NULL DEFAULT FALSE,
    last_updated TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    main_creditor_1_cui VARCHAR(20),
    main_creditor_2_cui VARCHAR(20),
    FOREIGN KEY (uat_id) REFERENCES UATs(id) ON DELETE RESTRICT,
    CHECK (
        main_creditor_1_cui IS NULL
        OR main_creditor_2_cui != cui
    ),
    CHECK (
        main_creditor_2_cui IS NULL
        OR main_creditor_2_cui != cui
    ) 
);
-- Add explanatory comment to Entities table
COMMENT ON TABLE Entities IS 'Public entities that report budget execution data, usually associated with UATs';
COMMENT ON COLUMN Entities.cui IS 'Unique fiscal identification code (CUI/CIF) of the reporting entity';
COMMENT ON COLUMN Entities.entity_type IS 'Type of entity: uat, public_institution, public_company, ministry, agency, other';
COMMENT ON COLUMN Entities.is_uat IS 'Flag indicating if this entity is a UAT';
-- Table for Functional Classification codes (COFOG)
CREATE TABLE FunctionalClassifications (
    functional_code VARCHAR(20) PRIMARY KEY,
    functional_name TEXT NOT NULL
);
-- Add explanatory comment
COMMENT ON TABLE FunctionalClassifications IS 'COFOG functional classification codes for categorizing budget items by purpose/function';
-- Table for Economic Classification codes
CREATE TABLE EconomicClassifications (
    economic_code VARCHAR(20) PRIMARY KEY,
    economic_name TEXT NOT NULL
);
-- Add explanatory comment
COMMENT ON TABLE EconomicClassifications IS 'Economic classification codes for categorizing budget items by economic nature';
-- Table for Funding Sources
CREATE TABLE FundingSources (
    source_id SERIAL PRIMARY KEY,
    source_description TEXT NOT NULL UNIQUE
);
-- Add explanatory comment
COMMENT ON TABLE FundingSources IS 'Sources of funding for budget items (e.g., State Budget, EU Funds, Own Revenues)';
-- Table for Budget Sectors
CREATE TABLE BudgetSectors (
    sector_id SERIAL PRIMARY KEY,
    sector_description TEXT NOT NULL UNIQUE
);
-- Add explanatory comment
COMMENT ON TABLE BudgetSectors IS 'Budget sectors for categorizing budget sources: local budget, state budget, etc.';
-- ========= TAGS SYSTEM =========
-- Create a tags table
CREATE TABLE Tags (
    tag_id SERIAL PRIMARY KEY,
    tag_name VARCHAR(100) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(tag_name)
);
COMMENT ON TABLE Tags IS 'Master table for all tags that can be applied to various entities in the system';
-- ========= METADATA TABLE =========
-- Table to store metadata about each imported report file/instance
CREATE TABLE Reports (
    report_id TEXT PRIMARY KEY,
    entity_cui VARCHAR(20) NOT NULL,
    report_type report_type NOT NULL,
    main_creditor_cui VARCHAR(20),
    report_date DATE NOT NULL,
    reporting_year INT NOT NULL CHECK (
        reporting_year >= 2000
        AND reporting_year <= 2100
    ),
    reporting_period VARCHAR(10) NOT NULL,
    budget_sector_id INT NOT NULL,
    file_source TEXT,
    import_timestamp TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    download_links TEXT [],
    FOREIGN KEY (entity_cui) REFERENCES Entities(cui) ON DELETE RESTRICT,
    FOREIGN KEY (main_creditor_cui) REFERENCES Entities(cui) ON DELETE RESTRICT,
    FOREIGN KEY (budget_sector_id) REFERENCES BudgetSectors(sector_id) ON DELETE RESTRICT,
    UNIQUE (
        entity_cui,
        report_type,
        report_date,
        main_creditor_cui,
        budget_sector_id
    )
);
-- Add explanatory comment
COMMENT ON TABLE Reports IS 'Metadata for each imported budget execution report, linking to the reporting entity';
COMMENT ON COLUMN Reports.report_type IS 'Type of report: main_creditor or detailed';
-- ========= FACT TABLE =========
-- The main table holding individual budget execution line items
CREATE TABLE ExecutionLineItems (
  -- partition keys first (required by PG for global uniqueness constraints)
  year  INT  NOT NULL CHECK (year BETWEEN 2000 AND 2100),
  month INT  NOT NULL CHECK (month BETWEEN 1 AND 12),
  report_type report_type NOT NULL,

  -- row identity inside the (year,report_type) sub-partition space
  line_item_id BIGINT GENERATED ALWAYS AS IDENTITY,

  report_id TEXT NOT NULL,
  entity_cui VARCHAR(20) NOT NULL,
  main_creditor_cui VARCHAR(20),
  budget_sector_id INT NOT NULL,
  funding_source_id INT NOT NULL,
  functional_code VARCHAR(20) NOT NULL,
  economic_code  VARCHAR(20),
  account_category account_category NOT NULL,
  program_code VARCHAR(50),
  expense_type expense_type,
  ytd_amount NUMERIC(18,2) NOT NULL,
  monthly_amount NUMERIC(18,2) NOT NULL,
  
  -- New columns for quarterly feature
  is_quarterly BOOLEAN NOT NULL DEFAULT FALSE,
  quarter INT CHECK (quarter BETWEEN 1 AND 4),
  quarterly_amount NUMERIC(18,2),
  is_yearly BOOLEAN NOT NULL DEFAULT FALSE,

  -- PK must include all partition keys
  PRIMARY KEY (year, report_type, line_item_id),

  -- FKs and checks
  FOREIGN KEY (report_id) REFERENCES Reports(report_id) ON DELETE CASCADE,
  FOREIGN KEY (entity_cui) REFERENCES Entities(cui) ON DELETE RESTRICT,
  FOREIGN KEY (funding_source_id) REFERENCES FundingSources(source_id) ON DELETE RESTRICT,
  FOREIGN KEY (functional_code)   REFERENCES FunctionalClassifications(functional_code) ON DELETE RESTRICT,
  FOREIGN KEY (economic_code)     REFERENCES EconomicClassifications(economic_code) ON DELETE RESTRICT,
  FOREIGN KEY (budget_sector_id)  REFERENCES BudgetSectors(sector_id) ON DELETE RESTRICT,
  FOREIGN KEY (main_creditor_cui) REFERENCES Entities(cui) ON DELETE RESTRICT,

  CHECK (account_category <> 'ch' OR economic_code IS NOT NULL),
  CHECK (NOT is_yearly OR is_quarterly)
)
PARTITION BY RANGE (year);

COMMENT ON COLUMN ExecutionLineItems.quarter IS 'The calendar quarter (1-4) for this line item, populated only when is_quarterly is true.';
COMMENT ON COLUMN ExecutionLineItems.quarterly_amount IS 'The computed total amount for the quarter. This value is only populated on the line item that is flagged as quarterly (e.g., the last month of the quarter).';

-- Declarative YEAR partitions with sub-partitions by report_type
DO $$
DECLARE y INT;
BEGIN
  FOR y IN 2016..2030 LOOP
    EXECUTE format(
      'CREATE TABLE %I PARTITION OF ExecutionLineItems
         FOR VALUES FROM (%s) TO (%s)
         PARTITION BY LIST (report_type);',
      'executionlineitems_y'||y, y, y+1
    );

    EXECUTE format(
      'CREATE TABLE %I PARTITION OF %I FOR VALUES IN (%L);',
      'executionlineitems_y'||y||'_detailed',
      'executionlineitems_y'||y,
      'Executie bugetara detaliata'
    );

    EXECUTE format(
      'CREATE TABLE %I PARTITION OF %I FOR VALUES IN (%L);',
      'executionlineitems_y'||y||'_aggregated',
      'executionlineitems_y'||y,
      'Executie bugetara agregata la nivel de ordonator principal'
    );

    EXECUTE format(
      'CREATE TABLE %I PARTITION OF %I FOR VALUES IN (%L);',
      'executionlineitems_y'||y||'_secondary',
      'executionlineitems_y'||y,
      'Executie bugetara agregata la nivel de ordonator secundar'
    );
  END LOOP;
END $$;

-- ========= MATERIALIZED VIEWS & INDEXES =========

CREATE MATERIALIZED VIEW mv_report_availability AS
SELECT
    entity_cui,
    year,
    report_type,
    CASE
        WHEN report_type = 'Executie bugetara agregata la nivel de ordonator principal' THEN 1
        WHEN report_type = 'Executie bugetara agregata la nivel de ordonator secundar' THEN 2
        WHEN report_type = 'Executie bugetara detaliata' THEN 3
        ELSE 4 -- others
    END as priority,
    MAX(CASE WHEN month = 12 THEN 1 ELSE 0 END) as has_december_data,
    ARRAY_AGG(DISTINCT month ORDER BY month) as available_months,
    MAX(month) as latest_month
FROM ExecutionLineItems
GROUP BY entity_cui, year, report_type;

CREATE UNIQUE INDEX idx_mv_report_avail_unique ON mv_report_availability (entity_cui, year, report_type);
CREATE INDEX idx_mv_report_avail_entity_year ON mv_report_availability (entity_cui, year, priority);

-- Function to set default report type on Entities based on availability and priority
CREATE OR REPLACE FUNCTION set_entities_default_report_type() RETURNS void AS $$
BEGIN
  WITH chosen AS (
    SELECT DISTINCT ON (entity_cui)
      entity_cui,
      report_type
    FROM mv_report_availability
    ORDER BY entity_cui, priority
  )
  UPDATE Entities e
  SET default_report_type = c.report_type
  FROM chosen c
  WHERE e.cui = c.entity_cui;
END;
$$ LANGUAGE plpgsql;
COMMENT ON FUNCTION set_entities_default_report_type() IS 'Sets Entities.default_report_type to highest-priority available report per entity (principal > secundar > detaliata).';


CREATE MATERIALIZED VIEW mv_summary_quarterly AS
SELECT
    eli.year,
    eli.quarter,
    eli.entity_cui,
    eli.main_creditor_cui,
    eli.report_type,
    -- Sum monthly amounts for income ('vn') and expenses ('ch')
    SUM(CASE WHEN eli.account_category = 'vn' THEN eli.quarterly_amount ELSE 0 END) AS total_income,
    SUM(CASE WHEN eli.account_category = 'ch' THEN eli.quarterly_amount ELSE 0 END) AS total_expense,
    -- Calculate the balance based on the summed monthly amounts
    SUM(CASE WHEN eli.account_category = 'vn' THEN eli.quarterly_amount ELSE -eli.quarterly_amount END) AS budget_balance
FROM
    ExecutionLineItems eli
JOIN
    Entities e ON eli.entity_cui = e.cui
WHERE
    eli.quarter IS NOT NULL -- Only include rows that have been assigned to a quarter
GROUP BY
    eli.year,
    eli.quarter,
    eli.entity_cui,
    eli.main_creditor_cui,
    eli.report_type;

COMMENT ON MATERIALIZED VIEW mv_summary_quarterly IS 'Quarterly summary of budget totals (income, expense, balance) aggregated by entity.';

-- Add a unique index for fast lookups
CREATE UNIQUE INDEX idx_mv_summary_quarterly_unique ON mv_summary_quarterly(year, quarter, entity_cui, report_type, main_creditor_cui);

CREATE MATERIALIZED VIEW mv_summary_monthly AS
SELECT
    eli.year,
    eli.month,
    eli.entity_cui,
    eli.main_creditor_cui,
    eli.report_type,
    -- The monthly amounts are already at the correct granularity, so we just sum them up by category
    SUM(CASE WHEN eli.account_category = 'vn' THEN eli.monthly_amount ELSE 0 END) AS total_income,
    SUM(CASE WHEN eli.account_category = 'ch' THEN eli.monthly_amount ELSE 0 END) AS total_expense,
    SUM(CASE WHEN eli.account_category = 'vn' THEN eli.monthly_amount ELSE -eli.monthly_amount END) AS budget_balance
FROM
    ExecutionLineItems eli
JOIN
    Entities e ON eli.entity_cui = e.cui
GROUP BY
    eli.year,
    eli.month,
    eli.entity_cui,
    eli.main_creditor_cui,
    eli.report_type;

COMMENT ON MATERIALIZED VIEW mv_summary_monthly IS 'Monthly summary of budget totals (income, expense, balance) aggregated by entity.';

-- Add a unique index for fast lookups
CREATE UNIQUE INDEX idx_mv_summary_monthly_unique ON mv_summary_monthly(year, month, entity_cui, report_type, main_creditor_cui);

CREATE MATERIALIZED VIEW mv_summary_annual AS
SELECT
    eli.year,
    eli.entity_cui,
    eli.main_creditor_cui,
    eli.report_type,
    SUM(CASE WHEN eli.account_category = 'vn' THEN eli.ytd_amount ELSE 0 END) AS total_income,
    SUM(CASE WHEN eli.account_category = 'ch' THEN eli.ytd_amount ELSE 0 END) AS total_expense,
    SUM(CASE WHEN eli.account_category = 'vn' THEN eli.ytd_amount ELSE -eli.ytd_amount END) AS budget_balance
FROM ExecutionLineItems eli
JOIN Entities e ON eli.entity_cui = e.cui
WHERE eli.is_yearly = true
GROUP BY
    eli.year,
    eli.entity_cui,
    eli.main_creditor_cui,
    eli.report_type;

COMMENT ON MATERIALIZED VIEW mv_summary_annual IS 'Annual summary of budget totals (income, expense, balance) aggregated by entity, using latest available month (is_yearly=true).';
CREATE INDEX idx_mv_summary_annual_entity_year ON mv_summary_annual(entity_cui, year);
CREATE INDEX idx_mv_summary_annual_year_balance ON mv_summary_annual(year, budget_balance DESC);

-- mv_annual_budget_summary: one row per (year, entity)
CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_summary_annual_unique
  ON mv_summary_annual (year, report_type, entity_cui, main_creditor_cui);


-- ========= JUNCTION TABLES =========
CREATE TABLE EntityTags (
    entity_cui VARCHAR(20) REFERENCES Entities(cui) ON DELETE CASCADE,
    tag_id INT REFERENCES Tags(tag_id) ON DELETE CASCADE,
    PRIMARY KEY (entity_cui, tag_id)
);
CREATE TABLE FunctionalClassificationTags (
    functional_code VARCHAR(20) REFERENCES FunctionalClassifications(functional_code) ON DELETE CASCADE,
    tag_id INT REFERENCES Tags(tag_id) ON DELETE CASCADE,
    PRIMARY KEY (functional_code, tag_id)
);
CREATE TABLE EconomicClassificationTags (
    economic_code VARCHAR(20) REFERENCES EconomicClassifications(economic_code) ON DELETE CASCADE,
    tag_id INT REFERENCES Tags(tag_id) ON DELETE CASCADE,
    PRIMARY KEY (economic_code, tag_id)
);

-- Reverse lookup indexes for junction tables to speed up lookups by tag
CREATE INDEX idx_entitytags_tag_id ON EntityTags(tag_id);
CREATE INDEX idx_functionalclassificationtags_tag_id ON FunctionalClassificationTags(tag_id);
CREATE INDEX idx_economicclassificationtags_tag_id ON EconomicClassificationTags(tag_id);


-- Indexes on the Partitioned Fact Table (ExecutionLineItems)
-- This first index is a powerful covering index for primary dashboard queries.
CREATE INDEX idx_executionlineitems_entity_cui_year_month_type_acct ON ExecutionLineItems (entity_cui, year, month, report_type, account_category);
-- Partial indexes for period filtering
CREATE INDEX idx_executionlineitems_yearly ON ExecutionLineItems (entity_cui, year, report_type) WHERE is_yearly = true;
CREATE INDEX idx_executionlineitems_quarterly ON ExecutionLineItems (entity_cui, year, report_type) WHERE is_quarterly = true;
-- New index for querying by quarter
CREATE INDEX idx_executionlineitems_year_quarter ON ExecutionLineItems (year, quarter) WHERE quarter IS NOT NULL;

-- Function to compute period flags (is_yearly, is_quarterly)
CREATE OR REPLACE FUNCTION set_period_flags() RETURNS void AS $$
BEGIN
  WITH computed AS (
    SELECT
      year,
      report_type,
      line_item_id,
      (month = MAX(month) OVER (PARTITION BY entity_cui, year, report_type)) AS is_yearly_calc,
      ((month IN (3, 6, 9, 12)) OR (month = MAX(month) OVER (PARTITION BY entity_cui, year, report_type))) AS is_quarterly_calc,
      CASE
          WHEN ((month IN (3, 6, 9, 12)) OR (month = MAX(month) OVER (PARTITION BY entity_cui, year, report_type)))
          THEN CEILING(month / 3.0)
          ELSE NULL
      END::INT AS quarter_calc
    FROM ExecutionLineItems
  )
  UPDATE ExecutionLineItems eli
  SET
    is_yearly = c.is_yearly_calc,
    is_quarterly = c.is_quarterly_calc,
    quarter = c.quarter_calc
  FROM computed c
  WHERE
    eli.year = c.year AND
    eli.report_type = c.report_type AND
    eli.line_item_id = c.line_item_id;
END;
$$ LANGUAGE plpgsql;
COMMENT ON FUNCTION set_period_flags() IS 'Computes is_yearly, is_quarterly, and quarter flags/values based on the latest available month for an entity/year/report_type.';

-- Function 2: Computes and stores the quarterly amount
CREATE OR REPLACE FUNCTION compute_quarterly_amounts() RETURNS void AS $$
BEGIN
  -- Step 1: Use a CTE with a window function (LAG) to calculate the quarterly amount
  -- from the ytd_amount. The quarterly value is the difference between the current
  -- quarter's YTD and the previous quarter's YTD.
  WITH QuarterlyTotals AS (
    SELECT
      line_item_id,
      year,
      report_type,
      (
        ytd_amount - LAG(ytd_amount, 1, 0) OVER (
          PARTITION BY
            year,
            entity_cui,
            report_type,
            main_creditor_cui,
            budget_sector_id,
            funding_source_id,
            functional_code,
            economic_code,
            program_code,
            expense_type,
            account_category
          ORDER BY
            month
        )
      ) AS total_quarterly_amount
    FROM
      ExecutionLineItems
    WHERE
      is_quarterly = true -- Process only rows flagged as end-of-quarter
  )
  -- Step 2: Update the main table with the computed quarterly amounts.
  UPDATE
    ExecutionLineItems eli
  SET
    -- The quarterly_amount is only set on the row marked as is_quarterly.
    -- Other rows within the same quarter will have this field as NULL.
    quarterly_amount = qt.total_quarterly_amount
  FROM
    QuarterlyTotals qt
  WHERE
    eli.line_item_id = qt.line_item_id
    AND eli.year = qt.year
    AND eli.report_type = qt.report_type;
END;
$$ LANGUAGE plpgsql;
COMMENT ON FUNCTION compute_quarterly_amounts() IS 'Computes quarterly totals by subtracting the previous quarter''s ytd_amount from the current one and stores the result in the quarterly_amount column for rows where is_quarterly=true.';

-- Indexes for specific expense drill-downs.
CREATE INDEX idx_executionlineitems_entity_cui_type_func_ch ON ExecutionLineItems (entity_cui, report_type, functional_code) WHERE account_category = 'ch';
CREATE INDEX idx_executionlineitems_entity_cui_type_econ_ch_notnull ON ExecutionLineItems (entity_cui, report_type, economic_code) WHERE account_category = 'ch' AND economic_code IS NOT NULL;
-- Indexes for prefix LIKE searches (e.g., LIKE '70.%'). These are superior to plain B-tree for this task.
CREATE INDEX idx_executionlineitems_functional_code_vpo ON ExecutionLineItems (functional_code varchar_pattern_ops);
CREATE INDEX idx_executionlineitems_economic_code_vpo ON ExecutionLineItems (economic_code varchar_pattern_ops);
-- Indexes for cross-entity classification analysis over time
CREATE INDEX idx_executionlineitems_func_code_year ON ExecutionLineItems (functional_code, year);
CREATE INDEX idx_executionlineitems_econ_code_year ON ExecutionLineItems (economic_code, year) WHERE economic_code IS NOT NULL;
-- Foreign key support indexes
CREATE INDEX idx_executionlineitems_report_id ON ExecutionLineItems (report_id);
CREATE INDEX idx_executionlineitems_funding_source_id ON ExecutionLineItems (funding_source_id);
CREATE INDEX idx_executionlineitems_budget_sector_id ON ExecutionLineItems (budget_sector_id);
CREATE INDEX idx_executionlineitems_main_creditor_cui ON ExecutionLineItems (main_creditor_cui);

-- Indexes on Dimension & Metadata Tables
-- Reports
CREATE INDEX idx_reports_entity_cui ON Reports (entity_cui);
CREATE INDEX idx_reports_report_date ON Reports (report_date);
CREATE INDEX idx_reports_date_brin ON Reports USING BRIN (report_date); -- BRIN is good for linear time-series data.
-- Helpful for frequent period filtering on reports
CREATE INDEX idx_reports_reporting_year ON Reports (reporting_year);
CREATE INDEX idx_reports_reporting_period ON Reports (reporting_period);
CREATE INDEX idx_reports_main_creditor_cui ON Reports (main_creditor_cui);
CREATE INDEX idx_reports_budget_sector_id ON Reports (budget_sector_id);
-- Entities
CREATE INDEX idx_entities_uat_id ON Entities (uat_id);
CREATE INDEX idx_entities_type ON Entities(entity_type) WHERE entity_type IS NOT NULL;
-- UATs
CREATE INDEX idx_uats_county_code ON UATs (county_code);
CREATE INDEX idx_uats_region ON UATs (region);


-- GIN Indexes for Text Search (pg_trgm)
CREATE INDEX idx_gin_entities_name ON Entities USING gin (name gin_trgm_ops);
CREATE INDEX idx_gin_uats_name ON UATs USING gin (name gin_trgm_ops);
CREATE INDEX idx_gin_fc_functional_name ON FunctionalClassifications USING gin (functional_name gin_trgm_ops);
CREATE INDEX idx_gin_ec_economic_name ON EconomicClassifications USING gin (economic_name gin_trgm_ops);
CREATE INDEX idx_gin_fs_source_description ON FundingSources USING gin (source_description gin_trgm_ops);
CREATE INDEX idx_gin_budget_sectors_description ON BudgetSectors USING gin (sector_description gin_trgm_ops);
CREATE INDEX idx_gin_tags_name ON Tags USING gin (tag_name gin_trgm_ops);
-- Immutable function for array indexing (unchanged, good practice)
CREATE OR REPLACE FUNCTION immutable_array_to_string(text [], text) RETURNS text AS $$
SELECT array_to_string($1, $2);
$$ LANGUAGE sql IMMUTABLE;
CREATE INDEX idx_gin_reports_download_links_trgm ON Reports USING gin (immutable_array_to_string(download_links, ' ') gin_trgm_ops);

-- This function is a useful utility for monitoring index health.
CREATE OR REPLACE FUNCTION analyze_index_usage() RETURNS TABLE(
    schemaname text, tablename text, indexname text, idx_scan bigint, size text
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        s.schemaname,
        s.tablename,
        s.indexname,
        s.idx_scan,
        pg_size_pretty(pg_relation_size(s.indexrelid)) as size
    FROM pg_stat_user_indexes s
    JOIN pg_index i ON s.indexrelid = i.indexrelid
    WHERE s.idx_scan = 0 -- Unused indexes
      AND i.indisunique IS FALSE -- Exclude unique constraints
      AND s.schemaname NOT IN ('pg_catalog', 'information_schema')
    ORDER BY pg_relation_size(s.indexrelid) DESC;
END;
$$ LANGUAGE plpgsql;
COMMENT ON FUNCTION analyze_index_usage() IS 'Returns a list of unused, non-unique indexes, ordered by size.';