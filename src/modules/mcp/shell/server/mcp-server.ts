/**
 * MCP Server Factory
 *
 * Creates and configures the MCP server with all tools, resources, and prompts.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import {
  GET_ENTITY_SNAPSHOT_DESCRIPTION,
  DISCOVER_FILTERS_DESCRIPTION,
  QUERY_TIMESERIES_DESCRIPTION,
  RANK_ENTITIES_DESCRIPTION,
  ANALYZE_ENTITY_BUDGET_DESCRIPTION,
  EXPLORE_BUDGET_BREAKDOWN_DESCRIPTION,
} from './tool-descriptions.js';
import {
  GetEntitySnapshotInputZod,
  DiscoverFiltersInputZod,
  RankEntitiesInputZod,
  QueryTimeseriesInputZod,
  AnalyzeEntityBudgetInputZod,
  ExploreBudgetBreakdownInputZod,
} from '../../core/schemas/zod-schemas.js';
import {
  analyzeEntityBudget,
  type AnalyzeEntityBudgetDeps,
} from '../../core/usecases/analyze-entity-budget.js';
import { discoverFilters, type DiscoverFiltersDeps } from '../../core/usecases/discover-filters.js';
import { exploreBudgetBreakdown } from '../../core/usecases/explore-budget-breakdown.js';
import {
  getEntitySnapshot,
  type GetEntitySnapshotDeps,
} from '../../core/usecases/get-entity-snapshot.js';
import { queryTimeseries, type QueryTimeseriesDeps } from '../../core/usecases/query-timeseries.js';
import { rankEntities, type RankEntitiesDeps } from '../../core/usecases/rank-entities.js';
import { ALL_PROMPTS } from '../prompts/prompt-templates.js';
import { getBudgetLegislationIndex } from '../resources/budget-legislation-index.js';
import { getEconomicClassificationGuide } from '../resources/economic-classification-guide.js';
import { getFinancialTermsGlossary } from '../resources/financial-terms-glossary.js';
import { getFunctionalClassificationGuide } from '../resources/functional-classification-guide.js';

import type { McpConfig } from '../../core/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Dependencies required to create the MCP server.
 */
export interface CreateMcpServerDeps {
  // Entity snapshot deps
  entityRepo: GetEntitySnapshotDeps['entityRepo'];
  executionRepo: GetEntitySnapshotDeps['executionRepo'];

  // Discover filters deps
  uatRepo: DiscoverFiltersDeps['uatRepo'];
  functionalClassificationRepo: DiscoverFiltersDeps['functionalClassificationRepo'];
  economicClassificationRepo: DiscoverFiltersDeps['economicClassificationRepo'];

  // Rank entities deps
  entityAnalyticsRepo: RankEntitiesDeps['entityAnalyticsRepo'];

  // Query timeseries deps
  analyticsService: QueryTimeseriesDeps['analyticsService'];

  // Analyze entity budget deps
  aggregatedLineItemsRepo: AnalyzeEntityBudgetDeps['aggregatedLineItemsRepo'];

  // Shared
  shareLink: {
    create(url: string): Promise<import('neverthrow').Result<string, unknown>>;
  };
  config: McpConfig;
}

// ─────────────────────────────────────────────────────────────────────────────
// Server Instructions
// ─────────────────────────────────────────────────────────────────────────────

