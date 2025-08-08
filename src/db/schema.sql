-- ========= CLEAR EXISTING DATA =========
-- Truncate all base tables to reset data and sequences before (re)creating schema or seeding.
-- RESTART IDENTITY resets serial counters (like for SERIAL or BIGSERIAL types).
-- CASCADE handles foreign key dependencies, truncating dependent tables as well.
-- TRUNCATE
-- UATs,
-- Entities,
-- FunctionalClassifications,
-- EconomicClassifications,
-- FundingSources,
-- BudgetSectors,
-- Reports,
-- ExecutionLineItems,
-- Tags,
-- EntityTags,
-- FunctionalClassificationTags,
-- EconomicClassificationTags,
-- ExecutionLineItemTags
-- RESTART IDENTITY CASCADE;
-- Enable pg_trgm extension for similarity searches
CREATE EXTENSION IF NOT EXISTS pg_trgm;
-- ========= ENUM TYPES =========
-- Create enum for report types
CREATE TYPE report_type AS ENUM (
    'Executie bugetara agregata la nivel de ordonator principal',
    'Executie bugetara detaliata'
);
-- Create enum for expense types
CREATE TYPE expense_type AS ENUM (
    'dezvoltare',
    -- development
    'functionare' -- operational
);
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
    is_main_creditor BOOLEAN NOT NULL DEFAULT FALSE,
    is_uat BOOLEAN NOT NULL DEFAULT FALSE,
    last_updated TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    main_creditor_1_cui VARCHAR(20),
    main_creditor_2_cui VARCHAR(20),
    FOREIGN KEY (uat_id) REFERENCES UATs(id) ON DELETE RESTRICT,
    -- FOREIGN KEY (main_creditor_1_cui) REFERENCES Entities(cui) ON DELETE RESTRICT,
    CHECK (
        main_creditor_1_cui IS NULL
        OR main_creditor_2_cui != cui
    ),
    CHECK (
        main_creditor_2_cui IS NULL
        OR main_creditor_2_cui != cui
    ) -- FOREIGN KEY (main_creditor_2_cui) REFERENCES Entities(cui) ON DELETE RESTRICT,
    -- Ensure main_creditor_2 is only set if main_creditor_1 is set
    -- CHECK (main_creditor_2_cui IS NULL OR main_creditor_1_cui IS NOT NULL)
);
-- Add explanatory comment to Entities table
COMMENT ON TABLE Entities IS 'Public entities that report budget execution data, usually associated with UATs';
COMMENT ON COLUMN Entities.cui IS 'Unique fiscal identification code (CUI/CIF) of the reporting entity';
COMMENT ON COLUMN Entities.entity_type IS 'Type of entity: uat, public_institution, public_company, ministry, agency, other';
COMMENT ON COLUMN Entities.is_main_creditor IS 'Flag indicating if this entity is a main creditor';
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
    line_item_id BIGSERIAL PRIMARY KEY,
    report_id TEXT NOT NULL,
    report_type report_type NOT NULL,
    entity_cui VARCHAR(20) NOT NULL,
    main_creditor_cui VARCHAR(20),
    budget_sector_id INT NOT NULL,
    funding_source_id INT NOT NULL,
    functional_code VARCHAR(20) NOT NULL,
    economic_code VARCHAR(20) NULL,
    account_category CHAR(2) NOT NULL,
    amount DECIMAL(18, 2) NOT NULL,
    program_code VARCHAR(50) NULL,
    expense_type expense_type NULL,
    year INT NOT NULL CHECK (
        year >= 2000
        AND year <= 2100
    ),
    FOREIGN KEY (report_id) REFERENCES Reports(report_id) ON DELETE CASCADE,
    FOREIGN KEY (entity_cui) REFERENCES Entities(cui) ON DELETE RESTRICT,
    FOREIGN KEY (funding_source_id) REFERENCES FundingSources(source_id) ON DELETE RESTRICT,
    FOREIGN KEY (functional_code) REFERENCES FunctionalClassifications(functional_code) ON DELETE RESTRICT,
    FOREIGN KEY (economic_code) REFERENCES EconomicClassifications(economic_code) ON DELETE RESTRICT,
    FOREIGN KEY (budget_sector_id) REFERENCES BudgetSectors(sector_id) ON DELETE RESTRICT,
    FOREIGN KEY (main_creditor_cui) REFERENCES Entities(cui) ON DELETE RESTRICT,
    CHECK (account_category IN ('vn', 'ch')),
    -- Ensure economic_code is not NULL for expenses (account_category = 'ch')
    CHECK (
        account_category != 'ch'
        OR economic_code IS NOT NULL
    )
);
-- Add explanatory comment
COMMENT ON TABLE ExecutionLineItems IS 'Fact table containing individual budget execution line items';
COMMENT ON COLUMN ExecutionLineItems.account_category IS 'Type of budget item: "vn" for income (venituri), "ch" for expenses (cheltuieli)';
COMMENT ON COLUMN ExecutionLineItems.amount IS 'Monetary amount in RON';
COMMENT ON COLUMN ExecutionLineItems.expense_type IS 'Type of expense: dezvoltare (development) or functionare (operational)';
-- Create junction tables for many-to-many relationships
CREATE TABLE EntityTags (
    entity_cui VARCHAR(20),
    tag_id INT,
    PRIMARY KEY (entity_cui, tag_id),
    FOREIGN KEY (entity_cui) REFERENCES Entities(cui) ON DELETE CASCADE,
    FOREIGN KEY (tag_id) REFERENCES Tags(tag_id) ON DELETE CASCADE
);
CREATE TABLE FunctionalClassificationTags (
    functional_code VARCHAR(20),
    tag_id INT,
    PRIMARY KEY (functional_code, tag_id),
    FOREIGN KEY (functional_code) REFERENCES FunctionalClassifications(functional_code) ON DELETE CASCADE,
    FOREIGN KEY (tag_id) REFERENCES Tags(tag_id) ON DELETE CASCADE
);
CREATE TABLE EconomicClassificationTags (
    economic_code VARCHAR(20),
    tag_id INT,
    PRIMARY KEY (economic_code, tag_id),
    FOREIGN KEY (economic_code) REFERENCES EconomicClassifications(economic_code) ON DELETE CASCADE,
    FOREIGN KEY (tag_id) REFERENCES Tags(tag_id) ON DELETE CASCADE
);
CREATE TABLE ExecutionLineItemTags (
    line_item_id BIGINT,
    tag_id INT,
    PRIMARY KEY (line_item_id, tag_id),
    FOREIGN KEY (line_item_id) REFERENCES ExecutionLineItems(line_item_id) ON DELETE CASCADE,
    FOREIGN KEY (tag_id) REFERENCES Tags(tag_id) ON DELETE CASCADE
);
-- ========= INDEXES FOR PERFORMANCE =========
-- Primary table indexes
CREATE INDEX idx_executionitems_report_id ON ExecutionLineItems (report_id);
CREATE INDEX idx_executionitems_funding_source_id ON ExecutionLineItems (funding_source_id);
CREATE INDEX idx_executionitems_functional_code ON ExecutionLineItems (functional_code);
CREATE INDEX idx_executionitems_economic_code ON ExecutionLineItems (economic_code)
WHERE economic_code IS NOT NULL;
CREATE INDEX idx_executionitems_account_category ON ExecutionLineItems (account_category);
CREATE INDEX idx_executionitems_budget_sector_id ON ExecutionLineItems (budget_sector_id);
CREATE INDEX idx_executionitems_main_creditor_cui ON ExecutionLineItems (main_creditor_cui)
WHERE main_creditor_cui IS NOT NULL;
-- Composite indexes for common query patterns
CREATE INDEX idx_executionitems_entity_year ON ExecutionLineItems (entity_cui, year);
CREATE INDEX idx_executionitems_year_entity_category ON ExecutionLineItems(year, entity_cui, account_category);
CREATE INDEX idx_executionitems_covering ON ExecutionLineItems(entity_cui, year, account_category) INCLUDE (amount, functional_code, economic_code);
-- Report indexes
CREATE INDEX idx_reports_entity_cui ON Reports (entity_cui);
CREATE INDEX idx_reports_report_date ON Reports (report_date);
CREATE INDEX idx_reports_reporting_year ON Reports (reporting_year);
CREATE INDEX idx_reports_type ON Reports(report_type);
CREATE INDEX idx_reports_main_creditor_cui ON Reports(main_creditor_cui)
WHERE main_creditor_cui IS NOT NULL;
CREATE INDEX idx_reports_detailed_type ON Reports(entity_cui, report_date)
WHERE report_type = 'Executie bugetara detaliata';
CREATE INDEX idx_reports_aggregated_type ON Reports(entity_cui, report_date)
WHERE report_type = 'Executie bugetara agregata la nivel de ordonator principal';
-- Entity indexes
CREATE INDEX idx_entities_uat_id ON Entities (uat_id);
CREATE INDEX idx_entities_uat_id_cui ON Entities(uat_id, cui);
CREATE INDEX idx_entities_main_creditor_1 ON Entities(main_creditor_1_cui)
WHERE main_creditor_1_cui IS NOT NULL;
CREATE INDEX idx_entities_main_creditor_2 ON Entities(main_creditor_2_cui)
WHERE main_creditor_2_cui IS NOT NULL;
CREATE INDEX idx_entities_type ON Entities(entity_type)
WHERE entity_type IS NOT NULL;
CREATE INDEX idx_entities_main_creditors_only ON Entities(cui, name)
WHERE is_main_creditor = TRUE;
CREATE INDEX idx_entities_uat ON Entities(cui)
WHERE is_uat = TRUE;
-- UAT indexes
CREATE INDEX idx_uats_uat_code ON UATs (uat_code);
CREATE INDEX idx_uats_county_code ON UATs (county_code);
CREATE INDEX idx_uats_uat_key ON UATs (uat_key);
-- Other indexes
CREATE INDEX idx_execution_expense_type ON ExecutionLineItems(expense_type)
WHERE account_category = 'ch';
CREATE INDEX idx_executionitems_expense_type_year ON ExecutionLineItems(expense_type, year)
WHERE expense_type IS NOT NULL;
CREATE INDEX idx_tags_name ON Tags(tag_name);
-- BRIN indexes for time-series data
CREATE INDEX idx_executionitems_year_brin ON ExecutionLineItems USING brin(year);
CREATE INDEX idx_reports_date_brin ON Reports USING brin(report_date);
-- Indexes for tag system
CREATE INDEX idx_entity_tags_entity ON EntityTags(entity_cui);
CREATE INDEX idx_entity_tags_tag ON EntityTags(tag_id);
CREATE INDEX idx_functional_tags_code ON FunctionalClassificationTags(functional_code);
CREATE INDEX idx_functional_tags_tag ON FunctionalClassificationTags(tag_id);
CREATE INDEX idx_economic_tags_code ON EconomicClassificationTags(economic_code);
CREATE INDEX idx_economic_tags_tag ON EconomicClassificationTags(tag_id);
CREATE INDEX idx_execution_tags_item ON ExecutionLineItemTags(line_item_id);
CREATE INDEX idx_execution_tags_tag ON ExecutionLineItemTags(tag_id);
-- Indexes for pg_trgm text search performance
CREATE INDEX idx_gin_fc_functional_name ON FunctionalClassifications USING gin (functional_name gin_trgm_ops);
CREATE INDEX idx_gin_ec_economic_name ON EconomicClassifications USING gin (economic_name gin_trgm_ops);
CREATE INDEX idx_gin_fs_source_description ON FundingSources USING gin (source_description gin_trgm_ops);
CREATE INDEX idx_gin_entities_name ON Entities USING gin (name gin_trgm_ops);
CREATE INDEX idx_gin_entities_address ON Entities USING gin (address gin_trgm_ops)
WHERE address IS NOT NULL;
CREATE INDEX idx_gin_uats_name ON UATs USING gin (name gin_trgm_ops);
CREATE INDEX idx_gin_uats_county_name ON UATs USING gin (county_name gin_trgm_ops);
CREATE INDEX idx_gin_reports_file_source ON Reports USING gin (file_source gin_trgm_ops)
WHERE file_source IS NOT NULL;
CREATE INDEX idx_gin_eli_program_code ON ExecutionLineItems USING gin (program_code gin_trgm_ops)
WHERE program_code IS NOT NULL;
CREATE INDEX idx_gin_tags_name ON Tags USING gin (tag_name gin_trgm_ops);
-- ========= ANALYTICAL VIEWS =========
-- View 1: Comprehensive flattened view of all execution line items with all dimensional attributes
CREATE MATERIALIZED VIEW vw_ExecutionDetails AS
SELECT eli.line_item_id,
    eli.entity_cui,
    eli.amount,
    eli.account_category,
    -- 'vn' (venituri/income), 'ch' (cheltuieli/expense)
    eli.program_code,
    eli.expense_type,
    r.report_id,
    r.report_date,
    r.reporting_year,
    r.reporting_period,
    r.import_timestamp,
    e.name AS entity_name,
    e.address AS entity_address,
    e.entity_type,
    e.is_main_creditor,
    e.is_uat,
    u.id AS uat_id,
    u.uat_code,
    u.name AS uat_name,
    u.county_code,
    u.county_name,
    u.region AS uat_region,
    u.population AS uat_population,
    fs.source_id AS funding_source_id,
    fs.source_description AS funding_source,
    fc.functional_code,
    fc.functional_name,
    ec.economic_code,
    ec.economic_name,
    bs.sector_id AS budget_sector_id,
    bs.sector_description AS budget_sector
