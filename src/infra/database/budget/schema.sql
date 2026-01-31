-- Enable pg_trgm extension for similarity searches
CREATE EXTENSION IF NOT EXISTS pg_trgm;
-- ========= ENUM TYPES =========
-- Create enum for report types
CREATE TYPE report_type AS ENUM (
    'Executie bugetara agregata la nivel de ordonator principal',
    'Executie bugetara agregata la nivel de ordonator secundar',
    'Executie bugetara detaliata',
    'Executie - Angajamente bugetare detaliat',
    -- NOTE: PostgreSQL enum labels are limited to 63 bytes. ANAF metadata strings for 903/904 exceed the limit,
    -- so we store shortened DB-safe labels and map from metadata labels in the loader.
    'Executie - Angajamente bugetare agregat principal',
    'Executie - Angajamente bugetare agregat secundar'
);
-- Create enum for expense types
CREATE TYPE expense_type AS ENUM (
    'dezvoltare',
    -- development
    'functionare' -- operational
);
-- Create enum for account categories
CREATE TYPE account_category AS ENUM ('vn', 'ch');

-- Create enum for anomaly types
CREATE TYPE anomaly_type AS ENUM ('YTD_ANOMALY', 'MISSING_LINE_ITEM');

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

-- Uniqueness for reports with nullable main_creditor_cui
CREATE UNIQUE INDEX idx_reports_uq_null_main_creditor
  ON Reports (entity_cui, report_type, report_date, budget_sector_id)
  WHERE main_creditor_cui IS NULL;
CREATE UNIQUE INDEX idx_reports_uq_not_null_main_creditor
  ON Reports (entity_cui, report_type, report_date, main_creditor_cui, budget_sector_id)
  WHERE main_creditor_cui IS NOT NULL;
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
  anomaly anomaly_type,

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

-- ========= ANGAJAMENTE FACT TABLE =========
-- Table holding budget commitments line items
CREATE TABLE AngajamenteLineItems (
  -- partition keys first
  year  INT  NOT NULL CHECK (year BETWEEN 2000 AND 2100),
  month INT  NOT NULL CHECK (month BETWEEN 1 AND 12),
  report_type report_type NOT NULL,

  line_item_id BIGINT GENERATED ALWAYS AS IDENTITY,

  report_id TEXT NOT NULL,
  entity_cui VARCHAR(20) NOT NULL,
  main_creditor_cui VARCHAR(20),
  budget_sector_id INT NOT NULL,
  funding_source_id INT NOT NULL,
  functional_code VARCHAR(20) NOT NULL,
  economic_code  VARCHAR(20),

  credite_angajament NUMERIC(18,2) NOT NULL,
  limita_credit_angajament NUMERIC(18,2) NOT NULL,
  credite_bugetare NUMERIC(18,2) NOT NULL,
  credite_angajament_initiale NUMERIC(18,2) NOT NULL,
  credite_bugetare_initiale NUMERIC(18,2) NOT NULL,
  credite_angajament_definitive NUMERIC(18,2) NOT NULL,
  credite_bugetare_definitive NUMERIC(18,2) NOT NULL,
  credite_angajament_disponibile NUMERIC(18,2) NOT NULL,
  credite_bugetare_disponibile NUMERIC(18,2) NOT NULL,
  receptii_totale NUMERIC(18,2) NOT NULL,
  plati_trezor NUMERIC(18,2) NOT NULL,
  plati_non_trezor NUMERIC(18,2) NOT NULL,
  receptii_neplatite NUMERIC(18,2) NOT NULL,

  monthly_plati_trezor NUMERIC(18,2) NOT NULL,
  monthly_plati_non_trezor NUMERIC(18,2) NOT NULL,
  monthly_receptii_totale NUMERIC(18,2) NOT NULL,
  monthly_receptii_neplatite_change NUMERIC(18,2) NOT NULL,
  monthly_credite_angajament NUMERIC(18,2) NOT NULL,

  is_quarterly BOOLEAN NOT NULL DEFAULT FALSE,
  quarter INT CHECK (quarter BETWEEN 1 AND 4),
  is_yearly BOOLEAN NOT NULL DEFAULT FALSE,

  quarterly_credite_angajament NUMERIC(18,2),
  quarterly_limita_credit_angajament NUMERIC(18,2),
  quarterly_credite_bugetare NUMERIC(18,2),
  quarterly_credite_angajament_initiale NUMERIC(18,2),
  quarterly_credite_bugetare_initiale NUMERIC(18,2),
  quarterly_credite_angajament_definitive NUMERIC(18,2),
  quarterly_credite_bugetare_definitive NUMERIC(18,2),
  quarterly_credite_angajament_disponibile NUMERIC(18,2),
  quarterly_credite_bugetare_disponibile NUMERIC(18,2),
  quarterly_receptii_totale NUMERIC(18,2),
  quarterly_plati_trezor NUMERIC(18,2),
  quarterly_plati_non_trezor NUMERIC(18,2),
  quarterly_receptii_neplatite NUMERIC(18,2),

  anomaly anomaly_type,

  PRIMARY KEY (year, report_type, line_item_id),

  FOREIGN KEY (report_id) REFERENCES Reports(report_id) ON DELETE CASCADE,
  FOREIGN KEY (entity_cui) REFERENCES Entities(cui) ON DELETE RESTRICT,
  FOREIGN KEY (main_creditor_cui) REFERENCES Entities(cui) ON DELETE RESTRICT,
  FOREIGN KEY (budget_sector_id) REFERENCES BudgetSectors(sector_id) ON DELETE RESTRICT,
  FOREIGN KEY (funding_source_id) REFERENCES FundingSources(source_id) ON DELETE RESTRICT,
  FOREIGN KEY (functional_code)   REFERENCES FunctionalClassifications(functional_code) ON DELETE RESTRICT,
  FOREIGN KEY (economic_code)     REFERENCES EconomicClassifications(economic_code) ON DELETE RESTRICT,

  CHECK (NOT is_yearly OR is_quarterly)
)
PARTITION BY RANGE (year);

