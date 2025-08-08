import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { functionalClassificationRepository } from "../db/repositories/functionalClassificationRepository";
import { economicClassificationRepository } from "../db/repositories/economicClassificationRepository";
import { executionLineItemRepository } from "../db/repositories/executionLineItemRepository";
import { uatRepository } from "../db/repositories/uatRepository";
import { fundingSourceRepository } from "../db/repositories/fundingSourceRepository";
import { budgetSectorRepository } from "../db/repositories/budgetSectorRepository";
import { datasetRepository } from "../db/repositories/datasetRepository";
import { uatAnalyticsRepository } from "../db/repositories/uatAnalyticsRepository";
import { reportRepository } from "../db/repositories/reportRepository";
import { judetAnalyticsRepository } from "../db/repositories/judetAnalyticsRepository";
import { categoryAnalyticsRepository } from "../db/repositories/categoryAnalyticsRepository";
import { buildEconomicSearchLink, buildFunctionalSearchLink, buildUatSearchLink } from "../utils/link";

function ok(reply: FastifyReply, data: unknown) { return reply.code(200).send({ ok: true, data }); }
function bad(reply: FastifyReply, message: string, details?: unknown) { return reply.code(400).send({ ok: false, error: message, details }); }

const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(25).optional(),
  offset: z.coerce.number().int().min(0).default(0).optional(),
});

const classificationSearchQuery = paginationSchema.extend({ search: z.string().min(1) });
const uatSearchQuery = paginationSchema.extend({ search: z.string().min(1) });

