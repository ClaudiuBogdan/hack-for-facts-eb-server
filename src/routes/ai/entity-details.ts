import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { entityRepository } from "../../db/repositories/entityRepository";
import { executionLineItemRepository } from "../../db/repositories/executionLineItemRepository";
import { functionalClassificationRepository } from "../../db/repositories/functionalClassificationRepository";
import { economicClassificationRepository } from "../../db/repositories/economicClassificationRepository";
import { buildClientLink, buildEconomicLink, buildEntityDetailsLink, buildFunctionalLink } from "../../utils/link";
import { filterGroups, groupByFunctional } from "../../utils/grouping";
import { formatCurrency } from "../../utils/formatter";
import { Entity, ExecutionLineItem } from "../../db/models";

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

export default async function aiBasicRoutes(fastify: FastifyInstance) {
  // Entities: simple search
  fastify.get(
    "/ai/v1/entities/search",
    {
      schema: {
        operationId: "getEntitiesSearch",
        tags: ["AI"],
        summary: "Find public institutions.",
        description:
          "Use this to help the user find a specific public institution when their query is ambiguous or they don't know the exact name or CUI (fiscal identifier). Returns a list of potential matches that the user can choose from.",
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
      const link = buildClientLink({ route: "/", view: "overview", filters: { search } });
      return ok(reply, { kind: "entities.search", query: { search, limit, offset }, link, items: nodes, pageInfo: { totalCount: total, limit: limit ?? 25, offset: offset ?? 0 } });
    }
  );

  // Economic classifications: search by code or name
  fastify.get(
    "/ai/v1/economic-classifications",
    {
      schema: {
        operationId: "getEconomicClassificationsSearch",
        tags: ["AI"],
        summary: "Search economic classifications (code or name) using romanian language.",
        description:
          `Find economic classification entries by code prefix or name keywords. Use this to locate a code (e.g., Salarii, Chirii, Constructii) before running entity analysis by economic code.`,
        querystring: {
          type: "object",
          properties: {
            search: { type: "string", description: "Keyword or code prefix (e.g., '10.01' or 'salarii')." },
            limit: { type: "integer", minimum: 1, maximum: 50 },
            offset: { type: "integer", minimum: 0 },
          },
          required: ["search"],
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const qs = request.query as any;
      const search: string = typeof qs?.search === "string" ? qs.search : "";
      const limit: number = typeof qs?.limit === "number" ? Math.min(Math.max(1, qs.limit), 50) : 10;
      const offset: number = typeof qs?.offset === "number" ? Math.max(0, qs.offset) : 0;
      if (!search.trim()) return bad(reply, "Invalid query");

      const [items, total] = await Promise.all([
        economicClassificationRepository.getAll({ search }, limit, offset),
        economicClassificationRepository.count({ search }),
      ]);

      return ok(reply, {
        kind: "economic-classifications.search",
        query: { search, limit, offset },
        items,
        pageInfo: { totalCount: total, limit, offset },
      });
    }
  );

  // Entity details (by cui or search)
  fastify.get("/ai/v1/entities/details", {
    schema: {
      operationId: "getEntityDetails",
      tags: ["AI"],
      summary: "Get high-level financial totals for an entity.",
      description: `Returns one-year totals (income and expenses) for a selected entity. Use for high-level questions like “How much did [entity] spend in <year>?”. Prefer 'entityCui' (exact); otherwise use 'entitySearch' (fuzzy). Include 'year'. Response contains a deep link at 'data.link'.`,
      querystring: {
        type: "object",
        properties: {
          entityCui: {
            type: "string",
            description: "Exact CUI (fiscal identifier) of the entity. Always prefer using this over 'search' if the CUI is known, as it guarantees an exact match.",
          },
          entitySearch: {
            type: "string",
            description: "Free-text fuzzy search. Use this when the CUI is unknown. Note: this returns the single best match, which may not be correct if the name is ambiguous.",
          },
          year: { type: "integer", minimum: 2016, maximum: 2100, default: 2024, description: "Reporting year for snapshot totals and execution lines" },
        },
      },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const qs = request.query as any;
    const entityCui: string | undefined = typeof qs?.entityCui === "string" && qs.entityCui.trim() ? qs.entityCui.trim() : undefined;
    const entitySearch: string | undefined = typeof qs?.entitySearch === "string" && qs.entitySearch.trim() ? qs.entitySearch.trim() : undefined;
    const year: number | undefined = typeof qs?.year === "number" ? qs.year : undefined;

    if (!year) return reply.code(400).send({ ok: false, error: "year is required" });
    let entity = entityCui ? await entityRepository.getById(entityCui) : undefined;
    if (!entity && entitySearch) {
      const results = await entityRepository.getAll({ search: entitySearch }, 1, 0);
      entity = results[0];
    }
    if (!entity) return reply.code(404).send({ ok: false, error: "Entity not found" });

    const yearlySnapshot = await executionLineItemRepository.getYearlySnapshotTotals(entity.cui, year);



    const details = {
      cui: entity.cui,
      name: (entity as any).name,
      address: (entity as any).address ?? null,
      totalIncome: yearlySnapshot.totalIncome,
      totalExpenses: yearlySnapshot.totalExpenses,
      totalIncomeHumanReadable: `The total income for ${entity.name} in ${year} was ${formatCurrency(yearlySnapshot.totalIncome, 'compact')} (${formatCurrency(yearlySnapshot.totalIncome, 'standard')})`,
      totalExpensesHumanReadable: `The total expenses for ${entity.name} in ${year} was ${formatCurrency(yearlySnapshot.totalExpenses, 'compact')} (${formatCurrency(yearlySnapshot.totalExpenses, 'standard')})`,
      summary: `In ${year}, ${entity.name} had a total income of ${formatCurrency(yearlySnapshot.totalIncome, 'compact')} (${formatCurrency(yearlySnapshot.totalIncome, 'standard')}) and a total expenses of ${formatCurrency(yearlySnapshot.totalExpenses, 'compact')} (${formatCurrency(yearlySnapshot.totalExpenses, 'standard')}).`,
    };

    const link = buildEntityDetailsLink(entity.cui, { year });
    return ok(reply, {
      kind: "entities.details",
      query: { cui: entity.cui, year },
      link,
      item: details,
    });
  });

  fastify.get("/ai/v1/entities/budget-analysis", {
    schema: {
      operationId: "getEntityBudgetAnalysis",
      summary: "Income and spending grouped by functional category (overview).",
      description: `One-year overview of income and expenses grouped by functional category (e.g., education, health, transport), sorted by amount. Identify entity by 'cui' or 'search'; 'year' is required. Response includes a deep link. For deep dives, use the functional or economic endpoints.`,
      querystring: {
        type: "object",
        properties: {
          cui: { type: "string", description: "Exact CUI of the entity (preferred when known)." },
          search: { type: "string", description: "Free-text fuzzy search when CUI is unknown." },
          year: { type: "integer", minimum: 2016, maximum: 2024, default: 2024, description: "Reporting year for the spending summary." },
        },
        required: ["year"],
      },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const qs = request.query as any;
    const cui: string | undefined = typeof qs?.cui === "string" && qs.cui.trim() ? qs.cui.trim() : undefined;
    const search: string | undefined = typeof qs?.search === "string" && qs.search.trim() ? qs.search.trim() : undefined;
    const year: number = qs.year;

    if (!year) return reply.code(400).send({ ok: false, error: "year is required" });
    const entity = await getEntity(cui, search);
    if (!entity) return reply.code(404).send({ ok: false, error: "Entity not found" });

    const budgetAnalysis = await getBudgetAnalysis({ entity, year, level: "group" });
    const details = {
      cui: entity.cui,
      name: (entity as any).name,
      ...budgetAnalysis,
    };


    const link = buildEntityDetailsLink(entity.cui, { year });
    return ok(reply, {
      kind: "entities.budget-analysis",
      query: { cui: entity.cui, year },
      link,
      item: details,
    });
  });


  fastify.get("/ai/v1/entities/budget-analysis-by-functional", {
    schema: {
      operationId: "getEntityBudgetAnalysisSpendingByFunctional",
      summary: "Deep dive by functional code (chapter or full code).",
      description: `Detailed breakdown for a single functional area. Accepts a 2-digit chapter (e.g., '65') or a full functional code (e.g., '65.04.02'). Required: 'entityCui', 'year', 'functionalCode'. Includes totals and, where applicable, economic composition. Response includes a deep link.`,
      querystring: {
        type: "object",
        properties: {
          entityCui: { type: "string", description: "Exact CUI of the entity." },
          year: { type: "integer", minimum: 2016, maximum: 2024, default: 2024, description: "Reporting year for the spending summary." },
          functionalCode: { type: "string", description: "Functional code to filter the breakdown. Use a 2-digit chapter (e.g., '65') or a full code (e.g., '65.04.02')." },
        },
        required: ["entityCui", "year", "functionalCode"],
      },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const qs = request.query as any;
    const entityCui: string = typeof qs?.entityCui === "string" && qs.entityCui.trim() ? qs.entityCui.trim() : "";
    const functionalCode: string = typeof qs?.functionalCode === "string" && qs.functionalCode.trim() ? qs.functionalCode.trim() : "";
    const year: number | undefined = typeof qs?.year === "number" ? qs.year : undefined;

    if (!year) return reply.code(400).send({ ok: false, error: "year is required" });

    console.log("entityCui, functionalCode, year", entityCui, functionalCode, year);

    const entity = await getEntity(entityCui);
    if (!entity) return reply.code(404).send({ ok: false, error: "Entity not found" });
    if (!functionalCode) return reply.code(400).send({ ok: false, error: "functionalCode is required" });

    const level = functionalCode.length === 2 ? "functional" : "economic";
    const budgetAnalysis = await getBudgetAnalysis({ entity, year, level, fnCode: functionalCode });
    const details = {
      cui: entity.cui,
      name: (entity as any).name,
      ...budgetAnalysis,
    };

    const type = budgetAnalysis.expenseGroups.length === 0 ? "income" : "expense";

    const link = buildFunctionalLink(entity.cui, functionalCode, type, year);
    return ok(reply, {
      kind: "entities.budget-analysis-spending-by-functional",
      query: { cui: entity.cui, year },
      link,
      item: details,
    });
  });


  fastify.get("/ai/v1/entities/budget-analysis-by-economic", {
    schema: {
      operationId: "getEntityBudgetAnalysisSpendingByEconomic",
      summary: "Deep dive by economic code (e.g., '10.01.01').",
      description: `Detailed breakdown filtered by an economic classification code (dotted format, e.g., '10.01.01' for salarii or the prefix '10.01' for all kind of salaries), showing where that code contributes across functional areas. Required: 'entityCui', 'year', 'economicCode'. Response includes a deep link.`,
      querystring: {
        type: "object",
        properties: {
          entityCui: { type: "string", description: "Exact CUI of the entity." },
          year: { type: "integer", minimum: 2016, maximum: 2024, default: 2024, description: "Reporting year for the spending summary." },
          economicCode: { type: "string", description: "Economic code to filter the breakdown; dotted format like '10.01.01'." }
        },
        required: ["entityCui", "year", "economicCode"],
      },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const qs = request.query as any;
    const entityCui: string = typeof qs?.entityCui === "string" && qs.entityCui.trim() ? qs.entityCui.trim() : "";
    const economicCode: string = typeof qs?.economicCode === "string" && qs.economicCode.trim() ? qs.economicCode.trim() : "";
    const year: number | undefined = typeof qs?.year === "number" ? qs.year : undefined;

    if (!year) return reply.code(400).send({ ok: false, error: "year is required" });

    const entity = await getEntity(entityCui);
    if (!entity) return reply.code(404).send({ ok: false, error: "Entity not found" });
    if (!economicCode) return reply.code(400).send({ ok: false, error: "economicCode is required" });

    const budgetAnalysis = await getBudgetAnalysis({ entity, year, level: "economic", ecCode: economicCode });
    const details = {
      cui: entity.cui,
      name: (entity as any).name,
      ...budgetAnalysis,
    };

    const type = budgetAnalysis.expenseGroups.length === 0 ? "income" : "expense";

    const link = buildEconomicLink(entity.cui, economicCode, type, year);
    return ok(reply, {
      kind: "entities.budget-analysis-spending-by-economic",
      query: { cui: entity.cui, year },
      link,
      item: details,
    });
  });
  return fastify;
}


interface GetBudgetAnalysisParams {
  entity: Entity;
  year: number;
  level: "group" | "functional" | "economic";
  fnCode?: string;
  ecCode?: string;
}

async function getBudgetAnalysis({ entity, year, level, fnCode, ecCode }: GetBudgetAnalysisParams) {

  const [expenseLineItems, incomeLineItems] = await Promise.all([
    executionLineItemRepository.getAll({ entity_cuis: [entity.cui], years: [year], account_category: "ch" }, { by: "amount", order: "DESC" }, 1000, 0),
    executionLineItemRepository.getAll({ entity_cuis: [entity.cui], years: [year], account_category: "vn" }, { by: "amount", order: "DESC" }, 1000, 0),
  ]);


  // Get the functional and economic names for the income line items
  const detailedLineItems = await Promise.all(expenseLineItems.map(async (li: ExecutionLineItem) => {
    const functionalClassification = li.functional_code ? await functionalClassificationRepository.getByCode(li.functional_code) : undefined;
    const economicClassification = li.economic_code ? await economicClassificationRepository.getByCode(li.economic_code) : undefined;
    return {
      ...li,
      functional_name: functionalClassification?.functional_name,
      economic_name: economicClassification?.economic_name,
    };
  }));

  const detailedIncomeLineItems = await Promise.all(incomeLineItems.map(async (li: ExecutionLineItem) => {
    const functionalClassification = li.functional_code ? await functionalClassificationRepository.getByCode(li.functional_code) : undefined;
    const economicClassification = li.economic_code ? await economicClassificationRepository.getByCode(li.economic_code) : undefined;
    return {
      ...li,
      functional_name: functionalClassification?.functional_name,
      economic_name: economicClassification?.economic_name,
    };
  }));


  let expenseGroups = groupByFunctional(detailedLineItems, entity.cui, "expense", year);
  let incomeGroups = groupByFunctional(detailedIncomeLineItems, entity.cui, "income", year);

  expenseGroups = filterGroups({ initialGroups: expenseGroups, fnCode, ecCode, level, type: "expense" });
  incomeGroups = filterGroups({ initialGroups: incomeGroups, fnCode, ecCode, level, type: "income" });

  let expenseGroupSummary: string | undefined = undefined;
  let incomeGroupSummary: string | undefined = undefined;

  if (expenseGroups.length > 0) {
    const total = expenseGroups.reduce((sum, ch) => sum + ch.totalAmount, 0);
    expenseGroupSummary = `The total expenses for ${entity.name} in ${year} were ${formatCurrency(total, 'compact')} (${formatCurrency(total, 'standard')})`;
  }
  if (incomeGroups.length > 0) {
    const total = incomeGroups.reduce((sum, ch) => sum + ch.totalAmount, 0);
    incomeGroupSummary = `The total income for ${entity.name} in ${year} were ${formatCurrency(total, 'compact')} (${formatCurrency(total, 'standard')})`;
  }

  return {
    expenseGroups,
    incomeGroups,
    expenseGroupSummary,
    incomeGroupSummary,
  };
}

async function getEntity(cui?: string, search?: string) {
  let entity = cui ? await entityRepository.getById(cui) : undefined;
  if (!entity && search) {
    const results = await entityRepository.getAll({ search }, 1, 0);
    entity = results[0];
  }
  if (!entity) {
    return null;
  }
  return entity;
}

/**
 * http://localhost:5173/entities/4305857?view=overview&year=2024
 * http://localhost:3000/ai/v1/entities/budget-analysis-by-functional?entityCui=4305857&functionalCode=84
 * http://localhost:3000/ai/v1/entities/budget-analysis-by-functional?entityCui=4305857&functionalCode=84.03
 * http://localhost:3000/ai/v1/economic-classifications?search=%22salarii%22
 * http://localhost:3000/ai/v1/entities/budget-analysis-by-economic?entityCui=4305857&economicCode=10.01
 */