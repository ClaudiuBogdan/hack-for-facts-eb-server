-- ========= CLEAR EXISTING DATA =========
-- Truncate all base tables to reset data and sequences before (re)creating schema or seeding.
-- RESTART IDENTITY resets serial counters (like for SERIAL or BIGSERIAL types).
-- CASCADE handles foreign key dependencies, truncating dependent tables as well.

-- TRUNCATE
--     UATs,
--     Entities,
--     FunctionalClassifications,
--     EconomicClassifications,
--     FundingSources,
--     Reports,
--     ExecutionLineItems
-- RESTART IDENTITY CASCADE;

-- ========= DIMENSION TABLES =========

-- Table to store information about the UATs (Administrative Territorial Units)
CREATE TABLE UATs (
    id SERIAL PRIMARY KEY,
    uat_key VARCHAR(35) NOT NULL, -- uat_key is combined of county name and uat name
    uat_code VARCHAR(20) UNIQUE NOT NULL, -- CIF/uat_cod from uat_cif_pop_2021.csv
    name TEXT NOT NULL,
    county_code VARCHAR(2),
    county_name VARCHAR(50),
    region VARCHAR(50),
    population INT,
    last_updated TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- Add explanatory comment to UATs table
COMMENT ON TABLE UATs IS 'Administrative Territorial Units of Romania with geographic and demographic information';
COMMENT ON COLUMN UATs.uat_code IS 'Unique code identifying the UAT, corresponds to CIF/uat_cod from official data';

-- Table to store information about the reporting entities (UATs, etc.)
CREATE TABLE Entities (
    cui VARCHAR(20) PRIMARY KEY,
    name TEXT NOT NULL,
    sector_type TEXT,
    uat_id INT,
    address TEXT,
    last_updated TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    
    FOREIGN KEY (uat_id) REFERENCES UATs(id) ON DELETE RESTRICT
);

-- Add explanatory comment to Entities table
COMMENT ON TABLE Entities IS 'Public entities that report budget execution data, usually associated with UATs';
COMMENT ON COLUMN Entities.cui IS 'Unique fiscal identification code (CUI/CIF) of the reporting entity';

-- Table for Functional Classification codes (COFOG)
CREATE TABLE FunctionalClassifications (
    functional_code VARCHAR(10) PRIMARY KEY,
    functional_name TEXT NOT NULL
);

-- Add explanatory comment
COMMENT ON TABLE FunctionalClassifications IS 'COFOG functional classification codes for categorizing budget items by purpose/function';

-- Table for Economic Classification codes
CREATE TABLE EconomicClassifications (
    economic_code VARCHAR(10) PRIMARY KEY,
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

-- ========= METADATA TABLE =========

-- Table to store metadata about each imported report file/instance
CREATE TABLE Reports (
    report_id SERIAL PRIMARY KEY,
    entity_cui VARCHAR(20) NOT NULL,
    report_date DATE NOT NULL,
    reporting_year INT NOT NULL,
    reporting_period VARCHAR(10) NOT NULL,
    file_source TEXT,
    import_timestamp TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (entity_cui) REFERENCES Entities(cui) ON DELETE RESTRICT,
    UNIQUE (entity_cui, report_date)
);

-- Add explanatory comment
COMMENT ON TABLE Reports IS 'Metadata for each imported budget execution report, linking to the reporting entity';

-- ========= FACT TABLE =========

-- The main table holding individual budget execution line items
CREATE TABLE ExecutionLineItems (
    line_item_id BIGSERIAL PRIMARY KEY,
    report_id INT NOT NULL,
    entity_cui VARCHAR(20) NOT NULL,
    funding_source_id INT NOT NULL,
    functional_code VARCHAR(10) NOT NULL,
    economic_code VARCHAR(10) NULL,
    account_category CHAR(2) NOT NULL,
    amount DECIMAL(18, 2) NOT NULL,
    program_code VARCHAR(50) NULL,
    year INT NOT NULL,

    FOREIGN KEY (report_id) REFERENCES Reports(report_id) ON DELETE CASCADE,
    FOREIGN KEY (entity_cui) REFERENCES Entities(cui) ON DELETE RESTRICT,
    FOREIGN KEY (funding_source_id) REFERENCES FundingSources(source_id) ON DELETE RESTRICT,
    FOREIGN KEY (functional_code) REFERENCES FunctionalClassifications(functional_code) ON DELETE RESTRICT,
    FOREIGN KEY (economic_code) REFERENCES EconomicClassifications(economic_code) ON DELETE RESTRICT,
    CHECK (account_category IN ('vn', 'ch')),
    -- Ensure economic_code is not NULL for expenses (account_category = 'ch')
    CHECK (account_category != 'ch' OR economic_code IS NOT NULL)
);

-- Add explanatory comment
COMMENT ON TABLE ExecutionLineItems IS 'Fact table containing individual budget execution line items';
COMMENT ON COLUMN ExecutionLineItems.account_category IS 'Type of budget item: "vn" for income (venituri), "ch" for expenses (cheltuieli)';
COMMENT ON COLUMN ExecutionLineItems.amount IS 'Monetary amount in RON';

-- ========= INDEXES FOR PERFORMANCE =========

CREATE INDEX idx_executionitems_report_id ON ExecutionLineItems (report_id);
CREATE INDEX idx_executionitems_funding_source_id ON ExecutionLineItems (funding_source_id);
CREATE INDEX idx_executionitems_functional_code ON ExecutionLineItems (functional_code);
CREATE INDEX idx_executionitems_economic_code ON ExecutionLineItems (economic_code);
CREATE INDEX idx_reports_entity_cui ON Reports (entity_cui);
CREATE INDEX idx_reports_report_date ON Reports (report_date);
CREATE INDEX idx_reports_reporting_year ON Reports (reporting_year);
CREATE INDEX idx_entities_uat_id ON Entities (uat_id);
CREATE INDEX idx_uats_uat_code ON UATs (uat_code);
CREATE INDEX idx_uats_county_code ON UATs (county_code);
CREATE INDEX idx_executionitems_account_category ON ExecutionLineItems (account_category);
CREATE INDEX idx_executionitems_entity_cui ON ExecutionLineItems (entity_cui);
CREATE INDEX idx_executionitems_year ON ExecutionLineItems (year);

-- ========= ANALYTICAL VIEWS =========

-- View 1: Comprehensive flattened view of all execution line items with all dimensional attributes
CREATE MATERIALIZED VIEW vw_ExecutionDetails AS
SELECT
    eli.line_item_id,
    eli.entity_cui,
    eli.amount,
    eli.account_category, -- 'vn' (venituri/income), 'ch' (cheltuieli/expense)
    eli.program_code,
    r.report_id,
    r.report_date,
    r.reporting_year,
    r.reporting_period,
    r.import_timestamp,
    e.name AS entity_name,
    e.sector_type AS entity_sector_type,
    e.address AS entity_address,
    u.id,
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
    ec.economic_name
FROM ExecutionLineItems eli
JOIN Reports r ON eli.report_id = r.report_id
JOIN Entities e ON eli.entity_cui = e.cui
JOIN FundingSources fs ON eli.funding_source_id = fs.source_id
JOIN FunctionalClassifications fc ON eli.functional_code = fc.functional_code
LEFT JOIN EconomicClassifications ec ON eli.economic_code = ec.economic_code -- Left join because economic_code can be NULL for income items
LEFT JOIN UATs u ON e.uat_id = u.id; -- Left join in case some entities might not be linked to a UAT

COMMENT ON MATERIALIZED VIEW vw_ExecutionDetails IS 'Detailed view of all execution line items with dimensional attributes for comprehensive analysis and reporting';

-- View 2: Budget summary by entity and reporting period
CREATE MATERIALIZED VIEW vw_BudgetSummary_ByEntityPeriod AS
SELECT
    r.reporting_year,
    r.reporting_period,
    eli.entity_cui AS entity_cui,
    e.name AS entity_name,
    u.name AS uat_name,
    u.county_name,
    u.region AS uat_region,
    SUM(CASE WHEN eli.account_category = 'vn' THEN eli.amount ELSE 0 END) AS total_income,
    SUM(CASE WHEN eli.account_category = 'ch' THEN eli.amount ELSE 0 END) AS total_expense,
    SUM(CASE WHEN eli.account_category = 'vn' THEN eli.amount ELSE -eli.amount END) AS budget_balance
FROM ExecutionLineItems eli
JOIN Reports r ON eli.report_id = r.report_id
JOIN Entities e ON eli.entity_cui = e.cui
LEFT JOIN UATs u ON e.uat_id = u.id
GROUP BY
    r.reporting_year,
    r.reporting_period,
    eli.entity_cui,
    e.name,
    u.name,
    u.county_name,
    u.region;

COMMENT ON MATERIALIZED VIEW vw_BudgetSummary_ByEntityPeriod IS 'Summary of budget totals (income, expense, balance) aggregated by entity and reporting period';

-- View 3: Expense analysis by functional and economic classifications
CREATE MATERIALIZED VIEW vw_ExpenseAnalysis_ByCategory AS
SELECT
    r.reporting_year,
    r.reporting_period,
    eli.entity_cui AS entity_cui,
    e.name AS entity_name,
    u.name AS uat_name,
    u.county_name,
    fc.functional_code,
    fc.functional_name,
    ec.economic_code,
    ec.economic_name,
    fs.source_description AS funding_source,
    SUM(eli.amount) AS total_expense
FROM ExecutionLineItems eli
JOIN Reports r ON eli.report_id = r.report_id
JOIN Entities e ON eli.entity_cui = e.cui
JOIN FunctionalClassifications fc ON eli.functional_code = fc.functional_code
LEFT JOIN EconomicClassifications ec ON eli.economic_code = ec.economic_code -- Left join in case any expense items have null economic codes
JOIN FundingSources fs ON eli.funding_source_id = fs.source_id
LEFT JOIN UATs u ON e.uat_id = u.id
WHERE eli.account_category = 'ch' -- Only include expenses
GROUP BY
    r.reporting_year,
    r.reporting_period,
    eli.entity_cui,
    e.name,
    u.name,
    u.county_name,
    fc.functional_code,
    fc.functional_name,
    ec.economic_code,
    ec.economic_name,
    fs.source_description;

COMMENT ON MATERIALIZED VIEW vw_ExpenseAnalysis_ByCategory IS 'Detailed analysis of expenses by functional and economic classifications, broken down by entity and funding source';

-- View 4: Funding source summary
CREATE MATERIALIZED VIEW vw_FundingSource_Summary AS
SELECT
    r.reporting_year,
    fs.source_description AS funding_source,
    u.county_name,
    u.region AS uat_region,
    SUM(CASE WHEN eli.account_category = 'vn' THEN eli.amount ELSE 0 END) AS total_income,
    SUM(CASE WHEN eli.account_category = 'ch' THEN eli.amount ELSE 0 END) AS total_expense
FROM ExecutionLineItems eli
JOIN Reports r ON eli.report_id = r.report_id
JOIN FundingSources fs ON eli.funding_source_id = fs.source_id
JOIN Entities e ON eli.entity_cui = e.cui
LEFT JOIN UATs u ON e.uat_id = u.id
GROUP BY
    r.reporting_year,
    fs.source_description,
    u.county_name,
    u.region;

COMMENT ON MATERIALIZED VIEW vw_FundingSource_Summary IS 'Summary of income and expenses by funding source, broken down by geographical area and reporting year'; 


-- View 5: Aggregated Metrics per UAT per Year/Period
-- Purpose: Facilitates comparisons and per capita analysis between UATs.
CREATE MATERIALIZED VIEW vw_UAT_Aggregated_Metrics AS
SELECT
    r.reporting_year,
    r.reporting_period,
    u.id AS uat_id,
    u.uat_code,
    u.name AS uat_name,
    u.county_code,
    u.county_name,
    u.region AS uat_region,
    u.population AS uat_population,
    SUM(CASE WHEN eli.account_category = 'vn' THEN eli.amount ELSE 0 END) AS total_income,
    SUM(CASE WHEN eli.account_category = 'ch' THEN eli.amount ELSE 0 END) AS total_expense,
    SUM(CASE WHEN eli.account_category = 'vn' THEN eli.amount ELSE -eli.amount END) AS budget_balance,
    -- Per capita calculations (handle division by zero or null population)
    CASE
        WHEN u.population IS NOT NULL AND u.population > 0 THEN
            SUM(CASE WHEN eli.account_category = 'vn' THEN eli.amount ELSE 0 END) / u.population
        ELSE NULL
    END AS per_capita_income,
    CASE
        WHEN u.population IS NOT NULL AND u.population > 0 THEN
            SUM(CASE WHEN eli.account_category = 'ch' THEN eli.amount ELSE 0 END) / u.population
        ELSE NULL
    END AS per_capita_expense
FROM ExecutionLineItems eli
JOIN Reports r ON eli.report_id = r.report_id
JOIN Entities e ON eli.entity_cui = e.cui
JOIN UATs u ON e.uat_id = u.id -- INNER JOIN ensures we only aggregate for entities linked to a UAT
GROUP BY
    r.reporting_year,
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
SELECT
    r.reporting_year,
    r.reporting_period,
    u.county_code,
    u.county_name,
    u.region AS uat_region, -- Assuming region is consistent within a county
    SUM(u.population) AS total_county_population, -- Sum population of UATs within the county
    SUM(CASE WHEN eli.account_category = 'vn' THEN eli.amount ELSE 0 END) AS total_income,
    SUM(CASE WHEN eli.account_category = 'ch' THEN eli.amount ELSE 0 END) AS total_expense,
    SUM(CASE WHEN eli.account_category = 'vn' THEN eli.amount ELSE -eli.amount END) AS budget_balance,
    -- Per capita calculations for the county
    CASE
        WHEN SUM(u.population) > 0 THEN
            SUM(CASE WHEN eli.account_category = 'vn' THEN eli.amount ELSE 0 END) / SUM(u.population)
        ELSE NULL
    END AS per_capita_income,
    CASE
        WHEN SUM(u.population) > 0 THEN
            SUM(CASE WHEN eli.account_category = 'ch' THEN eli.amount ELSE 0 END) / SUM(u.population)
        ELSE NULL
    END AS per_capita_expense
FROM ExecutionLineItems eli
JOIN Reports r ON eli.report_id = r.report_id
JOIN Entities e ON eli.entity_cui = e.cui
JOIN UATs u ON e.uat_id = u.id
WHERE u.county_code IS NOT NULL -- Ensure county code exists for aggregation
GROUP BY
    r.reporting_year,
    r.reporting_period,
    u.county_code,
    u.county_name,
    u.region;

COMMENT ON MATERIALIZED VIEW vw_County_Aggregated_Metrics IS 'Aggregated income, expense, balance, and per capita metrics for each County per reporting year and period.';

-- View 7: Aggregated Metrics by Category (Functional/Economic) per Year/Period
-- Purpose: Provides aggregated totals for specific spending/revenue categories across geographical levels.
CREATE MATERIALIZED VIEW vw_Category_Aggregated_Metrics AS
SELECT
    r.reporting_year,
    r.reporting_period,
    eli.account_category,
    fc.functional_code,
    fc.functional_name,
    ec.economic_code,
    ec.economic_name,
    fs.source_id AS funding_source_id,
    fs.source_description AS funding_source,
    u.county_name,
    u.region AS uat_region,
    -- Aggregate amounts
    SUM(eli.amount) AS total_amount,
    -- Count distinct entities contributing to this category (optional but potentially useful)
    COUNT(DISTINCT eli.entity_cui) AS contributing_entities_count
FROM ExecutionLineItems eli
JOIN Reports r ON eli.report_id = r.report_id
JOIN Entities e ON eli.entity_cui = e.cui
JOIN FunctionalClassifications fc ON eli.functional_code = fc.functional_code
LEFT JOIN EconomicClassifications ec ON eli.economic_code = ec.economic_code
JOIN FundingSources fs ON eli.funding_source_id = fs.source_id
LEFT JOIN UATs u ON e.uat_id = u.id -- Left join to include entities potentially not linked to UATs if needed, or INNER JOIN to restrict
GROUP BY
    r.reporting_year,
    r.reporting_period,
    eli.account_category,
    fc.functional_code,
    fc.functional_name,
    ec.economic_code,
    ec.economic_name,
    fs.source_id,
    fs.source_description,
    u.county_name,
    u.region;

COMMENT ON MATERIALIZED VIEW vw_Category_Aggregated_Metrics IS 'Aggregated amounts by functional/economic classification and funding source, optionally broken down by geography.';


-- -- Update materialized views on a regular basis
-- CREATE OR REPLACE FUNCTION refresh_materialized_views()
-- RETURNS VOID AS $$
-- BEGIN
--     REFRESH MATERIALIZED VIEW vw_ExecutionDetails;
--     REFRESH MATERIALIZED VIEW vw_BudgetSummary_ByEntityPeriod;
--     REFRESH MATERIALIZED VIEW vw_ExpenseAnalysis_ByCategory;
--     REFRESH MATERIALIZED VIEW vw_FundingSource_Summary;
--     REFRESH MATERIALIZED VIEW vw_UAT_Aggregated_Metrics;
--     REFRESH MATERIALIZED VIEW vw_County_Aggregated_Metrics;
--     REFRESH MATERIALIZED VIEW vw_Category_Aggregated_Metrics;
-- END;
-- $$ LANGUAGE plpgsql;

-- -- Schedule the function to run daily at 12:00 AM
-- CREATE EXTENSION IF NOT EXISTS pg_cron;
-- SELECT cron.schedule('0 0 * * *', 'CALL refresh_materialized_views()');