FROM ExecutionLineItems eli
    JOIN Reports r ON eli.report_id = r.report_id
    JOIN Entities e ON eli.entity_cui = e.cui
    JOIN FundingSources fs ON eli.funding_source_id = fs.source_id
    JOIN FunctionalClassifications fc ON eli.functional_code = fc.functional_code
    JOIN BudgetSectors bs ON eli.budget_sector_id = bs.sector_id
    LEFT JOIN EconomicClassifications ec ON eli.economic_code = ec.economic_code -- Left join because economic_code can be NULL for income items
    LEFT JOIN UATs u ON e.uat_id = u.id;
-- Left join in case some entities might not be linked to a UAT
COMMENT ON MATERIALIZED VIEW vw_ExecutionDetails IS 'Detailed view of all execution line items with dimensional attributes for comprehensive analysis and reporting';
-- View 2: Budget summary by entity and reporting period
CREATE MATERIALIZED VIEW vw_BudgetSummary_ByEntityPeriod AS
SELECT r.reporting_year,
    r.reporting_period,
    eli.entity_cui,
    e.name AS entity_name,
    e.entity_type,
    u.uat_code,
    u.name AS uat_name,
    u.county_name,
    u.region AS uat_region,
    SUM(
        CASE
            WHEN eli.account_category = 'vn' THEN eli.amount
            ELSE 0
        END
    ) AS total_income,
    SUM(
        CASE
            WHEN eli.account_category = 'ch' THEN eli.amount
            ELSE 0
        END
    ) AS total_expense,
    SUM(
        CASE
            WHEN eli.account_category = 'vn' THEN eli.amount
            ELSE - eli.amount
        END
    ) AS budget_balance,
    COUNT(DISTINCT r.report_id) AS report_count
