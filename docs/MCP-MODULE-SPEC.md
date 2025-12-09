# MCP Module Specification

## Model Context Protocol Integration for Transparenta.eu

**Version**: 1.0  
**Status**: Implemented  
**Last Updated**: 2024-12-10

---

## 1. Problem Statement

### 1.1 What is MCP?

The **Model Context Protocol (MCP)** is an open standard that enables AI applications (like Claude, ChatGPT, or Cursor) to connect to external data sources and tools. It provides a standardized way for LLMs to:

1. **Call Tools** - Execute actions and retrieve data
2. **Read Resources** - Access static documentation and guides
3. **Use Prompts** - Follow structured analysis workflows

### 1.2 Why MCP for Transparenta.eu?

Romanian public budget data is complex:

- **8,000+ entities** (municipalities, counties, ministries, schools, hospitals)
- **Hierarchical classifications** (functional COFOG, economic)
- **Multi-dimensional filtering** (time, geography, classification, entity type)
- **Romanian terminology** (UAT, CUI, cheltuieli/venituri)

**Problem**: Without AI assistance, citizens and journalists struggle to:

- Find the right entities (which CUI is "Municipiul Cluj-Napoca"?)
- Understand classification codes (what does "65.10.03" mean?)
- Compare entities fairly (absolute vs. per-capita values)
- Detect anomalies (is 500M RON for education normal?)

**Solution**: MCP provides a standardized AI interface that:

- Guides users through discovery workflows
- Resolves Romanian names to machine-usable IDs
- Generates shareable visualizations
- Provides contextual documentation

### 1.3 Target Users

| User Type         | Use Case                               |
| ----------------- | -------------------------------------- |
| **AI Assistants** | Claude Desktop, Cursor, custom AI apps |
| **Journalists**   | Investigate public spending patterns   |
| **Citizens**      | Understand local government finances   |
| **Researchers**   | Academic analysis of fiscal data       |
| **Developers**    | Build AI-powered budget applications   |

---

## 2. Business Requirements

### 2.1 Core Capabilities

The MCP module must provide:

1. **Entity Discovery** - Find public entities by name, get financial snapshots
2. **Filter Resolution** - Convert Romanian terms to machine IDs (CUI, UAT ID, classification codes)
3. **Time-Series Analysis** - Multi-entity, multi-year budget comparisons
4. **Hierarchical Exploration** - Drill down into budget categories
5. **Entity Ranking** - Compare entities by budget metrics
6. **Contextual Documentation** - Classification guides, glossary, legislation

### 2.2 Tool Inventory

| Tool                       | Purpose                          | Primary Use Case                       |
| -------------------------- | -------------------------------- | -------------------------------------- |
| `get_entity_snapshot`      | Point-in-time financial overview | "Show me București's 2023 budget"      |
| `discover_filters`         | Resolve names to IDs             | "Find CUI for Municipiul Cluj-Napoca"  |
| `query_timeseries_data`    | Multi-series trend analysis      | "Compare education spending 2020-2024" |
| `analyze_entity_budget`    | Single entity breakdown          | "Show Cluj's spending by category"     |
| `explore_budget_breakdown` | Hierarchical drill-down          | "What's inside education spending?"    |
| `rank_entities`            | Comparative entity list          | "Top 10 per-capita spenders on health" |

### 2.3 Resource Inventory

| Resource                        | URI                                               | Purpose                            |
| ------------------------------- | ------------------------------------------------- | ---------------------------------- |
| Functional Classification Guide | `transparenta://guides/functional-classification` | COFOG budget categories (Romanian) |
| Economic Classification Guide   | `transparenta://guides/economic-classification`   | Spending types (Romanian)          |
| Financial Terms Glossary        | `transparenta://glossary/financial-terms`         | Accessible terminology             |
| Budget Legislation Index        | `transparenta://index/budget-legislation`         | Legal framework references         |

### 2.4 Prompt Inventory

