# Module Specification: Economic Datasets (`modules/datasets`)

## 1. Overview and Goals

This module implements a **File-Based Data Store** for macro-economic and demographic indicators. It is designed to provide context for budget analysis while adhering to the **Transparenta.eu** architectural principles.

### 1.1 Design Decisions

- **Granularity-Based Files:** Data is split into separate files by frequency (annual, monthly) to optimize payload size (Lazy Loading).
- **Strict Schema:** `x`/`y` coordinates are strictly typed, and axis labels are internationalized.
- **No Float Rule:** All numerical values are stored as strings and parsed into `decimal.js` to prevent precision loss.
- **Data as Code:** Datasets are versioned in Git, ensuring audit trails, peer review, and rollbacks.
- **Decoupling:** Data analysts edit YAML files; Developers maintain TypeScript logic.
- **Precision:** Monetary and statistical values adhere strictly to the "No Float" rule using `decimal.js`.
- **Performance:** Data is lazy-loaded and cached in memory, preventing startup bottlenecks.

---

## 2. Directory & Naming Convention

### 2.1 File Location

All datasets reside in the project root to separate data assets from source code.

```text
/datasets
└── yaml/
    ├── economics/
    │   └── ro.economics.fdi.annual.yaml
    ├── demographics/
    │   └── ro.demographics.population.annual.yaml
    └── ro.economics.fdi.monthly.yaml
```

Subfolders under `datasets/yaml` are allowed for organization; the dataset **ID always matches the filename without the `.yaml` extension**, regardless of the folder hierarchy.

### 2.2 Filename Convention

We use a **4-Part Dot Notation** to ensure files are predictable, sortable, and explicitly describe their contents.

**Format:** `{iso_country}.{category}.{metric}.{frequency}.yaml`

| Segment       | Rule                          | Example                          |
| :------------ | :---------------------------- | :------------------------------- |
| **Country**   | 2-letter ISO code (lowercase) | `ro`, `eu`                       |
| **Category**  | Domain grouping               | `economics`, `demographics`      |
| **Metric**    | Specific indicator slug       | `fdi`, `gdp`, `cpi`              |
| **Frequency** | Time granularity              | `annual`, `monthly`, `quarterly` |

**Constraint:** The `frequency` in the filename **must** match the `axes.x.granularity` defined inside the file.

---

## 3. YAML File Structure

The file structure is designed for direct consumption by frontend charting libraries after parsing. Data points are simplified to `x` (label/date) and `y` (value).

### Example: `ro.economics.fdi.annual.yaml`

```yaml
metadata:
  id: 'ro.economics.fdi.annual'
  source: 'National Bank of Romania (BNR)'
  sourceUrl: 'https://bnr.ro/...'
  lastUpdated: '2024-12-31'
  units: 'million_eur'

# Internationalization Block (includes Axis Labels)
i18n:
  ro:
    title: 'Investiții străine directe'
    description: 'Fluxul de capital străin...'
    xAxisLabel: 'An'
    yAxisLabel: 'Milioane Euro'
  en:
    title: 'Foreign Direct Investment'
    description: 'Foreign capital flows...'
    xAxisLabel: 'Year'
    yAxisLabel: 'Million EUR'

# Technical Axis Configuration
axes:
  x:
    label: 'An'
    type: 'date' # enum: date, category, number
    granularity: 'annual' # enum: annual, monthly, quarterly
    format: 'YYYY' # Formatting hint for frontend
  y:
    label: 'Milioane Euro'
    type: 'number'
    unit: 'million_eur' # Standardized unit code

# Raw Data (x = label/date, y = value)
data:
  - { x: '2020', y: '3010' }
  - { x: '2021', y: '7400' }
  - { x: '2022', y: '10587' }
  - { x: '2023', y: '6748' }
```

---

## 4. Module Architecture (`src/modules/datasets`)

The module adheres to the **Functional Core / Imperative Shell** pattern.

```text
src/modules/datasets/
├── core/
│   ├── types.ts          # TypeBox Schemas & Domain Interfaces
│   ├── logic.ts          # Pure Validation & Parsing Logic
│   └── errors.ts         # Domain Errors
├── shell/
│   ├── repo/
│   │   ├── fs-repo.ts    # File System Access
│   │   └── cache.ts      # LRU Cache
│   └── rest/
│       └── handlers.ts   # Fastify Handlers
└── index.ts
```

### 4.1 Functional Core: Types (`core/types.ts`)

We use **TypeBox** to enforce the schema.

