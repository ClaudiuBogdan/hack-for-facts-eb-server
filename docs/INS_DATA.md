# Milestone: INS Data Integration

**Goal:** Integrate Institutul Național de Statistică (INS) Tempo database into Transparenta.eu to enable cross-referencing statistical indicators with budget execution data, and provide a better interface for exploring INS datasets.

**Outcome:** A fully automated pipeline that fetches, normalizes, and exposes INS statistical data linked to UATs via SIRUTA codes, accessible via a public API.

## ⚠️ Key Architectural Challenge

> **The core challenge isn't just fetching data—it's normalizing it.**
>
> INS Tempo data uses a **multi-dimensional cube structure** (OLAP-style), where each matrix has arbitrary dimensions (Year, Gender, Area Type, Age Group, etc.). Transparenta.eu treats data as **entities (UATs) with attached properties**.
>
> Bridging this gap requires a robust mapping strategy that flattens cube dimensions into queryable, UAT-linked observations while preserving the ability to filter by original dimensions.

**Success Criteria:**

- All relevant INS datasets are imported and linked to UAT entities via SIRUTA codes
- Data syncs automatically without service disruption
- API exposes INS data with filtering, aggregation, and UAT correlation capabilities
- Temporal data aligns with existing budget execution time periods
- Cube-to-entity normalization is handled consistently across all datasets

---

## Reference Projects & Resources

Existing implementations and tools to study before implementation:

| Project                   | Description                                        | URL                                                    |
| ------------------------- | -------------------------------------------------- | ------------------------------------------------------ |
| **Tempo Online (INS)**    | Official INS interface                             | <http://statistici.insse.ro:8077/tempo-online/>        |
| **Gov2.ro Tempo Browser** | Alternative Tempo browser                          | <https://tempo-online.gov2.ro/2/category-browser.html> |
| **Prometeu (gov2-ro)**    | Romanian gov data tools                            | <https://github.com/gov2-ro/prometeu>                  |
| **tempo.py**              | Python Tempo API client (study API patterns)       | <https://github.com/mark-veres/tempo.py>               |
| **QTempo**                | QGIS plugin for Tempo (comprehensive API coverage) | <https://github.com/alecsandrei/QTempo>                |
| **TEMPO (MarianNecula)**  | Another Tempo implementation                       | <https://github.com/MarianNecula/TEMPO>                |

**Action:** Review these projects for API parsing patterns and data structure understanding. Implementation will follow this project's TypeScript/Fastify/Kysely architecture.

---

## Project Architecture Alignment

This integration must follow the project's **Functional Core / Imperative Shell** (Hexagonal Architecture) patterns:

| Layer     | Responsibility                                  | Location                             |
| --------- | ----------------------------------------------- | ------------------------------------ |
| **Core**  | Pure business logic, types, ports (interfaces)  | `src/modules/ins/core/`              |
| **Shell** | Adapters (repos, API client, GraphQL resolvers) | `src/modules/ins/shell/`             |
| **Tests** | Unit tests with in-memory fakes                 | `tests/unit/ins/`, `tests/fixtures/` |

**Key Patterns to Follow:**

- **Result Pattern:** Use `neverthrow` for error handling (no throws in core layer)
- **Ports/Adapters:** Define interfaces in `core/ports.ts`, implement in `shell/`
- **TypeBox:** Use for runtime validation and type extraction
- **Decimal.js:** Use for all numeric values (never `parseFloat`)
- **BullMQ:** Use for background job processing
- **Kysely:** Use for type-safe database queries

> **Reference Files:** See `src/modules/entity/` for complete module patterns, `src/modules/datasets/core/types.ts` for TypeBox usage.

---

## Epic 1: Discovery & Data Analysis

> _Before writing code, we must map the "Matrix" cube structure of INS to our relational entities._

Understanding the INS data structure before implementation.

### 1.1 Document INS Data Structure

**Context:** Before importing, we need a complete understanding of INS's data model.

**Tasks:**

- [ ] Analyze INS Tempo API structure using the discovery endpoints:
  - `http://statistici.insse.ro:8077/tempo-ins/context/` - root catalog
  - `http://statistici.insse.ro:8077/tempo-ins/context/{id}` - category details
  - `http://statistici.insse.ro:8077/tempo-ins/matrix/{code}` - dataset matrix
- [ ] Document the hierarchical structure (contexts → categories → matrices → dimensions)
- [ ] Identify all dimension types (territorial, temporal, indicators, classifications)
- [ ] Map INS territorial codes to SIRUTA codes (UAT linkage)
- [ ] Document temporal granularity options (annual, quarterly, monthly)
- [ ] Identify which datasets contain UAT-level data vs. county/national only
- [ ] Create a data dictionary with field descriptions
- [ ] **Study reference projects** (tempo.py, QTempo, Prometeu) for API parsing patterns

**Acceptance Criteria:**

- Technical documentation explaining INS data model
- Mapping table: INS territorial codes ↔ SIRUTA codes
- List of datasets with UAT-level granularity
- List of relevant statistical indicators for Transparenta.eu use cases

### 1.2 Map INS Matrices to Business Requirements

**Context:** INS has hundreds of matrices. We need to identify which are relevant and how to flatten their dimensions.

**Tasks:**

- [ ] Create a mapping file listing relevant matrices:
  - Matrix Code (e.g., `POP105A` for Population, `FOM103A` for Labor Force)
  - Human-readable name and description
  - Dimensions to flatten vs. keep as filters
  - Update frequency (Monthly/Yearly/Census)
  - Priority level for import
- [ ] For each matrix, decide dimension handling strategy:
  - **Flatten:** Convert dimension values into separate columns (e.g., `population_male`, `population_female`)
  - **Filter:** Keep as queryable dimension in JSONB (e.g., `{"sex": "M", "area": "Urban"}`)
  - **Aggregate:** Pre-calculate totals (e.g., total population = sum of all age groups)
- [ ] Document matrix dependencies (some metrics derived from others)

**Deliverable:** Matrix mapping configuration (stored in database or as TypeBox-validated config)

