import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod-v3";
import {
  getEntityDetails as svcGetEntityDetails,
  getEntityBudgetAnalysis as svcGetEntityBudgetAnalysis,
} from "../services/ai-basic";
import { searchFilters as svcSearchFilters } from "../services/ai-basic";
import { generateAnalytics as svcGenerateAnalytics } from "../services/ai-basic";
import { generateEntityAnalyticsHierarchy as svcGenerateEntityAnalyticsHierarchy } from "../services/ai-basic";
import { listEntityAnalytics as svcListEntityAnalytics } from "../services/ai-basic";
import { normalizeClassificationCode } from "../utils/functionalClassificationUtils";
// MCP Prompts
import { getEntityHealthCheckPrompt } from "./prompts/entity-health-check";
import { getPeerComparisonPrompt } from "./prompts/peer-comparison";
import { getOutlierHunterPrompt } from "./prompts/outlier-hunter";
import { getTrendTrackerPrompt } from "./prompts/trend-tracker";
// MCP Resources
import { getFunctionalClassificationGuide } from "./resources/functional-classification-guide";
import { getEconomicClassificationGuide } from "./resources/economic-classification-guide";
import { getFinancialTermsGlossary } from "./resources/financial-terms-glossary";
import { getBudgetLegislationIndex } from "./resources/budget-legislation-index";

