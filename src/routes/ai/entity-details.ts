import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { entityRepository } from "../../db/repositories/entityRepository";
import { executionLineItemRepository } from "../../db/repositories/executionLineItemRepository";
import { functionalClassificationRepository } from "../../db/repositories/functionalClassificationRepository";
import { economicClassificationRepository } from "../../db/repositories/economicClassificationRepository";
import { buildClientLink, buildEntityDetailsLink } from "../../utils/link";
import { filterGroups, groupByFunctional } from "../../utils/grouping";
import { formatCurrency } from "../../utils/formatter";

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
        operationId: "getEntitiesSearch",
        tags: ["AI"],
        summary: "Search entities by name/address/CUI (fuzzy)",
        querystring: {
          type: "object",
          properties: {
            search: { type: "string" },
            limit: { type: "integer", minimum: 1, maximum: 10 },
            offset: { type: "integer", minimum: 0 },
          },
          required: ["search"],
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parse = entitySearchQuery.safeParse(request.query);
      if (!parse.success) return bad(reply, "Invalid query", parse.error.format());
      const { search, limit = 10, offset = 0 } = parse.data;

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
      operationId: "getEntityDetails",
      tags: ["AI"],
      summary: "Entity details by cui or search",
      description: `
How to query:
- Identify entity via one of:
  - cui: exact CUI string (preferred when known)
  - search: free-text (fuzzy) across name/CUI; first result is used
- year: reporting year (default 2024)
`,
      querystring: {
        type: "object",
        properties: {
          cui: { type: "string", description: "Exact CUI of the entity (preferred when known)" },
          search: { type: "string", description: "Free-text fuzzy search across name/address/CUI; first match is used when CUI is not provided" },
          year: { type: "integer", minimum: 2016, maximum: 2100, default: 2024, description: "Reporting year for snapshot totals and execution lines" },
        },
      },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const qs = request.query as any;
    const cui: string | undefined = typeof qs?.cui === "string" && qs.cui.trim() ? qs.cui.trim() : undefined;
    const search: string | undefined = typeof qs?.search === "string" && qs.search.trim() ? qs.search.trim() : undefined;
    const year: number = typeof qs?.year === "number" ? qs.year : 2024;

    let entity = cui ? await entityRepository.getById(cui) : undefined;
    if (!entity && search) {
      const results = await entityRepository.getAll({ search }, 1, 0);
      entity = results[0];
    }
    if (!entity) return reply.code(404).send({ ok: false, error: "Entity not found" });

    const yearlySnapshot = await executionLineItemRepository.getYearlySnapshotTotals(entity.cui, year);



    const details = {
      cui: entity.cui,
      name: (entity as any).name,
      address: (entity as any).address ?? null,
      totalIncome: `${yearlySnapshot.totalIncome} RON`,
      totalExpenses: `${yearlySnapshot.totalExpenses} RON`,
      totalIncomeHumanReadable: `${formatCurrency(yearlySnapshot.totalIncome, 'compact')}`,
      totalExpensesHumanReadable: `${formatCurrency(yearlySnapshot.totalExpenses, 'compact')}`,
      summary: `In ${year}, ${entity.name} had a total income of ${formatCurrency(yearlySnapshot.totalIncome, 'compact')} and a total expenses of ${formatCurrency(yearlySnapshot.totalExpenses, 'compact')}.`,
    };

    const link = buildEntityDetailsLink(entity.cui, { year });
    return ok(reply, {
      kind: "entities.details",
      query: { cui: entity.cui, year },
      link,
      item: details,
    });
  });

  // Removed compare endpoint; clients can compare by calling details multiple times

  return fastify;
}