const SERVER_INSTRUCTIONS = `
# Transparenta.eu - Romanian Public Budget Analytics

You are an AI assistant helping users explore Romanian public budget data through the Transparenta.eu platform.

**Language Requirement:** All entity names, classifications, and data are in Romanian. Always use Romanian terms when searching or querying.

## Available Tools

### Discovery & Lookup
- **discover_filters**: Find entities, UATs, or classification codes by Romanian name
- **get_entity_snapshot**: Get a financial overview for a single entity

### Analysis
- **rank_entities**: Compare entities by budget metrics with filtering and sorting
- **query_timeseries_data**: Query multi-series time-series data for trends and comparisons
- **analyze_entity_budget**: Analyze a single entity's budget with breakdown by classification
- **explore_budget_breakdown**: Explore budget hierarchically with progressive drill-down

## Key Concepts

### Entity Types
- **UAT** (Unitate Administrativ-Teritorială): Administrative units (municipalities, cities, communes)
- **CUI** (Cod Unic de Identificare): Fiscal identification code for entities

### Classifications
- **Functional (COFOG)**: What the money is spent on (education, health, transport, etc.) - in Romanian
- **Economic**: How the money is spent (salaries, goods, services, etc.) - in Romanian

### Account Categories
- **ch** (cheltuieli): Expenses
- **vn** (venituri): Income

### Period Formats
- **YEAR**: "2023" (yearly granularity)
- **MONTH**: "2023-06" (monthly granularity)
- **QUARTER**: "2023-Q2" (quarterly granularity)

### Normalization Modes
- **total**: Raw RON amounts
- **per_capita**: Amount per inhabitant (RON/capita)
- **total_euro**: Converted to EUR
- **per_capita_euro**: Amount per inhabitant in EUR

## Response Format Guidelines

- All monetary amounts use international number format (comma thousands separator, dot decimal)
  - Example: "5,234,567.89 RON" NOT "5.234.567,89 RON"
  - Compact format: "5.23M RON" and full format: "5,234,567.89 RON"
- All responses include short, shareable links (format: <domain>/share/<code>)
- Please format your analysis/response text in the user's language while keeping numbers in standard international format

## Recommended Workflow for In-Depth Analysis

1. Use discover_filters to find entity CUIs, UAT IDs, and classification codes with Romanian search terms
2. For single entity analysis: get_entity_snapshot → analyze_entity_budget with drill-down
3. For comparisons: query_timeseries_data (time-series charts) or rank_entities (tabular comparison)
4. For hierarchical exploration: explore_budget_breakdown with progressive drill-down

## Common Patterns

- Comparative analysis: discover_filters → query_timeseries_data (multiple series)
- Entity deep-dive: get_entity_snapshot → analyze_entity_budget → drill by functional/economic codes
- Regional analysis: discover_filters (UAT/county) → rank_entities or explore_budget_breakdown
- Classification analysis: discover_filters (functional/economic codes) → explore_budget_breakdown with path navigation

## Data Currency
All amounts are in Romanian Lei (RON) unless normalized to EUR or per-capita.
Data coverage: 2016-current year.
`;

// ─────────────────────────────────────────────────────────────────────────────
// Tool Response Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Builds a successful MCP tool response with structured content */
const okResponse = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value) }],
  structuredContent: value as Record<string, unknown>,
});

/** Builds an error MCP tool response with structured content */
const errResponse = (error: { code: string; message: string }) => {
  const errorObj = { ok: false, error: error.message };
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(errorObj) }],
    structuredContent: errorObj as Record<string, unknown>,
    isError: true as const,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// Server Factory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates a configured MCP server with all tools registered.
 */
