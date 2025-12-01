# Database Seeds Module

This module provides two main functionalities for working with budget data:

## 1. In-Memory Database (for Testing & Mocking)

Load seed data into an in-memory database for fast testing without needing PostgreSQL:

```typescript
import { loadSeedData, InMemoryDatabaseQuery } from '@/infra/database/seeds';
import path from 'node:path';

// Load all seed files from directory
const seedDir = path.join(process.cwd(), 'src/infra/database/seeds/entities');
const db = await loadSeedData(seedDir);

// Create query helper
const query = new InMemoryDatabaseQuery(db);

// Query the data
const entity = query.getEntityByCui('4270740');
const reports = query.getReportsByEntityAndYear('4270740', 2023);
const lineItems = query.getLineItemsByEntity('4270740');

// Get aggregated totals
const totals = query.getTotalsByEntityAndYear('4270740', 2023, 'Executie bugetara detaliata');
console.log(totals); // { totalIncome, totalExpense, balance }
```

## 2. Database Seeding (for PostgreSQL)

Seed actual PostgreSQL database with data from JSON files:

```typescript
import { seedDatabase } from '@/infra/database/seeds';
import { initDatabases } from '@/infra/database/client';
import { createConfig, parseEnv } from '@/infra/config/env';

// Initialize database clients
const env = parseEnv();
const config = createConfig(env);
const { budgetDb } = initDatabases(config);

// Seed a single file
await seedDatabase(budgetDb, 'src/infra/database/seeds/entities/4270740.json');

// Or seed multiple files
const files = fs.readdirSync('src/infra/database/seeds/entities');
for (const file of files) {
  await seedDatabase(budgetDb, path.join('src/infra/database/seeds/entities', file));
}
```

## Data Structure

The seed JSON files follow this structure:

```json
{
  "version": 1,
  "cui": "4270740",
  "entityName": "MUNICIPIUL SIBIU",
  "mainCreditData": {
    "2023": {
      "10": [
        {
          "reportInfo": {
            "id": "report-123",
            "date": "2023-10-31",
            "year": 2023,
            "period": "Luna 10",
            "documentLinks": ["http://..."]
          },
          "fileInfo": {
            "source": "xml-file.xml",
            "xmlHash": "abc123",
            "parsedAt": "2024-01-01",
            "formatId": "v1"
          },
          "summary": {
            "budgetSectorId": 1,
            "sectorType": "Buget local",
            "mainCreditor": "4270740"
          },
          "lineItems": [
            {
              "type": "vn",
              "functionalCode": "07.01.01",
              "economicCode": "30.01.01",
              "fundingSource": "A",
              "ytdAmount": 1000000,
              "monthlyAmount": 100000,
              "expenseType": "functionare"
            }
          ]
        }
      ]
    }
  },
  "secondaryCreditData": {},
  "detailedCreditData": {},
  "nameLookups": {
    "functional": {
      "07.01.01": "Impozit pe cladiri de la persoane fizice"
    },
    "economic": {
      "30.01.01": "Salarii de baza"
    },
    "fundingSource": {
      "A": "Buget de stat"
    }
  }
}
```

## Schema Reference

The data maps to these database tables:

- **Entities** - Public entities (UATs, institutions)
- **FunctionalClassifications** - COFOG functional codes
- **EconomicClassifications** - Economic classification codes
- **FundingSources** - Funding source descriptions
- **BudgetSectors** - Budget sector descriptions
- **Reports** - Budget execution report metadata
- **ExecutionLineItems** - Individual budget line items (partitioned by year and report_type)

See `src/infra/database/budget/schema.sql` for the complete schema definition.

## Testing Example

```typescript
import { describe, it, expect } from 'vitest';
import { loadSeedData, InMemoryDatabaseQuery } from '@/infra/database/seeds';

describe('Budget Data', () => {
  it('should load and query seed data', async () => {
    const db = await loadSeedData('./src/infra/database/seeds/entities');
    const query = new InMemoryDatabaseQuery(db);

    const entity = query.getEntityByCui('4270740');
    expect(entity).toBeDefined();
    expect(entity?.name).toBe('MUNICIPIUL SIBIU');

    const reports = query.getReportsByEntity('4270740');
    expect(reports.length).toBeGreaterThan(0);
  });
});
```
