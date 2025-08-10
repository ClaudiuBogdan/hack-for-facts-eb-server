import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { entityRepository } from "../db/repositories/entityRepository";
import { executionLineItemRepository } from "../db/repositories/executionLineItemRepository";
import { functionalClassificationRepository } from "../db/repositories/functionalClassificationRepository";
import { economicClassificationRepository } from "../db/repositories/economicClassificationRepository";
import { buildClientLink, buildEntityDetailsLink } from "../utils/link";
import { filterGroups, groupByFunctional } from "../utils/grouping";

function ok(reply: FastifyReply, data: unknown) {
  return reply.code(200).send({ ok: true, data });
}
function bad(reply: FastifyReply, message: string, details?: unknown) {
  return reply.code(400).send({ ok: false, error: message, details });
}

const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(25).optional(),
  offset: z.coerce.number().int().min(0).default(0).optional(),
});

const entitySearchQuery = paginationSchema.extend({
  search: z.string().min(1),
});

const spendingSummaryQuery = paginationSchema.extend({
  account_category: z.enum(["vn", "ch"]).describe("vn = venituri (income), ch = cheltuieli (expenses)"),
  years: z
    .string()
    .transform((s) => s.split(",").map((x) => parseInt(x.trim(), 10)).filter((n) => !isNaN(n)))
    .refine((arr) => arr.length > 0, "years must contain at least one number"),
  entity_cuis: z
    .string()
    .optional()
    .transform((s) => (s ? s.split(",").map((x) => x.trim()).filter(Boolean) : undefined)),
  county_code: z.string().optional(),
  economic_prefixes: z
    .string()
    .optional()
    .transform((s) => (s ? s.split(",").map((x) => x.trim()).filter(Boolean) : undefined)),
  functional_prefixes: z
    .string()
    .optional()
    .transform((s) => (s ? s.split(",").map((x) => x.trim()).filter(Boolean) : undefined)),
});

const entitiesCompareQuery = spendingSummaryQuery.extend({
  normalization: z.enum(["total", "per_capita"]).optional().default("total"),
  search: z.string().optional(),
});

const cuiParamSchema = z.object({ cui: z.string().min(1) });