| Prompt                    | Purpose                               | Key Arguments                               |
| ------------------------- | ------------------------------------- | ------------------------------------------- |
| `entity-health-check`     | Comprehensive financial analysis      | `cui`, `year`                               |
| `peer-comparison`         | Benchmarking against similar entities | `cui`, `year`, `peerCuis[]`                 |
| `outlier-detection`       | Detect atypical spending patterns     | `classificationCode`, `year`, `uatId?`      |
| `trend-tracking`          | Multi-year budget evolution           | `cui`, `startYear`, `endYear`, `focusArea?` |
| `deep-dive-investigation` | Detailed category investigation       | `cui`, `year`, `classificationCode?`        |

---

## 3. Key Design Decisions

### 3.1 Reuse Existing Modules

**Decision**: MCP tools delegate to existing use cases; no direct database access.

**Rationale**:

- Business logic already tested and validated
- Consistent behavior across GraphQL and MCP
- Single source of truth for budget calculations

**Module Mapping**:

| MCP Tool                   | Existing Module(s)                | Use Case(s)                                       |
| -------------------------- | --------------------------------- | ------------------------------------------------- |
| `get_entity_snapshot`      | `entity`, `execution-line-items`  | `getEntity`, `getYearlySnapshot`                  |
| `discover_filters`         | `entity`, `uat`, `classification` | `listEntities`, `listUATs`, `listClassifications` |
| `query_timeseries_data`    | `execution-analytics`             | `getAggregatedSeries`                             |
| `analyze_entity_budget`    | `aggregated-line-items`           | `getAggregatedLineItems`                          |
| `explore_budget_breakdown` | `aggregated-line-items`           | `getAggregatedLineItems` + grouping               |
| `rank_entities`            | `entity-analytics`                | `getEntityAnalytics`                              |

### 3.2 Shareable Links via Share Module

**Decision**: All tool outputs include a short, shareable URL.

**Rationale**:

- Users can verify AI-generated insights in the web interface
- Enables collaboration and bookmarking
- Links preserve all query parameters

**Implementation**: Use existing `share` module's `makeShareLink` use case.

### 3.3 Schema Validation with Zod

**Decision**: Use Zod for MCP tool/prompt schemas, TypeBox for output schemas.

**Rationale**:

- MCP SDK 1.24.3+ requires Zod schemas for `registerTool()` and `registerPrompt()`
- TypeBox used for output validation (consistent with project conventions)
- Minimal Zod usage (only for MCP registration, not business logic)

**Implementation**:

```typescript
// core/schemas/zod-schemas.ts
import { z } from 'zod';

export const GetEntitySnapshotInputZod = z.object({
  cui: z.string().describe('Entity CUI (fiscal code)'),
  period: PeriodInputZod,
});

// core/schemas/typebox-schemas.ts (output validation)
export const GetEntitySnapshotOutputSchema = Type.Object({
  ok: Type.Boolean(),
  entity: Type.Object({
    /* ... */
  }),
  shareableLink: Type.String(),
});
```

**Benefits**:

- Compatible with MCP SDK requirements
- TypeBox still used for output validation and type inference
- Clear separation: Zod for MCP registration, TypeBox for business logic

### 3.4 Stateless Server with StdioServerTransport

**Decision**: Use MCP SDK's `StdioServerTransport` for stateless, process-based communication.

**Rationale**:

- MCP clients (Claude Desktop, Cursor) spawn server as subprocess
- No HTTP transport or session management needed
- Simpler architecture: one server process per client
- No Redis dependency for MCP module

**Implementation**:

```typescript
// shell/server/mcp-server.ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

export async function runMcpServerStdio(deps: CreateMcpServerDeps): Promise<void> {
  const server = createMcpServer(deps);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
```

**Client Configuration** (Claude Desktop):

```json
{
  "mcpServers": {
    "transparenta": {
      "command": "node",
      "args": ["/path/to/dist/mcp-server.js"],
      "env": {
        "DATABASE_URL": "postgresql://...",
        "CLIENT_BASE_URL": "https://transparenta.eu"
      }
    }
  }
}
```

**Benefits**:

- No session management complexity
- No HTTP endpoints needed
- Process isolation per client
- Standard MCP pattern

### 3.5 Stateless Tool Execution

**Decision**: Each tool invocation is stateless; all context passed in arguments.

**Rationale**:

- Simpler testing and debugging
- No hidden state between tool calls
- Matches existing use case patterns

**Implication**: Tools may need to re-fetch entity details if not cached.

