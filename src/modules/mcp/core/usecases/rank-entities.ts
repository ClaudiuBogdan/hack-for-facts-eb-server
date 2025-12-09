/**
 * MCP Use Case: rank_entities
 *
 * Ranks entities by budget metrics with filtering and pagination.
 */

import { ok, err, type Result } from 'neverthrow';

import { databaseError, toMcpError, type McpError } from '../errors.js';
import { DEFAULT_RANKING_LIMIT, MAX_RANKING_LIMIT } from '../types.js';

import type { RankEntitiesInput, RankEntitiesOutput } from '../schemas/tools.js';

// ─────────────────────────────────────────────────────────────────────────────
// Dependencies
// ─────────────────────────────────────────────────────────────────────────────

interface EntityAnalyticsRow {
  entity_cui: string;
  entity_name: string;
  entity_type: string | null;
  uat_id: number | null;
  county_code: string | null;
  county_name: string | null;
  population: number | null;
  amount: number;
  total_amount: number;
  per_capita_amount: number;
}

interface EntityAnalyticsResult {
  rows: EntityAnalyticsRow[];
  totalCount: number;
}

export interface RankEntitiesDeps {
  entityAnalyticsRepo: {
    getEntityAnalytics(
      filter: Record<string, unknown>,
      sort: { by: string; order: 'ASC' | 'DESC' } | undefined,
      limit: number,
      offset: number
    ): Promise<Result<EntityAnalyticsResult, unknown>>;
  };
  shareLink: {
    create(url: string): Promise<Result<string, unknown>>;
  };
  config: {
    clientBaseUrl: string;
  };
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
 * Normalizes report type from various formats to database format.
 */
function normalizeReportType(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;

  const raw = value.trim();
  const DB_PRINCIPAL = 'Executie bugetara agregata la nivel de ordonator principal';
  const DB_SECONDARY = 'Executie bugetara agregata la nivel de ordonator secundar';
  const DB_DETAILED = 'Executie bugetara detaliata';

  // Pass-through for exact DB enum values
  if (raw === DB_PRINCIPAL || raw === DB_SECONDARY || raw === DB_DETAILED) return raw;

  // Normalize common aliases
  const lc = raw.toLowerCase().replace(/\s+/g, '_');
  if (lc === 'principal_aggregated') return DB_PRINCIPAL;
  if (lc === 'secondary_aggregated') return DB_SECONDARY;
  if (lc === 'detailed') return DB_DETAILED;

  // Uppercase GraphQL style tokens
  if (raw === 'PRINCIPAL_AGGREGATED') return DB_PRINCIPAL;
  if (raw === 'SECONDARY_AGGREGATED') return DB_SECONDARY;
  if (raw === 'DETAILED') return DB_DETAILED;

  return raw;
}

/**
 * Converts MCP filter format to internal analytics filter format.
 */
function toInternalFilter(input: RankEntitiesInput): Record<string, unknown> {
  const { period, filter } = input;

  const internal: Record<string, unknown> = {
    account_category: filter.accountCategory,
    report_type:
      normalizeReportType(filter.reportType) ??
      'Executie bugetara agregata la nivel de ordonator principal',
    report_period: {
      type: period.type,
      selection: period.selection,
    },
    normalization: filter.normalization ?? 'total',
  };

  // Entity scope
  if (filter.entityCuis !== undefined) internal['entity_cuis'] = filter.entityCuis;
  if (filter.uatIds !== undefined) internal['uat_ids'] = filter.uatIds;
  if (filter.countyCodes !== undefined) internal['county_codes'] = filter.countyCodes;
  if (filter.regions !== undefined) internal['regions'] = filter.regions;
  if (filter.isUat !== undefined) internal['is_uat'] = filter.isUat;

  // Population constraints
  if (filter.minPopulation !== undefined) internal['min_population'] = filter.minPopulation;
  if (filter.maxPopulation !== undefined) internal['max_population'] = filter.maxPopulation;

  // Classification filters
  if (filter.functionalCodes !== undefined) internal['functional_codes'] = filter.functionalCodes;
  if (filter.functionalPrefixes !== undefined)
    internal['functional_prefixes'] = filter.functionalPrefixes;
  if (filter.economicCodes !== undefined) internal['economic_codes'] = filter.economicCodes;
  if (filter.economicPrefixes !== undefined)
    internal['economic_prefixes'] = filter.economicPrefixes;

  // Other filters
  if (filter.fundingSourceIds !== undefined)
    internal['funding_source_ids'] = filter.fundingSourceIds;
  if (filter.budgetSectorIds !== undefined) internal['budget_sector_ids'] = filter.budgetSectorIds;
  if (filter.expenseTypes !== undefined) internal['expense_types'] = filter.expenseTypes;
  if (filter.programCodes !== undefined) internal['program_codes'] = filter.programCodes;

  // Exclusions
  if (filter.exclude !== undefined) {
    const exclude: Record<string, unknown> = {};
    if (filter.exclude.entity_cuis !== undefined)
      exclude['entity_cuis'] = filter.exclude.entity_cuis;
    if (filter.exclude.uat_ids !== undefined) exclude['uat_ids'] = filter.exclude.uat_ids;
    if (filter.exclude.county_codes !== undefined)
      exclude['county_codes'] = filter.exclude.county_codes;
    if (filter.exclude.functional_codes !== undefined)
      exclude['functional_codes'] = filter.exclude.functional_codes;
    if (filter.exclude.functional_prefixes !== undefined)
      exclude['functional_prefixes'] = filter.exclude.functional_prefixes;
    if (filter.exclude.economic_codes !== undefined)
      exclude['economic_codes'] = filter.exclude.economic_codes;
    if (filter.exclude.economic_prefixes !== undefined)
      exclude['economic_prefixes'] = filter.exclude.economic_prefixes;
    internal['exclude'] = exclude;
  }

  return internal;
}

/**
 * Builds a shareable link for the entity analytics view.
 */
function buildEntityAnalyticsLink(
  baseUrl: string,
  filter: Record<string, unknown>,
  page: number,
  pageSize: number
): string {
  const params = new URLSearchParams();
  params.set('view', 'table');
  params.set('page', String(page));
  params.set('pageSize', String(pageSize));
  params.set('filter', JSON.stringify(filter));
  return `${baseUrl}/analytics?${params.toString()}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Use Case
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ranks entities by budget metrics with filtering and pagination.
 */
export async function rankEntities(
  deps: RankEntitiesDeps,
  input: RankEntitiesInput
): Promise<Result<RankEntitiesOutput, McpError>> {
  const { sort, limit: inputLimit, offset: inputOffset } = input;

  // Validate and clamp pagination
  const limit = clamp(inputLimit ?? DEFAULT_RANKING_LIMIT, 1, MAX_RANKING_LIMIT);
  const offset = Math.max(inputOffset ?? 0, 0);

  // Convert filter
  const internalFilter = toInternalFilter(input);

  // Prepare sort
  const sortConfig =
    sort !== undefined ? { by: sort.by, order: sort.order ?? ('DESC' as const) } : undefined;

  // Query repository
  const result = await deps.entityAnalyticsRepo.getEntityAnalytics(
    internalFilter,
    sortConfig,
    limit,
    offset
  );

  if (result.isErr()) {
    const domainError = result.error as { type?: string; message?: string };
    if (domainError.type !== undefined) {
      return err(toMcpError({ type: domainError.type, message: domainError.message ?? '' }));
    }
    return err(databaseError());
  }

  const { rows, totalCount } = result.value;

  // Calculate page info
  const hasNextPage = offset + limit < totalCount;
  const hasPreviousPage = offset > 0;

  // Build shareable link
  const page = Math.floor(offset / limit) + 1;
  const fullLink = buildEntityAnalyticsLink(deps.config.clientBaseUrl, internalFilter, page, limit);
  const linkResult = await deps.shareLink.create(fullLink);
  const link = linkResult.isOk() ? linkResult.value : fullLink;

  return ok({
    ok: true,
    link,
    entities: rows,
    pageInfo: {
      totalCount,
      hasNextPage,
      hasPreviousPage,
    },
  });
}