export default async function aiBasicRoutes(fastify: FastifyInstance) {
  // Entities: simple search
  fastify.get(
    "/ai/v1/entities/search",
    {
      schema: {
        tags: ["AI"],
        summary: "Search entities by name/address/CUI (fuzzy)",
        querystring: {
          type: "object",
          properties: {
            search: { type: "string" },
            limit: { type: "integer", minimum: 1, maximum: 200 },
            offset: { type: "integer", minimum: 0 },
          },
          required: ["search"],
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parse = entitySearchQuery.safeParse(request.query);
      if (!parse.success) return bad(reply, "Invalid query", parse.error.format());
      const { search, limit, offset } = parse.data;

      const [nodes, total] = await Promise.all([
        entityRepository.getAll({ search }, limit, offset),
        entityRepository.count({ search }),
      ]);
      const link = buildClientLink({ view: "entities-search", filters: { search } });
      return ok(reply, { kind: "entities.search", query: { search, limit, offset }, link, items: nodes, pageInfo: { totalCount: total, limit: limit ?? 25, offset: offset ?? 0 } });
    }
  );

  // Entity details (by cui or search)
  fastify.get("/ai/v1/entities/details", {
    schema: {
      tags: ["AI"],
      summary: "Entity details by cui or search",
      description: `
Entity-centric endpoint optimized for AI. Returns:
- item: entity profile, yearly totals, trends, execution line items, grouped expense/income by functional chapters and economic codes
- link: deep link to open the client at the same view/search

How to query:
- Identify entity via one of:
  - cui: exact CUI string (preferred when known)
  - search: free-text (fuzzy) across name/CUI; first result is used
- year: reporting year (default 2024)
- startYear/endYear: inclusive range for trend series
- expenseSearch / incomeSearch: filter the grouped results on the server using:
  - plain text (case-insensitive): matches chapter descriptions, functional names, or economic names
  - fn:<code> to match a functional code (e.g., fn:65.03.02)
  - ec:<code> to match an economic code (e.g., ec:10.01.01)
  The server returns only matching chapters/functionals/economics and recomputes totals for matched subsets.
- view/trend/analyticsChartType/analyticsDataType/mapFilters: forwarded for client deep-linking; do not change server results.
`,
      querystring: {
        type: "object",
        properties: {
          cui: { type: "string", description: "Exact CUI of the entity (preferred when known)" },
          search: { type: "string", description: "Free-text fuzzy search across name/address/CUI; first match is used when CUI is not provided" },
          year: { type: "integer", minimum: 2016, maximum: 2100, default: 2024, description: "Reporting year for snapshot totals and execution lines" },
          startYear: { type: "integer", minimum: 2000, maximum: 2100, default: 2016, description: "Start of inclusive range for trend series" },
          endYear: { type: "integer", minimum: 2000, maximum: 2100, default: 2025, description: "End of inclusive range for trend series" },
          view: { type: "string", enum: ["overview", "map", "income-trends", "expense-trends"], description: "Forwarded to client deep-link (does not change server result)" },
          trend: { type: "string", enum: ["absolute", "percent"], description: "Forwarded to client deep-link (does not change server result)" },
          expenseSearch: { type: "string", description: "Server-side filter for expenseGroups. Supports plain text and code prefixes: fn:<code> for functional codes (e.g., fn:65.03.02), ec:<code> for economic codes (e.g., ec:10.01.01). Case-insensitive." },
          incomeSearch: { type: "string", description: "Server-side filter for incomeGroups. Supports plain text and code prefixes: fn:<code> for functional codes (e.g., fn:65.03.02), ec:<code> for economic codes (e.g., ec:10.01.01). Case-insensitive." },
          analyticsChartType: { type: "string", enum: ["bar", "pie"], description: "Forwarded to client deep-link (does not change server result)" },
          analyticsDataType: { type: "string", enum: ["income", "expense"], description: "Forwarded to client deep-link (does not change server result)" },
          mapFilters: { type: "object", description: "Forwarded to client deep-link (does not change server result)" },
        },
      },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const qs = request.query as any;
    const cui: string | undefined = typeof qs?.cui === "string" && qs.cui.trim() ? qs.cui.trim() : undefined;
    const search: string | undefined = typeof qs?.search === "string" && qs.search.trim() ? qs.search.trim() : undefined;
    const year: number = typeof qs?.year === "number" ? qs.year : 2024;
    const startYear: number = typeof qs?.startYear === "number" ? qs.startYear : 2016;
    const endYear: number = typeof qs?.endYear === "number" ? qs.endYear : 2025;
    const view: string | undefined = typeof qs?.view === "string" ? qs.view : undefined;
    const trend: string | undefined = typeof qs?.trend === "string" ? qs.trend : undefined;
    const expenseSearch: string | undefined = typeof qs?.expenseSearch === "string" ? qs.expenseSearch : undefined;
    const incomeSearch: string | undefined = typeof qs?.incomeSearch === "string" ? qs.incomeSearch : undefined;
    const analyticsChartType: string | undefined = typeof qs?.analyticsChartType === "string" ? qs.analyticsChartType : undefined;
    const analyticsDataType: string | undefined = typeof qs?.analyticsDataType === "string" ? qs.analyticsDataType : undefined;
    const mapFilters: any | undefined = typeof qs?.mapFilters === "object" ? qs.mapFilters : undefined;

    let entity = cui ? await entityRepository.getById(cui) : undefined;
    if (!entity && search) {
      const results = await entityRepository.getAll({ search }, 1, 0);
      entity = results[0];
    }
    if (!entity) return reply.code(404).send({ ok: false, error: "Entity not found" });

    const [executionLineItems] = await Promise.all([
      executionLineItemRepository.getAll({ entity_cuis: [entity.cui], years: [year], account_category: "ch" }, { by: "amount", order: "DESC" }, 1000, 0),
    ]);
    const [yearlySnapshot, trends] = await Promise.all([
      executionLineItemRepository.getYearlySnapshotTotals(entity.cui, year),
      executionLineItemRepository.getYearlyFinancialTrends(entity.cui, startYear, endYear),
    ]);

    const incomeTrend = trends.map(t => ({ year: t.year, totalAmount: t.totalIncome }));
    const expenseTrend = trends.map(t => ({ year: t.year, totalAmount: t.totalExpenses }));

    // Build classification name maps
    const functionalCodes = Array.from(new Set((executionLineItems || []).map((li: any) => li.functional_code).filter(Boolean)));
    const economicCodes = Array.from(new Set((executionLineItems || []).map((li: any) => li.economic_code).filter(Boolean)));
    const [functionalList, economicList] = await Promise.all([
      functionalClassificationRepository.getAll({ functional_codes: functionalCodes }, functionalCodes.length || 1, 0),
      economicClassificationRepository.getAll({ economic_codes: economicCodes }, economicCodes.length || 1, 0),
    ]);
    const funcNameByCode = new Map<string, string>();
    for (const f of functionalList) funcNameByCode.set((f as any).functional_code, (f as any).functional_name);
    const ecoNameByCode = new Map<string, string>();
    for (const e of economicList) ecoNameByCode.set((e as any).economic_code, (e as any).economic_name);

    // Compose execution items with classification names
    const enrichedItems = (executionLineItems || []).map((li: any) => ({
      account_category: li.account_category,
      amount: li.amount,
      functionalClassification: li.functional_code ? { functional_code: li.functional_code, functional_name: funcNameByCode.get(li.functional_code) || "Unknown" } : undefined,
      economicClassification: li.economic_code ? { economic_code: li.economic_code, economic_name: ecoNameByCode.get(li.economic_code) || "Unknown" } : undefined,
    }));

    let expenseGroups = groupByFunctional(enrichedItems.filter((it) => it.account_category === "ch"));
    let incomeGroups = groupByFunctional(enrichedItems.filter((it) => it.account_category === "vn"));

    if (expenseSearch) expenseGroups = filterGroups(expenseGroups, expenseSearch);
    if (incomeSearch) incomeGroups = filterGroups(incomeGroups, incomeSearch);

    const details = {
      cui: entity.cui,
      name: (entity as any).name,
      address: (entity as any).address ?? null,
      entity_type: (entity as any).entity_type ?? null,
      is_uat: (entity as any).is_uat ?? null,
      is_main_creditor: (entity as any).is_main_creditor ?? null,
      uat: null,
      children: [],
      parents: [],
      totalIncome: yearlySnapshot.totalIncome,
      totalExpenses: yearlySnapshot.totalExpenses,
      incomeTrend,
      expenseTrend,
      expenseGroups,
      incomeGroups,
    };

    const link = buildEntityDetailsLink(entity.cui, {
      view: view ?? "overview",
      year,
      trend,
      expenseSearch,
      incomeSearch,
      analyticsChartType,
      analyticsDataType,
    });
    return ok(reply, {
      kind: "entities.details",
      query: { cui: entity.cui, year, startYear, endYear, view, trend, expenseSearch, incomeSearch, analyticsChartType, analyticsDataType, mapFilters },
      link,
      item: details,
      raw: { entity },
    });
  });

  // Removed compare endpoint; clients can compare by calling details multiple times

  return fastify;
}