FROM ExecutionLineItems eli
    JOIN Reports r ON eli.report_id = r.report_id
    JOIN Entities e ON eli.entity_cui = e.cui
    LEFT JOIN UATs u ON e.uat_id = u.id
GROUP BY r.reporting_year,
    r.reporting_period,
    eli.entity_cui,
    e.name,
    e.entity_type,
    u.uat_code,
    u.name,
    u.county_name,
    u.region;
COMMENT ON MATERIALIZED VIEW vw_BudgetSummary_ByEntityPeriod IS 'Summary of budget totals (income, expense, balance) aggregated by entity and reporting period';
-- View 3: Expense analysis by functional and economic classifications
CREATE MATERIALIZED VIEW vw_ExpenseAnalysis_ByCategory AS
SELECT r.reporting_year,
    r.reporting_period,
    eli.entity_cui,
    e.name AS entity_name,
    u.uat_code,
    u.name AS uat_name,
    u.county_name,
    fc.functional_code,
    fc.functional_name,
    ec.economic_code,
    ec.economic_name,
    fs.source_description AS funding_source,
    eli.expense_type,
    SUM(eli.amount) AS total_expense,
    COUNT(*) AS transaction_count
FROM ExecutionLineItems eli
    JOIN Reports r ON eli.report_id = r.report_id
    JOIN Entities e ON eli.entity_cui = e.cui
    JOIN FunctionalClassifications fc ON eli.functional_code = fc.functional_code
    LEFT JOIN EconomicClassifications ec ON eli.economic_code = ec.economic_code -- Left join in case any expense items have null economic codes
    JOIN FundingSources fs ON eli.funding_source_id = fs.source_id
    LEFT JOIN UATs u ON e.uat_id = u.id