### 3.6 Normalization at SQL Level

**Decision**: Leverage existing SQL-level normalization from `normalization` module.

**Rationale**:

- Per-capita and currency conversion already implemented
- CPI adjustment for inflation available
- Consistent with GraphQL behavior

**Normalization Options**:
| Mode | Description | Unit |
|------|-------------|------|
| `total` | Raw RON values | RON |
| `per_capita` | Divided by population | RON/capita |
| `total_euro` | Converted to EUR | EUR |
| `per_capita_euro` | Per capita in EUR | EUR/capita |

### 3.7 Classification Code Normalization

**Decision**: Normalize codes by removing trailing `.00` segments before database queries.

**Rationale**:

- User input may include trailing zeros (e.g., "65.00")
- Database stores codes without trailing zeros (e.g., "65")
- Prevents query mismatches

**Implementation**: Pure function `normalizeClassificationCode()` in core.

### 3.8 No Authentication (Stdio Transport)

**Decision**: No authentication for MCP server (stdio transport).

**Rationale**:

- Stdio transport runs as subprocess of trusted client (Claude Desktop, Cursor)
- Client controls server lifecycle and access
- No network exposure (no HTTP endpoints)
- Authentication handled at client level (user must have access to client app)

**Security Model**:

- Server process inherits client's security context
- Database credentials in environment variables (client-controlled)
- No public network access
- Process isolation per user

### 3.9 No Rate Limiting (Process-Based)

**Decision**: No rate limiting for MCP server.

**Rationale**:

- One server process per client (process isolation)
- Client controls request rate
- No shared resources to protect
- Database connection pooling handles load

**Resource Protection**:

- Database query timeouts (existing)
- Connection pool limits (existing)
- Process memory limits (OS-level)

### 3.10 Result Caching Strategy

**Decision**: Cache expensive queries (timeseries, rankings) with short TTL, reusing existing cache infrastructure.

**Rationale**:

- Timeseries and ranking queries are expensive
- Same underlying data accessed by GraphQL
- Reuse repo-layer caching already in place

**Implementation Strategy**:

- No new caching layer in MCP module
- Rely on existing cache wrappers at repository level
- MCP tools benefit from same caching as GraphQL

**Cached Operations** (via existing repo caching):
| Operation | Cache Location | TTL |
|-----------|---------------|-----|
| `query_timeseries_data` | `execution-analytics` repo | 5 min |
| `rank_entities` | `entity-analytics` repo | 5 min |
| `explore_budget_breakdown` | `aggregated-line-items` repo | 5 min |
| `discover_filters` | `entity`, `uat`, `classification` repos | 15 min |

### 3.11 Romanian-Only Content

**Decision**: All content in Romanian (resources, prompts, tool descriptions).

**Rationale**:

- Data is in Romanian (entity names, classifications)
- Target users are Romanian citizens, journalists, researchers
- AI assistants can translate if needed
- Simpler implementation (no i18n complexity)

**Implementation**:

- Resources: Romanian markdown content
- Prompts: Romanian instructions
- Tool descriptions: Romanian with English technical terms
- Number format: International (1,234,567.89 RON) for AI compatibility

### 3.12 Error Handling Strategy

**Decision**: Minimal error responses (error code + short message).

**Rationale**:

- AI assistants can handle terse errors
- Reduces response payload size
- Avoids leaking internal details

**Error Response Format**:

```typescript
{
  ok: false,
  error: {
    code: string;      // e.g., "ENTITY_NOT_FOUND", "INVALID_PERIOD"
    message: string;   // Short human-readable message
  }
}
```

**Error Code Mapping**:
| Domain Error | MCP Error Code | Message Example |
|--------------|----------------|-----------------|
| Entity not found | `ENTITY_NOT_FOUND` | "Entity with CUI 'X' not found" |
| Invalid period format | `INVALID_PERIOD` | "Period format must be YYYY for type YEAR" |
| Invalid filter | `INVALID_FILTER` | "accountCategory is required" |
| Database error | `DATABASE_ERROR` | "Query failed" |
| Rate limit exceeded | `RATE_LIMIT_EXCEEDED` | "Too many requests" |
| Unauthorized | `UNAUTHORIZED` | "Authentication required" |