**Configuration should include for each matrix:**

- `matrix_code`: INS code (e.g., `POP105A`)
- `name`: Human-readable name
- `dimensions`: Map of dimension handling rules (territorial, temporal, filter, indicator)
- `update_frequency`: annual, quarterly, or monthly
- `priority`: high, medium, low

> **Implementation Note:** Use TypeBox schemas for validation (see `src/modules/datasets/core/types.ts` for patterns). Extract TypeScript types with `Static<typeof Schema>`.

**Acceptance Criteria:**

- Mapping file covers all MVP matrices
- Dimension handling strategy documented per matrix
- Configuration drives import behavior (not hardcoded)

### 1.3 SIRUTA Code Reconciliation (⚠️ Critical)

**Context:** INS uses SIRUTA codes to identify localities. These codes change over time due to administrative reorganizations (communes split, merge, or get upgraded to cities).

**The "Ghost Code" Problem:** Codes in INS that no longer exist in current SIRUTA, or codes that have changed meaning over time.

**Tasks:**

- [ ] Export all SIRUTA codes used in INS datasets
- [ ] Compare against current official SIRUTA database
- [ ] Identify discrepancies:
  - Codes in INS but not in current SIRUTA (historical/defunct)
  - Codes in current SIRUTA but missing from INS
  - Codes that changed meaning (same code, different locality)
- [ ] Research territorial changes history (Ministry of Administration sources)
- [ ] Build `SirutaNormalizationService` with:
  - Lookup: old_code → current_code (with validity period)
  - Reverse lookup for historical queries
  - Handling for split communes (1 old → N new)
  - Handling for merged communes (N old → 1 new)

**Edge Cases to Handle:**

| Scenario        | Example                                   | Strategy                                          |
| --------------- | ----------------------------------------- | ------------------------------------------------- |
| Commune split   | Code 12345 (pre-2005) → 12345 + 12346     | Attribute old data to parent, flag as "pre-split" |
| Communes merged | 12345 + 12346 → 12347                     | Sum historical data under new code                |
| City upgrade    | Commune → City (code unchanged)           | Handle in metadata, not code                      |
| Code reused     | Old defunct code assigned to new locality | Use validity periods                              |

**Deliverable:**

- `siruta_mappings` table with temporal validity
- `SirutaNormalizationService` module

**Acceptance Criteria:**

- 100% of INS SIRUTA codes mapped (even if to "unknown/historical")
- Historical territorial changes documented
- Service handles edge cases without data loss

### 1.4 API Capabilities Assessment

**Context:** Understand API limitations and capabilities for extraction strategy.

**Tasks:**

- [ ] Document API rate limits (if any) - _INS API is known to be slow/flaky_
- [ ] Test pagination behavior for large datasets
- [ ] Identify supported query parameters (filtering, date ranges)
- [ ] Test API response times for different dataset sizes
- [ ] Check API stability and error response formats
- [ ] Verify character encoding handling (UTF-8, Romanian diacritics)
- [ ] Document authentication requirements (if any)
- [ ] **Add configurable delay between requests** to avoid being blocked

**Acceptance Criteria:**

- API capabilities document with rate limits, pagination, filtering options
- Sample API responses documented
- Known limitations listed
- Request throttling strategy defined

### 1.5 Define Scope of Data Import

**Context:** INS has hundreds of datasets. We need to prioritize.

**Tasks:**

- [ ] Inventory all available datasets from the catalog
- [ ] Categorize by relevance to public finance analysis:
  - **High priority:** Population, employment, salaries, local budgets indicators
  - **Medium priority:** Education, health, infrastructure
  - **Low priority:** Less relevant to budget analysis
- [ ] Estimate storage requirements per category
- [ ] Define MVP dataset list for initial import
- [ ] Estimate row counts (⚠️ `InsObservation` will grow to millions of rows)

**Acceptance Criteria:**

- Prioritized dataset list with justification
- Storage estimate
- MVP scope defined

---

## Epic 2: Database Schema Design

> _We need a flexible schema that allows querying time-series data efficiently while handling the cube-to-entity transformation._

Design a flexible schema that links INS data to existing Transparenta.eu entities.

> **Note:** Schema definitions below are SQL migrations. All queries will use **Kysely** (type-safe query builder). Database types will be generated via `kysely-codegen` and stored in `src/infra/database/budget/types.ts`.

### 2.1 Design Core Schema (EAV/JSONB Approach)

**Context:** Schema must support multi-dimensional statistical data with UAT linkage.

**Key Decision:** Avoid creating a table per matrix. Use an EAV (Entity-Attribute-Value) pattern with JSONB for dimension flexibility.

**Requirements:**

- Support arbitrary number of dimensions per dataset
- Link to UAT via SIRUTA codes
- Handle temporal data compatible with budget execution periods
- Support versioning for data corrections/updates
- **Support rollback via `batch_id`**
- Efficient querying for time-series and cross-sectional analysis

**Tasks:**

- [ ] Design `ins_datasets` table (metadata about each matrix)

  ```sql
  -- Migration: src/infra/database/budget/migrations/XXXX_create_ins_tables.sql
  CREATE TABLE ins_datasets (
    id SERIAL PRIMARY KEY,
    ins_code VARCHAR(20) UNIQUE NOT NULL,  -- e.g., 'POP105A'
    name VARCHAR(255) NOT NULL,
    description TEXT,
    dimensions_schema JSONB,  -- Flexible dimension definitions
    temporal_granularity VARCHAR(20),  -- 'annual', 'quarterly', 'monthly'
    update_frequency VARCHAR(50),  -- 'Feb 1st', 'quarterly', etc.
    last_synced_at TIMESTAMPTZ,
    source_updated_at TIMESTAMPTZ,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  );
  ```

