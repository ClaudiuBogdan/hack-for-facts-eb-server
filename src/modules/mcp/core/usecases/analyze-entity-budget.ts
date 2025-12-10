/**
 * MCP Use Case: analyze_entity_budget
 *
 * Single entity budget breakdown with drill-down by classification.
 */

import { Decimal } from 'decimal.js';
import { ok, err, type Result } from 'neverthrow';

import {
  entityNotFoundError,
  entitySearchNotFoundError,
  databaseError,
  invalidInputError,
  type McpError,
} from '../errors.js';
import { normalizeClassificationCode, formatCompact } from '../utils.js';

import type { AnalyzeEntityBudgetInput, AnalyzeEntityBudgetOutput } from '../schemas/tools.js';

// ─────────────────────────────────────────────────────────────────────────────
// Dependencies
// ─────────────────────────────────────────────────────────────────────────────

interface EntityRow {
  cui: string;
  name: string;
  address?: string | null;
}

interface AggregatedLineItem {
  functional_code?: string | null;
  functional_name?: string | null;
  economic_code?: string | null;
  economic_name?: string | null;
  account_category: string;
  total_amount: number | Decimal;
}

interface AggregatedLineItemsResult {
  nodes: AggregatedLineItem[];
  pageInfo: {
    totalCount: number;
    hasNextPage: boolean;
    hasPreviousPage: boolean;
  };
}

