import { Entity, ExecutionLineItem } from "../db/models";
import { entityRepository } from "../db/repositories/entityRepository";
import { executionLineItemRepository } from "../db/repositories/executionLineItemRepository";
import { functionalClassificationRepository } from "../db/repositories/functionalClassificationRepository";
import { economicClassificationRepository } from "../db/repositories/economicClassificationRepository";
import { uatRepository } from "../db/repositories/uatRepository";
import { aggregatedLineItemsRepository } from "../db/repositories/aggregatedLineItemsRepository";
import {
  computeNameMatchBoost,
  findEconomicCodesByName,
  findFunctionalCodesByName,
  getEconomicLevelInfo,
  getFunctionalLevelInfo,
} from "./data-analytics-agent/utils/classificationIndex";
import { ShortLinkService } from "./short-link";
import { buildClientLink, buildEconomicLink, buildEntityDetailsLink, buildFunctionalLink, buildEntityAnalyticsLink } from "../utils/link";
import { groupByFunctional, filterGroups } from "../utils/grouping";
import { groupAggregatedLineItems, type ClassificationDimension, type CrossConstraint, type GroupedItem } from "../utils/groupingNodes";
import { formatCurrency } from "../utils/formatter";
import { AnalyticsFilter, ReportPeriodInput } from "../types";
import { getSeriesColor } from "./data-analytics-agent/schemas/utils";

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
    summary: `In ${year}, ${entity.name
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

  // Fetch execution line items (using old API)
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

  // Enrich with classification names
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

  // Group using old nested hierarchy API
  let expenseGroups = groupByFunctional(detailedExpenseLineItems, entity.cui, "expense", year);
  let incomeGroups = groupByFunctional(detailedIncomeLineItems, entity.cui, "income", year);

  // Apply filters using old API
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

// -------------------------------------------------------------
// Analytics generation (generate_analytics)
// -------------------------------------------------------------

type Granularity = 'YEAR' | 'MONTH' | 'QUARTER';
type AccountCategoryIn = 'ch' | 'vn';
type NormalizationIn = 'total' | 'per_capita' | 'total_euro' | 'per_capita_euro';

interface AnalyticsPeriodIn {
  type: Granularity;
  selection:
  | { interval: { start: string; end: string }; dates?: undefined }
  | { dates: string[]; interval?: undefined };
}

interface AnalyticsSeriesFilterIn {
  accountCategory: AccountCategoryIn;
  entityCuis?: string[];
  uatIds?: string[]; // strings on input; will be converted to number[]
  countyCodes?: string[];
  regions?: string[];
  isUat?: boolean;
  functionalCodes?: string[];
  functionalPrefixes?: string[];
  economicCodes?: string[];
  economicPrefixes?: string[];
  expenseTypes?: ("dezvoltare" | "functionare")[];
  fundingSourceIds?: number[];
  budgetSectorIds?: number[];
  programCodes?: string[];
  exclude?: {
    entityCuis?: string[];
    uatIds?: string[];
    countyCodes?: string[];
    functionalCodes?: string[];
    functionalPrefixes?: string[];
    economicCodes?: string[];
    economicPrefixes?: string[];
  };
  normalization?: NormalizationIn;
  reportType?: string;
}

interface AnalyticsSeriesDefinitionIn {
  label?: string;
  filter: AnalyticsSeriesFilterIn;
}

interface GenerateAnalyticsInput {
  title?: string;
  description?: string;
  period: AnalyticsPeriodIn;
  series: AnalyticsSeriesDefinitionIn[];
}

interface DataPointOut { x: string; y: number }
interface SeriesStatisticsOut { min: number; max: number; avg: number; sum: number; count: number }
type AxisUnitOut = 'year' | 'month' | 'quarter';
type ValueUnitOut = 'RON' | 'RON/capita' | 'EUR' | 'EUR/capita';

interface AnalyticsSeriesResultOut {
  label: string;
  seriesId: string;
  xAxis: { name: string; unit: AxisUnitOut };
  yAxis: { name: string; unit: ValueUnitOut };
  dataPoints: DataPointOut[];
  statistics: SeriesStatisticsOut;
}

function getNormalizationUnit(norm?: NormalizationIn): ValueUnitOut {
  switch (norm) {
    case 'per_capita': return 'RON/capita';
    case 'total_euro': return 'EUR';
    case 'per_capita_euro': return 'EUR/capita';
    default: return 'RON';
  }
}

function axisUnitFromGranularity(g: Granularity): AxisUnitOut {
  return g === 'YEAR' ? 'year' : g === 'MONTH' ? 'month' : 'quarter';
}

function computeStats(points: DataPointOut[]): SeriesStatisticsOut {
  if (!points.length) return { min: 0, max: 0, avg: 0, sum: 0, count: 0 };
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let sum = 0;
  for (const p of points) {
    min = Math.min(min, p.y);
    max = Math.max(max, p.y);
    sum += p.y;
  }
  const count = points.length;
  const avg = count ? sum / count : 0;
  return { min, max, avg, sum, count };
}

function toReportPeriod(period: AnalyticsPeriodIn): ReportPeriodInput {
  return {
    type: period.type,
    selection: period.selection,
  } as ReportPeriodInput;
}

function parseUatIds(uatIds: string[] | undefined): string[] | undefined {
  if (!uatIds || uatIds.length === 0) return undefined;

  const parsed = uatIds.map((s) => {
    return String(s);
  });

  return parsed;
}

function toAnalyticsFilter(series: AnalyticsSeriesFilterIn, period: AnalyticsPeriodIn): AnalyticsFilter {
  return {
    account_category: series.accountCategory,
    report_type: series.reportType ?? 'Executie bugetara agregata la nivel de ordonator principal',
    report_period: toReportPeriod(period),
    entity_cuis: series.entityCuis,
    functional_codes: series.functionalCodes,
    functional_prefixes: series.functionalPrefixes,
    economic_codes: series.economicCodes,
    economic_prefixes: series.economicPrefixes,
    funding_source_ids: series.fundingSourceIds,
    budget_sector_ids: series.budgetSectorIds,
    expense_types: series.expenseTypes,
    program_codes: series.programCodes,
    county_codes: series.countyCodes,
    regions: series.regions,
    uat_ids: parseUatIds(series.uatIds),
    is_uat: series.isUat,
    normalization: series.normalization ?? 'total',
    exclude: {
      entity_cuis: series.exclude?.entityCuis,
      uat_ids: parseUatIds(series.exclude?.uatIds),
      county_codes: series.exclude?.countyCodes,
      functional_codes: series.exclude?.functionalCodes,
      functional_prefixes: series.exclude?.functionalPrefixes,
      economic_codes: series.exclude?.economicCodes,
      economic_prefixes: series.exclude?.economicPrefixes,
    },
  } as AnalyticsFilter;
}

interface EntityWithName {
  name?: string;
  [key: string]: any;
}

async function synthesizeLabel(def: AnalyticsSeriesDefinitionIn): Promise<string> {
  if (def.label && def.label.trim()) return def.label.trim();
  const parts: string[] = [];
  const f = def.filter;

  // Entities / UATs
  if (f.uatIds && f.uatIds.length) {
    const ids = f.uatIds.map((s) => parseInt(s, 10)).filter((n) => !Number.isNaN(n));
    if (ids.length) {
      try {
        const uats = await uatRepository.getAll({ ids }, Math.min(ids.length, 5), 0);
        if (Array.isArray(uats) && uats.length > 0) {
          const names = uats
            .map((u: EntityWithName) => u?.name)
            .filter((name): name is string => typeof name === 'string' && name.length > 0)
            .join(" + ");
          if (names) parts.push(names);
        }
      } catch (error) {
        console.error('Error fetching UAT names for label:', error);
      }
    }
  } else if (f.entityCuis && f.entityCuis.length) {
    try {
      const entities = await entityRepository.getAll({ cuis: f.entityCuis }, Math.min(f.entityCuis.length, 5), 0);
      if (Array.isArray(entities) && entities.length > 0) {
        const names = entities
          .map((e: EntityWithName) => e?.name)
          .filter((name): name is string => typeof name === 'string' && name.length > 0)
          .join(" + ");
        if (names) parts.push(names);
      }
    } catch (error) {
      console.error('Error fetching entity names for label:', error);
    }
  }

  // Classifications
  let fnNames: string[] = [];
  if (f.functionalCodes && f.functionalCodes.length) {
    const info = await getFunctionalLevelInfo(f.functionalCodes[0]);
    if (info?.subchapterName || info?.chapterName) fnNames.push(info.subchapterName ?? info.chapterName!);
  } else if (f.functionalPrefixes && f.functionalPrefixes.length) {
    const code = f.functionalPrefixes[0].replace(/\.$/, '');
    const info = await getFunctionalLevelInfo(code);
    if (info?.chapterName) fnNames.push(info.chapterName);
  }
  let ecNames: string[] = [];
  if (f.economicCodes && f.economicCodes.length) {
    const info = await getEconomicLevelInfo(f.economicCodes[0]);
    if (info?.subchapterName || info?.chapterName) ecNames.push(info.subchapterName ?? info.chapterName!);
  } else if (f.economicPrefixes && f.economicPrefixes.length) {
    const code = f.economicPrefixes[0].replace(/\.$/, '');
    const info = await getEconomicLevelInfo(code);
    if (info?.chapterName) ecNames.push(info.chapterName);
  }
  const cls = [...fnNames, ...ecNames].filter(Boolean).join(" — ");
  if (cls) parts.push(cls);

  // Normalization suffix
  if (f.normalization && f.normalization !== 'total') {
    const normText = f.normalization === 'per_capita' ? 'per capita' : (f.normalization === 'total_euro' ? 'EUR' : 'EUR per capita');
    parts.push(`(${normText})`);
  }

  if (!parts.length) {
    return `Series (${f.accountCategory.toUpperCase()})`;
  }
  return parts.join(" — ");
}

function pointsFromTrend(periodType: Granularity, rows: any[]): DataPointOut[] {
  if (periodType === 'YEAR') {
    return rows.map((r) => ({ x: String(r.year), y: Number(r.value) }));
  }
  if (periodType === 'MONTH') {
    return rows.map((r) => ({
      x: `${r.year}-${String(r.month).padStart(2, '0')}`,
      y: Number(r.value),
    }));
  }
  // QUARTER
  return rows.map((r) => ({ x: `${r.year}-Q${Number(r.quarter)}`, y: Number(r.value) }));
}

function suggestChartType(periodType: Granularity, seriesCount: number): 'line' | 'bar' | 'area' | 'pie' {
  if (periodType !== 'YEAR' || seriesCount > 1) return 'line';
  return 'line';
}

function makeChartId(): string {
  const rnd = Math.random().toString(36).slice(2, 8);
  return `chart-${Date.now()}-${rnd}`;
}

export async function generateAnalytics(input: GenerateAnalyticsInput): Promise<{
  ok: boolean;
  title: string;
  dataLink: string;
  dataSeries: AnalyticsSeriesResultOut[];
}> {
  const periodType = input.period.type;
  const xUnit = axisUnitFromGranularity(periodType);
  const suggested = suggestChartType(periodType, input.series.length);

  // Parallelize series processing for better performance
  const results: AnalyticsSeriesResultOut[] = await Promise.all(
    input.series.map(async (def, i) => {
      try {
        const label = await synthesizeLabel(def);
        const unit = getNormalizationUnit(def.filter.normalization);
        const xAxis = { name: periodType === 'YEAR' ? 'Year' : (periodType === 'MONTH' ? 'Month' : 'Quarter'), unit: xUnit };
        const yAxis = { name: 'Amount', unit };

        const filters = toAnalyticsFilter(def.filter, input.period);

        // Select trend function by period type
        let rows: any[] = [];
        if (periodType === 'YEAR') {
          rows = await executionLineItemRepository.getYearlyTrend(filters);
        } else if (periodType === 'MONTH') {
          rows = await executionLineItemRepository.getMonthlyTrend(filters);
        } else {
          rows = await executionLineItemRepository.getQuarterlyTrend(filters);
        }

        const dataPoints = pointsFromTrend(periodType, rows);
        const statistics = computeStats(dataPoints);
        const seriesId = `${i + 1}-${Math.random().toString(36).slice(2, 7)}`;

        return { label, seriesId, xAxis, yAxis, dataPoints, statistics };
      } catch (error) {
        console.error(`Error processing series ${i}:`, error);
        throw new Error(`Failed to process series ${i}: ${error instanceof Error ? error.message : String(error)}`);
      }
    })
  );

  const chartId = makeChartId();
  const title = input.title?.trim() || 'Analytics';
  const now = new Date().toISOString();

  // Build chart schema following the ChartSchema specification from charts.ts
  // Convert input series to proper SeriesConfiguration objects
  const chartSeries = input.series.map((def, i) => {
    const seriesLabel = results[i]?.label || `Series ${i + 1}`;
    const unit = getNormalizationUnit(def.filter.normalization);
    const filter = toAnalyticsFilter(def.filter, input.period);
    const color = getSeriesColor(filter);

    return {
      id: `series-${chartId}-${i}`,
      type: 'line-items-aggregated-yearly' as const,
      enabled: true,
      label: seriesLabel,
      unit,
      config: {
        visible: true,
        showDataLabels: false,
        color,
      },
      filter,
      createdAt: now,
      updatedAt: now,
    };
  });

  // Build proper ChartSchema object
  const chartSchema = {
    id: chartId,
    title,
    description: input.description,
    config: {
      chartType: suggested,
      showGridLines: true,
      showLegend: input.series.length > 1, // Show legend for multi-series charts
      showTooltip: true,
      editAnnotations: false, // MCP-generated charts are read-only
      showAnnotations: true,
    },
    series: chartSeries,
    annotations: [],
    createdAt: now,
    updatedAt: now,
  };

  // Serialize and URL-encode the chart schema
  const chartSchemaJson = JSON.stringify(chartSchema);
  const chartSchemaEncoded = encodeURIComponent(chartSchemaJson);

  // Validate environment variables
  const clientBase = (process.env.PUBLIC_CLIENT_BASE_URL || process.env.CLIENT_BASE_URL || '').replace(/\/$/, '');
  if (!clientBase) {
    console.warn('PUBLIC_CLIENT_BASE_URL or CLIENT_BASE_URL not configured - using localhost');
  }

  // Construct chart URL with embedded schema
  const chartUrl = `${clientBase || 'http://localhost:3000'}/charts/${chartId}?chart=${chartSchemaEncoded}`;

  let shortLinkUrl: string | undefined = undefined;

  try {
    // Use a system user for MCP-created links
    const res = await ShortLinkService.createShortLink('mcp-system', chartUrl);
    if (res && res.success && res.code) {
      shortLinkUrl = `${clientBase || 'https://transparenta.eu'}/share/${res.code}`;
    } else {
      console.warn('Short link creation did not return success:', res);
    }
  } catch (error) {
    // Log but don't fail - fallback to direct chartUrl
    console.error('Failed to create short link:', error instanceof Error ? error.message : String(error));
  }

  return {
    ok: true,
    dataLink: shortLinkUrl ?? chartUrl,
    title,
    dataSeries: results,
  };
}

// -------------------------------------------------------------
// Entity Analytics Hierarchy (generate_analytics_hierarchy)
// -------------------------------------------------------------

interface GenerateEntityAnalyticsHierarchyInput {
  period: AnalyticsPeriodIn;
  filter: AnalyticsSeriesFilterIn;
  classification?: ClassificationDimension;
  rootDepth?: 'chapter' | 'subchapter' | 'paragraph';
  path?: string[];
  excludeEcCodes?: string[];
  limit?: number;
  offset?: number;
}

export async function generateEntityAnalyticsHierarchy(input: GenerateEntityAnalyticsHierarchyInput): Promise<{
  ok: boolean;
  link: string;
  item: {
    expenseGroups?: GroupedItem[];
    incomeGroups?: GroupedItem[];
    expenseGroupSummary?: string;
    incomeGroupSummary?: string;
  };
}> {
  const {
    period,
    filter,
    classification: classification = 'fn',
    path = [],
    excludeEcCodes = [],
    rootDepth = 'chapter',
    limit,
    offset
  } = input;

  // Default to both categories if not specified
  const categoriesToProcess = [filter.accountCategory];

  let expenseGroups: GroupedItem[] | undefined;
  let incomeGroups: GroupedItem[] | undefined;
  let expenseGroupSummary: string | undefined;
  let incomeGroupSummary: string | undefined;

  // Process both expense and income categories
  for (const accountCategory of categoriesToProcess) {
    // Build base analytics filter
    const analyticsFilter = toAnalyticsFilter(
      { ...filter, accountCategory } as AnalyticsSeriesFilterIn,
      period
    );

    // Apply path-based filters to narrow database query
    if (path.length > 0) {
      const lastPathCode = path[path.length - 1];
      const pathParts = lastPathCode.split('.').filter(p => p);

      if (classification === 'fn') {
        // For functional classification, add functional filter
        if (pathParts.length === 1) {
          // Chapter level - use prefix
          analyticsFilter.functional_prefixes = [
            ...(analyticsFilter.functional_prefixes || []),
            `${lastPathCode}.`
          ];
        } else {
          // Subchapter or classification - use exact code
          analyticsFilter.functional_codes = [
            ...(analyticsFilter.functional_codes || []),
            lastPathCode
          ];
        }
      } else {
        // For economic classification, add economic filter
        if (pathParts.length === 1) {
          // Chapter level - use prefix
          analyticsFilter.economic_prefixes = [
            ...(analyticsFilter.economic_prefixes || []),
            `${lastPathCode}.`
          ];
        } else {
          // Subchapter or classification - use exact code
          analyticsFilter.economic_codes = [
            ...(analyticsFilter.economic_codes || []),
            lastPathCode
          ];
        }
      }
    }

    // Apply excludeEcCodes filter at database level for better performance
    if (excludeEcCodes && excludeEcCodes.length > 0) {
      analyticsFilter.exclude = analyticsFilter.exclude || {};
      analyticsFilter.exclude.economic_prefixes = [
        ...(analyticsFilter.exclude.economic_prefixes || []),
        ...excludeEcCodes.map(code => `${code}.`)
      ];
    }

    // Fetch all rows for accurate grouping; apply limit/offset only after grouping
    const { rows } = await aggregatedLineItemsRepository.getAggregatedLineItems(
      analyticsFilter
    );

    const categoryType = accountCategory === 'ch' ? 'expense' : 'income';
    const groups = groupAggregatedLineItems(rows, analyticsFilter, {
      classification,
      category: categoryType,
      path,
      constraint: undefined,
      rootDepth,
      excludeEcCodes,
    });

    if (groups.length > 0) {
      const total = groups.reduce((sum, group) => sum + (Number(group.value) || 0), 0);
      const summary = `The total ${categoryType} was ${formatCurrency(total, 'compact')} (${formatCurrency(total, 'standard')})`;

      // Apply limit/offset to the final grouped output only
      const start = Math.max(0, offset ?? 0);
      const end = limit !== undefined ? start + Math.max(0, limit) : undefined;
      const pagedGroups = groups.slice(start, end);

      if (accountCategory === 'ch') {
        expenseGroups = pagedGroups;
        expenseGroupSummary = summary;
      } else {
        incomeGroups = pagedGroups;
        incomeGroupSummary = summary;
      }
    }
  }

  // Build top-level link with full filter (no narrowing)
  const fullFilter = toAnalyticsFilter(
    { ...filter, accountCategory: categoriesToProcess[0] as AccountCategoryIn } as AnalyticsSeriesFilterIn,
    period
  );
  const link = buildEntityAnalyticsLink({ view: 'line-items', filter: fullFilter, treemapPrimary: classification, treemapDepth: rootDepth });

  return {
    ok: true,
    link,
    item: {
      expenseGroups,
      incomeGroups,
      expenseGroupSummary,
      incomeGroupSummary,
    },
  };
}