export default async function aiAdvancedRoutes(fastify: FastifyInstance) {
  // Discovery for advanced endpoints
  fastify.get("/ai/v1/advanced", { schema: { tags: ["AI"], summary: "Discover advanced AI endpoints" } }, async (_req, reply) => {
    return ok(reply, {
      endpoints: [
        { path: "/ai/v1/classifications/functional/search" },
        { path: "/ai/v1/classifications/economic/search" },
        { path: "/ai/v1/classifications/functional/:code" },
        { path: "/ai/v1/classifications/economic/:code" },
        { path: "/ai/v1/uats/search" },
        { path: "/ai/v1/heatmap/uat" },
        { path: "/ai/v1/heatmap/judet" },
        { path: "/ai/v1/spending/summary" },
        { path: "/ai/v1/aggregates/functional" },
        { path: "/ai/v1/aggregates/economic" },
        { path: "/ai/v1/reports" },
        { path: "/ai/v1/funding-sources" },
        { path: "/ai/v1/budget-sectors" },
        { path: "/ai/v1/datasets" },
      ],
    });
  });

  // Functional classifications search
  fastify.get("/ai/v1/classifications/functional/search", { schema: { tags: ["AI"], summary: "Search functional classifications" } }, async (request: FastifyRequest, reply: FastifyReply) => {
    const parse = classificationSearchQuery.safeParse(request.query);
    if (!parse.success) return bad(reply, "Invalid query", parse.error.format());
    const { search, limit, offset } = parse.data;
    const [nodes, total] = await Promise.all([
      functionalClassificationRepository.getAll({ search }, limit, offset),
      functionalClassificationRepository.count({ search }),
    ]);
    const link = buildFunctionalSearchLink(search);
    return ok(reply, { kind: "classifications.functional.search", query: { search, limit, offset }, link, items: nodes, pageInfo: { totalCount: total, limit: limit ?? 25, offset: offset ?? 0 } });
  });

  // Economic classifications search
  fastify.get("/ai/v1/classifications/economic/search", { schema: { tags: ["AI"], summary: "Search economic classifications" } }, async (request: FastifyRequest, reply: FastifyReply) => {
    const parse = classificationSearchQuery.safeParse(request.query);
    if (!parse.success) return bad(reply, "Invalid query", parse.error.format());
    const { search, limit, offset } = parse.data;
    const [nodes, total] = await Promise.all([
      economicClassificationRepository.getAll({ search }, limit, offset),
      economicClassificationRepository.count({ search }),
    ]);
    const link = buildEconomicSearchLink(search);
    return ok(reply, { kind: "classifications.economic.search", query: { search, limit, offset }, link, items: nodes, pageInfo: { totalCount: total, limit: limit ?? 25, offset: offset ?? 0 } });
  });

  // Classification by code
  fastify.get("/ai/v1/classifications/functional/:code", { schema: { tags: ["AI"], summary: "Functional classification by code" } }, async (request: FastifyRequest, reply: FastifyReply) => {
    const code = (request as any).params?.code;
    const item = await functionalClassificationRepository.getByCode(code);
    if (!item) return reply.code(404).send({ ok: false, error: "Not found" });
    const link = buildFunctionalSearchLink(item.functional_code);
    return ok(reply, { kind: "classifications.functional.byCode", item, link });
  });
  fastify.get("/ai/v1/classifications/economic/:code", { schema: { tags: ["AI"], summary: "Economic classification by code" } }, async (request: FastifyRequest, reply: FastifyReply) => {
    const code = (request as any).params?.code;
    const item = await economicClassificationRepository.getByCode(code);
    if (!item) return reply.code(404).send({ ok: false, error: "Not found" });
    const link = buildEconomicSearchLink(item.economic_code);
    return ok(reply, { kind: "classifications.economic.byCode", item, link });
  });

  // UAT search
  fastify.get("/ai/v1/uats/search", { schema: { tags: ["AI"], summary: "Search UATs" } }, async (request: FastifyRequest, reply: FastifyReply) => {
    const parse = uatSearchQuery.safeParse(request.query);
    if (!parse.success) return bad(reply, "Invalid query", parse.error.format());
    const { search, limit, offset } = parse.data;
    const [nodes, total] = await Promise.all([uatRepository.getAll({ search }, limit, offset), uatRepository.count({ search })]);
    const link = buildUatSearchLink(search);
    return ok(reply, { kind: "uats.search", query: { search, limit, offset }, link, items: nodes, pageInfo: { totalCount: total, limit: limit ?? 25, offset: offset ?? 0 } });
  });

  // Spending summary
  fastify.get("/ai/v1/spending/summary", { schema: { tags: ["AI"], summary: "Aggregated spending summary and yearly trend" } }, async (request: FastifyRequest, reply: FastifyReply) => {
    const qs = request.query as any;
    if (!qs?.account_category || !qs?.years) return bad(reply, "account_category and years are required");
    const account_category = qs.account_category === "vn" ? "vn" : "ch";
    const years = String(qs.years).split(",").map((s) => parseInt(s.trim(), 10)).filter((n) => !Number.isNaN(n));
    const filters = { account_category, years, entity_cuis: qs.entity_cuis?.split(","), county_code: qs.county_code, economic_prefixes: qs.economic_prefixes?.split(","), functional_prefixes: qs.functional_prefixes?.split(",") } as any;
    const [totalAmount, yearlyTrend] = await Promise.all([executionLineItemRepository.getTotalAmount(filters), executionLineItemRepository.getYearlyTrend(filters)]);
    return ok(reply, { kind: "spending.summary", query: { account_category, years }, result: { totalAmount, yearlyTrend }, raw: { filters } });
  });

  // Heatmaps
  fastify.get("/ai/v1/heatmap/uat", { schema: { tags: ["AI"], summary: "UAT heatmap" } }, async (request: FastifyRequest, reply: FastifyReply) => {
    const qs = request.query as any;
    const account_categories = String(qs?.account_categories ?? "ch").split(",");
    const years = String(qs?.years ?? "").split(",").map((s) => parseInt(s.trim(), 10)).filter((n) => !Number.isNaN(n));
    if (years.length === 0) return bad(reply, "years must contain at least one number");
    const filter = { account_categories, years, functional_codes: qs.functional_codes?.split(","), economic_codes: qs.economic_codes?.split(","), normalization: qs.normalization, min_amount: qs.min_amount ? Number(qs.min_amount) : undefined, max_amount: qs.max_amount ? Number(qs.max_amount) : undefined, min_population: qs.min_population ? Number(qs.min_population) : undefined, max_population: qs.max_population ? Number(qs.max_population) : undefined } as any;
    const nodes = await uatAnalyticsRepository.getHeatmapData(filter);
    return ok(reply, { kind: "heatmap.uat", items: nodes });
  });
  fastify.get("/ai/v1/heatmap/judet", { schema: { tags: ["AI"], summary: "County heatmap" } }, async (request: FastifyRequest, reply: FastifyReply) => {
    const qs = request.query as any;
    const account_categories = String(qs?.account_categories ?? "ch").split(",");
    const years = String(qs?.years ?? "").split(",").map((s) => parseInt(s.trim(), 10)).filter((n) => !Number.isNaN(n));
    if (years.length === 0) return bad(reply, "years must contain at least one number");
    const filter = { account_categories, years, functional_codes: qs.functional_codes?.split(","), economic_codes: qs.economic_codes?.split(","), normalization: qs.normalization, min_amount: qs.min_amount ? Number(qs.min_amount) : undefined, max_amount: qs.max_amount ? Number(qs.max_amount) : undefined, min_population: qs.min_population ? Number(qs.min_population) : undefined, max_population: qs.max_population ? Number(qs.max_population) : undefined, county_codes: qs.county_codes?.split(",") } as any;
    const nodes = await judetAnalyticsRepository.getHeatmapJudetData(filter);
    return ok(reply, { kind: "heatmap.judet", items: nodes });
  });

  // Reports
  fastify.get("/ai/v1/reports", { schema: { tags: ["AI"], summary: "List reports" } }, async (request: FastifyRequest, reply: FastifyReply) => {
    const qs = request.query as any;
    const filter = { entity_cui: qs.entity_cui, reporting_year: qs.reporting_year ? Number(qs.reporting_year) : undefined, reporting_period: qs.reporting_period, report_date_start: qs.report_date_start, report_date_end: qs.report_date_end, search: qs.search } as any;
    const limit = qs?.limit ? Number(qs.limit) : 25;
    const offset = qs?.offset ? Number(qs.offset) : 0;
    const [nodes, total] = await Promise.all([reportRepository.getAll(filter, limit, offset), reportRepository.count(filter)]);
    return ok(reply, { kind: "reports.list", query: { ...filter, limit, offset }, items: nodes, pageInfo: { totalCount: total, limit, offset } });
  });

  // Aggregates
  fastify.get("/ai/v1/aggregates/functional", { schema: { tags: ["AI"], summary: "Aggregates by functional" } }, async (request: FastifyRequest, reply: FastifyReply) => {
    const qs = request.query as any;
    if (!qs?.account_category || !qs?.years) return bad(reply, "account_category and years are required");
    const account_category = qs.account_category === "vn" ? "vn" : "ch";
    const years = String(qs.years).split(",").map((s) => parseInt(s.trim(), 10)).filter((n) => !Number.isNaN(n));
    const { rows, totalCount } = await categoryAnalyticsRepository.getFunctionalAggregates({ account_category, years, functional_codes: qs.functional_codes?.split(","), functional_prefixes: qs.functional_prefixes?.split(","), county_codes: qs.county_codes?.split(","), funding_source_ids: qs.funding_source_ids?.split(",").map((s: string) => parseInt(s, 10)).filter((n: number) => !Number.isNaN(n)) }, qs.limit ? Number(qs.limit) : 50, qs.offset ? Number(qs.offset) : 0);
    return ok(reply, { kind: "aggregates.functional", items: rows, pageInfo: { totalCount, limit: qs.limit ?? 50, offset: qs.offset ?? 0 } });
  });
  fastify.get("/ai/v1/aggregates/economic", { schema: { tags: ["AI"], summary: "Aggregates by economic" } }, async (request: FastifyRequest, reply: FastifyReply) => {
    const qs = request.query as any;
    if (!qs?.account_category || !qs?.years) return bad(reply, "account_category and years are required");
    const account_category = qs.account_category === "vn" ? "vn" : "ch";
    const years = String(qs.years).split(",").map((s) => parseInt(s.trim(), 10)).filter((n) => !Number.isNaN(n));
    const { rows, totalCount } = await categoryAnalyticsRepository.getEconomicAggregates({ account_category, years, economic_codes: qs.economic_codes?.split(","), economic_prefixes: qs.economic_prefixes?.split(","), county_codes: qs.county_codes?.split(","), funding_source_ids: qs.funding_source_ids?.split(",").map((s: string) => parseInt(s, 10)).filter((n: number) => !Number.isNaN(n)) }, qs.limit ? Number(qs.limit) : 50, qs.offset ? Number(qs.offset) : 0);
    return ok(reply, { kind: "aggregates.economic", items: rows, pageInfo: { totalCount, limit: qs.limit ?? 50, offset: qs.offset ?? 0 } });
  });

  // Funding sources & budget sectors
  fastify.get("/ai/v1/funding-sources", { schema: { tags: ["AI"], summary: "List/search funding sources" } }, async (request: FastifyRequest, reply: FastifyReply) => {
    const qs = request.query as any;
    const search = typeof qs?.search === "string" && qs.search.trim() ? qs.search.trim() : undefined;
    const limitN = qs?.limit ? Number(qs.limit) : 25;
    const offsetN = qs?.offset ? Number(qs.offset) : 0;
    const [nodes, total] = await Promise.all([fundingSourceRepository.getAll({ search }, limitN, offsetN), fundingSourceRepository.count({ search })]);
    return ok(reply, { kind: "fundingSources.list", items: nodes, pageInfo: { totalCount: total, limit: limitN, offset: offsetN } });
  });
  fastify.get("/ai/v1/budget-sectors", { schema: { tags: ["AI"], summary: "List/search budget sectors" } }, async (request: FastifyRequest, reply: FastifyReply) => {
    const qs = request.query as any;
    const search = typeof qs?.search === "string" && qs.search.trim() ? qs.search.trim() : undefined;
    const limitN = qs?.limit ? Number(qs.limit) : 25;
    const offsetN = qs?.offset ? Number(qs.offset) : 0;
    const [nodes, total] = await Promise.all([budgetSectorRepository.getAll({ search }, limitN, offsetN), budgetSectorRepository.count({ search })]);
    return ok(reply, { kind: "budgetSectors.list", items: nodes, pageInfo: { totalCount: total, limit: limitN, offset: offsetN } });
  });

  // Datasets
  fastify.get("/ai/v1/datasets", { schema: { tags: ["AI"], summary: "List/search curated datasets" } }, async (request: FastifyRequest, reply: FastifyReply) => {
    const qs = request.query as any;
    const search = typeof qs?.search === "string" && qs.search.trim() ? qs.search.trim() : undefined;
    const ids = typeof qs?.ids === "string" && qs.ids.trim() ? qs.ids.split(",").map((s: string) => s.trim()).filter(Boolean) : undefined;
    const limitN = typeof qs?.limit === "number" ? qs.limit : 100;
    const offsetN = typeof qs?.offset === "number" ? qs.offset : 0;
    const filter = { search, ids } as any;
    const nodes = datasetRepository.getAll(filter, limitN, offsetN);
    const total = datasetRepository.count(filter);
    return ok(reply, { kind: "datasets.list", items: nodes, pageInfo: { totalCount: total, limit: limitN, offset: offsetN } });
  });

  return fastify;
}


