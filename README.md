## SQL Database

```sql
-- ========= DIMENSION TABLES =========

-- Table to store information about the reporting entities (UATs, etc.)
-- Requires enrichment with external data (uat_type, county, population)
CREATE TABLE Entities (
    cui VARCHAR(20) PRIMARY KEY,             -- Unique Fiscal Code (from <P_CUI>)
    name VARCHAR(255) NOT NULL,              -- Full name of the entity (from <NUME>)
    sector_type VARCHAR(100),                -- Sector type (from <TIP_SECTOR>)
    uat_type VARCHAR(20),                    -- Type: 'Comuna', 'Oras', 'Municipiu', 'Judet', 'Other' (Needs enrichment)
    county_code VARCHAR(2),                  -- Standard 2-letter county code (e.g., 'SB') (Needs enrichment)
    county_name VARCHAR(50),                 -- County name (e.g., 'Sibiu') (Needs enrichment)
    region VARCHAR(50),                      -- Development Region (Needs enrichment)
    population INT,                          -- Latest known population (Needs enrichment)
    last_updated TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP -- Track updates to enriched data
);

-- Table for Functional Classification codes (COFOG)
CREATE TABLE FunctionalClassifications (
    functional_code VARCHAR(10) PRIMARY KEY, -- Code (from <COD_FUNCTIONAL>)
    functional_name VARCHAR(255) NOT NULL    -- Name/Description (from <DENUMIRE_CF>)
    -- Adding UNIQUE constraint on name might be too strict if descriptions vary slightly for same code initially
);

-- Table for Economic Classification codes
CREATE TABLE EconomicClassifications (
    economic_code VARCHAR(10) PRIMARY KEY,   -- Code (from <COD_ECONOMIC>)
    economic_name VARCHAR(255) NOT NULL      -- Name/Description (from <DENUMIRE_CE>)
    -- Adding UNIQUE constraint on name might be too strict
);

-- Table for Funding Sources
CREATE TABLE FundingSources (
    source_id SERIAL PRIMARY KEY,            -- Auto-incrementing ID
    source_description VARCHAR(255) NOT NULL UNIQUE -- Description (from <SURSA_FINANTARE>)
);

-- Table for Budget Programs (if needed from Level 2)
-- CREATE TABLE BudgetPrograms (
--     program_code VARCHAR(50) PRIMARY KEY, -- Program identifier (from <PROGRAM_BUGETAR>)
--     program_description VARCHAR(255)      -- Optional description
-- );


-- ========= METADATA TABLE =========

-- Table to store metadata about each imported report file/instance
CREATE TABLE Reports (
    report_id SERIAL PRIMARY KEY,                 -- Auto-incrementing ID for the report instance
    entity_cui VARCHAR(20) NOT NULL,              -- Foreign key to the entity that submitted the report
    report_date DATE NOT NULL,                    -- End date of the reporting period (from <P_ZI>)
    reporting_year INT NOT NULL,                  -- Year extracted from report_date for easy filtering
    reporting_period VARCHAR(10) NOT NULL,        -- e.g., 'Annual', 'Q1', 'Q2', 'Q3', 'Q4', 'Monthly'
    file_source VARCHAR(512),                     -- Optional: Path or identifier of the source XML
    import_timestamp TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP, -- When the report was imported

    FOREIGN KEY (entity_cui) REFERENCES Entities(cui) ON DELETE RESTRICT, -- Prevent deleting entity if reports exist
    UNIQUE (entity_cui, report_date)             -- Prevent importing the same report for the same entity/date twice
);


-- ========= FACT TABLE =========

-- The main table holding individual budget execution line items
CREATE TABLE ExecutionLineItems (
    line_item_id BIGSERIAL PRIMARY KEY,           -- Unique ID for each financial line item
    report_id INT NOT NULL,                       -- Foreign key to the report metadata
    funding_source_id INT NOT NULL,               -- Foreign key to the funding source description
    functional_code VARCHAR(10) NOT NULL,         -- Foreign key to the functional classification
    economic_code VARCHAR(10) NULL,               -- Foreign key to the economic classification (NULL for revenues)
    account_category CHAR(2) NOT NULL,            -- 'vn' (revenue) or 'ch' (expenditure) (from <CATEG_CONT>)
    amount DECIMAL(18, 2) NOT NULL,               -- The financial value (from <RULAJ_CH_VN>)
    program_code VARCHAR(50) NULL,                -- Optional: Budget program identifier (from <PROGRAM_BUGETAR>)

    FOREIGN KEY (report_id) REFERENCES Reports(report_id) ON DELETE CASCADE, -- If report metadata is deleted, delete associated lines
    FOREIGN KEY (funding_source_id) REFERENCES FundingSources(source_id) ON DELETE RESTRICT,
    FOREIGN KEY (functional_code) REFERENCES FunctionalClassifications(functional_code) ON DELETE RESTRICT,
    FOREIGN KEY (economic_code) REFERENCES EconomicClassifications(economic_code) ON DELETE RESTRICT,
    -- Optional Foreign Key for BudgetPrograms if that table is used
    -- FOREIGN KEY (program_code) REFERENCES BudgetPrograms(program_code) ON DELETE RESTRICT,

    CHECK (account_category IN ('vn', 'ch')) -- Ensure only valid categories are inserted
);


-- ========= INDEXES FOR PERFORMANCE =========

-- Indexes on Foreign Keys in the main fact table are crucial
CREATE INDEX idx_executionitems_report_id ON ExecutionLineItems (report_id);
CREATE INDEX idx_executionitems_funding_source_id ON ExecutionLineItems (funding_source_id);
CREATE INDEX idx_executionitems_functional_code ON ExecutionLineItems (functional_code);
CREATE INDEX idx_executionitems_economic_code ON ExecutionLineItems (economic_code); -- Important even if nullable

-- Index on the Foreign Key in the Reports table
CREATE INDEX idx_reports_entity_cui ON Reports (entity_cui);

-- Indexes on frequently filtered columns
CREATE INDEX idx_reports_report_date ON Reports (report_date);
CREATE INDEX idx_reports_reporting_year ON Reports (reporting_year);
CREATE INDEX idx_entities_uat_type ON Entities (uat_type); -- If you enrich this data
CREATE INDEX idx_entities_county_code ON Entities (county_code); -- If you enrich this data
CREATE INDEX idx_executionitems_account_category ON ExecutionLineItems (account_category);

-- Consider composite indexes based on common query patterns, e.g.:
-- CREATE INDEX idx_executionitems_report_func_econ ON ExecutionLineItems (report_id, functional_code, economic_code);
```

