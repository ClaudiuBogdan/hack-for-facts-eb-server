import { formatCurrency, formatNumberRO } from "./formatter";
import { getChapterMap, getSubchapterMap, getEconomicChapterMap, getEconomicSubchapterMap } from "./functionalClassificationUtils";
import { AggregatedLineItem_Repo } from "../db/repositories/aggregatedLineItemsRepository";
import { AnalyticsFilter } from "../types";

/**
 * Classification dimension type
 */
export type ClassificationDimension = 'fn' | 'ec';

/**
 * Cross-dimensional constraint for filtering after pivot
 */
export interface CrossConstraint {
  /** Which dimension to constrain */
  dimension: ClassificationDimension;
  /** Code value to filter by (e.g., "540201") */
  code: string;
}

/**
 * Grouped budget item result
 */
export interface GroupedItem {
  /** Classification code at current depth (e.g., "54", "5402", "540201") */
  code: string;
  /** Human-readable label for this group */
  name: string;
  /** Total aggregated amount for this group */
  value: number;
  /** Total number of line items in this group */
  count: number;
  /** Whether this is a leaf node (deepest level, depth >= 6) */
  isLeaf: boolean;
  /** Percentage of total (0..1) */
  percentage: number;
  /** Human-readable summary */
  humanSummary?: string;
}

/**
 * Normalize code by removing non-numeric characters and dots
 */
function normalizeCode(code: string | null | undefined): string {
  return (code || '').replace(/[^0-9]/g, '');
}

/**
 * Format code with dot separators based on depth
 */
function formatCode(code: string, depth: number): string {
  const clean = normalizeCode(code);
  if (depth === 2) {
    return clean.substring(0, 2);
  } else if (depth === 4) {
    return `${clean.substring(0, 2)}.${clean.substring(2, 4)}`;
  } else if (depth === 6) {
    return `${clean.substring(0, 2)}.${clean.substring(2, 4)}.${clean.substring(4, 6)}`;
  }
  return clean;
}

/**
 * Calculate target grouping depth based on current path
 */
function calculateDepth(path: string[], rootDepth: 'chapter' | 'subchapter' | 'paragraph' = 'chapter'): number {
  if (path.length === 0) {
    return rootDepth === 'paragraph' ? 6 : rootDepth === 'subchapter' ? 4 : 2;
  }
  const lastCode = path[path.length - 1];
  const parts = lastCode.split('.').filter(p => p.length > 0);
  const currentDepth = parts.length * 2;
  const nextDepth = currentDepth + 2;
  if (nextDepth > 6) {
    return 6;
  }
  return nextDepth;
}

/**
 * Extract code prefix at specified depth
 */
function getGroupCode(code: string, depth: number): string {
  const clean = normalizeCode(code);
  return clean.substring(0, depth);
}

/**
 * Resolve human-readable label for a classification code
 */
function resolveLabel(
  code: string,
  sampleItem: AggregatedLineItem_Repo | undefined,
  dimension: ClassificationDimension,
  depth: number
): string {
  const formattedCode = formatCode(code, depth);

  // Functional classification: use maps for chapter/subchapter, avoid mixing with line-item names
  if (dimension === 'fn') {
    if (depth === 2) {
      const chapterMap = getChapterMap();
      const chapterCode = formattedCode.substring(0, 2);
      const name = chapterMap.get(chapterCode);
      return name || formattedCode;
    }
    if (depth === 4) {
      const subchapterMap = getSubchapterMap();
      const name = subchapterMap.get(formattedCode);
      // If subchapter not found in map, do NOT fall back to a line-item name; use code
      return name || formattedCode;
    }
    // Paragraph or deeper: use line-item name if available
    if (depth >= 6 && sampleItem) {
      const apiName = sampleItem.functional_name;
      if (apiName && apiName.trim()) return apiName.trim();
    }
    return formattedCode;
  }

  // Economic classification: use economic maps for chapter/subchapter, avoid mixing with line-item names
  if (dimension === 'ec') {
    if (depth === 2) {
      const chapterMap = getEconomicChapterMap();
      const name = chapterMap.get(formattedCode.substring(0, 2));
      return name || formattedCode;
    }
    if (depth === 4) {
      const subchapterMap = getEconomicSubchapterMap();
      const name = subchapterMap.get(formattedCode);
      return name || formattedCode;
    }
    if (depth >= 6 && sampleItem) {
      const apiName = sampleItem.economic_name;
      if (apiName && apiName.trim()) return apiName.trim();
    }
    return formattedCode;
  }
  return formattedCode;
}

