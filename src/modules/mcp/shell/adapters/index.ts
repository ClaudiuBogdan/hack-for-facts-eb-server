/**
 * MCP Repository Adapters
 *
 * Provides adapter functions that wrap existing repositories
 * to match the interfaces expected by MCP use cases.
 */

import { Decimal } from 'decimal.js';
import { ok, type Result } from 'neverthrow';

import type { AnalyzeEntityBudgetDeps } from '../../core/usecases/analyze-entity-budget.js';
import type { DiscoverFiltersDeps } from '../../core/usecases/discover-filters.js';
import type { ExploreBudgetBreakdownDeps } from '../../core/usecases/explore-budget-breakdown.js';
import type { GetEntitySnapshotDeps } from '../../core/usecases/get-entity-snapshot.js';
import type { RankEntitiesDeps } from '../../core/usecases/rank-entities.js';
import type { AggregatedLineItemsRepository } from '@/modules/aggregated-line-items/index.js';
import type {
  FunctionalClassificationRepository,
  EconomicClassificationRepository,
} from '@/modules/classification/index.js';
import type { EntityRepository } from '@/modules/entity/index.js';
import type { EntityAnalyticsRepository } from '@/modules/entity-analytics/index.js';
import type { ShortLinkRepository } from '@/modules/share/index.js';
import type { UATRepository } from '@/modules/uat/index.js';

