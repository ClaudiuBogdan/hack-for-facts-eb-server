/**
 * MCP Use Case: discover_filters
 *
 * Resolves Romanian names/terms to machine-usable filter values.
 * Supports entities, UATs, and classification codes.
 */

import { ok, err, type Result } from 'neverthrow';

import {
  invalidCategoryError,
  databaseError,
  invalidInputError,
  type McpError,
} from '../errors.js';
import {
  DEFAULT_FILTER_LIMIT,
  MAX_FILTER_LIMIT,
  BEST_MATCH_THRESHOLD,
  type FilterCategory,
  type FilterKey,
} from '../types.js';

import type { DiscoverFiltersInput, DiscoverFiltersOutput } from '../schemas/tools.js';

// ─────────────────────────────────────────────────────────────────────────────
// Dependencies
// ─────────────────────────────────────────────────────────────────────────────

interface EntityRow {
  cui: string;
  name: string;
  address?: string | null;
  entity_type?: string | null;
  uat_id?: number | null;
  relevance?: number;
}

interface UATRow {
  id: number;
  name: string;
  county_code?: string | null;
  population?: number | null;
  relevance?: number;
}

interface FunctionalClassificationRow {
  functional_code: string;
  functional_name?: string | null;
  relevance?: number;
}

interface EconomicClassificationRow {
  economic_code: string;
  economic_name?: string | null;
  relevance?: number;
}