```typescript
import { Type, Static } from '@sinclair/typebox';
import { Decimal } from 'decimal.js';

// 1. Localization Schema (includes Axis Labels)
const I18nContentSchema = Type.Object({
  title: Type.String(),
  description: Type.Optional(Type.String()),
  xAxisLabel: Type.String({ description: 'Translated label for X Axis' }),
  yAxisLabel: Type.String({ description: 'Translated label for Y Axis' }),
});

// 2. Main File Schema
export const DatasetFileSchema = Type.Object({
  metadata: Type.Object({
    id: Type.String(),
    source: Type.String(),
    sourceUrl: Type.Optional(Type.String({ format: 'uri' })),
    lastUpdated: Type.String({ format: 'date' }),
    units: Type.String(),
    granularity: Type.Optional(
      Type.Union([Type.Literal('annual'), Type.Literal('monthly'), Type.Literal('quarterly')])
    ),
  }),

  i18n: Type.Object({
    ro: I18nContentSchema,
    en: Type.Optional(I18nContentSchema),
  }),

  axes: Type.Object({
    x: Type.Object({
      label: Type.String(),
      type: Type.Union([Type.Literal('date'), Type.Literal('category'), Type.Literal('number')]),
      granularity: Type.Union([
        Type.Literal('annual'),
        Type.Literal('monthly'),
        Type.Literal('quarterly'),
      ]),
      format: Type.Optional(Type.String({ description: 'Display format hint, e.g. YYYY' })),
    }),
    y: Type.Object({
      label: Type.String(),
      type: Type.Literal('number'),
      unit: Type.String(),
    }),
  }),

  data: Type.Array(
    Type.Object({
      x: Type.String({ description: 'Date string or Category Label' }),
      y: Type.String({ description: 'Decimal value as string (No Float Rule)' }),
    })
  ),
});

export type DatasetFileDTO = Static<typeof DatasetFileSchema>;

// 3. Domain Entity (Application Use)
export interface DataPoint {
  x: string;
  y: Decimal;
}

export interface Dataset {
  id: string;
  metadata: DatasetFileDTO['metadata'];
  i18n: DatasetFileDTO['i18n'];
  axes: DatasetFileDTO['axes'];
  points: DataPoint[];
}
```

### 4.2 Functional Core: Logic (`core/logic.ts`)

Pure functions to validate business rules (Date formats) and data integrity (Decimal parsing).

```typescript
import { ok, err, Result } from 'neverthrow';
import { Decimal } from 'decimal.js';
import { DatasetFileDTO, Dataset } from './types';
import { DatasetValidationError } from './errors';

export function parseDataset(dto: DatasetFileDTO): Result<Dataset, DatasetValidationError> {
  // 1. Validate X-Axis Format Consistency based on Granularity
  const granularity = dto.axes.x.granularity;

  const isYear = (s: string) => /^\d{4}$/.test(s);
  const isMonth = (s: string) => /^\d{4}-\d{2}$/.test(s);
  const isQuarter = (s: string) => /^\d{4}-Q[1-4]$/.test(s);

  const points = [];

  for (const p of dto.data) {
    // A. Validate Date Format
    if (granularity === 'annual' && !isYear(p.x)) {
      return err({ type: 'InvalidFormat', message: `Expected YYYY for annual data, got ${p.x}` });
    }
    if (granularity === 'monthly' && !isMonth(p.x)) {
      return err({
        type: 'InvalidFormat',
        message: `Expected YYYY-MM for monthly data, got ${p.x}`,
      });
    }

    // B. Validate Value (No Float)
    try {
      const val = new Decimal(p.y);
      if (!val.isFinite()) throw new Error();
      points.push({ x: p.x, y: val });
    } catch {
      return err({ type: 'InvalidDecimal', message: `Value '${p.y}' is not a valid number` });
    }
  }

  return ok({
    id: dto.metadata.id,
    metadata: dto.metadata,
    i18n: dto.i18n,
    axes: dto.axes,
    points,
  });
}
```

---

## 5. Imperative Shell

### 5.1 Repository (`shell/repo/fs-repo.ts`)

Implements **Read-Through Caching** to minimize I/O.

- **Cache Strategy:** LRU Cache (Max 50 items, TTL 1 hour).
- **Dataset Discovery:** `listAvailable` walks `datasets/yaml` recursively and returns `{ id, relativePath, absolutePath }` so datasets can live in nested folders.
- **Repo Logic:**
  1. Build index of dataset files (fails fast on duplicate filenames/IDs).
  2. Check Cache -> Return if Hit.
  3. Resolve file path from index (supports nested folders).
  4. Read File.
  5. Parse YAML -> JSON.
  6. Validate Schema (TypeBox).
  7. Run Logic (`parseDataset`).
  8. Set Cache.
  9. Return Result.

### 5.2 API Layer (`shell/rest/handlers.ts`)

**Endpoint:** `GET /api/datasets/:id`

**Response (JSON):**
The API serializes the `Decimal` values back to strings for transport to ensure the client receives exact values.

```json
{
  "metadata": { "units": "million_eur", ... },
  "i18n": {
    "ro": {
      "title": "Investiții străine directe",
      "xAxisLabel": "An",
      "yAxisLabel": "Milioane Euro"
    },
    "en": { "xAxisLabel": "Year", ... }
  },
  "axes": { "x": { "granularity": "annual", ... }, ... },
  "data": [
    { "x": "2020", "y": "3010" },
    { "x": "2021", "y": "7400" }
  ]
}
```

---

## 6. Validation Pipeline (CI/CD)

A script `scripts/validate-datasets.ts` runs on pre-commit and CI.

1. **Discovery:** Recursively walks `datasets/yaml` (including subfolders).
2. **Filename Check:** Ensures `*.yaml` matches `{iso}.{cat}.{metric}.{freq}.yaml`.
3. **ID Check:** Ensures filename matches `metadata.id`.
4. **Uniqueness Check:** Fails if any `metadata.id` is repeated across files.
5. **Schema Check:** Validates structure via TypeBox.
6. **Logic Check:** Runs `parseDataset` to catch bad dates or invalid numbers.

---

## 7. Workflow Summary

1. **Analyst** adds a new year to `ro.economics.fdi.annual.yaml`.
2. **Analyst** runs `npm run validate-datasets` locally.
3. **Analyst** pushes to Git.
4. **CI** verifies data integrity.
5. **Deployment** updates the server.
6. **Frontend** requests `ro.economics.fdi.annual` and renders the chart using `i18n.ro.xAxisLabel` ("An") and data `{ x: "2024", y: "..." }`.
