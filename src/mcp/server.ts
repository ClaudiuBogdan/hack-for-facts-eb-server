import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { entityRepository } from "../db/repositories/entityRepository";
import { executionLineItemRepository } from "../db/repositories/executionLineItemRepository";
import { buildEntityDetailsLink } from "../utils/link";
import { formatCurrency } from "../utils/formatter";

export function createMcpServer() {
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

  server.tool(
    "getEntityDetails",
    "Get high-level financial totals for an entity (ai-basic: getEntityDetails).",
    {
      entityCui: z
        .string()
        .describe(
          "Exact CUI (fiscal identifier) of the entity. Prefer over search if known."
        )
        .optional(),
      entitySearch: z
        .string()
        .describe(
          "Free-text fuzzy search when the CUI is unknown. Returns best match and may be ambiguous."
        )
        .optional(),
      year: z
        .number()
        .int()
        .min(2016)
        .max(2100)
        .describe("Reporting year for snapshot totals and execution lines"),
    },
    async ({ entityCui, entitySearch, year }) => {
      if (!year) {
        return {
          content: [{ type: "text", text: JSON.stringify({ ok: false, error: "year is required" }) }],
          isError: true,
        };
      }

      let entity = entityCui ? await entityRepository.getById(entityCui) : undefined;
      if (!entity && entitySearch) {
        const results = await entityRepository.getAll({ search: entitySearch }, 1, 0);
        entity = results[0];
      }
      if (!entity) {
        return {
          content: [{ type: "text", text: JSON.stringify({ ok: false, error: "Entity not found" }) }],
          isError: true,
        };
      }

      const yearlySnapshot = await executionLineItemRepository.getYearlySnapshotTotals(
        entity.cui,
        year,
        entity.default_report_type
      );

      const details = {
        cui: entity.cui,
        name: (entity as any).name,
        address: (entity as any).address ?? null,
        totalIncome: yearlySnapshot.totalIncome,
        totalExpenses: yearlySnapshot.totalExpenses,
        totalIncomeHumanReadable: `The total income for ${entity.name} in ${year} was ${formatCurrency(yearlySnapshot.totalIncome, "compact")} (${formatCurrency(yearlySnapshot.totalIncome, "standard")})`,
        totalExpensesHumanReadable: `The total expenses for ${entity.name} in ${year} was ${formatCurrency(yearlySnapshot.totalExpenses, "compact")} (${formatCurrency(yearlySnapshot.totalExpenses, "standard")})`,
        summary: `In ${year}, ${entity.name} had a total income of ${formatCurrency(yearlySnapshot.totalIncome, "compact")} (${formatCurrency(yearlySnapshot.totalIncome, "standard")}) and a total expenses of ${formatCurrency(yearlySnapshot.totalExpenses, "compact")} (${formatCurrency(yearlySnapshot.totalExpenses, "standard")}).`,
      };

      const link = buildEntityDetailsLink(entity.cui, { year });
      const response = {
        ok: true,
        kind: "entities.details",
        query: { cui: entity.cui, year },
        link,
        item: details,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(response) }],
      };
    }
  );

  return server;
}

export const mcpDefinition = {
  name: "Hack for Facts – AI Basic MCP",
  version: "1.0.0",
  tools: [
    {
      name: "getEntityDetails",
      description:
        "Get high-level financial totals for an entity in a specific year (mirrors /ai/v1/entities/details).",
      args: {
        entityCui: { type: "string", optional: true },
        entitySearch: { type: "string", optional: true },
        year: { type: "number", min: 2016, max: 2100 },
      },
    },
  ],
  transport: {
    sse: {
      streamEndpoint: "/mcp/sse",
      postEndpoint: "/mcp/messages",
      auth: "optional api key via x-api-key if MCP_API_KEY is set",
    },
  },
};