export interface DiscoverFiltersDeps {
  entityRepo: {
    getAll(
      filter: { search?: string },
      limit: number,
      offset: number
    ): Promise<Result<{ nodes: EntityRow[] }, unknown>>;
  };
  uatRepo: {
    getAll(
      filter: { search?: string },
      limit: number,
      offset: number
    ): Promise<Result<{ nodes: UATRow[] }, unknown>>;
  };
  functionalClassificationRepo: {
    getAll(
      filter: { search?: string },
      limit: number,
      offset: number
    ): Promise<Result<{ nodes: FunctionalClassificationRow[] }, unknown>>;
  };
  economicClassificationRepo: {
    getAll(
      filter: { search?: string },
      limit: number,
      offset: number
    ): Promise<Result<{ nodes: EconomicClassificationRow[] }, unknown>>;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal Result Type
// ─────────────────────────────────────────────────────────────────────────────

interface InternalFilterResult {
  name: string;
  category: FilterCategory;
  context?: string;
  score: number;
  filterKey: FilterKey;
  filterValue: string;
  metadata?: Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Clamps a value between min and max.
 */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Converts relevance score to 0-1 range.
 */
function toScore(relevance: unknown): number {
  if (typeof relevance !== 'number' || Number.isNaN(relevance)) {
    return 0.5; // Default score
  }
  return clamp(relevance, 0, 1);
}

/**
 * Determines filter key for functional classification codes.
 */
function keyForFunctional(code: string): FilterKey {
  return code.endsWith('.') ? 'functional_prefixes' : 'functional_codes';
}

/**
 * Determines filter key for economic classification codes.
 */
function keyForEconomic(code: string): FilterKey {
  return code.endsWith('.') ? 'economic_prefixes' : 'economic_codes';
}

/**
 * Computes name match boost for scoring.
 */
function computeNameMatchBoost(name: string | null | undefined, query: string): number {
  if (name === null || name === undefined) return 0;
  const nameLower = name.toLowerCase();
  const queryLower = query.toLowerCase();

  if (nameLower === queryLower) return 0.3; // Exact match
  if (nameLower.startsWith(queryLower)) return 0.2; // Prefix match
  if (nameLower.includes(queryLower)) return 0.1; // Contains match
  return 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Search Functions
// ─────────────────────────────────────────────────────────────────────────────

async function searchEntities(
  deps: DiscoverFiltersDeps,
  query: string,
  limit: number
): Promise<Result<InternalFilterResult[], McpError>> {
  const result = await deps.entityRepo.getAll({ search: query }, limit, 0);
  if (result.isErr()) {
    return err(databaseError());
  }

  const results: InternalFilterResult[] = result.value.nodes.map((row) => {
    const item: InternalFilterResult = {
      name: row.name,
      category: 'entity',
      score: toScore(row.relevance) + computeNameMatchBoost(row.name, query),
      filterKey: 'entity_cuis',
      filterValue: row.cui,
      metadata: { cui: row.cui },
    };

    if (row.address !== null && row.address !== undefined) {
      item.context = `Address: ${row.address}`;
    }
    if (row.entity_type !== null && row.entity_type !== undefined && item.metadata !== undefined) {
      item.metadata['entityType'] = row.entity_type;
    }
    if (row.uat_id !== null && row.uat_id !== undefined && item.metadata !== undefined) {
      item.metadata['uatId'] = row.uat_id;
    }

    return item;
  });

  return ok(results);
}

async function searchUATs(
  deps: DiscoverFiltersDeps,
  query: string,
  limit: number
): Promise<Result<InternalFilterResult[], McpError>> {
  const result = await deps.uatRepo.getAll({ search: query }, limit, 0);
  if (result.isErr()) {
    return err(databaseError());
  }

  const results: InternalFilterResult[] = result.value.nodes.map((row) => {
    const item: InternalFilterResult = {
      name: row.name,
      category: 'uat',
      score: toScore(row.relevance) + computeNameMatchBoost(row.name, query),
      filterKey: 'uat_ids',
      filterValue: String(row.id),
      metadata: { uatId: String(row.id) },
    };

    if (row.county_code !== null && row.county_code !== undefined) {
      item.context = `County: ${row.county_code}`;
      if (item.metadata !== undefined) {
        item.metadata['countyCode'] = row.county_code;
      }
    }
    if (row.population !== null && row.population !== undefined && item.metadata !== undefined) {
      item.metadata['population'] = row.population;
    }

    return item;
  });

  return ok(results);
}

async function searchFunctionalClassifications(
  deps: DiscoverFiltersDeps,
  query: string,
  limit: number
): Promise<Result<InternalFilterResult[], McpError>> {
  const result = await deps.functionalClassificationRepo.getAll({ search: query }, limit, 0);
  if (result.isErr()) {
    return err(databaseError());
  }

  const results: InternalFilterResult[] = result.value.nodes.map((row) => {
    const code = row.functional_code;
    const key = keyForFunctional(code);

    return {
      name: row.functional_name ?? code,
      category: 'functional_classification' as FilterCategory,
      context: `COFOG: ${code}`,
      score: toScore(row.relevance) + computeNameMatchBoost(row.functional_name, query),
      filterKey: key,
      filterValue: code,
      metadata: {
        code,
        codeKind: key === 'functional_prefixes' ? 'prefix' : 'exact',
      },
    };
  });

  return ok(results);
}

async function searchEconomicClassifications(
  deps: DiscoverFiltersDeps,
  query: string,
  limit: number
): Promise<Result<InternalFilterResult[], McpError>> {
  const result = await deps.economicClassificationRepo.getAll({ search: query }, limit, 0);
  if (result.isErr()) {
    return err(databaseError());
  }

  const results: InternalFilterResult[] = result.value.nodes.map((row) => {
    const code = row.economic_code;
    const key = keyForEconomic(code);

    return {
      name: row.economic_name ?? code,
      category: 'economic_classification' as FilterCategory,
      context: `Economic: ${code}`,
      score: toScore(row.relevance) + computeNameMatchBoost(row.economic_name, query),
      filterKey: key,
      filterValue: code,
      metadata: {
        code,
        codeKind: key === 'economic_prefixes' ? 'prefix' : 'exact',
      },
    };
  });

  return ok(results);
}

// ─────────────────────────────────────────────────────────────────────────────
// Use Case
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Discover filter values by searching for Romanian names/terms.
 */
export async function discoverFilters(
  deps: DiscoverFiltersDeps,
  input: DiscoverFiltersInput
): Promise<Result<DiscoverFiltersOutput, McpError>> {
  const { category, query, limit: inputLimit } = input;

  // Validate input
  const trimmedQuery = query.trim();
  if (trimmedQuery === '') {
    return err(invalidInputError('Query cannot be empty'));
  }

  const limit = clamp(inputLimit ?? DEFAULT_FILTER_LIMIT, 1, MAX_FILTER_LIMIT);

  // Route to appropriate search function
  let searchResult: Result<InternalFilterResult[], McpError>;

  switch (category) {
    case 'entity':
      searchResult = await searchEntities(deps, trimmedQuery, limit);
      break;
    case 'uat':
      searchResult = await searchUATs(deps, trimmedQuery, limit);
      break;
    case 'functional_classification':
      searchResult = await searchFunctionalClassifications(deps, trimmedQuery, limit);
      break;
    case 'economic_classification':
      searchResult = await searchEconomicClassifications(deps, trimmedQuery, limit);
      break;
    default:
      return err(invalidCategoryError(category as string));
  }

  if (searchResult.isErr()) {
    return err(searchResult.error);
  }

  // Sort by score descending
  const sortedResults = searchResult.value.sort((a, b) => b.score - a.score);

  // Identify best match if score is high enough
  const bestMatch =
    sortedResults[0] !== undefined && sortedResults[0].score >= BEST_MATCH_THRESHOLD
      ? sortedResults[0]
      : undefined;

  // Build output
  const output: DiscoverFiltersOutput = {
    ok: true,
    results: sortedResults,
  };

  if (bestMatch !== undefined) {
    output.bestMatch = bestMatch;
  }

  return ok(output);
}