- [ ] Design `ins_dimensions` table (valid values for filters)

  ```sql
  CREATE TABLE ins_dimensions (
    id SERIAL PRIMARY KEY,
    dataset_id INTEGER REFERENCES ins_datasets(id) ON DELETE CASCADE,
    dimension_code VARCHAR(50) NOT NULL,
    dimension_name VARCHAR(255),
    dimension_type VARCHAR(50),  -- 'territorial', 'temporal', 'indicator', 'classification'
    values JSONB,  -- Array of {code, label} objects
    UNIQUE(dataset_id, dimension_code)
  );
  ```

- [ ] Design `ins_observations` table (the actual data points)

  ```sql
  CREATE TABLE ins_observations (
    id BIGSERIAL PRIMARY KEY,
    dataset_id INTEGER REFERENCES ins_datasets(id) NOT NULL,
    siruta_code VARCHAR(10),  -- Nullable for non-territorial data (joins to uats.siruta_code)

    -- Normalized temporal fields
    time_period DATE NOT NULL,  -- Normalized to first day of period
    period_type VARCHAR(20),  -- 'year', 'quarter', 'month'
    source_period_label VARCHAR(50),  -- Original INS format, e.g., 'Anul 2023'

    -- Cube dimensions flattened to JSONB
    dimensions JSONB,  -- e.g., {"sex": "M", "area": "Urban", "age_group": "15-24"}

    -- The actual value (NUMERIC for precision - use Decimal.js in code)
    value NUMERIC,
    unit VARCHAR(50),
    value_flags VARCHAR(10),  -- Original INS flags: ':', '-', 'c', etc.

    -- Versioning & rollback support
    batch_id UUID NOT NULL,  -- For batch deletion/rollback
    imported_at TIMESTAMPTZ DEFAULT NOW(),

    -- Prevent duplicates
    UNIQUE(dataset_id, siruta_code, time_period, dimensions)
  );

  -- Performance indexes
  CREATE INDEX idx_obs_siruta_dataset ON ins_observations(siruta_code, dataset_id);
  CREATE INDEX idx_obs_dataset_period ON ins_observations(dataset_id, time_period);
  CREATE INDEX idx_obs_batch ON ins_observations(batch_id);
  CREATE INDEX idx_obs_dimensions ON ins_observations USING GIN(dimensions);
  ```

- [ ] Design `ins_siruta_mappings` table (INS territorial codes to current SIRUTA)

  ```sql
  CREATE TABLE ins_siruta_mappings (
    id SERIAL PRIMARY KEY,
    ins_territorial_code VARCHAR(20) NOT NULL,
    siruta_code VARCHAR(10) NOT NULL,  -- References uats.siruta_code (loose coupling)
    valid_from DATE,
    valid_to DATE,  -- NULL = currently valid
    mapping_type VARCHAR(20),  -- 'exact', 'split_parent', 'merged_child', 'historical'
    notes TEXT,
    UNIQUE(ins_territorial_code, valid_from)
  );
  ```

- [ ] Design `ins_import_batches` table (for tracking and rollback)

  ```sql
  CREATE TABLE ins_import_batches (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    dataset_id INTEGER REFERENCES ins_datasets(id),
    started_at TIMESTAMPTZ DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    status VARCHAR(20),  -- 'running', 'success', 'failed', 'rolled_back'
    rows_imported INTEGER,
    rows_failed INTEGER,
    error_message TEXT,
    metadata JSONB  -- Additional context (time range imported, etc.)
  );
  ```

- [ ] Define corresponding TypeScript domain types in `core/types.ts`

> **Implementation Notes:**
>
> - Use TypeBox for schema validation (see `src/modules/datasets/core/types.ts` for patterns)
> - Use `Decimal` from `decimal.js` for numeric values (never `float` or `parseFloat`)
> - Separate database row types from domain types
> - Generate Kysely types via `kysely-codegen`

**Acceptance Criteria:**

- Schema DDL reviewed and approved
- Index strategy documented
- Sample queries demonstrating UAT correlation perform < 100ms
- Rollback by batch_id tested and working

### 2.2 UAT Linking Strategy

**Context:** Ensure foreign keys or loose coupling with existing UAT tables works even if INS data is dirty.

**Decision Point:** Use `siruta_code` as the join key (loose coupling). Do NOT use foreign key constraint to UAT table.

**Tasks:**

- [ ] Define behavior for unmapped SIRUTA codes:
  - Option A: Log warning, import anyway with NULL link
  - Option B: Skip record, log to quarantine table
  - Option C: Insert placeholder UAT record
  - **Recommended:** Option A with visibility in admin
- [ ] Create view/materialized view joining INS observations to UAT details
- [ ] Handle data for localities that don't exist in our UAT database

**Acceptance Criteria:**

- INS data importable even with dirty/unknown SIRUTA codes
- Unmapped codes are visible and queryable for review
- Join to UAT table works efficiently

### 2.3 Temporal Alignment Strategy

**Context:** INS data uses various period formats. Budget execution is typically monthly/quarterly/annual.

**Tasks:**

- [ ] Document all INS temporal formats encountered
- [ ] Design normalization rules:
  - Annual: `time_period = YYYY-01-01`, `period_type = 'year'`
  - Quarterly: `time_period = YYYY-QQ-01` (first day of quarter)
  - Monthly: `time_period = YYYY-MM-01`
- [ ] Handle edge cases:
  - Academic years (September-August)
  - Fiscal years (if different from calendar)
  - Rolling periods
  - Census reference dates
- [ ] Create utility functions for period comparison with budget execution data
- [ ] Ensure time_period is always comparable across datasets

**Acceptance Criteria:**

- Temporal normalization documented
- Utility functions created and tested
- Sample cross-reference query between INS and budget data works correctly

### 2.4 Handle Historical Territorial Changes

**Context:** Romanian UAT boundaries have changed over time (communes split/merged, cities upgraded).

**Key Question:** How do we display data for a Commune that existed in 2000 but was split into two in 2005?

**Tasks:**

- [ ] Research territorial changes since earliest INS data (1990s)
- [ ] Design strategy for handling:
  - SIRUTA codes that changed
  - Territorial units that split or merged
  - New units created
- [ ] Implement chosen strategy:
  - **Suggestion:** Display historical data under old name with "Historical" tag
  - Provide aggregation to current boundaries on demand
