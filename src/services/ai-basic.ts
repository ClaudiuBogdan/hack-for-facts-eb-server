import { Entity, ExecutionLineItem } from "../db/models";
import { entityRepository } from "../db/repositories/entityRepository";
import { executionLineItemRepository } from "../db/repositories/executionLineItemRepository";
import { functionalClassificationRepository } from "../db/repositories/functionalClassificationRepository";
import { economicClassificationRepository } from "../db/repositories/economicClassificationRepository";
import { uatRepository } from "../db/repositories/uatRepository";
import {
  computeNameMatchBoost,
  findEconomicCodesByName,
  findFunctionalCodesByName,
  getEconomicLevelInfo,
  getFunctionalLevelInfo,
} from "./data-analytics-agent/utils/classificationIndex";
import { buildClientLink, buildEconomicLink, buildEntityDetailsLink, buildFunctionalLink } from "../utils/link";
import { filterGroups, groupByFunctional } from "../utils/grouping";
import { formatCurrency } from "../utils/formatter";

export async function getEntityOrNull(entityCui?: string, entitySearch?: string): Promise<Entity | null> {
  let entity = entityCui ? await entityRepository.getById(entityCui) : undefined;
  if (!entity && entitySearch) {
    const results = await entityRepository.getAll({ search: entitySearch }, 1, 0);
    entity = results[0];
  }
  return entity ?? null;
}

export async function searchEntities(params: { search: string; limit?: number; offset?: number }) {
  const search = params.search;
  const limit = typeof params.limit === "number" ? Math.min(Math.max(1, params.limit), 10) : 10;
  const offset = typeof params.offset === "number" ? Math.max(0, params.offset) : 0;

  const [items, total] = await Promise.all([
    entityRepository.getAll({ search }, limit, offset),
    entityRepository.count({ search }),
  ]);
  const link = buildClientLink({ route: "/", view: "overview", filters: { search } });
  return {
    kind: "entities.search" as const,
    query: { search, limit, offset },
    link,
    items,
    pageInfo: { totalCount: total, limit, offset },
  };
}

export async function searchEconomicClassifications(params: { search: string; limit?: number; offset?: number }) {
  const search = params.search;
  const limit = typeof params.limit === "number" ? Math.min(Math.max(1, params.limit), 50) : 10;
  const offset = typeof params.offset === "number" ? Math.max(0, params.offset) : 0;

  const [items, total] = await Promise.all([
    economicClassificationRepository.getAll({ search }, limit, offset),
    economicClassificationRepository.count({ search }),
  ]);

  return {
    kind: "economic-classifications.search" as const,
    query: { search, limit, offset },
    items,
    pageInfo: { totalCount: total, limit, offset },
  };
}

export async function getEntityDetails(params: { entityCui?: string; entitySearch?: string; year: number }) {
  const { entityCui, entitySearch, year } = params;
  if (!year) throw new Error("year is required");

  const entity = await getEntityOrNull(entityCui, entitySearch);
  if (!entity) throw new Error("Entity not found");

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
    totalIncomeHumanReadable: `The total income for ${entity.name} in ${year} was ${formatCurrency(
      yearlySnapshot.totalIncome,
      "compact"
    )} (${formatCurrency(yearlySnapshot.totalIncome, "standard")})`,
    totalExpensesHumanReadable: `The total expenses for ${entity.name} in ${year} was ${formatCurrency(
      yearlySnapshot.totalExpenses,
      "compact"
    )} (${formatCurrency(yearlySnapshot.totalExpenses, "standard")})`,
    summary: `In ${year}, ${
      entity.name
    } had a total income of ${formatCurrency(
      yearlySnapshot.totalIncome,
      "compact"
    )} (${formatCurrency(yearlySnapshot.totalIncome, "standard")}) and a total expenses of ${formatCurrency(
      yearlySnapshot.totalExpenses,
      "compact"
    )} (${formatCurrency(yearlySnapshot.totalExpenses, "standard")}).`,
  };

  const link = buildEntityDetailsLink(entity.cui, { year });
  return {
    kind: "entities.details" as const,
    query: { cui: entity.cui, year },
    link,
    item: details,
  };
}

type BudgetLevel = "group" | "functional" | "economic";