## GraphQL API

A GraphQL API has been implemented based on this database schema to provide flexible access to the budget execution data. The API allows for:

1. **Basic Data Retrieval**: Query entities, classifications, and line items
2. **Budget Statistics**: Calculate aggregated statistics like total revenue, expenses, and balance
3. **Anomaly Detection**: Detect unusual spending patterns compared to averages

### Key Features

- **Entity Management**: Query information about public entities (UATs, etc.)
- **Report Analytics**: Analyze budget execution across time periods
- **Statistical Analysis**: Calculate aggregated financial metrics
- **Spending Anomalies**: Identify potential unusual spending patterns

### Setup and Usage

For detailed instructions on setting up and using the GraphQL API, please refer to the [API_README.md](API_README.md) file.

# Budget Execution GraphQL API

A GraphQL API built with Fastify, Mercurius and TypeScript for querying budget execution data from PostgreSQL.

## SQL Database Schema

```sql
// ... existing code ...
```

## GraphQL API

The GraphQL API provides flexible access to the budget execution data stored in the PostgreSQL database.

### Key Features

- **Entity Management**: Query information about public entities (UATs, etc.)
- **Report Analytics**: Analyze budget execution across time periods
- **Statistical Analysis**: Calculate aggregated financial metrics
- **Spending Anomalies**: Identify potential unusual spending patterns

### Setup and Installation

1. Install dependencies:

```bash
yarn install
```

2. Create a `.env` file in the root directory with your database connection details:

```
DATABASE_URL=postgres://username:password@localhost:5432/budget_db
PORT=3000
NODE_ENV=development
```

3. Start the development server:

```bash
yarn dev
```

4. Access GraphiQL playground: http://localhost:3000/graphiql

### Example Queries

#### Get entities with pagination

```graphql
query GetEntities {
  entities(limit: 10, offset: 0) {
    nodes {
      cui
      name
      uat_type
      county_name
    }
    pageInfo {
      totalCount
      hasNextPage
    }
  }
}
```

#### Get budget report with analytics

```graphql
query GetReportWithAnalytics {
  report(report_id: 1) {
    report_id
    entity_cui
    entity {
      name
      county_name
    }
    reporting_year
    reporting_period
    budgetTotals {
      revenue
      expense
      balance
    }
    topFunctionalCodesExpense(limit: 5) {
      functional_code
      functional_name
      total
      percentage
    }
  }
}
```

#### Get spending anomalies

```graphql
query GetAnomalies {
  spendingAnomalies(
    year: 2023,
    period: "Annual",
    minDeviationPercentage: 50,
    limit: 10
  ) {
    entity_name
    functional_name
    amount
    average_amount
    deviation_percentage
    score
  }
}
```

## API Documentation

For a complete list of available queries and their parameters, please refer to the GraphiQL interactive documentation available at http://localhost:3000/graphiql when running the development server.