**Implementation**:

```typescript
// core/errors.ts
export interface McpError {
  readonly code: string;
  readonly message: string;
}

export const createMcpError = (code: string, message: string): McpError => ({
  code,
  message,
});

// Map domain errors to MCP errors
export const toMcpError = (error: EntityError | AnalyticsError): McpError => {
  switch (error.type) {
    case 'EntityNotFoundError':
      return createMcpError('ENTITY_NOT_FOUND', error.message);
    case 'DatabaseError':
      return createMcpError('DATABASE_ERROR', 'Query failed');
    // ... etc
  }
};
```

### 3.13 Bilingual Number Formatting

**Decision**: Present monetary values in both compact and full international format.

**Rationale**:

- Compact format (5.23M RON) for readability
- Full format (5,234,567.89 RON) for precision
- International format (comma thousands, dot decimal) for consistency

**Example Output**:

```
Total expenses: 5.23M RON (5,234,567.89 RON)
```

---

## 4. Architecture

### 4.1 Module Structure

```
src/modules/mcp/
├── core/
│   ├── types.ts              # MCP-specific domain types
│   ├── errors.ts             # MCP error definitions
│   ├── ports.ts              # Interfaces for dependencies
│   ├── schemas/
│   │   ├── zod-schemas.ts    # Zod schemas (MCP registration)
│   │   ├── typebox-schemas.ts # TypeBox schemas (output validation)
│   │   └── index.ts
│   ├── utils/
│   │   └── classification-utils.ts # Code normalization utilities
│   └── usecases/
│       ├── get-entity-snapshot.ts
│       ├── discover-filters.ts
│       ├── query-timeseries.ts
│       ├── analyze-entity-budget.ts
│       ├── explore-budget-breakdown.ts
│       └── rank-entities.ts
│
├── shell/
│   ├── server/
│   │   ├── mcp-server.ts     # MCP server factory
│   │   └── tool-descriptions.ts # Comprehensive tool docs
│   ├── resources/            # Static markdown content
│   │   ├── functional-classification-guide.ts
│   │   ├── economic-classification-guide.ts
│   │   ├── financial-terms-glossary.ts
│   │   └── budget-legislation-index.ts
│   ├── prompts/              # Prompt templates
│   │   └── prompt-templates.ts # All 5 prompts
│   ├── adapters/             # Repository adapters
│   │   └── index.ts
│   ├── repo/
│   │   └── mcp-execution-repo.ts
│   └── service/
│       └── mcp-analytics-service.ts
│
└── index.ts                  # Public API
```

### 4.2 Dependency Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│                    MCP Client (Claude Desktop)                      │
│    Spawns server process via stdio                                  │
└───────────────────────────┬─────────────────────────────────────────┘
                            │ stdin/stdout
                            ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    MCP Server (Shell)                               │
│    StdioServerTransport + Tool/Resource/Prompt Registration         │
└───────────────────────────┬─────────────────────────────────────────┘
                            │ Calls
                            ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    MCP Use Cases (Core)                             │
│    Pure functions with injected dependencies                        │
└───────────────────────────┬─────────────────────────────────────────┘
                            │ Delegates to
                            ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    Existing Modules                                 │
│  entity │ uat │ classification │ entity-analytics │ share │ ...    │
└─────────────────────────────────────────────────────────────────────┘
```

### 4.3 Core Dependencies (Ports)

```typescript
// core/ports.ts

import type { Result } from 'neverthrow';
import type { EntityRepository } from '@/modules/entity/index.js';
import type { UATRepository } from '@/modules/uat/index.js';
import type {
  FunctionalClassificationRepository,
  EconomicClassificationRepository,
} from '@/modules/classification/index.js';
import type { EntityAnalyticsRepository } from '@/modules/entity-analytics/index.js';
import type { AnalyticsRepository } from '@/modules/execution-analytics/index.js';
import type { AggregatedLineItemsRepository } from '@/modules/aggregated-line-items/index.js';
import type { ShortLinkRepository } from '@/modules/share/index.js';

/**
 * Dependencies for MCP tool execution.
 * All repositories come from existing modules.
 */