export function createMcpServer(deps: CreateMcpServerDeps): McpServer {
  const server = new McpServer(
    {
      name: 'Transparenta.eu MCP Server',
      version: '1.0.0',
    },
    {
      instructions: SERVER_INSTRUCTIONS,
      capabilities: {
        tools: {},
      },
    }
  );

  // ─────────────────────────────────────────────────────────────────────────
  // Register Tools
  // ─────────────────────────────────────────────────────────────────────────

  // get_entity_snapshot
  server.registerTool(
    'get_entity_snapshot',
    {
      description: GET_ENTITY_SNAPSHOT_DESCRIPTION,
      inputSchema: GetEntitySnapshotInputZod.shape,
    },
    async (args) => {
      const result = await getEntitySnapshot(
        {
          entityRepo: deps.entityRepo,
          executionRepo: deps.executionRepo,
          shareLink: deps.shareLink,
          config: { clientBaseUrl: deps.config.clientBaseUrl },
        },
        args as Parameters<typeof getEntitySnapshot>[1]
      );
      return result.isErr() ? errResponse(result.error) : okResponse(result.value);
    }
  );

  // discover_filters
  server.registerTool(
    'discover_filters',
    {
      description: DISCOVER_FILTERS_DESCRIPTION,
      inputSchema: DiscoverFiltersInputZod.shape,
    },
    async (args) => {
      const result = await discoverFilters(
        {
          entityRepo: deps.entityRepo,
          uatRepo: deps.uatRepo,
          functionalClassificationRepo: deps.functionalClassificationRepo,
          economicClassificationRepo: deps.economicClassificationRepo,
        },
        args as Parameters<typeof discoverFilters>[1]
      );
      return result.isErr() ? errResponse(result.error) : okResponse(result.value);
    }
  );

  // rank_entities
  server.registerTool(
    'rank_entities',
    {
      description: RANK_ENTITIES_DESCRIPTION,
      inputSchema: RankEntitiesInputZod.shape,
    },
    async (args) => {
      const result = await rankEntities(
        {
          entityAnalyticsRepo: deps.entityAnalyticsRepo,
          shareLink: deps.shareLink,
          config: { clientBaseUrl: deps.config.clientBaseUrl },
        },
        args as Parameters<typeof rankEntities>[1]
      );
      return result.isErr() ? errResponse(result.error) : okResponse(result.value);
    }
  );

  // query_timeseries_data
  server.registerTool(
    'query_timeseries_data',
    {
      description: QUERY_TIMESERIES_DESCRIPTION,
      inputSchema: QueryTimeseriesInputZod.shape,
    },
    async (args) => {
      const result = await queryTimeseries(
        {
          analyticsService: deps.analyticsService,
          shareLink: deps.shareLink,
          config: { clientBaseUrl: deps.config.clientBaseUrl },
        },
        args as Parameters<typeof queryTimeseries>[1]
      );
      return result.isErr() ? errResponse(result.error) : okResponse(result.value);
    }
  );

  // analyze_entity_budget
  server.registerTool(
    'analyze_entity_budget',
    {
      description: ANALYZE_ENTITY_BUDGET_DESCRIPTION,
      inputSchema: AnalyzeEntityBudgetInputZod.shape,
    },
    async (args) => {
      const result = await analyzeEntityBudget(
        {
          entityRepo: deps.entityRepo,
          aggregatedLineItemsRepo: deps.aggregatedLineItemsRepo,
          shareLink: deps.shareLink,
          config: { clientBaseUrl: deps.config.clientBaseUrl },
        },
        args as Parameters<typeof analyzeEntityBudget>[1]
      );
      return result.isErr() ? errResponse(result.error) : okResponse(result.value);
    }
  );

  // explore_budget_breakdown
  server.registerTool(
    'explore_budget_breakdown',
    {
      description: EXPLORE_BUDGET_BREAKDOWN_DESCRIPTION,
      inputSchema: ExploreBudgetBreakdownInputZod.shape,
    },
    async (args) => {
      const result = await exploreBudgetBreakdown(
        {
          aggregatedLineItemsRepo: deps.aggregatedLineItemsRepo,
          shareLink: deps.shareLink,
          config: { clientBaseUrl: deps.config.clientBaseUrl },
        },
        args as Parameters<typeof exploreBudgetBreakdown>[1]
      );
      return result.isErr() ? errResponse(result.error) : okResponse(result.value);
    }
  );

  // ─────────────────────────────────────────────────────────────────────────
  // Register Resources
  // ─────────────────────────────────────────────────────────────────────────

  // Functional classification guide
  server.registerResource(
    'functional_classification_guide',
    'transparenta://guides/functional-classification',
    {
      title: 'Ghid Clasificare Funcțională',
      description: 'COFOG-based functional budget classifications guide (RO)',
      mimeType: 'text/markdown',
    },
    (uri) => ({
      contents: [
        {
          uri: uri.href,
          text: getFunctionalClassificationGuide(),
          mimeType: 'text/markdown',
        },
      ],
    })
  );

  // Economic classification guide
  server.registerResource(
    'economic_classification_guide',
    'transparenta://guides/economic-classification',
    {
      title: 'Ghid Clasificare Economică',
      description: 'Economic budget classifications guide (RO)',
      mimeType: 'text/markdown',
    },
    (uri) => ({
      contents: [
        {
          uri: uri.href,
          text: getEconomicClassificationGuide(),
          mimeType: 'text/markdown',
        },
      ],
    })
  );

  // Financial terms glossary
  server.registerResource(
    'financial_terms_glossary',
    'transparenta://glossary/financial-terms',
    {
      title: 'Glosar Termeni Financiari',
      description: 'Glosar accesibil de termeni pentru finanțe publice (RO)',
      mimeType: 'text/markdown',
    },
    (uri) => ({
      contents: [
        {
          uri: uri.href,
          text: getFinancialTermsGlossary(),
          mimeType: 'text/markdown',
        },
      ],
    })
  );

  // Budget legislation index
  server.registerResource(
    'budget_legislation_index',
    'transparenta://index/budget-legislation',
    {
      title: 'Index Legislativ Bugetar',
      description: 'Legislație cheie pentru bugetul public (RO)',
      mimeType: 'text/markdown',
    },
    (uri) => ({
      contents: [
        {
          uri: uri.href,
          text: getBudgetLegislationIndex(),
          mimeType: 'text/markdown',
        },
      ],
    })
  );

  // ─────────────────────────────────────────────────────────────────────────
  // Register Prompts
  // ─────────────────────────────────────────────────────────────────────────

  // Register all prompt templates
  for (const prompt of ALL_PROMPTS) {
    server.registerPrompt(
      prompt.name,
      {
        description: prompt.description,
        argsSchema: prompt.arguments.shape,
      },
      (args: Record<string, unknown>) => ({
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: prompt.template(args as never),
            },
          },
        ],
      })
    );
  }

  return server;
}

/**
 * Creates and runs the MCP server with stdio transport.
 * This is used for running the server as a standalone process.
 */
export async function runMcpServerStdio(deps: CreateMcpServerDeps): Promise<void> {
  const server = createMcpServer(deps);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