- [ ] Document edge cases and how they're handled

**Acceptance Criteria:**

- Territorial change handling documented
- Historical data maintains integrity
- UI can show "Historical locality" indicator
- Queries can aggregate at current boundaries or preserve historical

### 2.5 Performance Considerations

**Context:** `ins_observations` table will grow to **millions of rows**. Plan for scale.

**Tasks:**

- [ ] Evaluate partitioning strategy:
  - By year (most likely)
  - By dataset_id
  - Hybrid
- [ ] Consider TimescaleDB for time-series optimization (if already using PostgreSQL)
- [ ] Plan for table maintenance (VACUUM, ANALYZE schedules)
- [ ] Design archival strategy for very old data (if needed)
- [ ] Load test with realistic data volumes

**Acceptance Criteria:**

- Performance acceptable with 10M+ rows
- Partitioning strategy documented and implemented if needed
- Maintenance procedures documented

---

## Epic 3: Data Import Pipeline (ETL)

> _The core logic to fetch and sync data from INS Tempo API._

Build robust, resumable import process following the project's **Functional Core / Imperative Shell** architecture.

### 3.1 Build `TempoApiClient`

**Context:** A robust wrapper around the INS Tempo API. The API is known to be slow and occasionally flaky.

**Tasks:**

- [ ] Define `InsApiClient` port interface in `core/ports.ts`
  - Methods: `getContextTree()`, `getContext(id)`, `getMatrixMetadata(code)`, `getMatrixData(code, filters?)`
  - All methods return `Promise<Result<T, InsError>>` (see `src/modules/entity/core/ports.ts` for patterns)

- [ ] Implement HTTP client adapter in `shell/api-client/`
  - Configurable base URL (default: `http://statistici.insse.ro:8077/tempo-ins/`)
  - Request timeout configuration (default: 30s)
  - **Exponential backoff retry logic** (3 retries, 1s → 2s → 4s)
  - **Configurable delay between requests** (default: 500ms) to avoid rate limiting
  - Request/response logging for debugging

- [ ] Define error types in `core/errors.ts` as discriminated unions
  - `InsApiError` - HTTP/network errors with `retryable` flag
  - `InsParseError` - JSON parsing errors
  - `InsValidationError` - Schema validation errors
  - Include `readonly type` field for type-safe error matching (see `src/modules/entity/core/errors.ts`)

- [ ] Handle edge cases:
  - API returns HTML error page instead of JSON
  - Empty responses
  - Malformed JSON (use TypeBox validation, not raw `JSON.parse`)
  - Connection timeouts
  - Romanian diacritics in responses (UTF-8)

> **Implementation Notes:**
>
> - Follow Ports pattern: define interface in `core/`, implement in `shell/`
> - Never throw in core layer - always return `Result<T, E>` from `neverthrow`
> - Study `tempo.py` and `QTempo` for INS API patterns

**Acceptance Criteria:**

- Client implements `InsApiClient` port interface
- Returns `Result<T, InsError>` (never throws)
- Retry logic prevents transient failures from breaking import
- Rate limiting prevents IP blocks
- Comprehensive error handling with discriminated union errors

### 3.2 Catalog Sync Service

**Context:** First step is syncing the INS catalog to know what datasets exist.

**Tasks:**

- [ ] Create service to fetch and store INS catalog hierarchy
- [ ] Parse context tree structure recursively
- [ ] Store dataset metadata (code, name, dimensions, update frequency)
- [ ] Detect changes:
  - New datasets added
  - Datasets removed/deprecated
  - Dimension changes
- [ ] Schedule periodic catalog refresh (weekly suggested)
- [ ] Alert on significant catalog changes

**Acceptance Criteria:**

- Catalog sync runs successfully
- New datasets detected and flagged for review
- Catalog changes logged

### 3.3 Implement `SyncManager` (Upsert Logic)

**Context:** The orchestrator that coordinates dataset imports with idempotency guarantees.

**Requirements:**

- **Idempotency:** Running the import twice should not duplicate data
- **Resumability:** Failed imports can continue from where they stopped
- **Traceability:** Every import is tracked with `batch_id`

**Tasks:**

- [ ] Implement sync use case in `core/usecases/sync-dataset.ts`
  - Pure function with dependencies as first argument (see `src/modules/entity/core/usecases/` for patterns)
  - Steps: Create batch → Fetch metadata → Fetch data → Transform → Upsert → Update batch
  - Return `Result<SyncDatasetOutput, InsError>`

- [ ] Implement sync strategies:
  - **Full Overwrite:** Delete existing + insert new (safer for correcting past errors)
  - **Delta Update:** Only insert new periods (faster for incremental)
  - Strategy configurable per dataset via TypeBox config

- [ ] Handle configuration-driven sync:
  - Read from validated TypeBox config (see Epic 1.2)
  - Apply dimension handling rules
  - Apply SIRUTA normalization

- [ ] Implement job queue using **BullMQ** for multiple dataset syncs
  - Create queue and worker in `shell/jobs/`
  - Use Redis for job persistence (project already uses Redis/BullMQ)
  - Set `concurrency: 1` to prevent concurrent syncs of same dataset

- [ ] Prevent concurrent syncs of same dataset (use BullMQ job deduplication or Redis lock)

> **Implementation Notes:**
>
> - Use cases go in `core/usecases/` as pure functions
> - Job queue infrastructure goes in `shell/jobs/`
> - See existing BullMQ usage in the project for patterns

**Acceptance Criteria:**

- Sync is idempotent (safe to re-run)
- Batch tracking enables rollback
- Configuration drives behavior

### 3.4 Historical Data Import Strategy

**Context:** When fetching historical data (e.g., 1990-2024), fetching all at once may cause timeouts or memory issues.

**Tasks:**

- [ ] Implement batching strategy:
  - For annual data: fetch by decade or 5-year periods
  - For monthly data: fetch by year
- [ ] Track progress per batch for resumability
- [ ] Handle partial failures (some years succeed, others fail)
- [ ] Implement "backfill" mode for initial historical import
- [ ] Implement "incremental" mode for ongoing updates