WHERE eli.account_category = 'ch' -- Only include expenses
GROUP BY r.reporting_year,
    r.reporting_period,
    eli.entity_cui,
    e.name,
    u.uat_code,
    u.name,
    u.county_name,
    fc.functional_code,
    fc.functional_name,
    ec.economic_code,
    ec.economic_name,
    fs.source_description,
    eli.expense_type;
COMMENT ON MATERIALIZED VIEW vw_ExpenseAnalysis_ByCategory IS 'Detailed analysis of expenses by functional and economic classifications, broken down by entity and funding source';
-- View 4: Funding source summary
CREATE MATERIALIZED VIEW vw_FundingSource_Summary AS
SELECT r.reporting_year,
    fs.source_id,
    fs.source_description AS funding_source,
    u.county_code,
    u.county_name,
    u.region AS uat_region,
    SUM(
        CASE
            WHEN eli.account_category = 'vn' THEN eli.amount
            ELSE 0
        END
    ) AS total_income,
    SUM(
        CASE
            WHEN eli.account_category = 'ch' THEN eli.amount
            ELSE 0
        END
    ) AS total_expense,
    SUM(
        CASE
            WHEN eli.account_category = 'vn' THEN eli.amount
            ELSE - eli.amount
        END
    ) AS net_balance,
    COUNT(DISTINCT eli.entity_cui) AS entity_count