export interface McpToolDeps {
  entityRepo: EntityRepository;
  uatRepo: UATRepository;
  functionalClassificationRepo: FunctionalClassificationRepository;
  economicClassificationRepo: EconomicClassificationRepository;
  entityAnalyticsRepo: EntityAnalyticsRepository;
  analyticsRepo: AnalyticsRepository;
  aggregatedLineItemsRepo: AggregatedLineItemsRepository;
  shortLinkRepo: ShortLinkRepository;
}
```

---

## 5. Tool Specifications

### 5.1 `get_entity_snapshot`

**Purpose**: Point-in-time financial overview for a single entity.

**Input Schema**:

```typescript
{
  entityCui?: string;      // Exact CUI (preferred)
  entitySearch?: string;   // Fuzzy search (fallback)
  year: number;            // Required: 2016-current
}
```

**Output Schema**:

```typescript
{
  ok: boolean;
  kind: 'entities.details';
  query: {
    cui: string;
    year: number;
  }
  link: string; // Short shareable URL
  item: {
    cui: string;
    name: string;
    address: string | null;
    totalIncome: number;
    totalExpenses: number;
    totalIncomeFormatted: string; // "5.23M RON (5,234,567.89 RON)"
    totalExpensesFormatted: string;
    summary: string; // AI-friendly summary
  }
}
```

**Business Logic**:

1. Resolve entity by CUI or fuzzy search
2. Fetch yearly execution totals
3. Format amounts bilingually (RO/EN labels)
4. Generate shareable link via `share` module
5. Return structured snapshot

### 5.2 `discover_filters`

**Purpose**: Resolve Romanian names/terms to machine-usable filter values.

**Input Schema**:

```typescript
{
  category: 'entity' | 'uat' | 'functional_classification' | 'economic_classification';
  query: string;           // Romanian search term
  limit?: number;          // 1-50, default 3
}
```

**Output Schema**:

```typescript
{
  ok: boolean;
  results: Array<{
    name: string;
    category: string;
    context?: string;      // Additional info (county, chapter)
    score: number;         // 0-1 relevance
    filterKey: string;     // Which parameter to use (e.g., 'entity_cuis')
    filterValue: string;   // Value to pass
    metadata?: object;     // Category-specific details
  }>;
  bestMatch?: object;      // Top result if score >= 0.85
}
```

**Business Logic**:

1. Route to appropriate repository based on category
2. Apply fuzzy search with Romanian diacritics
3. Enrich results with context (chapter names, county codes)
4. Compute relevance scores with name-match boosts
5. Identify best match for high-confidence queries

**Filter Key Mapping**:
| Category | Filter Key(s) |
|----------|---------------|
| entity | `entity_cuis` |
| uat | `uat_ids` |
| functional_classification | `functional_prefixes` or `functional_codes` |
| economic_classification | `economic_prefixes` or `economic_codes` |

### 5.3 `query_timeseries_data`

**Purpose**: Multi-series time-series analysis for comparisons.

**Input Schema**:

```typescript
{
  title?: string;
  description?: string;
  period: {
    type: 'YEAR' | 'MONTH' | 'QUARTER';
    selection: { interval: { start: string; end: string } } | { dates: string[] };
  };
  series: Array<{          // 1-10 series
    label?: string;
    filter: AnalyticsFilter;
  }>;
}
```

**Output Schema**:

```typescript
{
  ok: boolean;
  title: string;
  dataLink: string; // Short URL to interactive chart
  dataSeries: Array<{
    label: string;
    seriesId: string;
    xAxis: { name: string; unit: 'year' | 'month' | 'quarter' };
    yAxis: { name: string; unit: 'RON' | 'RON/capita' | 'EUR' | 'EUR/capita' };
    dataPoints: Array<{ x: string; y: number }>;
    statistics: { min: number; max: number; avg: number; sum: number; count: number };
  }>;
}
```

**Business Logic**:

1. Validate period format matches type
2. Normalize classification codes
3. For each series:
   - Synthesize label from filter if not provided
   - Fetch time-series data via `analyticsRepo`
   - Compute statistics
4. Build chart schema for shareable link
5. Generate short URL via `share` module

### 5.4 `analyze_entity_budget`

**Purpose**: Single entity budget breakdown with drill-down.

**Input Schema**:

```typescript
{
  entityCui?: string;
  entitySearch?: string;
  year: number;
  breakdown_by?: 'overview' | 'functional' | 'economic';
  functionalCode?: string;   // Required when breakdown_by='functional'
  economicCode?: string;     // Required when breakdown_by='economic'
}
```

**Output Schema**:

```typescript
{
  ok: boolean;
  kind: string;
  query: { cui: string; year: number };
  link: string;
  item: {
    cui: string;
    name: string;
    expenseGroups: Array<GroupedItem>;
    incomeGroups: Array<GroupedItem>;
    expenseGroupSummary?: string;
    incomeGroupSummary?: string;
  };
}
```

**Business Logic**:

1. Resolve entity
2. Map `breakdown_by` to internal level ('group' | 'functional' | 'economic')
3. Fetch aggregated line items
4. Group by classification dimension
5. Generate summaries with formatted totals
6. Create drill-down shareable links

### 5.5 `explore_budget_breakdown`

**Purpose**: Hierarchical budget exploration with progressive drill-down.

**Input Schema**:

```typescript
{
  period: PeriodInput;
  filter: AnalyticsFilter;
  classification?: 'fn' | 'ec';     // Default: 'fn'
  path?: string[];                  // Drill-down path
  rootDepth?: 'chapter' | 'subchapter' | 'paragraph';
  excludeEcCodes?: string[];
  limit?: number;
  offset?: number;
}
```

**Output Schema**:

```typescript
{
  ok: boolean;
  link: string;
  item: {
    expenseGroups?: Array<{
      code: string;
      name: string;
      value: number;
      count: number;
      isLeaf: boolean;
      percentage: number;
      humanSummary?: string;
      link?: string;          // Drill-down link
    }>;
    incomeGroups?: Array<GroupedItem>;
    expenseGroupSummary?: string;
    incomeGroupSummary?: string;
  };
}
```

**Business Logic**:

1. Apply path-based filtering to narrow scope
2. Apply economic exclusions at database level
3. Fetch aggregated data
4. Group by classification at current depth
5. Generate per-group drill-down links
6. Determine leaf status (depth >= 6 = leaf)

### 5.6 `rank_entities`

**Purpose**: Tabular entity ranking by budget metrics.

**Input Schema**:

```typescript
{
  period: PeriodInput;
  filter: AnalyticsFilter;
  sort?: { by: string; order: 'ASC' | 'DESC' };
  limit?: number;          // Default 50, max 500
  offset?: number;
}
```

**Output Schema**:

```typescript
{
  ok: boolean;
  link: string;
  entities: Array<{
    entity_cui: string;
    entity_name: string;
    entity_type: string | null;
    uat_id: number | null;
    county_code: string | null;
    county_name: string | null;
    population: number | null;
    amount: number; // Normalized amount
    total_amount: number; // Raw RON
    per_capita_amount: number; // RON/capita
  }>;
  pageInfo: {
    totalCount: number;
    hasNextPage: boolean;
    hasPreviousPage: boolean;
  }
}
```

**Business Logic**:

1. Normalize classification codes
2. Delegate to `entityAnalyticsRepo`
3. Apply sorting (amount, per_capita, entity_name, etc.)
4. Paginate results
5. Generate shareable table link

---

## 6. Stdio Transport

### 6.1 Communication

- **Protocol**: JSON-RPC 2.0 over stdin/stdout
- **Transport**: `StdioServerTransport` from MCP SDK
- **Process Model**: One server process per client

### 6.2 Client Configuration

**Claude Desktop** (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "transparenta": {
      "command": "node",
      "args": ["/path/to/transparenta-eu-server/dist/mcp-server.js"],
      "env": {
        "DATABASE_URL": "postgresql://user:pass@host:5432/transparenta",
        "CLIENT_BASE_URL": "https://transparenta.eu"
      }
    }
  }
}
```