**Example:**

```
Historical import for POP105A (1990-2024):
  Batch 1: 1990-1999 ✓
  Batch 2: 2000-2009 ✓
  Batch 3: 2010-2019 ✓
  Batch 4: 2020-2024 ✓
```

**Acceptance Criteria:**

- Historical import doesn't timeout
- Progress is tracked and resumable
- Final data matches direct INS query

### 3.5 Data Transformation Layer

**Context:** Transform INS cube format to flat observations.

**Tasks:**

- [ ] Implement cube-to-rows transformation:
  - Input: Multi-dimensional INS response
  - Output: Flat rows with `(siruta, period, dimensions_json, value)`
- [ ] Apply dimension handling rules from mapping config:
  - Flatten certain dimensions to separate records
  - Keep others in JSONB
  - Calculate aggregates if configured
- [ ] Apply SIRUTA normalization using `SirutaNormalizationService`
- [ ] Apply temporal normalization
- [ ] Handle "Total" rows appropriately (don't double-count)

**Acceptance Criteria:**

- Transformation produces correct flat structure
- Dimension handling matches configuration
- SIRUTA codes are normalized

### 3.6 Data Validation & Sanitization

**Context:** INS sometimes publishes nulls or non-numeric flags for missing data.

**INS Special Value Flags:**

| Flag | Meaning            | Our Handling                            |
| ---- | ------------------ | --------------------------------------- |
| `:`  | Data not available | Store as NULL, flag as 'unavailable'    |
| `-`  | Zero or negligible | Store as 0, flag as 'zero'              |
| `c`  | Confidential       | Store as NULL, flag as 'confidential'   |
| `..` | Not applicable     | Store as NULL, flag as 'not_applicable' |

**Tasks:**

- [ ] Implement value parsing with flag detection
- [ ] Store original flag in `value_flags` column
- [ ] Convert to appropriate numeric value (NULL or 0)
- [ ] Validate SIRUTA code mappings (flag unmapped codes)
- [ ] Validate temporal consistency (no future dates, reasonable ranges)
- [ ] Check for duplicate observations (same dimensions)
- [ ] Generate validation report per import batch
- [ ] Decide on handling invalid records:
  - **Recommended:** Import with flag, don't skip

**Acceptance Criteria:**

- Validation runs on every import
- Invalid records don't corrupt database
- Validation issues are reported and reviewable
- Original INS flags preserved for reference

### 3.7 Import Monitoring & Observability

**Tasks:**

- [ ] Add metrics:
  - Datasets synced count
  - Observations imported per dataset
  - Import duration
  - Error rate
  - API response times
  - Unmapped SIRUTA codes count
- [ ] Create alerts for:
  - Import failures
  - Unusual observation counts (possible data issue)
  - API unavailability
  - High unmapped SIRUTA rate
- [ ] Dashboard for import status overview
- [ ] **Report status to monitoring channel** (Slack/Discord/Email):
  - Success: "POP105A synced: 45,000 rows, 2 warnings"
  - Partial Fail: "FOM103A: 80% complete, 3 batches failed"
  - Fail: "Import failed: API timeout after 3 retries"

**Acceptance Criteria:**

- Can monitor import health from existing observability stack
- Alerts fire on failures
- Status notifications sent to configured channel

---

## Epic 4: Incremental Sync & Updates

> _Keeping data fresh without disrupting service._

### 4.1 Change Detection Strategy

**Context:** Need to efficiently update only changed data.

**Tasks:**

- [ ] Research INS update patterns:
  - How often is each dataset updated?
  - Does INS provide "last modified" metadata?
  - Are historical values ever revised? (Yes - INS corrects past data)
- [ ] Design change detection approach:
  - **Option A: Full re-import with upsert** (simple, higher load)
    - For yearly data, full overwrite of that year is safer to correct past errors
  - **Option B: Compare checksums/timestamps** (efficient, complex)
  - **Option C: Hybrid** based on dataset characteristics
  - **Recommended:** Option A for yearly data, Option C for more frequent data
- [ ] Handle data revisions (INS corrects historical data):
  - Track `source_version` or `source_updated_at`
  - Allow full re-import of historical periods when corrections detected

**Acceptance Criteria:**

- Change detection strategy documented
- Approach chosen and justified per dataset type

### 4.2 Versioning & Rollback

**Context:** If INS pushes bad data, we need a way to revert quickly.

**Strategy:** Keep a `batch_id` on all imported rows. If a batch is corrupt, delete all rows with that `batch_id`.

**Tasks:**

- [ ] Implement rollback procedure:

  ```sql
  -- Rollback a bad import
  DELETE FROM ins_observations WHERE batch_id = 'uuid-of-bad-batch';
  UPDATE ins_import_batches SET status = 'rolled_back' WHERE id = 'uuid-of-bad-batch';
  ```

- [ ] Create admin endpoint/CLI for rollback
- [ ] Add confirmation step (show affected row count before delete)
- [ ] Keep last N successful batches for each dataset (retention policy)
- [ ] Log all rollback operations
- [ ] Test rollback doesn't break referential integrity

**Acceptance Criteria:**

- Rollback completes in < 1 minute for typical batch
- Rolled back data is completely removed
- Rollback is auditable

### 4.3 Zero-Downtime Sync

**Context:** Updates must not disrupt live API.

**Tasks:**

- [ ] Implement transactional updates (batch commits)
- [ ] Consider blue-green approach for major re-imports:
  - Import to staging table
  - Validate (row counts, checksums)
  - Swap in single transaction (rename tables)
- [ ] Handle partial failures (some datasets succeed, others fail)
- [ ] Add sync status tracking (last successful sync per dataset)
- [ ] Ensure API returns consistent data during sync (read from committed data only)

**Acceptance Criteria:**

- Sync runs without API downtime
- Failed syncs don't leave data in inconsistent state
- Rollback is possible if major issues detected

### 4.4 Sync Scheduling

**Context:** Different matrices update at different times. INS has specific publication calendars.

**Tasks:**

- [ ] Create configurable scheduler with per-dataset schedules:

  ```json
  {
    "POP105A": { "schedule": "0 6 1 2 *", "note": "Feb 1st 6AM - Population" },
    "FOM103A": { "schedule": "0 6 1 4,7,10,1 *", "note": "Quarterly - Labor" },
    "GDP_*": { "schedule": "0 6 15 * *", "note": "Monthly 15th" }
  }
  ```

- [ ] Implement scheduler (cron/job queue)
- [ ] Allow manual trigger for ad-hoc syncs
- [ ] Prevent concurrent syncs of same dataset (distributed lock)
- [ ] Support "sync all" command for full refresh
- [ ] Log sync schedule and actual run times

**Acceptance Criteria:**

- Scheduled syncs run reliably
- No duplicate sync runs
- Manual sync available in admin
- Schedule is configurable without code deploy

---

## Epic 5: API Design & Implementation

> _Exposing INS data through Transparenta.eu API._

This project uses **GraphQL (Mercurius)** as the primary API with optional REST endpoints via Fastify.

### 5.1 GraphQL Schema Design (Primary)

**Context:** GraphQL provides flexible querying, nested data fetching, and strong typing that aligns well with multi-dimensional INS data.

**Required GraphQL Types:**

| Type                       | Description                                                                  |
| -------------------------- | ---------------------------------------------------------------------------- |
| `InsDataset`               | Dataset metadata (code, name, dimensions, temporal granularity, last synced) |
| `InsDimension`             | Dimension metadata (code, name, type, available values)                      |
| `InsObservation`           | Single data point (siruta, period, dimensions JSON, value, unit, flags)      |
| `InsDatasetConnection`     | Paginated list of datasets with `PageInfo`                                   |
| `InsObservationConnection` | Paginated list of observations with `PageInfo`                               |

**Required GraphQL Queries:**

| Query                                                 | Description                                         |
| ----------------------------------------------------- | --------------------------------------------------- |
| `insDatasets(filter, limit, offset)`                  | List datasets with filtering                        |
| `insDataset(code)`                                    | Get single dataset by code                          |
| `insObservations(datasetCode, filter, limit, offset)` | Query observations with multi-dimensional filtering |
| `insUatIndicators(sirutaCode, period, datasetCodes)`  | Get all INS indicators for a UAT                    |
| `insCompare(sirutaCodes, datasetCode, period)`        | Compare indicator across multiple UATs              |

**Tasks:**

- [ ] Design GraphQL schema in `shell/graphql/schema.ts`
  - See `src/modules/entity/shell/graphql/schema.ts` for patterns
  - Use `extend type Query` to add to existing schema
- [ ] Design filtering and pagination strategy (offset-based or cursor-based)
- [ ] Design aggregation capabilities (sum, avg over time/territory)
- [ ] Define complexity limits to prevent expensive queries
- [ ] Add DataLoader for N+1 query prevention

> **Implementation Notes:**
>
> - Schema goes in `shell/graphql/schema.ts` as template literal with `/* GraphQL */` comment
> - Use existing `PageInfo` type from base schema
> - Resolvers go in separate `resolvers.ts` file

**Acceptance Criteria:**

- GraphQL schema documented and type-safe
- Queries reviewed and approved
- Covers all major use cases

### 5.1.1 REST Endpoints (Secondary/Optional)

For simpler integrations or external clients, optional REST endpoints can be added in `shell/rest/routes.ts`.

**Suggested REST Endpoints:**

| Endpoint                                 | Description             |
| ---------------------------------------- | ----------------------- |
| `GET /api/v1/ins/datasets`               | List available datasets |
| `GET /api/v1/ins/datasets/:code`         | Get dataset by code     |
| `GET /api/v1/ins/datasets/:code/data`    | Query observations      |
| `GET /api/v1/ins/uat/:siruta/indicators` | Get UAT indicators      |

> **Implementation Notes:**
>
> - Follow `src/modules/health/shell/rest/routes.ts` for patterns
> - Export factory function `makeInsRoutes(deps)`
> - Use Result pattern for error handling

### 5.2 Aggregation Strategy

**Context:** The frontend might need "Total Population" without manually summing "Male" + "Female".

**Options:**

1. **Pre-calculate during import:** Store aggregated totals as separate observations
2. **Calculate on-demand:** API computes sum/avg at query time
3. **Materialized views:** Pre-compute common aggregations, refresh periodically

**Tasks:**

- [ ] Identify common aggregation needs:
  - Total across gender (Male + Female = Total)
  - Total across area type (Urban + Rural = Total)
  - Sum across UATs within county
  - Average over time period
- [ ] Decide approach per aggregation type:
  - **Import-time:** Totals that INS provides (use their "Total" rows)
  - **Materialized view:** County/regional aggregations
  - **On-demand:** Custom groupings
- [ ] Implement chosen approach
- [ ] Handle "double counting" (don't sum totals with breakdowns)

**Acceptance Criteria:**

- Common aggregations available without client-side calculation
- No double-counting in aggregated results
- Performance acceptable for on-demand aggregations

### 5.3 GraphQL Resolver Implementation

**Tasks:**

- [ ] Implement resolvers in `shell/graphql/resolvers.ts`
  - Export factory function `makeInsResolvers(deps)` returning `IResolvers`
  - See `src/modules/entity/shell/graphql/resolvers.ts` for patterns
  - Call use cases from `core/usecases/`, handle `Result` errors by logging + throwing

- [ ] Implement use cases called by resolvers:
  - `getInsDatasets` - List with filtering
  - `getInsDataset` - Single by code
  - `getInsObservations` - Query with filters
  - `getInsUatIndicators` - Aggregated UAT view
  - `getInsComparison` - Compare across UATs

- [ ] Add response caching using Mercurius cache or Redis:
  - Dataset metadata: cache 1 hour
  - Historical data: cache 24 hours
  - Recent data: cache 1 hour or less

- [ ] Add DataLoader for N+1 prevention on nested fields

> **Implementation Notes:**
>
> - Clamp pagination limits (e.g., `DEFAULT_LIMIT = 20`, `MAX_LIMIT = 500`)
> - Log errors via `context.reply.log.error()` before throwing
> - Return `null` for not-found cases (don't throw)

**Acceptance Criteria:**

- All GraphQL queries implemented and tested
- Response times < 200ms for typical queries
- Pagination works for large result sets (>10k rows)
- N+1 queries prevented via DataLoader

### 5.4 Integration with Existing UAT API

**Context:** INS data should enhance existing UAT views.

**Tasks:**

- [ ] Add INS indicators summary to existing UAT detail endpoint:

  ```json
  GET /api/v1/uat/{siruta}
  {
    ...existing_uat_fields,
    "ins_indicators": {
      "population": 45000,
      "unemployment_rate": 4.2,
      "average_salary": 3500,
      "as_of": "2023"
    }
  }
  ```

- [ ] Add INS data availability flag to UAT listing
- [ ] Create correlation endpoint: budget execution + INS indicators

  ```
  GET /api/v1/uat/{siruta}/budget-context
  - Response: budget data + relevant INS indicators for same period
  ```

- [ ] Document how to use INS data in conjunction with budget data

**Acceptance Criteria:**

- UAT detail includes INS data summary
- Users can correlate budget and statistical data
- Documentation explains use cases

---

## Epic 6: Testing & Quality Assurance

> **Testing Strategy:** Follow project's testing pyramid (see `CLAUDE.md`). Use **in-memory fakes** instead of mocking libraries.

### 6.1 Unit Tests (Core Layer)

Test pure business logic in `core/usecases/` with in-memory fakes.

**Tasks:**

- [ ] Create test fakes in `tests/fixtures/ins-fakes.ts`
  - Implement port interfaces with in-memory storage
  - No mocking libraries (jest.mock, sinon) - just simple objects
  - See `tests/fixtures/fakes.ts` for existing patterns

- [ ] Unit tests for use cases:
  - `syncDataset` - batch creation, error handling, rollback
  - `getInsDatasets` - filtering, pagination
  - `getInsObservations` - multi-dimensional filtering

- [ ] Unit tests for pure functions:
  - INS API response parsing
  - Temporal normalization
  - SIRUTA mapping
  - Data validation rules

> **Implementation Notes:**
>
> - Test files go in `tests/unit/ins/`
> - Pass in-memory fakes as dependencies
> - Verify `Result` outcomes with `result.isOk()` / `result.isErr()`

**Acceptance Criteria:**

- Test coverage > 80% for `core/` layer
- No mocking libraries used (only in-memory fakes)
- Tests run fast (< 5 seconds total)

### 6.2 Integration Tests (GraphQL/REST)

Test HTTP/GraphQL routes using `app.inject()` with in-memory fakes.

**Tasks:**

- [ ] Integration tests for GraphQL queries
  - Use `app.inject()` to test without real HTTP server
  - Inject fake repositories via dependency injection
  - See `tests/integration/` for existing patterns

- [ ] Test edge cases:
  - Empty datasets
  - Special values (`:`, `-`, `c`)
  - Unicode characters (Romanian diacritics)
  - Pagination boundaries

**Acceptance Criteria:**

- Integration tests cover all GraphQL queries
- Tests use `app.inject()` (no real HTTP server)
- Tests run fast (< 10 seconds total)

### 6.3 E2E Tests (Optional - Testcontainers)

For full database integration, use Testcontainers PostgreSQL.

**Tasks:**

- [ ] E2E tests with real database
  - Use `tests/infra/test-db.ts` for Testcontainers setup
  - Test full sync pipeline with real DB
  - See `tests/e2e/` for existing patterns

- [ ] Load test import pipeline with largest datasets
- [ ] Identify and optimize slow Kysely queries

**Acceptance Criteria:**

- Import of largest dataset completes in < X minutes
- No memory leaks in long-running sync

### 6.4 Data Quality Validation

**Tasks:**

- [ ] Spot-check imported data against INS website
- [ ] Validate SIRUTA mappings for sample of records
- [ ] Compare aggregated values (county totals should match INS)

**Acceptance Criteria:**

- No discrepancies found in spot checks
- Aggregations match INS published totals

---

## Epic 7: Documentation & Deployment

### 7.1 Technical Documentation

**Tasks:**

- [ ] Document database schema
- [ ] Document import pipeline architecture
- [ ] Document sync scheduling and configuration
- [ ] Document API endpoints (auto-generated from OpenAPI)
- [ ] Document troubleshooting guide
- [ ] Document data dictionary (what each indicator means)

**Acceptance Criteria:**

- Documentation in project wiki/docs
- New team member can understand system from docs

### 7.2 Operational Runbook

**Tasks:**

- [ ] Document how to:
  - Add new dataset to import
  - Trigger manual sync
  - Investigate sync failures
  - Handle SIRUTA mapping issues
  - Roll back bad import
- [ ] Document monitoring and alerting setup

**Acceptance Criteria:**

- Runbook covers common operational scenarios

### 7.3 Deployment

**Tasks:**

- [ ] Create database migrations
- [ ] Add feature flags if needed for gradual rollout
- [ ] Deploy to staging, run full import
- [ ] Validate staging data
- [ ] Deploy to production
- [ ] Run initial production import (off-peak hours)
- [ ] Monitor for issues post-launch

**Acceptance Criteria:**

- Successful staging validation
- Production deployment with no incidents
- Initial import completes successfully

---

## Non-Functional Requirements

| Requirement             | Target                             |
| ----------------------- | ---------------------------------- |
| API Response Time (p95) | < 200ms                            |
| Import Throughput       | > 10,000 records/minute            |
| Data Freshness          | Within 24h of INS update           |
| Availability            | 99.9% (aligned with main platform) |
| Storage Growth          | Monitor and alert at 80% capacity  |

---

## Risks & Mitigations

| Risk                                   | Impact                 | Probability | Mitigation                                                               |
| -------------------------------------- | ---------------------- | ----------- | ------------------------------------------------------------------------ |
| INS API unavailable/unstable           | Import fails           | Medium      | Retry logic, alerting, graceful degradation, consider local cache        |
| INS changes API format                 | Parser breaks          | Low         | Versioned parsers, monitoring for schema changes, alerts on parse errors |
| SIRUTA mapping incomplete              | Data not linked to UAT | Medium      | Manual mapping table, flag unmapped records, admin review workflow       |
| Storage grows faster than expected     | Cost/performance       | Medium      | Prioritize datasets, implement data retention, consider partitioning     |
| Historical territorial changes complex | Incorrect aggregations | High        | Document edge cases, validate with known totals, "Historical" tagging    |
| INS rate limits our requests           | Import blocked         | Medium      | Configurable delays, respect rate limits, cache catalog locally          |
| Data quality issues from INS           | Bad data in our system | Medium      | Validation layer, batch rollback capability, spot-check process          |
| Performance with millions of rows      | Slow queries           | Medium      | Partitioning, indexes, query optimization, caching                       |

---

## Key Technical Questions to Answer During Implementation

> These questions should be answered during Epic 1 (Discovery) and documented.

### Data Model Questions

1. **Ghost Codes:** How do we display data for a Commune that existed in 2000 but was split into two in 2005?
   - _Suggestion: Display it under the old name with a "Historical" tag_
2. **Dimension Handling:** For each matrix, which dimensions should be flattened vs. kept as filters?
   - _Needs product input on most useful views_
3. **Totals Handling:** Does INS provide "Total" rows, or do we need to calculate them?
   - _Don't double-count totals with breakdowns_

### Performance Questions

4. **Table Size:** `ins_observations` will grow to millions of rows. Do we need:
   - TimescaleDB?
   - Table partitioning by year?
   - Archival of old data?
5. **Query Patterns:** What are the most common query patterns? Optimize indexes accordingly.

### API Questions

6. **Rate Limiting:** Does INS block us if we hit them too hard?
   - _Action: Add configurable delay between requests, start conservative_
7. **Caching:** Should we cache INS data locally for offline resilience?
   - _Consider: What if INS is down during scheduled sync?_

### Legal/Compliance Questions

8. **Licensing:** Are there any INS data licensing/usage restrictions?
   - _Check INS terms of service_
9. **Attribution:** Do we need to display INS attribution in UI?
   - _Likely yes - document requirements_

---

## Open Questions (Require Product/Team Input)

- [ ] What is the MVP dataset list? (needs product prioritization)
- [ ] How should historical localities be displayed in UI?
- [ ] Should INS data be public or require authentication?
- [ ] What's the acceptable data freshness SLA? (24h? 1 week?)
- [ ] Do we want to build an INS data explorer UI, or just API?
- [ ] Budget for additional infrastructure (if TimescaleDB needed)?

---

## Estimated Timeline

| Phase                          | Duration  | Dependencies   |
| ------------------------------ | --------- | -------------- |
| Epic 1: Discovery              | 1 week    | -              |
| Epic 2: Schema Design          | 1 week    | Epic 1         |
| Epic 3: Import Pipeline        | 2 weeks   | Epic 2         |
| Epic 4: Sync                   | 1 week    | Epic 3         |
| Epic 5: API                    | 1.5 weeks | Epic 2, Epic 3 |
| Epic 6: Testing                | 1 week    | Epic 3, 5      |
| Epic 7: Documentation & Deploy | 0.5 week  | All            |

**Total Estimate: 6-8 weeks**

---

## Definition of Done

- [ ] All datasets in MVP scope are imported
- [ ] Data linked to UAT via SIRUTA where applicable
- [ ] Automated sync running on schedule
- [ ] API endpoints available and documented
- [ ] Tests passing, coverage adequate
- [ ] Monitoring and alerting in place
- [ ] Documentation complete
- [ ] Deployed to production successfully
- [ ] Rollback procedure tested and documented
- [ ] Performance benchmarks met

---

## Suggested Implementation Order

Given dependencies, here's the recommended sequence:

```
Week 1: Epic 1 (Discovery)
├── 1.1 Document INS Data Structure
├── 1.2 Map Matrices to Requirements
├── 1.3 SIRUTA Reconciliation (start early, it's critical)
├── 1.4 API Assessment
└── 1.5 Define Scope → MVP dataset list

Week 2: Epic 2 (Schema)
├── 2.1 Core Schema Design
├── 2.2 UAT Linking Strategy
├── 2.3 Temporal Alignment
└── 2.4 Historical Territorial Handling

Week 3-4: Epic 3 (Import Pipeline)
├── 3.1 TempoApiClient
├── 3.2 Catalog Sync
├── 3.3 SyncManager
├── 3.4 Historical Import Strategy
├── 3.5 Data Transformation
└── 3.6 Validation

Week 5: Epic 4 (Sync) + Epic 5 (API) in parallel
├── 4.1-4.4 Sync & Scheduling
└── 5.1-5.4 API Implementation

Week 6: Epic 6 (Testing) + Epic 7 (Deploy)
├── Testing & QA
├── Documentation
└── Production Deployment
```

---

## Immediate Next Steps

Before starting implementation:

1. **Start with API exploration** (Epic 1)
   - Study `tempo.py` and `QTempo` for API patterns
   - Document INS API response structures
   - Identify SIRUTA code mapping challenges

2. **Define MVP dataset list** - get product input on:
   - Population (POP105A) - almost certainly yes
   - Labor force (FOM103A)
   - Salaries
   - Education indicators
   - Health indicators

3. **Create module skeleton**
   - Create `src/modules/ins/` directory structure
   - Define initial types and ports in `core/`
   - Wire into `app/build-app.ts`

---

## Related Resources

- INS Tempo Online: <http://statistici.insse.ro:8077/tempo-online/>
- INS API Base: <http://statistici.insse.ro:8077/tempo-ins/>
- SIRUTA Database: [link to Ministry of Administration]
- Transparenta.eu UAT Schema: [link to internal docs]