/**
 * Group aggregated line items by classification codes
 * 
 * This is the main entry point for budget data grouping. It performs client-side
 * grouping and aggregation at the specified depth.
 * 
 * **Important:** The caller should apply path-based and exclusion filters at the 
 * database level before calling this function for optimal performance. This function
 * performs additional filtering for:
 * - Cross-dimensional constraints (pivoting)
 * - Economic code exclusions (if not filtered at DB level)
 * - Self-grouping prevention
 * 
 * @param rows - Pre-filtered aggregated line items from database
 * @param baseFilter - Base analytics filter used for building drilldown links
 * @param options - Grouping configuration
 */
export function groupAggregatedLineItems(
  rows: AggregatedLineItem_Repo[],
  baseFilter: AnalyticsFilter,
  options: {
    classification: ClassificationDimension;
    category: 'expense' | 'income';
    path?: string[];
    constraint?: CrossConstraint;
    rootDepth?: 'chapter' | 'subchapter' | 'paragraph';
    excludeEcCodes?: string[];
  }
): GroupedItem[] {
  const {
    classification,
    category,
    path = [],
    constraint,
    rootDepth = 'chapter',
    excludeEcCodes = []
  } = options;

  const INVALID_ECONOMIC_CODES = new Set(["0", "00.00.00"]);

  // Step 1: Calculate target grouping depth
  const targetDepth = calculateDepth(path, rootDepth);

  // Step 2: Filter line items based on criteria
  const currentCode = path.length > 0 ? normalizeCode(path[path.length - 1]) : null;

  const filtered = rows.filter(item => {
    // Filter 2a: Exclude specific economic codes
    if (excludeEcCodes.length > 0) {
      const ecChapter = normalizeCode(item.economic_code).substring(0, 2);
      if (excludeEcCodes.includes(ecChapter)) {
        return false;
      }
    }

    // Filter 2b: Exclude invalid economic codes
    if (INVALID_ECONOMIC_CODES.has(item.economic_code)) {
      return false;
    }

    // Filter 2c: Apply cross-constraint (for pivoted views)
    if (constraint) {
      const constraintCode = constraint.dimension === 'fn'
        ? item.functional_code
        : item.economic_code;
      const normalized = normalizeCode(constraintCode);
      const targetCode = normalizeCode(constraint.code);
      if (!normalized.startsWith(targetCode)) {
        return false;
      }
    }

    // Filter 2d: Filter by current path
    if (currentCode) {
      const code = classification === 'fn' ? item.functional_code : item.economic_code;
      const normalized = normalizeCode(code);
      if (!normalized.startsWith(currentCode)) {
        return false;
      }
    }

    return true;
  });

  // Step 3: Group by code prefix at target depth
  const groups = new Map<string, {
    value: number;
    count: number;
    items: AggregatedLineItem_Repo[]
  }>();

  filtered.forEach(item => {
    const code = classification === 'fn' ? item.functional_code : item.economic_code;
    const normalizedCode = normalizeCode(code);
    const groupCode = getGroupCode(normalizedCode, targetDepth);

    // Skip if groupCode matches the current path code (avoid self-grouping)
    if (groupCode === currentCode) {
      return;
    }

    if (!groups.has(groupCode)) {
      groups.set(groupCode, { value: 0, count: 0, items: [] });
    }

    const group = groups.get(groupCode)!;
    group.value += Number(item.amount) || 0;
    group.count += Number(item.count) || 0;
    group.items.push(item);
  });

  // Step 4: Calculate overall total for percentages
  let overallTotal = 0;
  for (const group of groups.values()) {
    overallTotal += group.value;
  }
  overallTotal = Number.isFinite(overallTotal) ? overallTotal : 0;

  const toPercent = (value: number): string => {
    if (!overallTotal || !Number.isFinite(value)) return "0%";
    const pct = (value / overallTotal) * 100;
    return `${formatNumberRO(pct, 'compact')}%`;
  };

  // Step 5: Resolve labels and create output
  const results: GroupedItem[] = [];
  for (const [code, data] of groups.entries()) {
    const label = resolveLabel(code, data.items[0], classification, targetDepth);

    // Build drilldown link
    const formattedCode = formatCode(code, targetDepth);

    const humanSummary = `The ${category} for ${classification === 'fn' ? 'functional' : 'economic'} category "${label}" was ${formatCurrency(data.value, 'compact')} (${formatCurrency(data.value, 'standard')}) — ${toPercent(data.value)} of total ${category}.`;

    results.push({
      code: formattedCode,
      name: label,
      value: data.value,
      count: data.count,
      isLeaf: targetDepth >= 6,
      percentage: overallTotal ? data.value / overallTotal : 0,
      humanSummary,
    });
  }

  // Step 6: Sort by value descending
  return results.sort((a, b) => b.value - a.value);
}