### 6.3 Error Responses

```typescript
// Tool execution error
{
  ok: false,
  error: {
    code: "ENTITY_NOT_FOUND",
    message: "Entity with CUI '12345678' not found"
  }
}
```

---

## 7. Configuration

### 7.1 Environment Variables

| Variable          | Purpose                      | Default | Required |
| ----------------- | ---------------------------- | ------- | -------- |
| `DATABASE_URL`    | PostgreSQL connection string | -       | Yes      |
| `CLIENT_BASE_URL` | Base URL for shareable links | -       | Yes      |
| `NODE_ENV`        | Environment (dev/prod)       | `dev`   | No       |
| `LOG_LEVEL`       | Logging level                | `info`  | No       |

### 7.2 Server Configuration

```typescript
const server = new McpServer(
  {
    name: 'Transparenta.eu – AI Basic MCP',
    version: '1.0.0',
  },
  {
    instructions: `Romanian Public Budget Transparency Platform...`,
    capabilities: { tools: {} },
  }
);
```

---

## 8. Testing Strategy

### 8.1 Unit Tests (Core)

**Scope**: Tool use cases, formatting functions, schema validation.

**Approach**: In-memory fakes for all repositories.

**Examples**:

- `discover-filters.test.ts` - Filter resolution logic
- `format-amount.test.ts` - Bilingual formatting
- `normalize-classification-code.test.ts` - Code normalization