export async function getEntityBudgetAnalysis(params: {
  entityCui?: string;
  entitySearch?: string;
  year: number;
  level: BudgetLevel;
  fnCode?: string;
  ecCode?: string;
}) {
  const { entityCui, entitySearch, year, level, fnCode, ecCode } = params;
  if (!year) throw new Error("year is required");

  const entity = await getEntityOrNull(entityCui, entitySearch);
  if (!entity) throw new Error("Entity not found");

  const { expenseGroups, incomeGroups, expenseGroupSummary, incomeGroupSummary } = await computeBudgetGroups({
    entity,
    year,
    level,
    fnCode,
    ecCode,
  });

  const item = {
    cui: entity.cui,
    name: (entity as any).name,
    expenseGroups,
    incomeGroups,
    expenseGroupSummary,
    incomeGroupSummary,
  };

  if (level === "functional") {
    const type = expenseGroups.length === 0 ? "income" : "expense";
    const link = buildFunctionalLink(entity.cui, fnCode ?? "", type, year);
    return {
      kind: "entities.budget-analysis-spending-by-functional" as const,
      query: { cui: entity.cui, year },
      link,
      item,
    };
  }

  if (level === "economic") {
    const type = expenseGroups.length === 0 ? "income" : "expense";
    const link = buildEconomicLink(entity.cui, ecCode ?? "", type, year);
    return {
      kind: "entities.budget-analysis-spending-by-economic" as const,
      query: { cui: entity.cui, year },
      link,
      item,
    };
  }

  // level === "group"
  const link = buildEntityDetailsLink(entity.cui, { year });
  return {
    kind: "entities.budget-analysis" as const,
    query: { cui: entity.cui, year },
    link,
    item,
  };
}

async function computeBudgetGroups({
  entity,
  year,
  level,
  fnCode,
  ecCode,
}: {
  entity: Entity;
  year: number;
  level: BudgetLevel;
  fnCode?: string;
  ecCode?: string;
}) {
  const report_period = { type: "YEAR", selection: { interval: { start: `${year}-01`, end: `${year}-01` } } } as const;
  const default_report_type = "Executie bugetara agregata la nivel de ordonator principal";
  const [expenseLineItems, incomeLineItems] = await Promise.all([
    executionLineItemRepository.getAll(
      { entity_cuis: [entity.cui], report_period, report_type: default_report_type, account_category: "ch" } as any,
      { by: "ytd_amount", order: "DESC" },
      1000,
      0
    ),
    executionLineItemRepository.getAll(
      { entity_cuis: [entity.cui], report_period, report_type: default_report_type, account_category: "vn" } as any,
      { by: "ytd_amount", order: "DESC" },
      1000,
      0
    ),
  ]);

  const detailedExpenseLineItems = await Promise.all(
    expenseLineItems.map(async (li: ExecutionLineItem) => {
      const functionalClassification = li.functional_code
        ? await functionalClassificationRepository.getByCode(li.functional_code)
        : undefined;
      const economicClassification = li.economic_code
        ? await economicClassificationRepository.getByCode(li.economic_code)
        : undefined;
      return {
        ...li,
        functional_name: functionalClassification?.functional_name,
        economic_name: economicClassification?.economic_name,
      } as any;
    })
  );

  const detailedIncomeLineItems = await Promise.all(
    incomeLineItems.map(async (li: ExecutionLineItem) => {
      const functionalClassification = li.functional_code
        ? await functionalClassificationRepository.getByCode(li.functional_code)
        : undefined;
      const economicClassification = li.economic_code
        ? await economicClassificationRepository.getByCode(li.economic_code)
        : undefined;
      return {
        ...li,
        functional_name: functionalClassification?.functional_name,
        economic_name: economicClassification?.economic_name,
      } as any;
    })
  );

  let expenseGroups = groupByFunctional(detailedExpenseLineItems, entity.cui, "expense", year);
  let incomeGroups = groupByFunctional(detailedIncomeLineItems, entity.cui, "income", year);

  expenseGroups = filterGroups({ initialGroups: expenseGroups, fnCode, ecCode, level, type: "expense" });
  incomeGroups = filterGroups({ initialGroups: incomeGroups, fnCode, ecCode, level, type: "income" });

  let expenseGroupSummary: string | undefined = undefined;
  let incomeGroupSummary: string | undefined = undefined;

  if (expenseGroups.length > 0) {
    const total = expenseGroups.reduce((sum: number, ch: any) => sum + ch.totalAmount, 0);
    expenseGroupSummary = `The total expenses for ${entity.name} in ${year} were ${formatCurrency(total, "compact")} (${formatCurrency(total, "standard")})`;
  }
  if (incomeGroups.length > 0) {
    const total = incomeGroups.reduce((sum: number, ch: any) => sum + ch.totalAmount, 0);
    incomeGroupSummary = `The total income for ${entity.name} in ${year} were ${formatCurrency(total, "compact")} (${formatCurrency(total, "standard")})`;
  }

  return {
    expenseGroups,
    incomeGroups,
    expenseGroupSummary,
    incomeGroupSummary,
  };
}