FROM ExecutionLineItems eli
    JOIN Reports r ON eli.report_id = r.report_id
    JOIN FundingSources fs ON eli.funding_source_id = fs.source_id
    JOIN Entities e ON eli.entity_cui = e.cui
    LEFT JOIN UATs u ON e.uat_id = u.id
GROUP BY r.reporting_year,
    fs.source_id,
    fs.source_description,
    u.county_code,
    u.county_name,
    u.region;
COMMENT ON MATERIALIZED VIEW vw_FundingSource_Summary IS 'Summary of income and expenses by funding source, broken down by geographical area and reporting year';
-- View 5: Aggregated Metrics per UAT per Year/Period
-- Purpose: Facilitates comparisons and per capita analysis between UATs.
CREATE MATERIALIZED VIEW vw_UAT_Aggregated_Metrics AS
SELECT r.reporting_year,
    r.reporting_period,
    u.id AS uat_id,
    u.uat_code,
    u.name AS uat_name,
    u.county_code,
    u.county_name,
    u.region AS uat_region,
    u.population AS uat_population,
    SUM(
        CASE
            WHEN eli.account_category = 'vn' THEN eli.amount
            ELSE 0
        END
    ) AS total_income,
    SUM(
        CASE
            WHEN eli.account_category = 'ch' THEN eli.amount
            ELSE 0
        END
    ) AS total_expense,
    SUM(
        CASE
            WHEN eli.account_category = 'vn' THEN eli.amount
            ELSE - eli.amount
        END
    ) AS budget_balance,
    -- Per capita calculations (handle division by zero or null population)
    CASE
        WHEN u.population IS NOT NULL
        AND u.population > 0 THEN SUM(
            CASE
                WHEN eli.account_category = 'vn' THEN eli.amount
                ELSE 0
            END
        ) / u.population
        ELSE NULL
    END AS per_capita_income,
    CASE
        WHEN u.population IS NOT NULL
        AND u.population > 0 THEN SUM(
            CASE
                WHEN eli.account_category = 'ch' THEN eli.amount
                ELSE 0
            END
        ) / u.population
        ELSE NULL
    END AS per_capita_expense,
    COUNT(DISTINCT eli.entity_cui) AS entity_count,
    COUNT(DISTINCT r.report_id) AS report_count
FROM ExecutionLineItems eli
    JOIN Reports r ON eli.report_id = r.report_id
    JOIN Entities e ON eli.entity_cui = e.cui
    JOIN UATs u ON e.uat_id = u.id -- INNER JOIN ensures we only aggregate for entities linked to a UAT
GROUP BY r.reporting_year,
    r.reporting_period,
    u.id,
    u.uat_code,
    u.name,
    u.county_code,
    u.county_name,
    u.region,
    u.population;