### 8.2 Integration Tests (Shell)

**Scope**: MCP server registration, HTTP transport.

**Approach**: Fastify.inject with fake dependencies.

**Examples**:

- `mcp-routes.test.ts` - Session lifecycle
- `mcp-tools.test.ts` - Tool invocation via HTTP

### 8.3 Golden Master Tests

**Scope**: Tool output stability.

**Approach**: Snapshot testing for tool responses.

---

## 9. Implementation Status

### ✅ Phase 1: Core Infrastructure (Complete)

- ✅ Module structure created
- ✅ Zod schemas for tool/prompt inputs
- ✅ TypeBox schemas for output validation
- ✅ Ports interface defined
- ✅ MCP server factory with stdio transport
- ✅ Classification normalization utilities

### ✅ Phase 2: Tool Use Cases (Complete)

- ✅ `get_entity_snapshot`
- ✅ `discover_filters`
- ✅ `query_timeseries_data`
- ✅ `analyze_entity_budget`
- ✅ `explore_budget_breakdown`
- ✅ `rank_entities`

### ✅ Phase 3: Resources (Complete)

- ✅ Functional classification guide (Romanian)
- ✅ Economic classification guide (Romanian)
- ✅ Financial terms glossary (Romanian)
- ✅ Budget legislation index (Romanian)

### ✅ Phase 4: Prompts (Complete)

- ✅ Entity health check prompt
- ✅ Peer comparison prompt
- ✅ Outlier detection prompt
- ✅ Trend tracking prompt
- ✅ Deep-dive investigation prompt

### ✅ Phase 5: Testing & Documentation (Complete)

- ✅ Unit tests (20 tests for classification utils)
- ✅ Integration tests (all passing)
- ✅ Tool descriptions (comprehensive)
- ✅ MCP-PROMPTS.md documentation
- ✅ Module specification updated

---

## 10. Final Decisions

| Decision             | Resolution                                       |
| -------------------- | ------------------------------------------------ |
| Schema library       | Zod for MCP registration, TypeBox for validation |
| Transport            | StdioServerTransport (process-based)             |
| Session storage      | None (stateless, one process per client)         |
| Authentication       | None (client controls server process)            |
| Implementation scope | Full (6 tools + 4 resources + 5 prompts)         |
| Rate limiting        | None (process isolation)                         |
| Result caching       | Reuse repo-layer caching (no new MCP cache)      |
| Localization         | Romanian only (AI can translate if needed)       |
| Number format        | International (1,234,567.89 RON)                 |
| Error verbosity      | Minimal (error code + short message)             |
| Classification codes | Normalized (trailing `.00` removed)              |

---

## 12. References

- [MCP Protocol Specification](https://modelcontextprotocol.io/)
- [MCP SDK Documentation](https://github.com/modelcontextprotocol/sdk)
- [Transparenta.eu Architecture](./ARCHITECTURE.md)
- [Functional Core / Imperative Shell](./CORE-SHELL-ARCHITECTURE.md)
- [Module Dependencies](./MODULE-DEPENDENCIES.md)
- [Auth Module Specification](./AUTH-MODULE-SPEC.md)
- [Share Module (Short Links)](../src/modules/share/)