// -------------------------------------------------------------
// Unified Search Filters Tool (service layer)
// -------------------------------------------------------------

type SearchFiltersCategory =
  | "entity"
  | "uat"
  | "functional_classification"
  | "economic_classification";

type FilterKey =
  | "entity_cuis"
  | "uat_ids"
  | "functional_prefixes"
  | "functional_codes"
  | "economic_prefixes"
  | "economic_codes";

interface SearchFiltersInput {
  category: SearchFiltersCategory;
  query: string;
  limit?: number;
}

interface BaseResult {
  name: string;
  category: SearchFiltersCategory;
  context?: string;
  score: number;
  filterKey: FilterKey;
  filterValue: string;
  metadata?: any;
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function toScore(v: any): number {
  const n = typeof v === "number" ? v : undefined;
  if (n === undefined || Number.isNaN(n)) return 1;
  return Math.max(0, Math.min(1, n));
}

function keyForFunctional(code: string): FilterKey {
  return code.endsWith(".") ? "functional_prefixes" : "functional_codes";
}

function keyForEconomic(code: string): FilterKey {
  return code.endsWith(".") ? "economic_prefixes" : "economic_codes";
}

export async function searchFilters(input: SearchFiltersInput): Promise<{
  ok: boolean;
  results: BaseResult[];
  bestMatch?: BaseResult;
  totalMatches?: number;
}> {
  const category = input.category;
  const query = (input.query ?? "").trim();
  const limit = clamp(typeof input.limit === "number" ? input.limit : 3, 1, 50);

  if (!query) {
    throw new Error("query is required");
  }

  if (category === "entity") {
    const rows = await entityRepository.getAll({ search: query }, limit, 0);
    const results: BaseResult[] = rows.map((r: any) => ({
      name: String(r.name ?? r.cui ?? ""),
      category,
      context: r.address ? `Address: ${r.address}` : undefined,
      score: toScore(r.relevance),
      filterKey: "entity_cuis",
      filterValue: String(r.cui),
      metadata: { cui: r.cui, entityType: r.entity_type ?? undefined, uatId: r.uat_id ?? undefined },
    }));

    const sorted = results.sort((a, b) => b.score - a.score);
    const bestMatch = sorted[0] && sorted[0].score >= 0.85 ? sorted[0] : undefined;
    return { ok: true, results: sorted, bestMatch };
  }

  if (category === "uat") {
    const rows = await uatRepository.getAll({ search: query }, limit, 0);
    const results: BaseResult[] = rows.map((r: any) => ({
      name: String(r.name ?? r.id ?? ""),
      category,
      context: r.county_code ? `County: ${r.county_code}` : undefined,
      score: toScore(r.relevance),
      filterKey: "uat_ids",
      filterValue: String(r.id),
      metadata: { uatId: String(r.id), countyCode: r.county_code ?? undefined, population: r.population ?? undefined },
    }));

    const sorted = results.sort((a, b) => b.score - a.score);
    const bestMatch = sorted[0] && sorted[0].score >= 0.85 ? sorted[0] : undefined;
    return { ok: true, results: sorted, bestMatch };
  }

  if (category === "functional_classification") {
    // Expand with chapter/subchapter name matches
    const nameCodes = await findFunctionalCodesByName(query);
    const prefQueries = Array.from(new Set(nameCodes.map((c) => `fn:${c}`)));

    const primary = await functionalClassificationRepository.getAll({ search: query }, limit, 0);
    const expanded: any[] = [...primary];
    // Optionally fetch more by code prefixes derived from names
    for (const p of prefQueries) {
      const more = await functionalClassificationRepository.getAll({ search: p }, Math.max(0, limit - expanded.length), 0);
      for (const m of more) {
        if (!expanded.find((e) => e.functional_code === m.functional_code)) expanded.push(m);
      }
      if (expanded.length >= limit) break;
    }

    const enriched: BaseResult[] = [];
    for (const r of expanded.slice(0, limit)) {
      const code: string = String(r.functional_code);
      const key = keyForFunctional(code);
      const info = await getFunctionalLevelInfo(code);
      const contextParts = [`COFOG: ${code}`];
      if (info?.chapterCode && info?.chapterName) contextParts.push(`Chapter: ${info.chapterCode} ${info.chapterName}`);
      if (info?.subchapterCode && info?.subchapterName) contextParts.push(`Subchapter: ${info.subchapterCode} ${info.subchapterName}`);

      const base = toScore(r.relevance);
      let score = base;
      // Boosts when query matches known names
      score += computeNameMatchBoost(r.functional_name, query);
      score += computeNameMatchBoost(info?.chapterName, query);
      score += computeNameMatchBoost(info?.subchapterName, query);
      // Slight penalty for pure code-only when no names present
      if (!r.functional_name) score = Math.max(0, score - 0.05);
      score = Math.min(1, score);

      enriched.push({
        name: String(r.functional_name ?? info?.subchapterName ?? info?.chapterName ?? code),
        category,
        context: contextParts.join(" | "),
        score,
        filterKey: key,
        filterValue: code,
        metadata: {
          code,
          codeKind: key === "functional_prefixes" ? "prefix" : "exact",
          chapterCode: info?.chapterCode,
          chapterName: info?.chapterName,
          subchapterCode: info?.subchapterCode,
          subchapterName: info?.subchapterName,
        },
      });
    }

    const sorted = enriched.sort((a, b) => b.score - a.score);
    const bestMatch = sorted[0] && sorted[0].score >= 0.85 ? sorted[0] : undefined;
    return { ok: true, results: sorted, bestMatch };
  }

  if (category === "economic_classification") {
    const nameCodes = await findEconomicCodesByName(query);
    const prefQueries = Array.from(new Set(nameCodes.map((c) => `ec:${c}`)));

    const primary = await economicClassificationRepository.getAll({ search: query }, limit, 0);
    const expanded: any[] = [...primary];
    for (const p of prefQueries) {
      const more = await economicClassificationRepository.getAll({ search: p }, Math.max(0, limit - expanded.length), 0);
      for (const m of more) {
        if (!expanded.find((e) => e.economic_code === m.economic_code)) expanded.push(m);
      }
      if (expanded.length >= limit) break;
    }

    const enriched: BaseResult[] = [];
    for (const r of expanded.slice(0, limit)) {
      const code: string = String(r.economic_code);
      const key = keyForEconomic(code);
      const info = await getEconomicLevelInfo(code);
      const contextParts = [`Economic: ${code}`];
      if (info?.chapterCode && info?.chapterName) contextParts.push(`Chapter: ${info.chapterCode} ${info.chapterName}`);
      if (info?.subchapterCode && info?.subchapterName) contextParts.push(`Subchapter: ${info.subchapterCode} ${info.subchapterName}`);

      const base = toScore(r.relevance);
      let score = base;
      score += computeNameMatchBoost(r.economic_name, query);
      score += computeNameMatchBoost(info?.chapterName, query);
      score += computeNameMatchBoost(info?.subchapterName, query);
      if (!r.economic_name) score = Math.max(0, score - 0.05);
      score = Math.min(1, score);

      enriched.push({
        name: String(r.economic_name ?? info?.subchapterName ?? info?.chapterName ?? code),
        category,
        context: contextParts.join(" | "),
        score,
        filterKey: key,
        filterValue: code,
        metadata: {
          code,
          codeKind: key === "economic_prefixes" ? "prefix" : "exact",
          chapterCode: info?.chapterCode,
          chapterName: info?.chapterName,
          subchapterCode: info?.subchapterCode,
          subchapterName: info?.subchapterName,
        },
      });
    }

    const sorted = enriched.sort((a, b) => b.score - a.score);
    const bestMatch = sorted[0] && sorted[0].score >= 0.85 ? sorted[0] : undefined;
    return { ok: true, results: sorted, bestMatch };
  }

  throw new Error(`Unsupported category: ${category}`);
}