COMMENT ON MATERIALIZED VIEW vw_UAT_Aggregated_Metrics IS 'Aggregated income, expense, balance, and per capita metrics for each UAT per reporting year and period.';
-- View 6: Aggregated Metrics per County per Year/Period
-- Purpose: Aggregates metrics at the county level.
CREATE MATERIALIZED VIEW vw_County_Aggregated_Metrics AS
SELECT r.reporting_year,
    r.reporting_period,
    u.county_code,
    u.county_name,
    u.region AS uat_region,
    -- Assuming region is consistent within a county
    SUM(DISTINCT u.population) AS total_county_population,
    -- Distinct to avoid double counting UAT populations
    SUM(
        CASE
            WHEN eli.account_category = 'vn' THEN eli.amount
            ELSE 0
        END
    ) AS total_income,
    SUM(
        CASE
            WHEN eli.account_category = 'ch' THEN eli.amount
            ELSE 0
        END
    ) AS total_expense,
    SUM(
        CASE
            WHEN eli.account_category = 'vn' THEN eli.amount
            ELSE - eli.amount
        END
    ) AS budget_balance,
    -- Per capita calculations for the county
    CASE
        WHEN SUM(DISTINCT u.population) > 0 THEN SUM(
            CASE
                WHEN eli.account_category = 'vn' THEN eli.amount
                ELSE 0
            END
        ) / SUM(DISTINCT u.population)
        ELSE NULL
    END AS per_capita_income,
    CASE
        WHEN SUM(DISTINCT u.population) > 0 THEN SUM(
            CASE
                WHEN eli.account_category = 'ch' THEN eli.amount
                ELSE 0
            END
        ) / SUM(DISTINCT u.population)
        ELSE NULL
    END AS per_capita_expense,
    COUNT(DISTINCT u.id) AS uat_count,
    COUNT(DISTINCT eli.entity_cui) AS entity_count
FROM ExecutionLineItems eli
    JOIN Reports r ON eli.report_id = r.report_id
    JOIN Entities e ON eli.entity_cui = e.cui
    JOIN UATs u ON e.uat_id = u.id
WHERE u.county_code IS NOT NULL -- Ensure county code exists for aggregation
GROUP BY r.reporting_year,
    r.reporting_period,
    u.county_code,
    u.county_name,
    u.region;
COMMENT ON MATERIALIZED VIEW vw_County_Aggregated_Metrics IS 'Aggregated income, expense, balance, and per capita metrics for each County per reporting year and period.';
-- View 7: Aggregated Metrics by Category (Functional/Economic) per Year/Period
-- Purpose: Provides aggregated totals for specific spending/revenue categories across geographical levels.
CREATE MATERIALIZED VIEW vw_Category_Aggregated_Metrics AS
SELECT r.reporting_year,
    r.reporting_period,
    eli.account_category,
    fc.functional_code,
    fc.functional_name,
    ec.economic_code,
    ec.economic_name,
    fs.source_id AS funding_source_id,
    fs.source_description AS funding_source,
    u.county_code,
    u.county_name,
    u.region AS uat_region,
    -- Aggregate amounts
    SUM(eli.amount) AS total_amount,
    -- Count distinct entities contributing to this category
    COUNT(DISTINCT eli.entity_cui) AS contributing_entities_count,
    -- Statistical measures
    AVG(eli.amount) AS avg_amount,
    MIN(eli.amount) AS min_amount,
    MAX(eli.amount) AS max_amount
FROM ExecutionLineItems eli
    JOIN Reports r ON eli.report_id = r.report_id
    JOIN Entities e ON eli.entity_cui = e.cui
    JOIN FunctionalClassifications fc ON eli.functional_code = fc.functional_code
    LEFT JOIN EconomicClassifications ec ON eli.economic_code = ec.economic_code
    JOIN FundingSources fs ON eli.funding_source_id = fs.source_id
    LEFT JOIN UATs u ON e.uat_id = u.id
GROUP BY r.reporting_year,
    r.reporting_period,
    eli.account_category,
    fc.functional_code,
    fc.functional_name,
    ec.economic_code,
    ec.economic_name,
    fs.source_id,
    fs.source_description,
    u.county_code,
    u.county_name,
    u.region;
