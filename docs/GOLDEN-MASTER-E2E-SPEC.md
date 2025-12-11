# Golden Master E2E Test Specification

> **Version:** 2.0.0
> **Status:** Draft
> **Last Updated:** 2025-12-07

## Table of Contents

1. [Overview](#1-overview)
2. [Architecture](#2-architecture)
3. [Determinism Guarantees](#3-determinism-guarantees)
4. [Test Structure](#4-test-structure)
5. [Snapshot Management](#5-snapshot-management)
6. [CI/CD Workflow](#6-cicd-workflow)
7. [Maintenance Procedures](#7-maintenance-procedures)

---

## 1. Overview

### 1.1 Purpose

Golden Master (Snapshot) E2E tests provide **strict regression protection** by comparing GraphQL query outputs against known-good baselines. These tests connect to a persistent test database containing historical budget data and verify that query results remain byte-for-byte identical over time.

### 1.2 Goals

| Goal                     | Description                                                               |
| ------------------------ | ------------------------------------------------------------------------- |
| **Determinism**          | Identical queries produce identical results, regardless of when tests run |
| **Regression Detection** | Any change to query logic or data transformation is immediately detected  |
| **Client Coverage**      | All client-facing queries are tested with realistic parameter variations  |
| **Production Parity**    | Tests run against real PostgreSQL with production-like data               |

### 1.3 Scope

These tests cover **read-only GraphQL queries** including:

- `executionAnalytics` - Time series aggregation queries
- `entityAnalytics` - Per-entity budget analytics
- `countyHeatmapData` - Geographic aggregations
- `uatHeatmapData` - UAT-level analytics
- `aggregatedLineItems` - Line item queries with filters
- `executionLineItems` - Detailed line item queries
- `budgetSectors`, `fundingSources`, `classifications` - Dimension queries

### 1.4 Out of Scope

- Mutations (write operations)
- Authentication/authorization flows
- Performance benchmarks
- UI/Frontend testing

---

## 2. Architecture

### 2.1 Dual-Mode Execution

The test suite supports two execution modes, allowing flexibility between local development and snapshot generation from production:

```text
┌─────────────────────────────────────────────────────────────────────┐
│                    Golden Master E2E Suite                           │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  MODE 1: Database Mode (Default)                                     │
│  ════════════════════════════════                                    │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────────────┐   │
│  │  Test Runner │───▶│ Fastify App  │───▶│   PostgreSQL 16      │   │
│  │   (Vitest)   │    │  (in-proc)   │    │   (Test Database)    │   │
│  └──────────────┘    └──────────────┘    └──────────────────────┘   │
│                                                                      │
│  MODE 2: API Mode (Snapshot Generation)                              │
│  ═══════════════════════════════════════                             │
│  ┌──────────────┐                        ┌──────────────────────┐   │
│  │  Test Runner │───────────────────────▶│   External API       │   │
│  │   (Vitest)   │        HTTP            │   (Prod/Staging)     │   │
│  └──────────────┘                        └──────────────────────┘   │
│         │                                                            │
│         ▼                                                            │
│  ┌──────────────┐                                                    │
│  │   Snapshot   │                                                    │
│  │   Storage    │                                                    │
│  │  (.snap.json)│                                                    │
│  └──────────────┘                                                    │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

### 2.2 Execution Modes

| Mode         | Trigger                | Use Case                                  |
| ------------ | ---------------------- | ----------------------------------------- |
| **Database** | `TEST_GM_DATABASE_URL` | CI/CD testing, local development          |
| **API**      | `TEST_GM_API_URL`      | Initial snapshot generation from prod API |

**Mode Selection Logic:**

```typescript
// If API URL is set, use external API mode
// Otherwise, use database mode with in-process Fastify
const useApiMode = Boolean(process.env['TEST_GM_API_URL']);
```

### 2.3 Key Principles

1. **Decoupled Test Runner** - Tests are HTTP clients, independent of application internals
2. **Environment Agnostic** - Same tests run against any GraphQL endpoint
3. **Snapshot from Production** - Generate golden baselines from real prod API
4. **Validate Anywhere** - Verify any environment returns identical results

### 2.4 Technology Stack

| Component       | Technology   | Rationale                                   |
| --------------- | ------------ | ------------------------------------------- |
| Test Runner     | Vitest       | Native ESM, fast, built-in snapshot support |
| HTTP Client     | Native fetch | No dependencies, works with any endpoint    |
| Snapshot Format | JSON         | Human-readable diffs, mergeable in PRs      |

### 2.5 Configuration

| Variable               | Required | Description                                |
| ---------------------- | -------- | ------------------------------------------ |
| `TEST_GM_API_URL`      | No\*     | External API endpoint (e.g., prod GraphQL) |
| `TEST_GM_DATABASE_URL` | No\*     | Database connection for in-process mode    |

\*One of these must be provided.

**Database Mode (CI/Local Development):**

```bash
export TEST_GM_DATABASE_URL="postgresql://readonly:pass@test-db:5432/budget"
pnpm test:gm
```

**API Mode (Snapshot Generation from Prod):**

```bash
export TEST_GM_API_URL="https://api.transparenta.eu/graphql"
pnpm test:gm --update
```

---

## 3. Determinism Guarantees

### 3.1 Core Principle

All Golden Master tests query **historical data from closed fiscal years** (2016-2024). This data is immutable - once a fiscal year closes, the budget execution reports are finalized and never change.

```text
┌─────────────────────────────────────────────────────────────────────┐
│                      DATA MUTABILITY TIMELINE                        │
├─────────────────────────────────────────────────────────────────────┤
│  2016-2024                              2025+                        │
│  ─────────                              ─────                        │
│  IMMUTABLE (Closed Years)               MUTABLE (Current Year)       │
│       ▲                                      ▲                       │
│       │                                      │                       │
│  SAFE FOR GOLDEN MASTER              DO NOT USE IN TESTS             │
└─────────────────────────────────────────────────────────────────────┘
```

### 3.2 PostgreSQL Environment Requirements

| Factor           | Requirement   | Impact                              |
| ---------------- | ------------- | ----------------------------------- |
| `LC_COLLATE`     | `en_US.UTF-8` | Affects `ORDER BY` for strings      |
| `LC_CTYPE`       | `en_US.UTF-8` | Affects character classification    |
| `TIMEZONE`       | `UTC`         | Affects timestamp comparisons       |
| Postgres Version | 16.x          | Consistent query planning/execution |

**Verification Query:**

```sql
SHOW lc_collate;  -- Must be en_US.UTF-8
SHOW lc_ctype;    -- Must be en_US.UTF-8
SHOW timezone;    -- Must be UTC
SELECT version(); -- Must be PostgreSQL 16.x
```

### 3.3 Query Determinism Rules

| Rule                  | Implementation                                       |
| --------------------- | ---------------------------------------------------- |
| **Explicit Ordering** | All queries MUST include `ORDER BY` clauses          |
| **No Current Time**   | Never use `NOW()`, `CURRENT_DATE`, or relative dates |
| **Fixed Date Ranges** | Query only 2016-2024 (closed fiscal years)           |
| **Stable Pagination** | Use deterministic cursors (not offset-based)         |

### 3.4 Response Handling

Responses are compared **as-is** from the API. No transformation is applied to decimal values - the API must return consistent precision natively.

```typescript
// Minimal normalization - only exclude volatile metadata
const NORMALIZATION = {
  // Exclude fields that vary between requests
  excludeFields: ['__typename', 'requestId', 'extensions'],
};
```

**Why no decimal normalization?**

- The API should return consistent decimal precision
- If precision varies between environments, that's a bug to fix in the API
- Keeping raw values ensures we detect precision issues early

---

## 4. Test Structure

### 4.1 Directory Layout

```text
tests/
├── golden-master/
│   ├── client.ts                          # GraphQL client (dual-mode)
│   ├── setup.ts                           # Mode detection & initialization
│   │
│   ├── specs/                             # Test specifications
│   │   ├── execution-analytics.gm.test.ts
│   │   ├── entity-analytics.gm.test.ts
│   │   ├── heatmap.gm.test.ts
│   │   ├── line-items.gm.test.ts
│   │   └── dimensions.gm.test.ts
│   │
│   └── snapshots/                         # Expected outputs (VCS-tracked)
│       ├── execution-analytics/
│       │   ├── yearly-totals.snap.json
│       │   ├── quarterly-normalized.snap.json
│       │   └── monthly-with-growth.snap.json
│       ├── entity-analytics/
│       │   └── entity-comparison.snap.json
│       ├── heatmap/
│       │   ├── county-heatmap-2024.snap.json
│       │   └── uat-heatmap.snap.json
│       └── dimensions/
│           ├── functional-tree.snap.json
│           └── economic-tree.snap.json
```

### 4.2 Naming Conventions

| Element       | Convention                  | Example                                   |
| ------------- | --------------------------- | ----------------------------------------- |
| Test file     | `<module>.gm.test.ts`       | `execution-analytics.gm.test.ts`          |
| Snapshot file | `<scenario>.snap.json`      | `yearly-totals.snap.json`                 |
| Test name     | `[GM] <query> - <scenario>` | `[GM] executionAnalytics - yearly totals` |

### 4.3 Client Query Coverage

| Query                       | Variations to Test                                                                   |
| --------------------------- | ------------------------------------------------------------------------------------ |
| `executionAnalytics`        | YEAR/QUARTER/MONTH frequency, normalization modes, inflation adjusted, period growth |
| `entityAnalytics`           | Single entity, entity comparison, all time ranges                                    |
| `countyHeatmapData`         | All counties, single year (2024), multi-year range                                   |
| `uatHeatmapData`            | Single UAT, all UATs in county                                                       |
| `executionLineItems`        | Filtered by entity, by classification, paginated                                     |
| `aggregatedLineItems`       | Default pagination, filtered, sorted variations                                      |
| `functionalClassifications` | Full tree, filtered by prefix                                                        |
| `economicClassifications`   | Full tree, filtered by prefix                                                        |
| `budgetSectors`             | List all                                                                             |
| `fundingSources`            | List all, filtered                                                                   |

### 4.4 GraphQL Client (Dual-Mode)

The client abstracts the execution mode, allowing tests to work with both database and API modes:

```typescript
// tests/golden-master/client.ts

import type { FastifyInstance } from 'fastify';

export interface GoldenMasterClient {
  query<T>(gql: string, variables?: Record<string, unknown>): Promise<T>;
  close(): Promise<void>;
}

// API Mode: Direct HTTP to external endpoint
function createApiClient(apiUrl: string): GoldenMasterClient {
  return {
    async query<T>(gql: string, variables?: Record<string, unknown>): Promise<T> {
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: gql, variables }),
      });
      const body = await response.json();
      if (body.errors) throw new Error(JSON.stringify(body.errors));
      return body.data;
    },
    async close() {
      /* no-op */
    },
  };
}

// Database Mode: In-process Fastify app
function createDbClient(app: FastifyInstance): GoldenMasterClient {
  return {
    async query<T>(gql: string, variables?: Record<string, unknown>): Promise<T> {
      const response = await app.inject({
        method: 'POST',
        url: '/graphql',
        payload: { query: gql, variables },
      });
      const body = response.json();
      if (body.errors) throw new Error(JSON.stringify(body.errors));
      return body.data;
    },
    async close() {
      await app.close();
    },
  };
}
```

### 4.5 Test File Template

Tests use the client abstraction - they don't know or care which mode is active:

```typescript
// tests/golden-master/specs/execution-analytics.gm.test.ts

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getClient, type GoldenMasterClient } from '../client.js';

describe('[Golden Master] Execution Analytics', () => {
  let client: GoldenMasterClient;

  beforeAll(async () => {
    client = await getClient(); // Returns API or DB client based on env
  }, 30_000);

  afterAll(async () => {
    await client?.close();
  });

  it('[GM] executionAnalytics - yearly totals', async () => {
    const query = `
      query YearlyTotals($input: ExecutionAnalyticsInput!) {
        executionAnalytics(inputs: [$input]) {
          seriesId
          series {
            frequency
            data { date value }
          }
        }
      }
    `;

    const variables = {
      input: {
        seriesId: 'yearly-totals',
        filter: {
          account_category: 'ch',
          report_period: {
            type: 'YEAR',
            selection: { interval: { start: '2020', end: '2024' } },
          },
          normalization: 'total',
          inflation_adjusted: false,
          show_period_growth: false,
        },
      },
    };

    const data = await client.query(query, variables);

    expect(data).toMatchFileSnapshot('../snapshots/execution-analytics/yearly-totals.snap.json');
  });
});
```

---

## 5. Snapshot Management

### 5.1 Snapshot File Format

Snapshots capture the exact API response (no transformation):

```json
{
  "executionAnalytics": [
    {
      "seriesId": "yearly-totals",
      "series": {
        "frequency": "YEAR",
        "data": [
          { "date": "2020", "value": 1234567890.5 },
          { "date": "2021", "value": 1345678901.25 },
          { "date": "2022", "value": 1456789012.0 },
          { "date": "2023", "value": 1567890123.75 },
          { "date": "2024", "value": 1678901234.5 }
        ]
      }
    }
  ]
}
```

**Key characteristics:**

- Raw API response (no post-processing)
- Decimal values as returned by the API (number or string, depending on schema)
- No metadata wrapper

### 5.2 Generating Snapshots from Production

The recommended workflow for initial snapshot creation:

```bash
# 1. Point tests at production API
export TEST_GM_API_URL="https://api.transparenta.eu/graphql"

# 2. Generate snapshots from prod (the source of truth)
pnpm test:gm -- --update

# 3. Review generated snapshots
git diff tests/golden-master/snapshots/

# 4. Commit the golden baselines
git add tests/golden-master/snapshots/
git commit -m "test(golden-master): generate initial snapshots from production"
```

### 5.3 Validating Against Database

Normal CI/development workflow validates snapshots against the test database:

```bash
# Use database mode (default for CI)
export TEST_GM_DATABASE_URL="postgresql://readonly:pass@test-db:5432/budget"

# Run tests - they must match prod-generated snapshots
pnpm test:gm
```

### 5.4 Updating Snapshots After Changes

When intentional changes affect query outputs:

```bash
# 1. Run tests to see failures
pnpm test:gm

# 2. If changes are intentional, regenerate from prod API
export TEST_GM_API_URL="https://api.transparenta.eu/graphql"
pnpm test:gm -- --update

# 3. Review the diff
git diff tests/golden-master/snapshots/

# 4. Commit with explanation
git add tests/golden-master/snapshots/
git commit -m "test(golden-master): update snapshots for new calculation logic"
```

### 5.5 Review Checklist

When reviewing snapshot changes in PRs:

- [ ] Change is expected based on the PR description
- [ ] Snapshots were regenerated from production API
- [ ] Array ordering is consistent
- [ ] No unexpected fields added/removed

---

## 6. CI/CD Workflow

### 6.1 Workflow Triggers

| Trigger             | Golden Master Tests | Blocking |
| ------------------- | ------------------- | -------- |
| Pull Request        | Yes                 | Yes      |
| Push to `main`      | Yes                 | Yes      |
| Nightly (02:00 UTC) | Yes                 | No       |

### 6.2 GitHub Actions Configuration

```yaml
# .github/workflows/golden-master.yml

name: Golden Master E2E Tests

on:
  pull_request:
    branches: [main]
    paths:
      - 'src/**'
      - 'tests/golden-master/**'
  push:
    branches: [main]
  schedule:
    - cron: '0 2 * * *'
  workflow_dispatch:
    inputs:
      update_snapshots:
        description: 'Update snapshots'
        type: boolean
        default: false

jobs:
  golden-master:
    name: Golden Master E2E
    runs-on: ubuntu-latest
    timeout-minutes: 10

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup pnpm
        uses: pnpm/action-setup@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version-file: '.nvmrc'
          cache: 'pnpm'

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Run Golden Master Tests
        run: |
          if [ "${{ inputs.update_snapshots }}" = "true" ]; then
            pnpm test:gm -- --update
          else
            pnpm test:gm
          fi
        env:
          TEST_GM_DATABASE_URL: ${{ secrets.TEST_DATABASE_URL }}
          TZ: UTC

      - name: Upload snapshot diffs on failure
        if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: snapshot-diffs
          path: tests/golden-master/snapshots/
          retention-days: 7
```

### 6.3 Package.json Scripts

```json
{
  "scripts": {
    "test:gm": "vitest run tests/golden-master --config vitest.gm.config.ts",
    "test:gm:update": "vitest run tests/golden-master --config vitest.gm.config.ts --update"
  }
}
```

### 6.4 Local Development

Developers can run Golden Master tests locally by setting the database URL:

```bash
# Option 1: Export environment variable
export TEST_GM_DATABASE_URL="postgresql://readonly:pass@dev-db:5432/budget"
pnpm test:gm

# Option 2: Use .env.test file
echo 'TEST_GM_DATABASE_URL=postgresql://...' > .env.test
pnpm test:gm
```

---

## 7. Maintenance Procedures

### 7.1 Adding New Tests

1. Identify client query to test from coverage matrix
2. Create test in appropriate `specs/*.gm.test.ts` file
3. Run with `--update` to generate initial snapshot
4. Review snapshot contents for correctness
5. Commit test and snapshot together

### 7.2 Investigating Failures

```bash
# 1. Run with verbose output
pnpm test:gm -- --reporter=verbose

# 2. Check database connectivity
psql $TEST_GM_DATABASE_URL -c "SELECT 1"

# 3. Verify PostgreSQL locale settings
psql $TEST_GM_DATABASE_URL -c "SHOW lc_collate; SHOW timezone;"

# 4. Compare specific snapshot
diff tests/golden-master/snapshots/x.snap.json /tmp/actual.json
```

### 7.3 Troubleshooting

| Issue                  | Cause                          | Resolution                           |
| ---------------------- | ------------------------------ | ------------------------------------ |
| Connection refused     | DB not accessible              | Check network/firewall, VPN status   |
| Locale mismatch        | Different `LC_COLLATE` setting | Verify DB uses `en_US.UTF-8`         |
| Decimal precision diff | Float vs Decimal               | Ensure `decimal.js` used everywhere  |
| Array order mismatch   | Missing `ORDER BY`             | Add explicit ordering to query       |
| Timeout                | Slow query                     | Increase test timeout, check indexes |

---

## Appendix A: Glossary

| Term          | Definition                                                            |
| ------------- | --------------------------------------------------------------------- |
| Golden Master | A known-correct output captured at a point in time, used as reference |
| Snapshot      | JSON file containing expected query output                            |
| Deterministic | Same input always produces same output                                |

## Appendix B: Related Documentation

- [ARCHITECTURE.md](./ARCHITECTURE.md) - System architecture overview
- [TECHNICAL-REFERENCE.md](./TECHNICAL-REFERENCE.md) - API documentation

## Appendix C: Decision Log

| Date       | Decision                             | Rationale                               |
| ---------- | ------------------------------------ | --------------------------------------- |
| 2025-12-07 | Use external test DB over containers | Simpler setup, no seed file management  |
| 2025-12-07 | Read-only service account            | Prevent accidental data modification    |
| 2025-12-07 | Query historical data only           | Guarantees determinism (immutable data) |
| 2025-12-07 | Require `en_US.UTF-8` collation      | Consistent string ordering across envs  |