export interface AnalyzeEntityBudgetDeps {
  entityRepo: {
    getById(cui: string): Promise<Result<EntityRow | null, unknown>>;
    getAll(
      filter: { search?: string },
      limit: number,
      offset: number
    ): Promise<Result<{ nodes: EntityRow[] }, unknown>>;
  };
  aggregatedLineItemsRepo: {
    getAggregatedLineItems(
      filter: Record<string, unknown>,
      limit: number,
      offset: number
    ): Promise<Result<AggregatedLineItemsResult, unknown>>;
  };
  shareLink: {
    create(url: string): Promise<Result<string, unknown>>;
  };
  config: {
    clientBaseUrl: string;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface BudgetGroup {
  code: string;
  name: string;
  amount: number;
  percentage: number;
  link?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Groups line items by functional or economic classification.
 */
function groupLineItems(
  items: AggregatedLineItem[],
  groupBy: 'functional' | 'economic',
  accountCategory: 'ch' | 'vn'
): Map<string, { name: string; amount: Decimal }> {
  const groups = new Map<string, { name: string; amount: Decimal }>();

  for (const item of items) {
    if (item.account_category !== accountCategory) continue;

    let code: string | null = null;
    let name: string | null = null;

    if (groupBy === 'functional') {
      code = item.functional_code ?? null;
      name = item.functional_name ?? null;
    } else {
      code = item.economic_code ?? null;
      name = item.economic_name ?? null;
    }

    if (code === null) continue;

    // Get the chapter level (first segment before dot, or whole code if no dot)
    const chapterCode = code.split('.')[0] ?? code;

    const existing = groups.get(chapterCode);
    const itemAmount =
      item.total_amount instanceof Decimal ? item.total_amount : new Decimal(item.total_amount);

    if (existing !== undefined) {
      existing.amount = existing.amount.plus(itemAmount);
    } else {
      groups.set(chapterCode, {
        name: name ?? chapterCode,
        amount: itemAmount,
      });
    }
  }

  return groups;
}

/**
 * Converts grouped data to output format with percentages.
 */
function toOutputGroups(
  groups: Map<string, { name: string; amount: Decimal }>,
  total: Decimal,
  baseUrl: string,
  cui: string,
  year: number,
  groupType: 'functional' | 'economic',
  accountCategory: 'ch' | 'vn'
): BudgetGroup[] {
  const result: BudgetGroup[] = [];

  for (const [code, data] of groups) {
    const percentage = total.isZero() ? 0 : data.amount.dividedBy(total).times(100).toNumber();

    const linkPath =
      groupType === 'functional'
        ? `/entities/${cui}/functional/${code}?year=${String(year)}&type=${accountCategory}`
        : `/entities/${cui}/economic/${code}?year=${String(year)}&type=${accountCategory}`;

    result.push({
      code,
      name: data.name,
      amount: data.amount.toNumber(),
      percentage,
      link: `${baseUrl}${linkPath}`,
    });
  }

  // Sort by amount descending
  result.sort((a, b) => b.amount - a.amount);

  return result;
}

/**
 * Creates a summary string for budget groups.
 */
function createGroupSummary(groups: BudgetGroup[], total: Decimal, label: string): string {
  if (groups.length === 0) {
    return `No ${label} recorded.`;
  }

  const topGroups = groups.slice(0, 3);
  const topParts = topGroups.map((g) => `${g.name} (${g.percentage.toFixed(1)}%)`);

  return `Total ${label}: ${formatCompact(total.toNumber())}. Top categories: ${topParts.join(', ')}.`;
}

/**
 * Builds the full link for an entity view.
 */
function buildEntityLink(baseUrl: string, cui: string, year: number, breakdown: string): string {
  const params = new URLSearchParams();
  params.set('year', String(year));
  if (breakdown !== 'overview') {
    params.set('breakdown', breakdown);
  }
  return `${baseUrl}/entities/${cui}?${params.toString()}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Use Case
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Analyze a single entity's budget with breakdown by classification.
 */
export async function analyzeEntityBudget(
  deps: AnalyzeEntityBudgetDeps,
  input: AnalyzeEntityBudgetInput
): Promise<Result<AnalyzeEntityBudgetOutput, McpError>> {
  const {
    entityCui,
    entitySearch,
    year,
    breakdown_by: breakdownBy = 'overview',
    functionalCode,
    economicCode,
  } = input;

  // 1. Resolve entity
  let entity: EntityRow | null = null;

  if (entityCui !== undefined && entityCui !== '') {
    const result = await deps.entityRepo.getById(entityCui);
    if (result.isErr()) {
      return err(databaseError());
    }
    entity = result.value;

    if (entity === null) {
      return err(entityNotFoundError(entityCui));
    }
  } else if (entitySearch !== undefined && entitySearch !== '') {
    const result = await deps.entityRepo.getAll({ search: entitySearch }, 1, 0);
    if (result.isErr()) {
      return err(databaseError());
    }

    const firstEntity = result.value.nodes[0];
    if (firstEntity === undefined) {
      return err(entitySearchNotFoundError(entitySearch));
    }
    entity = firstEntity;
  } else {
    return err(invalidInputError('Either entityCui or entitySearch is required'));
  }

  // 2. Build base filter for aggregated line items
  const baseFilter: Record<string, unknown> = {
    entity_cuis: [entity.cui],
    report_period: {
      type: 'YEAR',
      selection: { dates: [String(year)] },
    },
    report_type: 'Executie bugetara agregata la nivel de ordonator principal',
  };

  // Apply drill-down filter if specified
  if (breakdownBy === 'functional' && functionalCode !== undefined) {
    baseFilter['functional_prefixes'] = [normalizeClassificationCode(functionalCode) + '.'];
  }
  if (breakdownBy === 'economic' && economicCode !== undefined) {
    baseFilter['economic_prefixes'] = [normalizeClassificationCode(economicCode) + '.'];
  }

  // Build separate filters for expenses and income (account_category is required by repo)
  const expenseFilter: Record<string, unknown> = {
    ...baseFilter,
    account_category: 'ch',
  };

  const incomeFilter: Record<string, unknown> = {
    ...baseFilter,
    account_category: 'vn',
  };

  // 3. Fetch aggregated line items (separate queries for expenses and income)
  const [expenseResult, incomeResult] = await Promise.all([
    deps.aggregatedLineItemsRepo.getAggregatedLineItems(expenseFilter, 1000, 0),
    deps.aggregatedLineItemsRepo.getAggregatedLineItems(incomeFilter, 1000, 0),
  ]);

  if (expenseResult.isErr()) {
    return err(databaseError());
  }
  if (incomeResult.isErr()) {
    return err(databaseError());
  }

  // Combine items from both queries
  const items = [...expenseResult.value.nodes, ...incomeResult.value.nodes];

  // 4. Determine grouping dimension
  const groupBy: 'functional' | 'economic' = breakdownBy === 'economic' ? 'economic' : 'functional';

  // 5. Group expenses and income
  const expenseGroups = groupLineItems(items, groupBy, 'ch');
  const incomeGroups = groupLineItems(items, groupBy, 'vn');

  // Calculate totals
  let totalExpenses = new Decimal(0);
  let totalIncome = new Decimal(0);

  for (const group of expenseGroups.values()) {
    totalExpenses = totalExpenses.plus(group.amount);
  }
  for (const group of incomeGroups.values()) {
    totalIncome = totalIncome.plus(group.amount);
  }

  // 6. Convert to output format
  const outputExpenseGroups = toOutputGroups(
    expenseGroups,
    totalExpenses,
    deps.config.clientBaseUrl,
    entity.cui,
    year,
    groupBy,
    'ch'
  );

  const outputIncomeGroups = toOutputGroups(
    incomeGroups,
    totalIncome,
    deps.config.clientBaseUrl,
    entity.cui,
    year,
    groupBy,
    'vn'
  );

  // 7. Create summaries
  const expenseGroupSummary = createGroupSummary(outputExpenseGroups, totalExpenses, 'expenses');
  const incomeGroupSummary = createGroupSummary(outputIncomeGroups, totalIncome, 'income');

  // 8. Build and shorten link
  const fullLink = buildEntityLink(deps.config.clientBaseUrl, entity.cui, year, breakdownBy);
  const linkResult = await deps.shareLink.create(fullLink);
  const link = linkResult.isOk() ? linkResult.value : fullLink;

  // 9. Determine output kind
  const kind =
    breakdownBy === 'overview' ? 'entities.budget.overview' : `entities.budget.${breakdownBy}`;

  return ok({
    ok: true,
    kind,
    query: {
      cui: entity.cui,
      year,
    },
    link,
    item: {
      cui: entity.cui,
      name: entity.name,
      expenseGroups: outputExpenseGroups,
      incomeGroups: outputIncomeGroups,
      expenseGroupSummary,
      incomeGroupSummary,
    },
  });
}
