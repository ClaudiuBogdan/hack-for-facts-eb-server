import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {z} from "zod-v3";
import {
  getEntityDetails as svcGetEntityDetails,
  searchEntities as svcSearchEntities,
  searchEconomicClassifications as svcSearchEconomicClassifications,
  getEntityBudgetAnalysis as svcGetEntityBudgetAnalysis,
} from "../services/ai-basic";
import { searchFilters as svcSearchFilters } from "../services/ai-basic";

export function createMcpServer() {
  const currentYear = new Date().getFullYear();

  const server = new McpServer(
    {
      name: "Hack for Facts – AI Basic MCP",
      version: "1.0.0",
    },
    {
      instructions:
        "Use the provided tools to retrieve AI-friendly, compact public spending data. Start with getEntityDetails when the user asks about a specific entity in a given year.",
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
      description: "Find machine-usable filter values for analytics (entity, uat, functional, economic).",
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


