import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod-v3";
import {
  getEntityDetails as svcGetEntityDetails,
  searchEntities as svcSearchEntities,
  searchEconomicClassifications as svcSearchEconomicClassifications,
  getEntityBudgetAnalysis as svcGetEntityBudgetAnalysis,
} from "../services/ai-basic";
import { searchFilters as svcSearchFilters } from "../services/ai-basic";
import { generateAnalytics as svcGenerateAnalytics } from "../services/ai-basic";
import { normalizeClassificationCode } from "../utils/functionalClassificationUtils";

export function createMcpServer() {
  const currentYear = new Date().getFullYear();

  const server = new McpServer(
    {
      name: "Hack for Facts – AI Basic MCP",
      version: "1.0.0",
    },
    {
      instructions:
        "Use search_filters to resolve machine-usable IDs and codes (entity_cuis, uat_ids as strings, functional/economic prefixes or exact codes). Then call generate_analytics to fetch data series and a chart link. For specific entity snapshots, use getEntityDetails.",
      capabilities: {
        tools: {},
      },
    }
  );

  server.registerTool(
    "getEntityDetails",
    {
      title: "Get Entity Details",
      description: "Get high-level financial totals for an entity (ai-basic: getEntityDetails).",
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
            totalIncomeHumanReadable: z.string(),
            totalExpensesHumanReadable: z.string(),
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
    "search_filters",
    {
      title: "Search Filters",
      description: `High-precision discovery tool for resolving machine-usable filter values used by analytics.

Search in Romanian as the data is in Romanian only. You can call the search_filters tool as many times as you need to find the relevant filters. This is important to provide an accurate and quality analytics using the filters, so you need to make sure you find all the relevant filters and then decide how to use them.

Inputs:
- category (required): one of "entity" | "uat" | "functional_classification" | "economic_classification".
- query (required): natural language or code-like search term. Use romanian only. Supports diacritics and fuzzy matching.
- limit (optional): max results to return (1..50, default 3).

Behavior:
- Single-category search per call for precision.
- Results are sorted by relevance score (0..1). "bestMatch" is included when the score is high (>=0.85).
- For classifications, both prefix and exact code matches are supported. Use classification search to find relevant classification to the query. If you want to check the code, use the fn: or ec: prefix on the query. Eg: fn:70. or ec:10.

Output fields:
- results[].name: human-readable item name.
- results[].category: mirrors the input category.
- results[].context: short descriptor (e.g., county, chapter/subchapter info).
- results[].score: relevance (0..1), higher means better match.
- results[].filterKey: which analytics filter field to use ("entity_cuis" | "uat_ids" | "functional_prefixes" | "functional_codes" | "economic_prefixes" | "economic_codes").
- results[].filterValue: the exact string to pass into that filter array.
- results[].metadata: category-specific details. For classifications includes { codeKind: 'prefix' | 'exact', chapterCode/chapterName, subchapterCode/subchapterName }. For UAT includes { uatId, countyCode, population }. For entities includes { cui, entityType }.

Usage patterns:
- Entities: { category: 'entity', query: 'Municipiul Cluj-Napoca' } → filterKey 'entity_cuis', filterValue '<CUI>'. Use the name convention used by ANAF: Comuna, Oras,Municipiul, Consiliul, Ministerul, etc
- UATs: { category: 'uat', query: 'Cluj' } → filterKey 'uat_ids', filterValue '<UAT_ID_AS_STRING>' (IMPORTANT: keep as string).
- Functional classifications: query by name or code (using fn: prefix); use filterKey "functional_prefixes" for categories (trailing dot).
- Economic classifications: query by name or code (using ec: prefix); use filterKey "economic_prefixes" (trailing dot).
`,
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

  // Generate analytics tool
  server.registerTool(
    "generate_analytics",
    {
      title: "Generate Analytics",
      description: `Retrieve one or more analytics data series for a specified period and filters, and get a ready-to-use chart link.

Purpose:
- Minimal, agent-friendly input that mirrors core chart filter semantics without UI-only fields.
- The tool auto-derives axis metadata, units (from normalization), and a suggested chart type.

Inputs:
- title (optional): A descriptive title. If missing, a generic title is generated.
- description (optional): Free text for context; forwarded as metadata.
- period (required): { type: 'YEAR' | 'MONTH' | 'QUARTER', selection: { interval { start, end } | dates[] } }.
  • YEAR: 'YYYY' (e.g., '2023')
  • MONTH: 'YYYY-MM'
  • QUARTER: 'YYYY-Qn'
- series (1..N): each item has:
  • label (optional): Series label; auto-generated if omitted (entity/UAT + classification + normalization suffix).
  • filter (required):
    - accountCategory (required): 'ch' (expenses) | 'vn' (revenues)
    - entityCuis?: string[] (resolve via search_filters category='entity')
    - uatIds?: string[] (IMPORTANT: strings; resolve via search_filters category='uat')
    - countyCodes?: string[]
    - isUat?: boolean
    - functionalPrefixes?: string[] (TRAILING DOT; resolve via search_filters with metadata.codeKind=='prefix')
    - economicPrefixes?: string[] (TRAILING DOT; resolve via search_filters with metadata.codeKind=='prefix')
    - expenseTypes?: ('dezvoltare'|'functionare')[]
    - fundingSourceIds?: number[]
    - budgetSectorIds?: number[]
    - exclude?: same shape as include fields for negative filtering (e.g., exclude.functional_prefixes: ['70.'])
    - normalization?: 'total' | 'per_capita' | 'total_euro' | 'per_capita_euro' (default 'total')
    - reportType?: string (defaults to principal aggregated when omitted)

Normalization & Units:
- total → unit 'RON'
- per_capita → unit 'RON/capita'
- total_euro → unit 'EUR'
- per_capita_euro → unit 'EUR/capita'

Outputs:
- ok: boolean
- dataLink: link to data source. Please provide the url in your report or response, as this allow verifying the data you provide.
- title: final title (auto if omitted)
- dataSeries[]: per-series results with:
  • label, seriesId
  • xAxis { name: 'Year'|'Month'|'Quarter', unit: 'year'|'month'|'quarter' }
  • yAxis { name: 'Amount', unit as per normalization }
  • dataPoints: [{ x: string, y: number }]
  • statistics: { min, max, avg, sum, count }

Tips:
- Resolve all IDs/codes via MCP search_filters first and plug filterKey/filterValue directly into filters.
- Keep uatIds as strings; the backend converts to numeric IDs internally.
- Prefer prefixes (functional/economic) for category-level analyses; use exact codes for precise slices.
`,
      inputSchema: {
        title: z.string().optional(),
        description: z.string().optional(),
        period: z.object({
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
          // Validate date format matches period type
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
        }),
        series: z.array(
          z.object({
            label: z.string().optional(),
            filter: z.object({
              accountCategory: z.enum(["ch", "vn"]),
              entityCuis: z.array(z.string()).optional(),
              uatIds: z.array(z.string()).optional(),
              countyCodes: z.array(z.string()).optional(),
              isUat: z.boolean().optional(),
              functionalPrefixes: z.array(z.string()).optional(),
              economicPrefixes: z.array(z.string()).optional(),
              expenseTypes: z.array(z.enum(["dezvoltare", "functionare"])).optional(),
              fundingSourceIds: z.array(z.number().int()).optional(),
              budgetSectorIds: z.array(z.number().int()).optional(),
              exclude: z
                .object({
                  entityCuis: z.array(z.string()).optional(),
                  uatIds: z.array(z.string()).optional(),
                  countyCodes: z.array(z.string()).optional(),
                  functionalPrefixes: z.array(z.string()).optional(),
                  economicPrefixes: z.array(z.string()).optional(),
                })
                .optional(),
              normalization: z.enum(["total", "per_capita", "total_euro", "per_capita_euro"]).optional(),
              reportType: z.string().optional(),
            }),
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

  // Entity budget analysis (group level)
  server.registerTool(
    "getEntityBudgetAnalysis",
    {
      title: "Get Entity Budget Analysis",
      description: "Income and spending grouped by functional category (overview).",
      inputSchema: {
        entityCui: z.string().optional(),
        entitySearch: z.string().optional(),
        year: z.number().int().min(2016).max(currentYear),
      },
      outputSchema: {
        ok: z.boolean(),
        kind: z.literal("entities.budget-analysis"),
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
    async ({ entityCui, entitySearch, year }) => {
      if (!year) {
        const error = { ok: false, error: "year is required" } as const;
        return { content: [{ type: "text", text: JSON.stringify(error) }], structuredContent: error, isError: true };
      }
      try {
        const result = await svcGetEntityBudgetAnalysis({ entityCui, entitySearch, year, level: "group" });
        const response = { ok: true, ...result } as const;
        return { content: [{ type: "text", text: JSON.stringify(response) }], structuredContent: response };
      } catch (e: any) {
        const error = { ok: false, error: String(e?.message ?? e) };
        return { content: [{ type: "text", text: JSON.stringify(error) }], structuredContent: error, isError: true };
      }
    }
  );

  // Budget analysis by functional
  server.registerTool(
    "getEntityBudgetAnalysisByFunctional",
    {
      title: "Get Entity Budget Analysis by Functional",
      description: "Deep dive by functional code (chapter or full code).",
      inputSchema: {
        entityCui: z.string(),
        year: z.number().int().min(2016).max(currentYear),
        functionalCode: z.string(),
      },
      outputSchema: {
        ok: z.boolean(),
        kind: z.literal("entities.budget-analysis-spending-by-functional"),
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
    async ({ entityCui, year, functionalCode }) => {
      if (!year) {
        const error = { ok: false, error: "year is required" } as const;
        return { content: [{ type: "text", text: JSON.stringify(error) }], structuredContent: error, isError: true };
      }
      if (!functionalCode) {
        const error = { ok: false, error: "functionalCode is required" } as const;
        return { content: [{ type: "text", text: JSON.stringify(error) }], structuredContent: error, isError: true };
      }
      try {
        const result = await svcGetEntityBudgetAnalysis({ entityCui, year, level: "functional", fnCode: functionalCode });
        const response = { ok: true, ...result } as const;
        return { content: [{ type: "text", text: JSON.stringify(response) }], structuredContent: response };
      } catch (e: any) {
        const error = { ok: false, error: String(e?.message ?? e) };
        return { content: [{ type: "text", text: JSON.stringify(error) }], structuredContent: error, isError: true };
      }
    }
  );

  // Budget analysis by economic
  server.registerTool(
    "getEntityBudgetAnalysisByEconomic",
    {
      title: "Get Entity Budget Analysis by Economic",
      description: "Deep dive by economic code (dotted code e.g. '10.01.01').",
      inputSchema: {
        entityCui: z.string(),
        year: z.number().int().min(2016).max(currentYear),
        economicCode: z.string(),
      },
      outputSchema: {
        ok: z.boolean(),
        kind: z.literal("entities.budget-analysis-spending-by-economic"),
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
    async ({ entityCui, year, economicCode }) => {
      if (!year) {
        const error = { ok: false, error: "year is required" } as const;
        return { content: [{ type: "text", text: JSON.stringify(error) }], structuredContent: error, isError: true };
      }
      if (!economicCode) {
        const error = { ok: false, error: "economicCode is required" } as const;
        return { content: [{ type: "text", text: JSON.stringify(error) }], structuredContent: error, isError: true };
      }
      try {
        const result = await svcGetEntityBudgetAnalysis({ entityCui, year, level: "economic", ecCode: economicCode });
        const response = { ok: true, ...result } as const;
        return { content: [{ type: "text", text: JSON.stringify(response) }], structuredContent: response };
      } catch (e: any) {
        const error = { ok: false, error: String(e?.message ?? e) };
        return { content: [{ type: "text", text: JSON.stringify(error) }], structuredContent: error, isError: true };
      }
    }
  );

  return server;
}