DO $$
DECLARE y INT;
BEGIN
  FOR y IN 2016..2030 LOOP
    EXECUTE format(
      'CREATE TABLE %I PARTITION OF AngajamenteLineItems
         FOR VALUES FROM (%s) TO (%s);',
      'angajamentelineitems_y'||y, y, y+1
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
    SUM(CASE WHEN eli.account_category = 'vn' THEN COALESCE(eli.quarterly_amount, 0) ELSE 0 END) AS total_income,
    SUM(CASE WHEN eli.account_category = 'ch' THEN COALESCE(eli.quarterly_amount, 0) ELSE 0 END) AS total_expense,
    SUM(CASE WHEN eli.account_category = 'vn' THEN COALESCE(eli.quarterly_amount, 0) ELSE -COALESCE(eli.quarterly_amount, 0) END) AS budget_balance
FROM
    ExecutionLineItems eli
JOIN
    Entities e ON eli.entity_cui = e.cui
WHERE
    eli.is_quarterly = true
    -- Exclude Expense Transfers (ec 51.01, 51.02)
    -- NOTE: Ideally excludes only transfers within consolidated perimeter,
    -- but counterparty data unavailable in source XML
    AND NOT (
        eli.account_category = 'ch' AND (
            eli.economic_code LIKE '51.01%' OR
            eli.economic_code LIKE '51.02%'
        )
    )
    -- Exclude Revenue Transfers (fn 36.02.05, 37.02.03, 37.02.04, 47.02.04)
    AND NOT (
        eli.account_category = 'vn' AND (
            eli.functional_code LIKE '36.02.05%' OR
            eli.functional_code LIKE '37.02.03%' OR
            eli.functional_code LIKE '37.02.04%' OR
            eli.functional_code LIKE '47.02.04%'
        )
    )
GROUP BY
    eli.year,
    eli.quarter,
    eli.entity_cui,
    eli.main_creditor_cui,
    eli.report_type;

COMMENT ON MATERIALIZED VIEW mv_summary_quarterly IS 'Quarterly summary excluding inter-budget transfers (ec:51.01, 51.02; fn:36.02.05, 37.02.03, 37.02.04, 47.02.04). Note: expense transfer exclusion is not counterparty-aware.';


-- 4. Monthly Summary (Filtered)
CREATE MATERIALIZED VIEW mv_summary_monthly AS
SELECT
    eli.year,
    eli.month,
    eli.entity_cui,
    eli.main_creditor_cui,
    eli.report_type,
    SUM(CASE WHEN eli.account_category = 'vn' THEN eli.monthly_amount ELSE 0 END) AS total_income,
    SUM(CASE WHEN eli.account_category = 'ch' THEN eli.monthly_amount ELSE 0 END) AS total_expense,
    SUM(CASE WHEN eli.account_category = 'vn' THEN eli.monthly_amount ELSE -eli.monthly_amount END) AS budget_balance
FROM
    ExecutionLineItems eli
WHERE
    -- Exclude Expense Transfers (ec 51.01, 51.02)
    -- NOTE: Ideally excludes only transfers within consolidated perimeter,
    -- but counterparty data unavailable in source XML
    NOT (
        eli.account_category = 'ch' AND (
            eli.economic_code LIKE '51.01%' OR
            eli.economic_code LIKE '51.02%'
        )
    )
    -- Exclude Revenue Transfers (fn 36.02.05, 37.02.03, 37.02.04, 47.02.04)
    AND NOT (
        eli.account_category = 'vn' AND (
            eli.functional_code LIKE '36.02.05%' OR
            eli.functional_code LIKE '37.02.03%' OR
            eli.functional_code LIKE '37.02.04%' OR
            eli.functional_code LIKE '47.02.04%'
        )
    )
GROUP BY
    eli.year,
    eli.month,
    eli.entity_cui,
    eli.main_creditor_cui,
    eli.report_type;

COMMENT ON MATERIALIZED VIEW mv_summary_monthly IS 'Monthly summary excluding inter-budget transfers (ec:51.01, 51.02; fn:36.02.05, 37.02.03, 37.02.04, 47.02.04). Note: expense transfer exclusion is not counterparty-aware.';


-- 5. Annual Summary (Filtered)
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
WHERE
    eli.is_yearly = true
    -- Exclude Expense Transfers (ec 51.01, 51.02)
    -- NOTE: Ideally excludes only transfers within consolidated perimeter,
    -- but counterparty data unavailable in source XML
    AND NOT (
        eli.account_category = 'ch' AND (
            eli.economic_code LIKE '51.01%' OR
            eli.economic_code LIKE '51.02%'
        )
    )
    -- Exclude Revenue Transfers (fn 36.02.05, 37.02.03, 37.02.04, 47.02.04)
    AND NOT (
        eli.account_category = 'vn' AND (
            eli.functional_code LIKE '36.02.05%' OR
            eli.functional_code LIKE '37.02.03%' OR
            eli.functional_code LIKE '37.02.04%' OR
            eli.functional_code LIKE '47.02.04%'
        )
    )
GROUP BY
    eli.year,
    eli.entity_cui,
    eli.main_creditor_cui,
    eli.report_type;

COMMENT ON MATERIALIZED VIEW mv_summary_annual IS 'Annual summary excluding inter-budget transfers (ec:51.01, 51.02; fn:36.02.05, 37.02.03, 37.02.04, 47.02.04). Note: expense transfer exclusion is not counterparty-aware.';

-- ========= ANGAJAMENTE SUMMARY VIEWS =========
CREATE MATERIALIZED VIEW mv_angajamente_summary_quarterly AS
SELECT
    ali.year,
    ali.quarter,
    ali.entity_cui,
    ali.main_creditor_cui,
    ali.report_type,
    SUM(COALESCE(ali.quarterly_credite_angajament, 0)) AS credite_angajament,
    SUM(COALESCE(ali.quarterly_limita_credit_angajament, 0)) AS limita_credit_angajament,
    SUM(COALESCE(ali.quarterly_credite_bugetare, 0)) AS credite_bugetare,
    SUM(COALESCE(ali.quarterly_credite_angajament_initiale, 0)) AS credite_angajament_initiale,
    SUM(COALESCE(ali.quarterly_credite_bugetare_initiale, 0)) AS credite_bugetare_initiale,
    SUM(COALESCE(ali.quarterly_credite_angajament_definitive, 0)) AS credite_angajament_definitive,
    SUM(COALESCE(ali.quarterly_credite_bugetare_definitive, 0)) AS credite_bugetare_definitive,
    SUM(COALESCE(ali.quarterly_credite_angajament_disponibile, 0)) AS credite_angajament_disponibile,
    SUM(COALESCE(ali.quarterly_credite_bugetare_disponibile, 0)) AS credite_bugetare_disponibile,
    SUM(COALESCE(ali.quarterly_receptii_totale, 0)) AS receptii_totale,
    SUM(COALESCE(ali.quarterly_plati_trezor, 0)) AS plati_trezor,
    SUM(COALESCE(ali.quarterly_plati_non_trezor, 0)) AS plati_non_trezor,
    SUM(COALESCE(ali.quarterly_receptii_neplatite, 0)) AS receptii_neplatite
FROM AngajamenteLineItems ali
WHERE
    ali.is_quarterly = true
    AND NOT (
        ali.economic_code IS NOT NULL AND (
            ali.economic_code LIKE '51.01%' OR
            ali.economic_code LIKE '51.02%'
        )
    )
    AND NOT (
        ali.functional_code LIKE '36.02.05%' OR
        ali.functional_code LIKE '37.02.03%' OR
        ali.functional_code LIKE '37.02.04%' OR
        ali.functional_code LIKE '47.02.04%'
    )
GROUP BY
    ali.year,
    ali.quarter,
    ali.entity_cui,
    ali.main_creditor_cui,
    ali.report_type;

COMMENT ON MATERIALIZED VIEW mv_angajamente_summary_quarterly IS 'Quarterly summary for angajamente based on quarterly deltas. Transfer exclusions applied by economic/functional codes without counterparty context.';

CREATE MATERIALIZED VIEW mv_angajamente_summary_monthly AS
SELECT
    ali.year,
    ali.month,
    ali.entity_cui,
    ali.main_creditor_cui,
    ali.report_type,
    SUM(ali.monthly_credite_angajament) AS credite_angajament,
    SUM(ali.monthly_plati_trezor) AS plati_trezor,
    SUM(ali.monthly_plati_non_trezor) AS plati_non_trezor,
    SUM(ali.monthly_receptii_totale) AS receptii_totale,
    SUM(ali.monthly_receptii_neplatite_change) AS receptii_neplatite_change
FROM AngajamenteLineItems ali
WHERE
    NOT (
        ali.economic_code IS NOT NULL AND (
            ali.economic_code LIKE '51.01%' OR
            ali.economic_code LIKE '51.02%'
        )
    )
    AND NOT (
        ali.functional_code LIKE '36.02.05%' OR
        ali.functional_code LIKE '37.02.03%' OR
        ali.functional_code LIKE '37.02.04%' OR
        ali.functional_code LIKE '47.02.04%'
    )
GROUP BY
    ali.year,
    ali.month,
    ali.entity_cui,
    ali.main_creditor_cui,
    ali.report_type;

COMMENT ON MATERIALIZED VIEW mv_angajamente_summary_monthly IS 'Monthly summary for angajamente based on monthly deltas. Transfer exclusions applied by economic/functional codes without counterparty context.';

CREATE MATERIALIZED VIEW mv_angajamente_summary_annual AS
SELECT
    ali.year,
    ali.entity_cui,
    ali.main_creditor_cui,
    ali.report_type,
    SUM(ali.credite_angajament) AS credite_angajament,
    SUM(ali.limita_credit_angajament) AS limita_credit_angajament,
    SUM(ali.credite_bugetare) AS credite_bugetare,
    SUM(ali.credite_angajament_initiale) AS credite_angajament_initiale,
    SUM(ali.credite_bugetare_initiale) AS credite_bugetare_initiale,
    SUM(ali.credite_angajament_definitive) AS credite_angajament_definitive,
    SUM(ali.credite_bugetare_definitive) AS credite_bugetare_definitive,
    SUM(ali.credite_angajament_disponibile) AS credite_angajament_disponibile,
    SUM(ali.credite_bugetare_disponibile) AS credite_bugetare_disponibile,
    SUM(ali.receptii_totale) AS receptii_totale,
    SUM(ali.plati_trezor) AS plati_trezor,
    SUM(ali.plati_non_trezor) AS plati_non_trezor,
    SUM(ali.receptii_neplatite) AS receptii_neplatite
FROM AngajamenteLineItems ali
WHERE
    ali.is_yearly = true
    AND NOT (
        ali.economic_code IS NOT NULL AND (
            ali.economic_code LIKE '51.01%' OR
            ali.economic_code LIKE '51.02%'
        )
    )
    AND NOT (
        ali.functional_code LIKE '36.02.05%' OR
        ali.functional_code LIKE '37.02.03%' OR
        ali.functional_code LIKE '37.02.04%' OR
        ali.functional_code LIKE '47.02.04%'
    )
GROUP BY
    ali.year,
    ali.entity_cui,
    ali.main_creditor_cui,
    ali.report_type;

COMMENT ON MATERIALIZED VIEW mv_angajamente_summary_annual IS 'Annual (YTD) summary for angajamente using latest-available month per entity/year. Transfer exclusions applied by economic/functional codes without counterparty context.';

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

-- Function to compute period flags (is_yearly, is_quarterly)
CREATE OR REPLACE FUNCTION set_period_flags(year_param INT DEFAULT NULL) RETURNS void AS $$
BEGIN
  WITH max_month AS (
    SELECT
      entity_cui,
      year,
      report_type,
      main_creditor_cui,
      budget_sector_id,
      MAX(month) AS max_month
    FROM ExecutionLineItems
    WHERE year_param IS NULL OR year = year_param
    GROUP BY entity_cui, year, report_type, main_creditor_cui, budget_sector_id
  )
  UPDATE ExecutionLineItems eli
  SET
    is_yearly = (eli.month = mm.max_month),
    is_quarterly = (eli.month IN (3, 6, 9, 12) OR eli.month = mm.max_month),
    quarter = CASE
        WHEN (eli.month IN (3, 6, 9, 12) OR eli.month = mm.max_month)
        THEN CEILING(eli.month / 3.0)
        ELSE NULL
    END::INT
  FROM max_month mm
  WHERE
    eli.entity_cui = mm.entity_cui AND
    eli.year = mm.year AND
    eli.report_type = mm.report_type AND
    eli.budget_sector_id = mm.budget_sector_id AND
    eli.main_creditor_cui IS NOT DISTINCT FROM mm.main_creditor_cui;
END;
$$ LANGUAGE plpgsql;
COMMENT ON FUNCTION set_period_flags(INT) IS 'Computes is_yearly, is_quarterly, and quarter flags/values based on the latest available month for an entity/year/report_type/main_creditor/budget_sector. If year_param is provided, only processes that specific year.';

-- Function to compute period flags for angajamente (is_yearly, is_quarterly)
CREATE OR REPLACE FUNCTION set_angajamente_period_flags(year_param INT DEFAULT NULL) RETURNS void AS $$
BEGIN
  WITH max_month AS (
    SELECT
      entity_cui,
      year,
      report_type,
      main_creditor_cui,
      budget_sector_id,
      MAX(month) AS max_month
    FROM AngajamenteLineItems
    WHERE year_param IS NULL OR year = year_param
    GROUP BY entity_cui, year, report_type, main_creditor_cui, budget_sector_id
  )
  UPDATE AngajamenteLineItems ali
  SET
    is_yearly = (ali.month = mm.max_month),
    is_quarterly = (ali.month IN (3, 6, 9, 12) OR ali.month = mm.max_month),
    quarter = CASE
        WHEN (ali.month IN (3, 6, 9, 12) OR ali.month = mm.max_month)
        THEN CEILING(ali.month / 3.0)
        ELSE NULL
    END::INT
  FROM max_month mm
  WHERE
    ali.entity_cui = mm.entity_cui AND
    ali.year = mm.year AND
    ali.report_type = mm.report_type AND
    ali.budget_sector_id = mm.budget_sector_id AND
    ali.main_creditor_cui IS NOT DISTINCT FROM mm.main_creditor_cui;
END;
$$ LANGUAGE plpgsql;
COMMENT ON FUNCTION set_angajamente_period_flags(INT) IS 'Computes is_yearly, is_quarterly, and quarter flags/values for AngajamenteLineItems based on the latest available month for an entity/year/report_type/main_creditor/budget_sector. If year_param is provided, only processes that specific year.';

-- Optimized function to get population for entities
CREATE OR REPLACE FUNCTION get_entity_population(entity_cui_param VARCHAR(20), entity_type_param VARCHAR(50), uat_id_param INT)
RETURNS INT AS $$
DECLARE
    result INT;
BEGIN
    -- For UAT entities, get population directly from UAT
    IF entity_type_param = 'uat' OR entity_type_param IS NULL THEN
        SELECT u.population INTO result
        FROM UATs u
        WHERE u.id = uat_id_param OR u.uat_code = entity_cui_param
        ORDER BY CASE WHEN u.id = uat_id_param THEN 0 ELSE 1 END
        LIMIT 1;
        RETURN result;
    END IF;

    -- For admin county council, get county population
    IF entity_type_param = 'admin_county_council' THEN
        SELECT COALESCE(
            MAX(CASE
                WHEN u.county_code = 'B' AND u.siruta_code = '179132' THEN u.population
                WHEN u.siruta_code = u.county_code THEN u.population
                ELSE 0
            END),
            0
        ) INTO result
        FROM UATs u
        WHERE u.county_code = (
            SELECT u2.county_code
            FROM UATs u2
            WHERE u2.id = uat_id_param OR u2.uat_code = entity_cui_param
            ORDER BY CASE WHEN u2.id = uat_id_param THEN 0 ELSE 1 END
            LIMIT 1
        );
        RETURN result;
    END IF;

    RETURN NULL;
END;
$$ LANGUAGE plpgsql;
COMMENT ON FUNCTION get_entity_population(cui VARCHAR(20), entity_type VARCHAR(50), uat_id INT) IS 'Returns population for an entity based on its type and UAT association';

-- Function 2: Computes and stores the quarterly amount
CREATE OR REPLACE FUNCTION compute_quarterly_amounts(year_param INT DEFAULT NULL) RETURNS void AS $$
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
      AND (year_param IS NULL OR year = year_param)
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
COMMENT ON FUNCTION compute_quarterly_amounts(INT) IS 'Computes quarterly totals by subtracting the previous quarter''s ytd_amount from the current one and stores the result in the quarterly_amount column for rows where is_quarterly=true. If year_param is provided, only processes that specific year.';

-- Function: Computes and stores quarterly deltas for angajamente
CREATE OR REPLACE FUNCTION compute_angajamente_quarterly_amounts(year_param INT DEFAULT NULL) RETURNS void AS $$
BEGIN
  WITH QuarterlyTotals AS (
    SELECT
      line_item_id,
      year,
      report_type,
      (
        credite_angajament - LAG(credite_angajament, 1, 0) OVER (
          PARTITION BY
            year,
            entity_cui,
            report_type,
            main_creditor_cui,
            budget_sector_id,
            funding_source_id,
            functional_code,
            economic_code
          ORDER BY
            month
        )
      ) AS quarterly_credite_angajament_calc,
      (
        limita_credit_angajament - LAG(limita_credit_angajament, 1, 0) OVER (
          PARTITION BY
            year,
            entity_cui,
            report_type,
            main_creditor_cui,
            budget_sector_id,
            funding_source_id,
            functional_code,
            economic_code
          ORDER BY
            month
        )
      ) AS quarterly_limita_credit_angajament_calc,
      (
        credite_bugetare - LAG(credite_bugetare, 1, 0) OVER (
          PARTITION BY
            year,
            entity_cui,
            report_type,
            main_creditor_cui,
            budget_sector_id,
            funding_source_id,
            functional_code,
            economic_code
          ORDER BY
            month
        )
      ) AS quarterly_credite_bugetare_calc,
      (
        credite_angajament_initiale - LAG(credite_angajament_initiale, 1, 0) OVER (
          PARTITION BY
            year,
            entity_cui,
            report_type,
            main_creditor_cui,
            budget_sector_id,
            funding_source_id,
            functional_code,
            economic_code
          ORDER BY
            month
        )
      ) AS quarterly_credite_angajament_initiale_calc,
      (
        credite_bugetare_initiale - LAG(credite_bugetare_initiale, 1, 0) OVER (
          PARTITION BY
            year,
            entity_cui,
            report_type,
            main_creditor_cui,
            budget_sector_id,
            funding_source_id,
            functional_code,
            economic_code
          ORDER BY
            month
        )
      ) AS quarterly_credite_bugetare_initiale_calc,
      (
        credite_angajament_definitive - LAG(credite_angajament_definitive, 1, 0) OVER (
          PARTITION BY
            year,
            entity_cui,
            report_type,
            main_creditor_cui,
            budget_sector_id,
            funding_source_id,
            functional_code,
            economic_code
          ORDER BY
            month
        )
      ) AS quarterly_credite_angajament_definitive_calc,
      (
        credite_bugetare_definitive - LAG(credite_bugetare_definitive, 1, 0) OVER (
          PARTITION BY
            year,
            entity_cui,
            report_type,
            main_creditor_cui,
            budget_sector_id,
            funding_source_id,
            functional_code,
            economic_code
          ORDER BY
            month
        )
      ) AS quarterly_credite_bugetare_definitive_calc,
      (
        credite_angajament_disponibile - LAG(credite_angajament_disponibile, 1, 0) OVER (
          PARTITION BY
            year,
            entity_cui,
            report_type,
            main_creditor_cui,
            budget_sector_id,
            funding_source_id,
            functional_code,
            economic_code
          ORDER BY
            month
        )
      ) AS quarterly_credite_angajament_disponibile_calc,
      (
        credite_bugetare_disponibile - LAG(credite_bugetare_disponibile, 1, 0) OVER (
          PARTITION BY
            year,
            entity_cui,
            report_type,
            main_creditor_cui,
            budget_sector_id,
            funding_source_id,
            functional_code,
            economic_code
          ORDER BY
            month
        )
      ) AS quarterly_credite_bugetare_disponibile_calc,
      (
        receptii_totale - LAG(receptii_totale, 1, 0) OVER (
          PARTITION BY
            year,
            entity_cui,
            report_type,
            main_creditor_cui,
            budget_sector_id,
            funding_source_id,
            functional_code,
            economic_code
          ORDER BY
            month
        )
      ) AS quarterly_receptii_totale_calc,
      (
        plati_trezor - LAG(plati_trezor, 1, 0) OVER (
          PARTITION BY
            year,
            entity_cui,
            report_type,
            main_creditor_cui,
            budget_sector_id,
            funding_source_id,
            functional_code,
            economic_code
          ORDER BY
            month
        )
      ) AS quarterly_plati_trezor_calc,
      (
        plati_non_trezor - LAG(plati_non_trezor, 1, 0) OVER (
          PARTITION BY
            year,
            entity_cui,
            report_type,
            main_creditor_cui,
            budget_sector_id,
            funding_source_id,
            functional_code,
            economic_code
          ORDER BY
            month
        )
      ) AS quarterly_plati_non_trezor_calc,
      (
        receptii_neplatite - LAG(receptii_neplatite, 1, 0) OVER (
          PARTITION BY
            year,
            entity_cui,
            report_type,
            main_creditor_cui,
            budget_sector_id,
            funding_source_id,
            functional_code,
            economic_code
          ORDER BY
            month
        )
      ) AS quarterly_receptii_neplatite_calc
    FROM AngajamenteLineItems
    WHERE
      is_quarterly = true
      AND (year_param IS NULL OR year = year_param)
  )
  UPDATE AngajamenteLineItems ali
  SET
    quarterly_credite_angajament = qt.quarterly_credite_angajament_calc,
    quarterly_limita_credit_angajament = qt.quarterly_limita_credit_angajament_calc,
    quarterly_credite_bugetare = qt.quarterly_credite_bugetare_calc,
    quarterly_credite_angajament_initiale = qt.quarterly_credite_angajament_initiale_calc,
    quarterly_credite_bugetare_initiale = qt.quarterly_credite_bugetare_initiale_calc,
    quarterly_credite_angajament_definitive = qt.quarterly_credite_angajament_definitive_calc,
    quarterly_credite_bugetare_definitive = qt.quarterly_credite_bugetare_definitive_calc,
    quarterly_credite_angajament_disponibile = qt.quarterly_credite_angajament_disponibile_calc,
    quarterly_credite_bugetare_disponibile = qt.quarterly_credite_bugetare_disponibile_calc,
    quarterly_receptii_totale = qt.quarterly_receptii_totale_calc,
    quarterly_plati_trezor = qt.quarterly_plati_trezor_calc,
    quarterly_plati_non_trezor = qt.quarterly_plati_non_trezor_calc,
    quarterly_receptii_neplatite = qt.quarterly_receptii_neplatite_calc
  FROM QuarterlyTotals qt
  WHERE
    ali.line_item_id = qt.line_item_id
    AND ali.year = qt.year
    AND ali.report_type = qt.report_type;
END;
$$ LANGUAGE plpgsql;
COMMENT ON FUNCTION compute_angajamente_quarterly_amounts(INT) IS 'Computes quarterly deltas for angajamente by subtracting the previous quarter''s YTD values from the current quarter''s YTD values and stores them in quarterly_* columns for rows where is_quarterly=true. If year_param is provided, only processes that specific year.';

-- Immutable function for array indexing (unchanged, good practice)
CREATE OR REPLACE FUNCTION immutable_array_to_string(text [], text) RETURNS text AS $$
SELECT array_to_string($1, $2);
$$ LANGUAGE sql IMMUTABLE;

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

-- ========= INDEXES =========
-- This file contains all index definitions for the database schema.
-- Indexes should be created AFTER data has been loaded for better performance.

-- ========= MATERIALIZED VIEW INDEXES =========

-- Indexes on mv_report_availability
CREATE UNIQUE INDEX idx_mv_report_avail_unique ON mv_report_availability (entity_cui, year, report_type);
CREATE INDEX idx_mv_report_avail_entity_year ON mv_report_availability (entity_cui, year, priority);

-- Index on mv_summary_quarterly
CREATE UNIQUE INDEX idx_mv_summary_quarterly_unique ON mv_summary_quarterly(year, quarter, entity_cui, report_type, main_creditor_cui);

-- Index on mv_summary_monthly
CREATE UNIQUE INDEX idx_mv_summary_monthly_unique ON mv_summary_monthly(year, month, entity_cui, report_type, main_creditor_cui);

-- Indexes on mv_summary_annual
CREATE INDEX idx_mv_summary_annual_entity_year ON mv_summary_annual(entity_cui, year);
CREATE INDEX idx_mv_summary_annual_year_balance ON mv_summary_annual(year, budget_balance DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_summary_annual_unique
  ON mv_summary_annual (year, report_type, entity_cui, main_creditor_cui);

-- Indexes on mv_angajamente_summary_quarterly
CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_angajamente_summary_quarterly_unique
  ON mv_angajamente_summary_quarterly(year, quarter, entity_cui, report_type, main_creditor_cui);

-- Indexes on mv_angajamente_summary_monthly
CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_angajamente_summary_monthly_unique
  ON mv_angajamente_summary_monthly(year, month, entity_cui, report_type, main_creditor_cui);

-- Indexes on mv_angajamente_summary_annual
CREATE INDEX IF NOT EXISTS idx_mv_angajamente_summary_annual_entity_year ON mv_angajamente_summary_annual(entity_cui, year);
CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_angajamente_summary_annual_unique
  ON mv_angajamente_summary_annual(year, report_type, entity_cui, main_creditor_cui);

-- ========= JUNCTION TABLE INDEXES =========

-- Reverse lookup indexes for junction tables to speed up lookups by tag
CREATE INDEX idx_entitytags_tag_id ON EntityTags(tag_id);
CREATE INDEX idx_functionalclassificationtags_tag_id ON FunctionalClassificationTags(tag_id);
CREATE INDEX idx_economicclassificationtags_tag_id ON EconomicClassificationTags(tag_id);

-- ========= FACT TABLE INDEXES (ExecutionLineItems) =========

-- Partial indexes for period filtering
CREATE INDEX idx_executionlineitems_yearly ON ExecutionLineItems (entity_cui, year, report_type) WHERE is_yearly = true;
CREATE INDEX idx_executionlineitems_quarterly ON ExecutionLineItems (entity_cui, year, report_type) WHERE is_quarterly = true;

-- Composite index for main filter conditions (report_type, year, account_category, is_yearly)
CREATE INDEX idx_executionlineitems_report_type_year_acct_yearly ON ExecutionLineItems (report_type, year, account_category, is_yearly) WHERE is_yearly = true;

-- Index for querying by quarter
CREATE INDEX idx_executionlineitems_year_quarter ON ExecutionLineItems (year, quarter) WHERE quarter IS NOT NULL;

-- Comprehensive index for the entity analytics query patterns.
-- It leads with the most common filters (account_category, report_type) that are not already part of the partitioning key.
-- This allows the planner to quickly narrow down the set of rows to scan.
-- It includes entity_cui, functional_code, and economic_code to cover common drill-down scenarios.
-- The various amount columns are included (INCLUDE) to allow for index-only scans, avoiding table heap access.
CREATE INDEX idx_eli_analytics_coverage ON ExecutionLineItems (
    is_yearly,
    is_quarterly,
    account_category,
    report_type,
    functional_code,
    economic_code,
    entity_cui
)
INCLUDE (ytd_amount, monthly_amount, quarterly_amount);

-- Indexes for specific expense drill-downs
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

-- ========= FACT TABLE INDEXES (AngajamenteLineItems) =========

-- Partial indexes for period filtering
CREATE INDEX IF NOT EXISTS idx_angajamente_yearly ON AngajamenteLineItems (entity_cui, year, report_type) WHERE is_yearly = true;
CREATE INDEX IF NOT EXISTS idx_angajamente_quarterly ON AngajamenteLineItems (entity_cui, year, report_type) WHERE is_quarterly = true;

-- Index for querying by quarter
CREATE INDEX IF NOT EXISTS idx_angajamente_year_quarter ON AngajamenteLineItems (year, quarter) WHERE quarter IS NOT NULL;

CREATE INDEX idx_angajamente_entity_year ON AngajamenteLineItems (entity_cui, year);
CREATE INDEX idx_angajamente_report_id ON AngajamenteLineItems (report_id);
CREATE INDEX idx_angajamente_budget_sector_id ON AngajamenteLineItems (budget_sector_id);
CREATE INDEX idx_angajamente_main_creditor_cui ON AngajamenteLineItems (main_creditor_cui);
CREATE INDEX idx_angajamente_funding_source_id ON AngajamenteLineItems (funding_source_id);
CREATE INDEX idx_angajamente_year_month ON AngajamenteLineItems (year, month);
CREATE INDEX idx_angajamente_functional_code_vpo ON AngajamenteLineItems (functional_code varchar_pattern_ops);
CREATE INDEX idx_angajamente_economic_code_vpo ON AngajamenteLineItems (economic_code varchar_pattern_ops);

-- ========= DIMENSION & METADATA TABLE INDEXES =========

-- Reports indexes
CREATE INDEX idx_reports_entity_cui ON Reports (entity_cui);
CREATE INDEX idx_reports_report_date ON Reports (report_date);
CREATE INDEX idx_reports_date_brin ON Reports USING BRIN (report_date); -- BRIN is good for linear time-series data.
CREATE INDEX idx_reports_reporting_year ON Reports (reporting_year);
CREATE INDEX idx_reports_reporting_period ON Reports (reporting_period);
CREATE INDEX idx_reports_main_creditor_cui ON Reports (main_creditor_cui);
CREATE INDEX idx_reports_budget_sector_id ON Reports (budget_sector_id);

-- Entities indexes
CREATE INDEX idx_entities_uat_id ON Entities (uat_id);
CREATE INDEX idx_entities_type ON Entities(entity_type) WHERE entity_type IS NOT NULL;

-- UATs indexes
CREATE INDEX idx_uats_county_code ON UATs (county_code);
CREATE INDEX idx_uats_region ON UATs (region);
CREATE INDEX idx_uats_id ON UATs (id);
CREATE INDEX idx_uats_uat_code ON UATs (uat_code);
CREATE INDEX idx_uats_siruta_code ON UATs (siruta_code);
CREATE INDEX idx_uats_county_code_siruta_code ON UATs (county_code, siruta_code);

-- ========= TEXT SEARCH INDEXES (pg_trgm) =========

-- GIN Indexes for fuzzy text search
CREATE INDEX idx_gin_entities_name ON Entities USING gin (name gin_trgm_ops);
CREATE INDEX idx_gin_uats_name ON UATs USING gin (name gin_trgm_ops);
CREATE INDEX idx_gin_fc_functional_name ON FunctionalClassifications USING gin (functional_name gin_trgm_ops);
CREATE INDEX idx_gin_ec_economic_name ON EconomicClassifications USING gin (economic_name gin_trgm_ops);
CREATE INDEX idx_gin_fs_source_description ON FundingSources USING gin (source_description gin_trgm_ops);
CREATE INDEX idx_gin_budget_sectors_description ON BudgetSectors USING gin (sector_description gin_trgm_ops);
CREATE INDEX idx_gin_tags_name ON Tags USING gin (tag_name gin_trgm_ops);
CREATE INDEX idx_gin_reports_download_links_trgm ON Reports USING gin (immutable_array_to_string(download_links, ' ') gin_trgm_ops);