export const makeEntityAdapter = (
  repo: EntityRepository
): DiscoverFiltersDeps['entityRepo'] & GetEntitySnapshotDeps['entityRepo'] => ({
  getById: async (cui) => {
    return repo.getById(cui);
  },
  getAll: async (filter, limit, offset) => {
    return repo.getAll(filter, limit, offset);
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// UAT Adapter
// ─────────────────────────────────────────────────────────────────────────────

export const makeUatAdapter = (repo: UATRepository): DiscoverFiltersDeps['uatRepo'] => ({
  getAll: async (filter, limit, offset) => {
    return repo.getAll(filter, limit, offset);
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Classification Adapters
// ─────────────────────────────────────────────────────────────────────────────

export const makeFunctionalClassificationAdapter = (
  repo: FunctionalClassificationRepository
): DiscoverFiltersDeps['functionalClassificationRepo'] => ({
  getAll: async (filter, limit, offset) => {
    // Only pass search if it's defined
    const searchFilter = filter.search !== undefined ? { search: filter.search } : {};
    const result = await repo.list(searchFilter, limit, offset);
    if (result.isErr()) {
      return result;
    }
    return ok({
      nodes: result.value.nodes.map((n) => ({
        functional_code: n.functional_code,
        functional_name: n.functional_name,
      })),
    });
  },
});

export const makeEconomicClassificationAdapter = (
  repo: EconomicClassificationRepository
): DiscoverFiltersDeps['economicClassificationRepo'] => ({
  getAll: async (filter, limit, offset) => {
    // Only pass search if it's defined
    const searchFilter = filter.search !== undefined ? { search: filter.search } : {};
    const result = await repo.list(searchFilter, limit, offset);
    if (result.isErr()) {
      return result;
    }
    return ok({
      nodes: result.value.nodes.map((n) => ({
        economic_code: n.economic_code,
        economic_name: n.economic_name,
      })),
    });
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Share Link Adapter
// ─────────────────────────────────────────────────────────────────────────────

export interface MakeShareLinkAdapterDeps {
  shortLinkRepo: ShortLinkRepository;
  publicBaseUrl: string;
}

/**
 * Creates a simple share link adapter for MCP.
 * Note: This creates links without proper hashing - for full functionality,
 * use the share module's createShortLink use case.
 */
export const makeShareLinkAdapter = (
  deps: MakeShareLinkAdapterDeps
): { create(url: string): Promise<Result<string, unknown>> } => ({
  create: async (url: string) => {
    // Generate a simple code from the URL (deterministic)
    const urlHash = simpleHash(url);
    const code = urlHash.substring(0, 16);

    // Parse URL for metadata
    let metadata: { path: string; query: Record<string, string | string[]> };
    try {
      const parsed = new URL(url);
      const query: Record<string, string | string[]> = {};
      parsed.searchParams.forEach((value, key) => {
        const existing = query[key];
        if (existing !== undefined) {
          if (Array.isArray(existing)) {
            existing.push(value);
          } else {
            query[key] = [existing, value];
          }
        } else {
          query[key] = value;
        }
      });
      metadata = { path: parsed.pathname, query };
    } catch {
      metadata = { path: url, query: {} };
    }

    const result = await deps.shortLinkRepo.createOrAssociateUser({
      code,
      originalUrl: url,
      userId: 'mcp-system',
      metadata,
    });

    if (result.isErr()) {
      // Fall back to original URL if short link creation fails
      return ok(url);
    }

    return ok(`${deps.publicBaseUrl}/share/${result.value.code}`);
  },
});

/**
 * Simple hash function for generating deterministic codes.
 * NOT cryptographically secure - use for short link code generation only.
 */
function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash + char) | 0;
  }
  // Convert to base36 and pad/truncate to 16 chars
  const base36 = Math.abs(hash).toString(36);
  return (base36 + base36 + base36 + base36).substring(0, 16).padEnd(16, '0');
}

// ─────────────────────────────────────────────────────────────────────────────
// Entity Analytics Adapter
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Adapts EntityAnalyticsRepository to the interface expected by rank_entities use case.
 *
 * Key difference: The actual repo returns `{ items, totalCount }` but the MCP use case
 * expects `{ rows, totalCount }`.
 */
export const makeEntityAnalyticsAdapter = (
  repo: EntityAnalyticsRepository
): RankEntitiesDeps['entityAnalyticsRepo'] => ({
  getEntityAnalytics: async (filter, sort, limit, offset) => {
    // Map sort field from string to EntityAnalyticsSortField
    const sortField = (sort?.by ?? 'AMOUNT') as Parameters<
      EntityAnalyticsRepository['getEntityAnalytics']
    >[3]['by'];
    const sortOrder = sort?.order ?? 'DESC';

    // Build factor map from report_period (required for SQL INNER JOIN factors)
    // Without factors, the query returns zero rows
    const factorMap = new Map<string, Decimal>();
    const reportPeriod = filter['report_period'] as
      | {
          selection?: {
            interval?: { start?: string; end?: string };
            dates?: string[];
          };
        }
      | undefined;

    if (reportPeriod?.selection !== undefined) {
      const selection = reportPeriod.selection;
      if (selection.interval !== undefined) {
        // Extract years from interval
        const startYear = parseInt(selection.interval.start ?? '2020', 10);
        const endYear = parseInt(selection.interval.end ?? '2024', 10);
        for (let year = startYear; year <= endYear; year++) {
          factorMap.set(String(year), new Decimal(1));
        }
      } else if (selection.dates !== undefined) {
        // Extract years from dates array
        for (const date of selection.dates) {
          const year = date.substring(0, 4);
          if (!factorMap.has(year)) {
            factorMap.set(year, new Decimal(1));
          }
        }
      }
    }

    // If no years extracted, use a default range
    if (factorMap.size === 0) {
      for (let year = 2016; year <= 2024; year++) {
        factorMap.set(String(year), new Decimal(1));
      }
    }

    // The MCP use case passes a filter that's already been converted to the internal format
    // by the use case itself. We cast to the expected type.
    const result = await repo.getEntityAnalytics(
      filter as unknown as Parameters<EntityAnalyticsRepository['getEntityAnalytics']>[0],
      factorMap,
      { limit, offset },
      { by: sortField, order: sortOrder },
      undefined
    );

    if (result.isErr()) {
      // Map error to unknown as expected by MCP interface
      return { isErr: () => true, isOk: () => false, error: result.error } as ReturnType<
        RankEntitiesDeps['entityAnalyticsRepo']['getEntityAnalytics']
      > extends Promise<infer R>
        ? R
        : never;
    }

    // Convert `items` to `rows` as expected by MCP use case
    return ok({
      rows: result.value.items.map((item) => ({
        entity_cui: item.entity_cui,
        entity_name: item.entity_name,
        entity_type: item.entity_type,
        uat_id: item.uat_id,
        county_code: item.county_code,
        county_name: item.county_name,
        population: item.population,
        amount: item.total_amount.toNumber(),
        total_amount: item.total_amount.toNumber(),
        per_capita_amount: item.per_capita_amount.toNumber(),
      })),
      totalCount: result.value.totalCount,
    });
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Aggregated Line Items Adapter
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Adapts AggregatedLineItemsRepository to the interface expected by MCP use cases.
 *
 * Key differences:
 * 1. Method name: MCP expects `getAggregatedLineItems`, repo has `getNormalizedAggregatedItems`
 * 2. Parameters: MCP passes (filter, limit, offset), repo expects (filter, factorMap, pagination, aggregateFilters)
 * 3. Return shape: MCP expects `{ nodes, pageInfo }`, repo returns `{ items, totalCount }`
 * 4. Field names: MCP expects `total_amount`, repo returns `amount`
 */
export const makeAggregatedLineItemsAdapter = (
  repo: AggregatedLineItemsRepository
): AnalyzeEntityBudgetDeps['aggregatedLineItemsRepo'] &
  ExploreBudgetBreakdownDeps['aggregatedLineItemsRepo'] => ({
  getAggregatedLineItems: async (filter, limit, offset) => {
    // Create an empty factor map (no normalization - each period gets multiplier of 1)
    const factorMap = new Map<string, Decimal>();

    // Extract years from filter's report_period to populate factor map
    const reportPeriod = filter['report_period'] as
      | {
          selection?: {
            interval?: { start?: string; end?: string };
            dates?: string[];
          };
        }
      | undefined;

    if (reportPeriod?.selection !== undefined) {
      const selection = reportPeriod.selection;
      if (selection.interval !== undefined) {
        // Extract years from interval
        const startYear = parseInt(selection.interval.start ?? '2020', 10);
        const endYear = parseInt(selection.interval.end ?? '2024', 10);
        for (let year = startYear; year <= endYear; year++) {
          factorMap.set(String(year), new Decimal(1));
        }
      } else if (selection.dates !== undefined) {
        // Extract years from dates array
        for (const date of selection.dates) {
          const year = date.substring(0, 4);
          if (!factorMap.has(year)) {
            factorMap.set(year, new Decimal(1));
          }
        }
      }
    }

    // If no years extracted, use a default range
    if (factorMap.size === 0) {
      for (let year = 2016; year <= 2024; year++) {
        factorMap.set(String(year), new Decimal(1));
      }
    }

    const result = await repo.getNormalizedAggregatedItems(
      filter as unknown as Parameters<
        AggregatedLineItemsRepository['getNormalizedAggregatedItems']
      >[0],
      factorMap,
      { limit, offset },
      undefined
    );

    if (result.isErr()) {
      // Map error to unknown as expected by MCP interface
      return { isErr: () => true, isOk: () => false, error: result.error } as ReturnType<
        AnalyzeEntityBudgetDeps['aggregatedLineItemsRepo']['getAggregatedLineItems']
      > extends Promise<infer R>
        ? R
        : never;
    }

    const { items, totalCount } = result.value;

    // Convert to MCP expected format
    const accountCategory =
      typeof filter['account_category'] === 'string' ? filter['account_category'] : 'ch';

    return ok({
      nodes: items.map((item) => ({
        functional_code: item.functional_code,
        functional_name: item.functional_name,
        economic_code: item.economic_code,
        economic_name: item.economic_name,
        account_category: accountCategory,
        total_amount: item.amount, // Decimal is kept as-is
      })),
      pageInfo: {
        totalCount,
        hasNextPage: offset + limit < totalCount,
        hasPreviousPage: offset > 0,
      },
    });
  },
});