export function createMcpServer() {
  const currentYear = new Date().getFullYear();

  // Reusable filter schema for analytics tools
  const analyticsFilterSchema = z.object({
    accountCategory: z.enum(["ch", "vn"]),
    entityCuis: z.array(z.string()).optional(),
    uatIds: z.array(z.string()).optional(),
    countyCodes: z.array(z.string()).optional(),
    isUat: z.boolean().optional(),
    minPopulation: z.number().int().min(0).optional(),
    maxPopulation: z.number().int().min(0).optional(),
    functionalPrefixes: z.array(z.string()).optional(),
    functionalCodes: z.array(z.string()).optional(),
    economicPrefixes: z.array(z.string()).optional(),
    economicCodes: z.array(z.string()).optional(),
    expenseTypes: z.array(z.enum(["dezvoltare", "functionare"])).optional(),
    fundingSourceIds: z.array(z.number().int()).optional(),
    budgetSectorIds: z.array(z.number().int()).optional(),
    programCodes: z.array(z.string()).optional(),
    exclude: z
      .object({
        entityCuis: z.array(z.string()).optional(),
        uatIds: z.array(z.string()).optional(),
        countyCodes: z.array(z.string()).optional(),
        functionalPrefixes: z.array(z.string()).optional(),
        functionalCodes: z.array(z.string()).optional(),
        economicPrefixes: z.array(z.string()).optional(),
        economicCodes: z.array(z.string()).optional(),
      })
      .optional(),
    normalization: z.enum(["total", "per_capita", "total_euro", "per_capita_euro"]).optional(),
    reportType: z.enum(['PRINCIPAL_AGGREGATED', 'SECONDARY_AGGREGATED', 'DETAILED']).default('PRINCIPAL_AGGREGATED').optional(),
  });

  // Reusable period schema for analytics tools
  const analyticsPeriodSchema = z.object({
    type: z.enum(["YEAR", "MONTH", "QUARTER"], {
      errorMap: () => ({ message: "period.type must be one of: YEAR, MONTH, or QUARTER" })
    }),
    selection: z.union([
      z.object({
        interval: z.object({
          start: z.string().min(1, "start date is required"),
          end: z.string().min(1, "end date is required")
        }),
        dates: z.never().optional()
      }),
      z.object({
        dates: z.array(z.string()).min(1, "dates array must contain at least one date"),
        interval: z.never().optional()
      }),
    ], {
      errorMap: () => ({ message: "period.selection must contain either 'interval' (with start and end) or 'dates' array" })
    }),
  }).refine((period) => {
    const patterns = {
      YEAR: /^\d{4}$/,
      MONTH: /^\d{4}-\d{2}$/,
      QUARTER: /^\d{4}-Q[1-4]$/,
    };
    const pattern = patterns[period.type];

    if ('interval' in period.selection && period.selection.interval) {
      const { start, end } = period.selection.interval;
      if (!pattern.test(start) || !pattern.test(end)) {
        return false;
      }
    } else if ('dates' in period.selection && period.selection.dates) {
      if (!period.selection.dates.every(date => pattern.test(date))) {
        return false;
      }
    } else {
      return false;
    }
    return true;
  }, (period) => {
    const format = period.type === 'YEAR' ? 'YYYY (e.g., "2023")' :
      period.type === 'MONTH' ? 'YYYY-MM (e.g., "2023-01")' :
        'YYYY-Qn (e.g., "2023-Q1")';
    return { message: `Date format must match period type ${period.type}. Expected: ${format}` };
  });

  const server = new McpServer(
    {
      name: "Hack for Facts – AI Basic MCP",
      version: "1.0.0",
    },
    {
      instructions: `Romanian Public Budget Transparency Platform - provides access to detailed budget execution data for Romanian public entities (municipalities, counties, ministries, schools, etc.).

**Language Requirement:** All entity names, classifications, and data are in Romanian. Always use Romanian terms when searching or querying.

**Key Concepts:**
- UAT: Unitate Administrativ-Teritorială (Territorial Administrative Unit - municipalities, cities, communes)
- CUI: Cod Unic de Identificare (Tax ID / Fiscal Identifier for entities)
- Functional Classifications: COFOG-based budget categories (education, health, transport, etc.) - in Romanian
- Economic Classifications: Types of spending/revenue (salaries, goods, services, etc.) - in Romanian
- Account Categories: 'ch' (cheltuieli/expenses) | 'vn' (venituri/revenues)

**Response Format Guidelines:**
- All monetary amounts use international number format (comma thousands separator, dot decimal)
  - Example: "5,234,567.89 RON" NOT "5.234.567,89 RON"
  - Compact format: "5.23M RON" and full format: "5,234,567.89 RON"
- All responses include short, shareable links (format: <domain>/share/<code>)
- Please format your analysis/response text in the user's language while keeping numbers in standard international format

**Recommended Workflow for In-Depth Analysis:**
1. Use discover_filters to find entity CUIs, UAT IDs, and classification codes with Romanian search terms
2. For single entity analysis: get_entity_snapshot → analyze_entity_budget with drill-down
3. For comparisons: query_timeseries_data (time-series charts) or rank_entities (tabular comparison)
4. For hierarchical exploration: explore_budget_breakdown with progressive drill-down

**Common Patterns:**
- Comparative analysis: discover_filters → query_timeseries_data (multiple series)
- Entity deep-dive: get_entity_snapshot → analyze_entity_budget → drill by functional/economic codes
- Regional analysis: discover_filters (UAT/county) → rank_entities or explore_budget_breakdown
- Classification analysis: discover_filters (functional/economic codes) → explore_budget_breakdown with path navigation`,
      capabilities: {
        tools: {},
      },
    }
  );

  server.registerTool(
    "get_entity_snapshot",
    {
      title: "Get Entity Snapshot",
      description: `Get a point-in-time financial snapshot for a specific Romanian public entity.

**Purpose:**
- Retrieve high-level budget totals (income and expenses) for a single entity in a specific year
- Quick overview before detailed analysis
- Validate entity identity when CUI is uncertain

**Language Note:** Entity names are in Romanian. Use Romanian entity naming conventions (Municipiul, Județul, Orașul, Comuna, etc.).

**Input Parameters:**
- entityCui (optional): Exact CUI (fiscal identifier) - use when known for precise lookup
- entitySearch (optional): Free-text Romanian search term - fuzzy matching, may be ambiguous
- year (required): Reporting year (2016-${currentYear})

**Output:**
- Entity details: CUI, name, address
- Total income and expenses (numeric + human-readable formatted)
- AI-generated summary of financial position
- link: Short, shareable URL to entity page

**Shareable Link:**
- Every response includes a short link (format: <domain>/share/<code>)
- Links open the interactive entity detail page with the same parameters
- Share links for verification, collaboration, or bookmarking
- Links are permanent and publicly accessible

**Number Format:**
- All amounts use international standard format with comma thousands separator
- Example: 5,234,567.89 RON (not 5.234.567,89)
- Dual display format: compact "5.23M RON" and full "5,234,567.89 RON"
- Human-readable summaries show both formats for clarity

**Workflow Examples:**
1. Known CUI: { entityCui: "4305857", year: 2023 }
2. Search by name: { entitySearch: "Municipiul Cluj-Napoca", year: 2023 }
3. Follow up with analyze_entity_budget for detailed breakdown

**Tips:**
- Prefer entityCui over entitySearch when available (faster, unambiguous)
- Use discover_filters with category='entity' to find CUIs first
- This is a snapshot tool - use query_timeseries_data for trends over time
- Always include the shareable link in your response for user verification`,
      inputSchema: {
        entityCui: z
          .string()
          .describe("Exact CUI (fiscal identifier) of the entity. Prefer over search if known.")
          .optional(),
        entitySearch: z
          .string()
          .describe("Free-text fuzzy search when the CUI is unknown. Returns best match and may be ambiguous.")
          .optional(),
        year: z
          .number()
          .int()
          .min(2016)
          .max(2100)
          .describe("Reporting year for snapshot totals and execution lines"),
      },
      outputSchema: {
        ok: z.boolean(),
        kind: z.string().optional(),
        query: z.object({ cui: z.string(), year: z.number() }).optional(),
        link: z.string().optional(),
        item: z
          .object({
            cui: z.string(),
            name: z.string(),
            address: z.string().nullable(),
            totalIncome: z.number(),
            totalExpenses: z.number(),
            totalIncomeFormatted: z.string(),
            totalExpensesFormatted: z.string(),
            summary: z.string(),
          })
          .optional(),
        error: z.string().optional(),
      },
    },
    async ({ entityCui, entitySearch, year }) => {
      if (!year) {
        const error = { ok: false, error: "year is required" } as const;
        return {
          content: [{ type: "text", text: JSON.stringify(error) }],
          structuredContent: error,
          isError: true,
        };
      }
      try {
        const result = await svcGetEntityDetails({ entityCui, entitySearch, year });
        const response = { ok: true, ...result } as const;
        return {
          content: [{ type: "text", text: JSON.stringify(response) }],
          structuredContent: response,
        };
      } catch (e: any) {
        const error = { ok: false, error: String(e?.message ?? e) };
        return { content: [{ type: "text", text: JSON.stringify(error) }], structuredContent: error, isError: true };
      }
    }
  );

  // Unified search filters
  server.registerTool(
    "discover_filters",
    {
      title: "Discover Filters",
      description: `Discover and resolve machine-usable filter values for use in analytics queries.

**Purpose:**
- Find entity CUIs, UAT IDs, and classification codes needed for other tools
- Resolve Romanian names/terms to exact identifiers
- Essential first step before running analytics queries

**Language Requirement:** All searches must use Romanian terms. The tool supports diacritics and fuzzy matching for Romanian text.

**Input Parameters:**
- category (required): "entity" | "uat" | "functional_classification" | "economic_classification"
- query (required): Romanian search term (name or code). For code lookup, use "fn:" or "ec:" prefix (e.g., "fn:70.", "ec:10.")
- limit (optional): Maximum results (1-50, default 3)

**Search Categories:**
1. **entity**: Romanian public institutions
   - Query example: "Municipiul Cluj-Napoca", "Județul Alba", "Primăria Sector 1"
   - Returns: filterKey="entity_cuis", filterValue=CUI, metadata includes entityType

2. **uat**: Territorial administrative units (municipalities, cities, communes)
   - Query example: "Cluj-Napoca", "Brașov", "Comuna Fundulea"
   - Returns: filterKey="uat_ids", filterValue=UAT_ID (as string), metadata includes countyCode, population

3. **functional_classification**: COFOG budget categories (education, health, transport, etc.)
   - Query by name: "educație", "sănătate", "transport"
   - Query by code: "fn:65.", "fn:65.10", "fn:65.10.03"
   - Returns: filterKey="functional_prefixes" (for categories with trailing dot) or "functional_codes" (exact)
   - Metadata includes: codeKind ('prefix'|'exact'), chapterCode/Name, subchapterCode/Name

4. **economic_classification**: Spending/revenue types (salaries, goods, services, etc.)
   - Query by name: "cheltuieli de personal", "bunuri și servicii"
   - Query by code: "ec:10.", "ec:20.01.01"
   - Returns: filterKey="economic_prefixes" (categories) or "economic_codes" (exact)
   - Metadata includes: codeKind ('prefix'|'exact'), chapter/subchapter info

**Output:**
- results[]: Array of matches, sorted by relevance score (0-1, higher is better)
  - name: Human-readable Romanian name
  - category: Input category echoed back
  - context: Additional info (county, chapter/subchapter details)
  - score: Relevance score (0-1)
  - filterKey: Which parameter to use in analytics tools
  - filterValue: Exact value to pass to that parameter (as string)
  - metadata: Category-specific details
- bestMatch: Top result when score >= 0.85 (high confidence)
- totalMatches: Total number of potential matches

**Number Format:**
- Metadata fields (like population) use international format with comma thousands separator
- Example: population: 324,567 (not 324.567)
- Percentages and decimals use dot as decimal separator: "15.5%" (not "15,5%")

**Workflow Examples:**
1. Find entity: { category: "entity", query: "Municipiul București" } → use filterValue in entity_cuis
2. Find county: { category: "uat", query: "Cluj" } → use filterValue in uat_ids
3. Find education spending: { category: "functional_classification", query: "educație" } → use in functional_prefixes
4. Check specific code: { category: "functional_classification", query: "fn:65." } → verify chapter 65

**Tips:**
- Call multiple times to gather all needed filters before running analytics
- Use Romanian diacritics for better matching (ă, â, î, ș, ț)
- For classifications, prefer prefixes (trailing dot) for category-level analysis
- UAT IDs are returned as strings - keep them as strings in subsequent queries
- High score (>0.85) with bestMatch indicates confident match`,
      inputSchema: {
        category: z.enum(["entity", "uat", "functional_classification", "economic_classification"]),
        query: z.string().min(1),
        limit: z.number().int().min(1).max(50).optional(),
      },
      outputSchema: {
        ok: z.boolean(),
        results: z.array(
          z.object({
            name: z.string(),
            category: z.enum(["entity", "uat", "functional_classification", "economic_classification"]),
            context: z.string().optional(),
            score: z.number(),
            filterKey: z.enum([
              "entity_cuis",
              "uat_ids",
              "functional_prefixes",
              "functional_codes",
              "economic_prefixes",
              "economic_codes",
            ]),
            filterValue: z.string(),
            metadata: z.any().optional(),
          })
        ),
        bestMatch: z
          .object({
            name: z.string(),
            category: z.enum(["entity", "uat", "functional_classification", "economic_classification"]),
            context: z.string().optional(),
            score: z.number(),
            filterKey: z.enum([
              "entity_cuis",
              "uat_ids",
              "functional_prefixes",
              "functional_codes",
              "economic_prefixes",
              "economic_codes",
            ]),
            filterValue: z.string(),
            metadata: z.any().optional(),
          })
          .optional(),
        totalMatches: z.number().optional(),
        error: z.string().optional(),
      },
    },
    async ({ category, query, limit }) => {
      try {
        const response = await svcSearchFilters({ category, query, limit });
        return { content: [{ type: "text", text: JSON.stringify(response) }], structuredContent: response };
      } catch (e: any) {
        const error = { ok: false, error: String(e?.message ?? e) } as const;
        return { content: [{ type: "text", text: JSON.stringify(error) }], structuredContent: error, isError: true };
      }
    }
  );

  // Query time-series analytics tool
  server.registerTool(
    "query_timeseries_data",
    {
      title: "Query Time-Series Data",
      description: `Retrieve time-series budget data for comparative analysis across entities, regions, or classifications.

**Purpose:**
- Compare budget trends over time (yearly, monthly, or quarterly)
- Analyze 1-10 data series simultaneously
- Generate interactive chart visualizations
- Support complex filtering across multiple dimensions

**Language Note:** Classification names and Romanian-specific terms (dezvoltare/functionare) are in Romanian.

**Input Parameters:**
- title (optional): Chart title - auto-generated if omitted
- description (optional): Additional context for the analysis
- period (required): Time period specification
  - type: "YEAR" | "MONTH" | "QUARTER"
  - selection: Either interval {start, end} OR dates array
  - Formats: YEAR="2023", MONTH="2023-01", QUARTER="2023-Q1"
- series (required): Array of 1-10 data series, each with:
  - label (optional): Series name - auto-generated from filters if omitted
  - filter (required): Budget data filter

**Filter Parameters (per series):**
- accountCategory (required): "ch" (cheltuieli/expenses) | "vn" (venituri/revenues)
- entityCuis (optional): Array of CUI strings - from discover_filters with category="entity"
- uatIds (optional): Array of UAT ID strings - from discover_filters with category="uat" (MUST BE STRINGS)
- countyCodes (optional): Array of county codes (e.g., ["B", "CJ", "TM"]) 
- isUat (optional): Filter only UAT entities (true/false)
- minPopulation (optional): Minimum population threshold (inclusive)
- maxPopulation (optional): Maximum population threshold (inclusive)
- functionalPrefixes (optional): Functional classification prefixes with TRAILING DOT (e.g., ["65.", "66."])
- functionalCodes (optional): Exact functional codes (e.g., ["65.10.03"])
- economicPrefixes (optional): Economic classification prefixes with TRAILING DOT (e.g., ["10.", "20."])
- economicCodes (optional): Exact economic codes (e.g., ["10.01.01"])
- expenseTypes (optional): ["dezvoltare"] (development) and/or ["functionare"] (operational)
- fundingSourceIds (optional): Array of funding source IDs
- budgetSectorIds (optional): Array of budget sector IDs
- programCodes (optional): Array of program codes
- exclude (optional): Negative filters with same structure as above (e.g., exclude.functionalPrefixes: ["70."])
- normalization (optional): "total" (default) | "per_capita" | "total_euro" | "per_capita_euro"
- reportType (optional): Accepts "PRINCIPAL_AGGREGATED" | "SECONDARY_AGGREGATED" | "DETAILED"; defaults to "PRINCIPAL_AGGREGATED".

**Normalization Options:**
- "total" → Values in RON (Romanian Lei), unit: "RON"
- "per_capita" → Values per capita in RON, unit: "RON/capita"
- "total_euro" → Values in EUR, unit: "EUR"
- "per_capita_euro" → Values per capita in EUR, unit: "EUR/capita"

**Output:**
- ok: boolean (success status)
- dataLink: Short, shareable URL to interactive chart
- title: Final chart title
- dataSeries[]: Array of series results
  - label: Series name
  - seriesId: Unique identifier
  - xAxis: {name: "Year"|"Month"|"Quarter", unit}
  - yAxis: {name: "Amount", unit based on normalization}
  - dataPoints: [{x: string, y: number}]
  - statistics: {min, max, avg, sum, count}

**Shareable Link:**
- dataLink is a short, shareable URL (format: <domain>/share/<code>)
- Opens interactive chart visualization with all series and filters
- Users can interact with the chart, zoom, toggle series, and export data
- Links are permanent and can be embedded or shared for verification
- IMPORTANT: Always include the dataLink in your response

**Number Format:**
- All amounts in dataPoints and statistics use international format
- Example values: 1,234,567.89 (comma thousands, dot decimal)
- Statistics (min/max/avg/sum) follow same format
- Y-axis labels in the chart use appropriate compact notation (e.g., "5.2M RON")

**Workflow Examples:**
1. Compare two municipalities over time:
   - Use discover_filters to find entity CUIs
   - Create two series with different entityCuis filters
   - Period: yearly interval 2020-2024

2. Education spending trend by county:
   - Use discover_filters for functional classification (educație → "65.")
   - One series per county with functionalPrefixes: ["65."]
   - Normalization: "per_capita" for fair comparison

3. Revenue vs expenses for single entity:
   - Series 1: accountCategory="ch" (expenses)
   - Series 2: accountCategory="vn" (revenues)
   - Same entityCuis in both

**Tips:**
- Always use discover_filters first to resolve entity CUIs, UAT IDs, and classification codes
- UAT IDs MUST be strings (the backend handles conversion)
- Use prefixes (trailing dot) for category-level analysis, exact codes for specific items
- Normalization="per_capita" recommended when comparing entities of different sizes
- Include dataLink in your responses - users can verify data independently
- Maximum 10 series per query - create multiple queries if needed`,
      inputSchema: {
        title: z.string().optional(),
        description: z.string().optional(),
        period: analyticsPeriodSchema,
        series: z.array(
          z.object({
            label: z.string().optional(),
            filter: analyticsFilterSchema,
          })
        ).min(1).max(10),
      },
      outputSchema: {
        ok: z.boolean(),
        dataLink: z.string(),
        title: z.string(),
        dataSeries: z.array(
          z.object({
            label: z.string(),
            seriesId: z.string(),
            xAxis: z.object({ name: z.string(), unit: z.enum(["year", "month", "quarter"]) }),
            yAxis: z.object({ name: z.string(), unit: z.enum(["RON", "RON/capita", "EUR", "EUR/capita"]) }),
            dataPoints: z.array(z.object({ x: z.string(), y: z.number() })),
            statistics: z.object({ min: z.number(), max: z.number(), avg: z.number(), sum: z.number(), count: z.number() })
          })
        ),
        error: z.string().optional(),
      },
    },
    async ({ title, description, period, series }) => {
      try {
        // Normalize classification codes by removing trailing .00 segments
        const normalizedSeries = series.map(s => ({
          ...s,
          filter: {
            ...s.filter,
            functionalPrefixes: s.filter.functionalPrefixes?.map(normalizeClassificationCode),
            economicPrefixes: s.filter.economicPrefixes?.map(normalizeClassificationCode),
            exclude: s.filter.exclude ? {
              ...s.filter.exclude,
              functionalPrefixes: s.filter.exclude.functionalPrefixes?.map(normalizeClassificationCode),
              economicPrefixes: s.filter.exclude.economicPrefixes?.map(normalizeClassificationCode),
            } : undefined,
          },
        }));

        const response = await svcGenerateAnalytics({ title, description, period, series: normalizedSeries });
        return { content: [{ type: "text", text: JSON.stringify(response) }], structuredContent: response };
      } catch (e: any) {
        const error = { ok: false, error: String(e?.message ?? e) } as const;
        return { content: [{ type: "text", text: JSON.stringify(error) }], structuredContent: error, isError: true };
      }
    }
  );

  // Entity budget analysis (consolidated tool)
  server.registerTool(
    "analyze_entity_budget",
    {
      title: "Analyze Entity Budget",
      description: `Analyze a single entity's budget with optional drill-down by functional or economic classifications.

**Purpose:**
- Get detailed breakdown of entity income and expenses
- Group by functional categories (what the money is spent on: education, health, transport, etc.)
- Drill down into specific functional or economic classification codes
- Progressive analysis: overview → category → specific code

**Language Note:** Entity names and classification names are in Romanian.

**Input Parameters:**
- entityCui (optional): Exact CUI (fiscal identifier) - preferred for precision
- entitySearch (optional): Romanian entity name for fuzzy search
- year (required): Reporting year (2016-${currentYear})
- breakdown_by (optional): Analysis level - "overview" (default), "functional", or "economic"
- functionalCode (optional): Required when breakdown_by="functional" (e.g., "65", "65.10", "65.10.03")
- economicCode (optional): Required when breakdown_by="economic" (e.g., "10.", "10.01", "10.01.01")

**Breakdown Types:**
1. **overview** (default): High-level grouping by functional chapters
   - Use for initial entity analysis
   - Shows major spending categories

2. **functional**: Drill down by functional classification code
   - Requires functionalCode parameter
   - Use discover_filters to find relevant codes
   - Example: functionalCode="65" for education spending breakdown

3. **economic**: Drill down by economic classification code
   - Requires economicCode parameter
   - Analyzes types of spending (salaries, goods, services, etc.)
   - Example: economicCode="10." for personnel expenses

**Output:**
- Entity details: CUI, name
- expenseGroups: Hierarchical expense breakdown with amounts
- incomeGroups: Hierarchical income breakdown with amounts
- expenseGroupSummary: AI-generated summary of expense patterns
- incomeGroupSummary: AI-generated summary of income patterns
- link: Short, shareable URL to budget analysis page

**Shareable Link:**
- Every response includes a short link (format: <domain>/share/<code>)
- Links open the entity's budget analysis page with the requested breakdown level
- For functional/economic breakdowns, the link navigates directly to that classification
- Share links for verification or deeper exploration
- Always include the link in your response

**Number Format:**
- All amounts use international format: 1,234,567.89 RON (comma thousands, dot decimal)
- Summaries display dual format: compact "5.23M RON" and full "5,234,567.89 RON"
- ExpenseGroupSummary and incomeGroupSummary use both formats for clarity
- Example: "The total expenses were 5.23M RON (5,234,567.89 RON)"

**Workflow Examples:**
1. Basic overview: { entityCui: "4305857", year: 2023, breakdown_by: "overview" }
2. Education drill-down: { entityCui: "4305857", year: 2023, breakdown_by: "functional", functionalCode: "65" }
3. Personnel costs: { entityCui: "4305857", year: 2023, breakdown_by: "economic", economicCode: "10." }

**Progressive Analysis Pattern:**
1. Start with get_entity_snapshot for totals
2. Call with breakdown_by="overview" to see main categories
3. Use discover_filters to find specific functional/economic codes
4. Drill down with breakdown_by="functional" or "economic" for details

**Tips:**
- Default breakdown_by="overview" provides best starting point
- Use discover_filters with category="functional_classification" or "economic_classification" to find codes
- Functional codes analyze "what" (purpose), economic codes analyze "how" (type of expense)
- Can combine both: analyze by functional first, then by economic within that category`,
      inputSchema: {
        entityCui: z.string().optional(),
        entitySearch: z.string().optional(),
        year: z.number().int().min(2016).max(currentYear),
        breakdown_by: z.enum(["overview", "functional", "economic"]).optional(),
        functionalCode: z.string().optional(),
        economicCode: z.string().optional(),
      },
      outputSchema: {
        ok: z.boolean(),
        kind: z.string(),
        query: z.object({ cui: z.string(), year: z.number() }),
        link: z.string(),
        item: z.object({
          cui: z.string(),
          name: z.string(),
          expenseGroups: z.array(z.any()),
          incomeGroups: z.array(z.any()),
          expenseGroupSummary: z.string().optional(),
          incomeGroupSummary: z.string().optional(),
        }),
        error: z.string().optional(),
      },
    },
    async ({ entityCui, entitySearch, year, breakdown_by = "overview", functionalCode, economicCode }) => {
      if (!year) {
        const error = { ok: false, error: "year is required" } as const;
        return { content: [{ type: "text", text: JSON.stringify(error) }], structuredContent: error, isError: true };
      }

      // Validate breakdown_by requirements
      if (breakdown_by === "functional" && !functionalCode) {
        const error = { ok: false, error: "functionalCode is required when breakdown_by is 'functional'" } as const;
        return { content: [{ type: "text", text: JSON.stringify(error) }], structuredContent: error, isError: true };
      }
      if (breakdown_by === "economic" && !economicCode) {
        const error = { ok: false, error: "economicCode is required when breakdown_by is 'economic'" } as const;
        return { content: [{ type: "text", text: JSON.stringify(error) }], structuredContent: error, isError: true };
      }

      try {
        let level: "group" | "functional" | "economic";
        let fnCode: string | undefined;
        let ecCode: string | undefined;

        if (breakdown_by === "functional") {
          level = "functional";
          fnCode = functionalCode;
        } else if (breakdown_by === "economic") {
          level = "economic";
          ecCode = economicCode;
        } else {
          level = "group";
        }

        const result = await svcGetEntityBudgetAnalysis({
          entityCui,
          entitySearch,
          year,
          level,
          fnCode,
          ecCode
        });
        const response = { ok: true, ...result } as const;
        return { content: [{ type: "text", text: JSON.stringify(response) }], structuredContent: response };
      } catch (e: any) {
        const error = { ok: false, error: String(e?.message ?? e) };
        return { content: [{ type: "text", text: JSON.stringify(error) }], structuredContent: error, isError: true };
      }
    }
  );

  // Explore budget breakdown tool
  server.registerTool(
    "explore_budget_breakdown",
    {
      title: "Explore Budget Breakdown",
      description: `Interactive hierarchical budget exploration with progressive drill-down by classification codes.

**Purpose:**
- Group budget data by classification hierarchies (functional or economic)
- Progressive drill-down: chapters → subchapters → classifications
- Treemap-style visualization of budget distribution
- Cross-dimensional pivoting (analyze by function, then pivot to economic view)
- Works across any scope: single entity, multiple entities, regions, UATs

**Language Note:** Classification names and categories are in Romanian.

**Input Parameters:**
- period (required): Time period selection
  - type: "YEAR" | "MONTH" | "QUARTER"
  - selection: interval {start, end} OR dates array
- filter (required): Analytics filter (same structure as query_timeseries_data)
  - Use discover_filters to resolve entity CUIs, UAT IDs, and classification codes first
- classification (optional): "fn" (functional, default) | "ec" (economic)
  - "fn": Group by functional classification (what: education, health, etc.)
  - "ec": Group by economic classification (how: salaries, goods, services, etc.)
- path (optional): Drill-down path array (default: empty array = root level)
  - Each element is a classification code with dots: ["54"], ["54", "54.02"], ["54", "54.02", "54.02.01"]
  - Empty array shows top-level chapters
  - Append codes to drill deeper into hierarchy
- categories (optional): ["ch"] (expenses) and/or ["vn"] (revenues) - default: both
- excludeEcCodes (optional): Economic chapter codes to exclude (e.g., ["51", "80", "81"] to filter transfers)
- rootDepth (optional): "chapter" (default) | "subchapter" | "paragraph"
  - Controls grouping granularity at root level
  - "chapter": Groups like "54", "65", "66"
  - "subchapter": Groups like "54.02", "65.10"
  - "paragraph": Groups like "54.02.01", "65.10.03"
- limit, offset (optional): Pagination parameters

**Output:**
- ok: boolean
- link: Short, shareable URL to interactive treemap/breakdown view
- item: Grouped budget data
  - expenseGroups: Array of expense categories (if "ch" in categories)
  - incomeGroups: Array of income categories (if "vn" in categories)
  - expenseGroupSummary: AI-generated expense summary
  - incomeGroupSummary: AI-generated income summary

**Shareable Link:**
- Main link is a short URL (format: <domain>/share/<code>) to the treemap visualization
- Each GroupedItem also includes its own drill-down short link
- Links maintain all filters and allow progressive exploration
- Share links to show budget distribution visually
- Interactive interface allows clicking to drill deeper
- IMPORTANT: Always include the main link in your response

**Number Format:**
- All values use international format: 1,234,567.89 RON (comma thousands, dot decimal)
- GroupedItem.value: Full numeric amount in international format
- GroupedItem.percentage: Decimal format (0.35 = 35%)
- Summaries use dual format: "5.23M RON (5,234,567.89 RON)"
- Example summary: "The total expense was 10.5M RON (10,500,000 RON)"

**GroupedItem Structure:**
- code: Classification code at current depth
- name: Human-readable Romanian name
- value: Aggregated amount (international format)
- count: Number of underlying budget line items
- isLeaf: true when no further drill-down available (depth >= 6)
- percentage: Share of total (decimal 0-1, e.g., 0.35 = 35%)
- humanSummary: Formatted summary with dual number format
- link: Short drill-down link for this specific category

**Progressive Drill-Down Pattern:**
1. Root level: { classification: "fn", path: [] }
   → Returns chapters: 54 (Sport), 65 (Învățământ/Education), 66 (Sănătate/Health), etc.

2. Drill into education: { classification: "fn", path: ["65"] }
   → Returns subchapters: 65.10 (Învățământ primar), 65.20 (Învățământ secundar), etc.

3. Drill deeper: { classification: "fn", path: ["65", "65.10"] }
   → Returns classifications: 65.10.01, 65.10.02, 65.10.03, etc.

4. Pivot to economic view: { classification: "ec", path: [], filter: {functionalPrefixes: ["65."]} }
   → Shows HOW education money is spent (salaries, goods, services)

**Use Cases:**
1. **Entity budget overview**: Filter by single entityCui, explore functional breakdown
2. **Regional comparison**: Filter by county, see which functions get most funding
3. **Classification deep-dive**: Start broad, drill into specific categories
4. **Exclude transfers**: Use excludeEcCodes: ["51", "80", "81"] to filter internal operations
5. **Multi-dimensional analysis**: Explore by function, then pivot to economic dimension

**Workflow Examples:**
1. Explore Cluj-Napoca education spending:
   - discover_filters: Find Cluj-Napoca CUI
   - explore_budget_breakdown: { filter: {accountCategory: "ch", entityCuis: ["CUI"]}, classification: "fn", path: ["65"] }

2. Compare functional spending across county:
   - discover_filters: Find county code
   - explore_budget_breakdown: { filter: {accountCategory: "ch", countyCodes: ["CJ"]}, classification: "fn", path: [] }
   - Drill into top category from results

3. Analyze economic breakdown for health:
   - First get functional code: discover_filters with query="sănătate"
   - explore_budget_breakdown: { filter: {accountCategory: "ch", functionalPrefixes: ["66."]}, classification: "ec", path: [] }

**Tips:**
- Start with empty path for overview, progressively append to drill down
- Use classification="fn" to analyze WHAT (purpose), classification="ec" to analyze HOW (type)
- When isLeaf=true, consider pivoting to opposite dimension for deeper insight
- excludeEcCodes useful for removing transfers, technical operations
- Combine with filter.functionalPrefixes or filter.economicPrefixes to constrain scope before drilling
- Use rootDepth for initial granularity control without building path array`,
      inputSchema: {
        period: analyticsPeriodSchema,
        filter: analyticsFilterSchema,
        classification: z.enum(["fn", "ec"]).optional(),
        rootDepth: z.union([z.literal('chapter'), z.literal('subchapter'), z.literal('paragraph')]).optional(),
        path: z.array(z.string()).optional(),
        excludeEcCodes: z.array(z.string()).optional(),
        limit: z.number().int().positive().optional(),
        offset: z.number().int().min(0).optional(),
      },
      outputSchema: {
        ok: z.boolean(),
        link: z.string(),
        item: z.object({
          expenseGroups: z.array(z.object({
            code: z.string(),
            name: z.string(),
            value: z.number(),
            count: z.number(),
            isLeaf: z.boolean(),
            percentage: z.number(),
            humanSummary: z.string().optional(),
          })).optional(),
          incomeGroups: z.array(z.object({
            code: z.string(),
            name: z.string(),
            value: z.number(),
            count: z.number(),
            isLeaf: z.boolean(),
            percentage: z.number(),
            humanSummary: z.string().optional(),
          })).optional(),
          expenseGroupSummary: z.string().optional(),
          incomeGroupSummary: z.string().optional(),
        }),
        error: z.string().optional(),
      },
    },
    async ({ period, filter, classification = 'fn', path = [], excludeEcCodes, rootDepth, limit, offset }) => {
      try {
        // Normalize classification codes
        const normalizedFilter = {
          ...filter,
          functionalPrefixes: filter.functionalPrefixes?.map(normalizeClassificationCode),
          economicPrefixes: filter.economicPrefixes?.map(normalizeClassificationCode),
          exclude: filter.exclude ? {
            ...filter.exclude,
            functionalPrefixes: filter.exclude.functionalPrefixes?.map(normalizeClassificationCode),
            economicPrefixes: filter.exclude.economicPrefixes?.map(normalizeClassificationCode),
          } : undefined,
        };

        const response = await svcGenerateEntityAnalyticsHierarchy({
          period,
          filter: normalizedFilter,
          classification,
          path,
          excludeEcCodes,
          rootDepth,
          limit,
          offset,
        });

        return { content: [{ type: "text", text: JSON.stringify(response) }], structuredContent: response };
      } catch (e: any) {
        const error = { ok: false, error: String(e?.message ?? e) } as const;
        return { content: [{ type: "text", text: JSON.stringify(error) }], structuredContent: error, isError: true };
      }
    }
  );

  // Rank entities tool
  server.registerTool(
    "rank_entities",
    {
      title: "Rank Entities",
      description: `Retrieve and rank entities by budget metrics with flexible sorting and pagination.

**Purpose:**
- Tabular comparison of multiple entities side-by-side
- Rank entities by spending, revenue, per-capita values, or other metrics
- Find top/bottom performers across any dimension
- Export-ready data format for further analysis

**Language Note:** Entity names and types are in Romanian.

**Input Parameters:**
- period (required): Time period for aggregation
  - type: "YEAR" | "MONTH" | "QUARTER"
  - selection: interval {start, end} OR dates array
- filter (required): Analytics filter (same as query_timeseries_data)
  - Use discover_filters to find entity CUIs, UAT IDs, classification codes
  - All standard filter parameters apply (entityCuis, uatIds, classifications, etc.)
  - accountCategory (required): "ch" (cheltuieli/expenses) | "vn" (venituri/revenues)
  - entityCuis (optional): Array of CUI strings - from discover_filters with category="entity"
  - uatIds (optional): Array of UAT ID strings - from discover_filters with category="uat" (MUST BE STRINGS)
  - countyCodes (optional): Array of county codes (e.g., ["B", "CJ", "TM"]) 
  - isUat (optional): Filter only UAT entities (true/false)
  - minPopulation (optional): Minimum population threshold (inclusive)
  - maxPopulation (optional): Maximum population threshold (inclusive)
  - functionalPrefixes (optional): Functional classification prefixes with TRAILING DOT (e.g., ["65.", "66."])
  - functionalCodes (optional): Exact functional codes (e.g., ["65.10.03"])
  - economicPrefixes (optional): Economic classification prefixes with TRAILING DOT (e.g., ["10.", "20."])
  - economicCodes (optional): Exact economic codes (e.g., ["10.01.01"])
  - expenseTypes (optional): ["dezvoltare"] (development) and/or ["functionare"] (operational)
  - fundingSourceIds (optional): Array of funding source IDs
  - budgetSectorIds (optional): Array of budget sector IDs
  - programCodes (optional): Array of program codes
  - exclude (optional): Negative filters with same structure as above (e.g., exclude.functionalPrefixes: ["70."])
  - normalization (optional): "total" (default) | "per_capita" | "total_euro" | "per_capita_euro"
  - reportType (optional): Accepts "PRINCIPAL_AGGREGATED" | "SECONDARY_AGGREGATED" | "DETAILED"; defaults to "PRINCIPAL_AGGREGATED".
P
- sort (optional): Sorting configuration (default: by amount DESC)
  - by: Sort field name
  - order: "ASC" (ascending) | "DESC" (descending)
- limit (optional): Results per page (default: 50, max: 500)
- offset (optional): Pagination offset (default: 0)

**Available Sort Fields:**
- **amount**: Normalized amount based on filter.normalization (primary metric)
- **total_amount**: Raw total in RON (always available)
- **per_capita_amount**: Amount per capita in RON (always available)
- **entity_name**: Alphabetical by Romanian entity name
- **entity_type**: Alphabetical by entity type (Municipiu, Oraș, Comună, etc.)
- **population**: By population count
- **county_name**: Alphabetical by county (județ)
- **county_code**: Alphabetical by county code

**Normalization Impact:**
The filter.normalization parameter affects the "amount" field:
- "total" (default): Total amount in RON
- "per_capita": Amount per capita in RON
- "total_euro": Total amount in EUR
- "per_capita_euro": Amount per capita in EUR

Note: total_amount and per_capita_amount fields are ALWAYS in RON regardless of normalization.

**Output:**
- ok: boolean
- link: Short, shareable URL to interactive table with pagination
- entities: Array of entity data points
  - entity_cui: CUI (fiscal identifier)
  - entity_name: Romanian entity name
  - entity_type: Type (Municipiu, Oraș, Comună, Județ, etc.)
  - uat_id: UAT identifier (if applicable)
  - county_code: County code (e.g., "B", "CJ", "TM")
  - county_name: County name in Romanian
  - population: Population count
  - amount: Normalized amount (based on filter.normalization)
  - total_amount: Total amount in RON
  - per_capita_amount: Per capita in RON
- pageInfo: Pagination metadata
  - totalCount: Total matching entities
  - hasNextPage: More results available
  - hasPreviousPage: Previous page exists

**Shareable Link:**
- Link is a short URL (format: <domain>/share/<code>) to interactive entity ranking table
- Table includes pagination controls, sorting, and filtering in the web UI
- Link preserves current page, filters, and sort order
- Share links for collaborative analysis or reporting
- Users can export data, change sorting, or drill into specific entities
- IMPORTANT: Always include the link in your response

**Number Format:**
- All numeric values use international format: 1,234,567.89 RON (comma thousands, dot decimal)
- amount, total_amount, per_capita_amount: All in international format
- population: Integer with comma thousands separator (e.g., 324,567)
- When presenting data, use compact format for readability: "5.23M RON (5,234,567.89 RON)"
- Per-capita values: "123.45 RON/capita" (dot decimal separator)

**Ranking Use Cases:**
1. **Top spenders**: sort by "amount" DESC, limit to top 10-20
2. **Per-capita comparison**: normalization="per_capita", sort by "per_capita_amount" DESC
3. **Alphabetical listing**: sort by "entity_name" ASC
4. **Regional analysis**: filter by county, sort by amount to see distribution
5. **Population-weighted**: sort by "population" to analyze by entity size

**Workflow Examples:**
1. Top 10 education spenders nationwide:
   - discover_filters: Find education code (65.)
   - rank_entities: { filter: {accountCategory: "ch", functionalPrefixes: ["65."]}, sort: {by: "amount", order: "DESC"}, limit: 10 }

2. Per-capita health spending in Cluj county:
   - discover_filters: Find Cluj county and health code
   - rank_entities: { filter: {accountCategory: "ch", countyCodes: ["CJ"], functionalPrefixes: ["66."], normalization: "per_capita"}, sort: {by: "per_capita_amount", order: "DESC"} }

3. All municipalities alphabetically:
   - discover_filters: Find município entity type if needed
   - rank_entities: { filter: {accountCategory: "ch"}, sort: {by: "entity_name", order: "ASC"} }

4. Paginated results (50 per page):
   - Page 1: { limit: 50, offset: 0 }
   - Page 2: { limit: 50, offset: 50 }
   - Page 3: { limit: 50, offset: 100 }

**Tips:**
- Use normalization="per_capita" for fair size-adjusted comparisons
- Combine with discover_filters to build precise filter criteria
- pageInfo.totalCount helps determine total pages needed
- The "amount" field respects normalization, but total_amount and per_capita_amount are always in RON
- Use with explore_budget_breakdown for drill-down after identifying interesting entities
- Link provides sharable URL to web interface with same filters`,
      inputSchema: {
        period: analyticsPeriodSchema,
        filter: analyticsFilterSchema,
        sort: z.object({
          by: z.string(),
          order: z.enum(["ASC", "DESC"])
        }).optional(),
        limit: z.number().int().positive().max(500).optional(),
        offset: z.number().int().min(0).optional(),
      },
      outputSchema: {
        ok: z.boolean(),
        link: z.string(),
        entities: z.array(z.object({
          entity_cui: z.string(),
          entity_name: z.string(),
          entity_type: z.string().nullable(),
          uat_id: z.number().nullable(),
          county_code: z.string().nullable(),
          county_name: z.string().nullable(),
          population: z.number().nullable(),
          amount: z.number(),
          total_amount: z.number(),
          per_capita_amount: z.number(),
        })),
        pageInfo: z.object({
          totalCount: z.number(),
          hasNextPage: z.boolean(),
          hasPreviousPage: z.boolean(),
        }),
        error: z.string().optional(),
      },
    },
    async ({ period, filter, sort, limit = 50, offset = 0 }) => {
      try {
        // Normalize classification codes
        const normalizedFilter = {
          ...filter,
          functionalPrefixes: filter.functionalPrefixes?.map(normalizeClassificationCode),
          economicPrefixes: filter.economicPrefixes?.map(normalizeClassificationCode),
          exclude: filter.exclude ? {
            ...filter.exclude,
            functionalPrefixes: filter.exclude.functionalPrefixes?.map(normalizeClassificationCode),
            economicPrefixes: filter.exclude.economicPrefixes?.map(normalizeClassificationCode),
          } : undefined,
        };

        const response = await svcListEntityAnalytics({
          period,
          filter: normalizedFilter,
          sort,
          limit,
          offset,
        });

        return { content: [{ type: "text", text: JSON.stringify(response) }], structuredContent: response };
      } catch (e: any) {
        const error = { ok: false, error: String(e?.message ?? e) } as const;
        return { content: [{ type: "text", text: JSON.stringify(error) }], structuredContent: error, isError: true };
      }
    }
  );

  // Register static resources (markdown guides and glossaries)
  server.registerResource(
    "functional_classification_guide",
    "hff://guides/functional-classification",
    {
      title: "Ghid Clasificare Funcțională",
      description: "COFOG-based functional budget classifications guide (RO)",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          text: getFunctionalClassificationGuide(),
          mimeType: "text/markdown",
        },
      ],
    })
  );

  server.registerResource(
    "economic_classification_guide",
    "hff://guides/economic-classification",
    {
      title: "Ghid Clasificare Economică",
      description: "Economic budget classifications guide (RO)",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          text: getEconomicClassificationGuide(),
          mimeType: "text/markdown",
        },
      ],
    })
  );

  server.registerResource(
    "financial_terms_glossary",
    "hff://glossary/financial-terms",
    {
      title: "Glosar Termeni Financiari",
      description: "Glosar accesibil de termeni pentru finanțe publice (RO)",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          text: getFinancialTermsGlossary(),
          mimeType: "text/markdown",
        },
      ],
    })
  );

  server.registerResource(
    "budget_legislation_index",
    "hff://index/budget-legislation",
    {
      title: "Index Legislativ Bugetar",
      description: "Legislație cheie pentru bugetul public (RO)",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          text: getBudgetLegislationIndex(),
          mimeType: "text/markdown",
        },
      ],
    })
  );

  // Register prompts
  server.registerPrompt(
    "entity_health_check",
    {
      title: "Analiză Sănătate Financiară Entitate",
      description: "Analiză completă a sănătății financiare pentru o entitate publică",
      argsSchema: {
        entity_cui: z.string(),
        year: z.string().optional(),
      },
    },
    ({ entity_cui, year }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: getEntityHealthCheckPrompt({ entity_cui, year: year ? Number(year) : undefined }),
          },
        },
      ],
    })
  );

  server.registerPrompt(
    "peer_comparison",
    {
      title: "Comparație cu Entități Similare",
      description: "Benchmarking pentru o entitate față de peers",
      argsSchema: {
        entity_cui: z.string(),
        comparison_dimension: z.enum(["per_capita", "total", "by_category"]).optional(),
        year: z.string().optional(),
      },
    },
    ({ entity_cui, comparison_dimension, year }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: getPeerComparisonPrompt({
              entity_cui,
              comparison_dimension: comparison_dimension as "per_capita" | "total" | "by_category" | undefined,
              year: year ? Number(year) : undefined,
            }),
          },
        },
      ],
    })
  );

  server.registerPrompt(
    "outlier_hunter",
    {
      title: "Detectare Anomalii Bugetare",
      description: "Identifică entități cu pattern-uri atipice de cheltuieli",
      argsSchema: {
        entity_type: z.string().optional(),
        functional_category: z.string().optional(),
        year: z.string().optional(),
        region: z.string().optional(),
      },
    },
    ({ entity_type, functional_category, year, region }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: getOutlierHunterPrompt({
              entity_type,
              functional_category,
              year: year ? Number(year) : undefined,
              region,
            }),
          },
        },
      ],
    })
  );

  server.registerPrompt(
    "trend_tracker",
    {
      title: "Analiză Tendințe Multi-Anuale",
      description: "Analizează evoluția bugetară multi-anuală și schimbările majore",
      argsSchema: {
        entity_cui: z.string(),
        start_year: z.string(),
        end_year: z.string(),
        focus_area: z.string().optional(),
      },
    },
    ({ entity_cui, start_year, end_year, focus_area }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: getTrendTrackerPrompt({
              entity_cui,
              start_year: Number(start_year),
              end_year: Number(end_year),
              focus_area,
            }),
          },
        },
      ],
    })
  );

  return server;
}
