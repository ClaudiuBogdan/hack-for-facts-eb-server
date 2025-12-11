/**
 * MCP Use Case: explore_budget_breakdown
 *
 * Hierarchical budget exploration with progressive drill-down.
 */

import { Decimal } from 'decimal.js';
import { ok, err, type Result } from 'neverthrow';

import { databaseError, toMcpError, type McpError } from '../errors.js';
import {
  validatePeriodSelection,
  normalizeClassificationCode,
  normalizeFilterClassificationCodes,
  formatCompact,
  clamp,
} from '../utils.js';

import type {
  ExploreBudgetBreakdownInput,
  ExploreBudgetBreakdownOutput,
} from '../schemas/tools.js';

// ─────────────────────────────────────────────────────────────────────────────
// Dependencies
// ─────────────────────────────────────────────────────────────────────────────

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

export interface ExploreBudgetBreakdownDeps {
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

interface GroupedItem {
  code: string;
  name: string;
  value: number;
  count: number;
  isLeaf: boolean;
  percentage: number;
  humanSummary?: string;
  link?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_BREAKDOWN_LIMIT = 20;
const MAX_BREAKDOWN_LIMIT = 100;

/**
 * Maximum depth considered a leaf node.
 * Classification codes are dot-separated segments:
 * chapter.subchapter.paragraph.subparagraph.alinea.subalinea
 */
const LEAF_DEPTH = 6;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Gets the depth of a classification code (number of segments).
 */
function getCodeDepth(code: string): number {
  return code.split('.').filter((s) => s !== '').length;
}

/**
 * Gets the parent prefix at a specific depth.
 */
function getCodeAtDepth(code: string, depth: number): string {
  const segments = code.split('.').filter((s) => s !== '');
  return segments.slice(0, depth).join('.');
}

/**
 * Gets the starting depth based on rootDepth option.
 */
function getStartingDepth(rootDepth: string | undefined): number {
  switch (rootDepth) {
    case 'subchapter':
      return 2;
    case 'paragraph':
      return 3;
    case 'chapter':
    default:
      return 1;
  }
}

/**
 * Groups line items by classification code at a specific depth.
 */
function groupByCodeAtDepth(
  items: AggregatedLineItem[],
  classification: 'fn' | 'ec',
  depth: number,
  accountCategory: 'ch' | 'vn'
): Map<string, { name: string; amount: Decimal; count: number; maxDepth: number }> {
  const groups = new Map<
    string,
    { name: string; amount: Decimal; count: number; maxDepth: number }
  >();

  for (const item of items) {
    if (item.account_category !== accountCategory) continue;

    const code = classification === 'fn' ? item.functional_code : item.economic_code;
    const name = classification === 'fn' ? item.functional_name : item.economic_name;

    if (code === null || code === undefined) continue;

    const codeAtDepth = getCodeAtDepth(code, depth);
    if (codeAtDepth === '') continue;

    const itemAmount =
      item.total_amount instanceof Decimal ? item.total_amount : new Decimal(item.total_amount);

    const itemDepth = getCodeDepth(code);

    const existing = groups.get(codeAtDepth);
    if (existing !== undefined) {
      existing.amount = existing.amount.plus(itemAmount);
      existing.count += 1;
      existing.maxDepth = Math.max(existing.maxDepth, itemDepth);
    } else {
      groups.set(codeAtDepth, {
        name: name ?? codeAtDepth,
        amount: itemAmount,
        count: 1,
        maxDepth: itemDepth,
      });
    }
  }

  return groups;
}

/**
 * Converts grouped data to output format.
 */
function toGroupedItems(
  groups: Map<string, { name: string; amount: Decimal; count: number; maxDepth: number }>,
  total: Decimal,
  baseUrl: string,
  classification: 'fn' | 'ec',
  filter: Record<string, unknown>,
  period: ExploreBudgetBreakdownInput['period']
): GroupedItem[] {
  const result: GroupedItem[] = [];

  for (const [code, data] of groups) {
    const percentage = total.isZero() ? 0 : data.amount.dividedBy(total).times(100).toNumber();

    const isLeaf = data.maxDepth >= LEAF_DEPTH || data.count === 1;

    // Create human-friendly summary
    const humanSummary = `${data.name}: ${formatCompact(data.amount.toNumber())} (${percentage.toFixed(1)}% of total)`;

    // Build base item
    const item: GroupedItem = {
      code,
      name: data.name,
      value: data.amount.toNumber(),
      count: data.count,
      isLeaf,
      percentage,
      humanSummary,
    };

    // Add drill-down link if not a leaf
    if (!isLeaf) {
      const drillDownFilter = {
        ...filter,
        [classification === 'fn' ? 'functional_prefixes' : 'economic_prefixes']: [code + '.'],
      };

      const params = new URLSearchParams();
      params.set('view', 'breakdown');
      params.set('classification', classification);
      params.set('period', JSON.stringify(period));
      params.set('filter', JSON.stringify(drillDownFilter));

      item.link = `${baseUrl}/analytics?${params.toString()}`;
    }

    result.push(item);
  }

  // Sort by value descending
  result.sort((a, b) => b.value - a.value);

  return result;
}

/**
 * Creates a summary for grouped items.
 */
function createGroupSummary(groups: GroupedItem[], total: Decimal, label: string): string {
  if (groups.length === 0) {
    return `No ${label} in this breakdown.`;
  }

  const topGroups = groups.slice(0, 3);
  const topParts = topGroups.map((g) => `${g.name} (${g.percentage.toFixed(1)}%)`);

  return `Total ${label}: ${formatCompact(total.toNumber())}. Top: ${topParts.join(', ')}.`;
}

/**
 * Builds the full link for the breakdown view.
 */
function buildBreakdownLink(
  baseUrl: string,
  classification: 'fn' | 'ec',
  filter: Record<string, unknown>,
  period: ExploreBudgetBreakdownInput['period']
): string {
  const params = new URLSearchParams();
  params.set('view', 'breakdown');
  params.set('classification', classification);
  params.set('period', JSON.stringify(period));
  params.set('filter', JSON.stringify(filter));
  return `${baseUrl}/analytics?${params.toString()}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Use Case
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Explore budget hierarchically with progressive drill-down.
 */
export async function exploreBudgetBreakdown(
  deps: ExploreBudgetBreakdownDeps,
  input: ExploreBudgetBreakdownInput
): Promise<Result<ExploreBudgetBreakdownOutput, McpError>> {
  const {
    period,
    filter,
    classification = 'fn',
    path,
    rootDepth,
    excludeEcCodes,
    limit: inputLimit,
    offset: inputOffset,
  } = input;

  // Validate period
  const periodValidation = validatePeriodSelection(period.selection, period.type);
  if (periodValidation.isErr()) {
    return err(periodValidation.error);
  }

  // Normalize filter
  const normalizedFilter = normalizeFilterClassificationCodes(filter as Record<string, unknown>);

  // Build internal filter
  const reportType = normalizedFilter['reportType'];
  const internalFilter: Record<string, unknown> = {
    account_category: normalizedFilter['accountCategory'],
    report_type:
      typeof reportType === 'string'
        ? reportType
        : 'Executie bugetara agregata la nivel de ordonator principal',
    report_period: {
      type: period.type,
      selection: period.selection,
    },
  };

  // Copy filter fields (mapping camelCase to snake_case for repo)
  const fieldMappings: [string, string][] = [
    ['entityCuis', 'entity_cuis'],
    ['entity_cuis', 'entity_cuis'],
    ['uatIds', 'uat_ids'],
    ['uat_ids', 'uat_ids'],
    ['countyCodes', 'county_codes'],
    ['county_codes', 'county_codes'],
    ['functionalCodes', 'functional_codes'],
    ['functional_codes', 'functional_codes'],
    ['functionalPrefixes', 'functional_prefixes'],
    ['functional_prefixes', 'functional_prefixes'],
    ['economicCodes', 'economic_codes'],
    ['economic_codes', 'economic_codes'],
    ['economicPrefixes', 'economic_prefixes'],
    ['economic_prefixes', 'economic_prefixes'],
  ];

  for (const [inputField, outputField] of fieldMappings) {
    if (normalizedFilter[inputField] !== undefined) {
      internalFilter[outputField] = normalizedFilter[inputField];
    }
  }

  // Apply path-based prefix filter
  if (path !== undefined && path.length > 0) {
    const lastCode = path[path.length - 1];
    if (lastCode !== undefined) {
      const normalizedCode = normalizeClassificationCode(lastCode);
      const prefixField = classification === 'fn' ? 'functional_prefixes' : 'economic_prefixes';
      internalFilter[prefixField] = [normalizedCode + '.'];
    }
  }

  // Apply economic exclusions
  if (excludeEcCodes !== undefined && excludeEcCodes.length > 0) {
    const existingExclude = internalFilter['exclude'];
    const exclude: Record<string, unknown> =
      typeof existingExclude === 'object' && existingExclude !== null
        ? (existingExclude as Record<string, unknown>)
        : {};
    exclude['economic_prefixes'] = excludeEcCodes.map((c) => normalizeClassificationCode(c) + '.');
    internalFilter['exclude'] = exclude;
  }

  // Calculate pagination
  const limit = clamp(inputLimit ?? DEFAULT_BREAKDOWN_LIMIT, 1, MAX_BREAKDOWN_LIMIT);
  const offset = Math.max(inputOffset ?? 0, 0);

  // Fetch aggregated line items
  const itemsResult = await deps.aggregatedLineItemsRepo.getAggregatedLineItems(
    internalFilter,
    10000, // Fetch all for grouping
    0
  );

  if (itemsResult.isErr()) {
    const domainError = itemsResult.error as { type?: string; message?: string; cause?: unknown };
    if (domainError.type !== undefined) {
      return err(toMcpError({ type: domainError.type, message: domainError.message ?? '' }));
    }
    // Extract error message for debugging
    const errorDetail =
      domainError.message ??
      (itemsResult.error instanceof Error ? itemsResult.error.message : undefined);
    return err(databaseError(errorDetail));
  }

  const items = itemsResult.value.nodes;

  // Determine grouping depth
  const startDepth = getStartingDepth(rootDepth);
  const pathDepth = path !== undefined ? path.length : 0;
  const groupDepth = startDepth + pathDepth;

  // Group by classification
  const expenseGroups = groupByCodeAtDepth(items, classification, groupDepth, 'ch');
  const incomeGroups = groupByCodeAtDepth(items, classification, groupDepth, 'vn');

  // Calculate totals
  let totalExpenses = new Decimal(0);
  let totalIncome = new Decimal(0);

  for (const group of expenseGroups.values()) {
    totalExpenses = totalExpenses.plus(group.amount);
  }
  for (const group of incomeGroups.values()) {
    totalIncome = totalIncome.plus(group.amount);
  }

  // Convert to output format
  const outputExpenseGroups = toGroupedItems(
    expenseGroups,
    totalExpenses,
    deps.config.clientBaseUrl,
    classification,
    internalFilter,
    period
  ).slice(offset, offset + limit);

  const outputIncomeGroups = toGroupedItems(
    incomeGroups,
    totalIncome,
    deps.config.clientBaseUrl,
    classification,
    internalFilter,
    period
  ).slice(offset, offset + limit);

  // Create summaries
  const expenseGroupSummary = createGroupSummary(outputExpenseGroups, totalExpenses, 'expenses');
  const incomeGroupSummary = createGroupSummary(outputIncomeGroups, totalIncome, 'income');

  // Build shareable link
  const fullLink = buildBreakdownLink(
    deps.config.clientBaseUrl,
    classification,
    internalFilter,
    period
  );
  const linkResult = await deps.shareLink.create(fullLink);
  const link = linkResult.isOk() ? linkResult.value : fullLink;

  // Build the item object, only including arrays if non-empty
  const item: ExploreBudgetBreakdownOutput['item'] = {
    expenseGroupSummary,
    incomeGroupSummary,
  };

  if (outputExpenseGroups.length > 0) {
    item.expenseGroups = outputExpenseGroups;
  }
  if (outputIncomeGroups.length > 0) {
    item.incomeGroups = outputIncomeGroups;
  }

  return ok({
    ok: true,
    link,
    item,
  });
}