COMMENT ON MATERIALIZED VIEW vw_Category_Aggregated_Metrics IS 'Aggregated amounts by functional/economic classification and funding source, optionally broken down by geography.';
-- Create indexes on materialized views for better query performance
CREATE INDEX idx_mv_execution_details_entity_year ON vw_ExecutionDetails(entity_cui, reporting_year);
CREATE INDEX idx_mv_budget_summary_entity_year ON vw_BudgetSummary_ByEntityPeriod(entity_cui, reporting_year);
CREATE INDEX idx_mv_expense_analysis_entity_year ON vw_ExpenseAnalysis_ByCategory(entity_cui, reporting_year);
CREATE INDEX idx_mv_expense_analysis_functional ON vw_ExpenseAnalysis_ByCategory(functional_code, entity_cui);
CREATE INDEX idx_mv_funding_source_year ON vw_FundingSource_Summary(reporting_year, source_id);
CREATE INDEX idx_mv_uat_metrics_uat_year ON vw_UAT_Aggregated_Metrics(uat_id, reporting_year);
CREATE INDEX idx_mv_uat_metrics_county ON vw_UAT_Aggregated_Metrics(county_code, reporting_year);
CREATE INDEX idx_mv_county_metrics_county_year ON vw_County_Aggregated_Metrics(county_code, reporting_year);
CREATE INDEX idx_mv_category_metrics_func_year ON vw_Category_Aggregated_Metrics(functional_code, reporting_year);
CREATE UNIQUE INDEX idx_mv_execution_details_unique ON vw_ExecutionDetails(line_item_id);
-- Function to refresh all materialized views
CREATE OR REPLACE FUNCTION refresh_all_materialized_views() RETURNS void AS $$ BEGIN -- Only vw_ExecutionDetails has a unique index, so it can be refreshed concurrently
    RAISE NOTICE 'Refreshing vw_ExecutionDetails concurrently...';
REFRESH MATERIALIZED VIEW CONCURRENTLY vw_ExecutionDetails;
RAISE NOTICE 'vw_ExecutionDetails refreshed successfully';
-- The rest are aggregated views without unique indexes, so refresh them non-concurrently
RAISE NOTICE 'Refreshing vw_BudgetSummary_ByEntityPeriod...';
REFRESH MATERIALIZED VIEW vw_BudgetSummary_ByEntityPeriod;
RAISE NOTICE 'vw_BudgetSummary_ByEntityPeriod refreshed successfully';
RAISE NOTICE 'Refreshing vw_ExpenseAnalysis_ByCategory...';
REFRESH MATERIALIZED VIEW vw_ExpenseAnalysis_ByCategory;
RAISE NOTICE 'vw_ExpenseAnalysis_ByCategory refreshed successfully';
RAISE NOTICE 'Refreshing vw_FundingSource_Summary...';
REFRESH MATERIALIZED VIEW vw_FundingSource_Summary;
RAISE NOTICE 'vw_FundingSource_Summary refreshed successfully';
RAISE NOTICE 'Refreshing vw_UAT_Aggregated_Metrics...';
REFRESH MATERIALIZED VIEW vw_UAT_Aggregated_Metrics;
RAISE NOTICE 'vw_UAT_Aggregated_Metrics refreshed successfully';
RAISE NOTICE 'Refreshing vw_County_Aggregated_Metrics...';
REFRESH MATERIALIZED VIEW vw_County_Aggregated_Metrics;
RAISE NOTICE 'vw_County_Aggregated_Metrics refreshed successfully';
RAISE NOTICE 'Refreshing vw_Category_Aggregated_Metrics...';
REFRESH MATERIALIZED VIEW vw_Category_Aggregated_Metrics;
RAISE NOTICE 'vw_Category_Aggregated_Metrics refreshed successfully';
RAISE NOTICE 'All materialized views refreshed successfully';
END;
$$ LANGUAGE plpgsql;
COMMENT ON FUNCTION refresh_all_materialized_views() IS 'Refreshes all materialized views concurrently to maintain up-to-date analytical data';
-- Function to analyze index usage
CREATE OR REPLACE FUNCTION analyze_index_usage() RETURNS TABLE(
        schemaname text,
        tablename text,
        indexname text,
        idx_scan bigint,
        idx_tup_read bigint,
        idx_tup_fetch bigint,
        size text
    ) AS $$ BEGIN RETURN QUERY
SELECT s.schemaname,
    s.tablename,
    s.indexname,
    s.idx_scan,
    s.idx_tup_read,
    s.idx_tup_fetch,
    pg_size_pretty(pg_relation_size(s.indexrelid)) as size
FROM pg_stat_user_indexes s
    JOIN pg_index i ON s.indexrelid = i.indexrelid
WHERE s.idx_scan = 0 -- Unused indexes
    AND s.schemaname NOT IN ('pg_catalog', 'information_schema')
ORDER BY pg_relation_size(s.indexrelid) DESC;
END;
$$ LANGUAGE plpgsql;
COMMENT ON FUNCTION analyze_index_usage() IS 'Returns a list of unused indexes in the current database, ordered by size';