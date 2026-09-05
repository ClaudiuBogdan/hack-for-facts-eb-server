/**
 * Budget module — public API (plan §11). Assembles the repos, GraphQL slice, MCP
 * tools, and the cross-source contributor from a kernel Kysely instance. The app
 * registers the slice + tools and the contributor into the kernel registry, and
 * registers the `budget_execution` flow type + `budget_entity`/`budget_report`
 * doc types (declared, gated until the scrapper projects them).
 *
 * Importing this barrel pulls in `shell/db/schema.ts`, whose `declare module`
 * augments `ProdDatabase` with the `budget.*` tables (module-augmentation pattern).
 */

import './shell/db/schema.js';

import {
  LEGACY_ANALYTICS_MAX_POINTS,
  type FactorSource,
  type LegacyExecutionAggregateRepo,
  type PopulationSource,
} from './core/legacy-analytics/ports.js';
import { makeBudgetContributor } from './shell/contributor.js';
import { makeBudgetGroupedResolvers } from './shell/graphql/legacy/grouped-resolvers.js';
import { budgetGroupedTypeDefs } from './shell/graphql/legacy/grouped-typedefs.js';
import { makeBudgetLegacyResolvers } from './shell/graphql/legacy/resolvers.js';
import {
  budgetLegacyCollisionTypeDefs,
  budgetLegacyTypeDefs,
} from './shell/graphql/legacy/typedefs.js';
import { makeBudgetResolvers } from './shell/graphql/resolvers.js';
import { budgetTypeDefs } from './shell/graphql/typedefs.js';
import { makeBudgetMcpTools } from './shell/mcp/tools.js';
import { makeBudgetMcpResources } from './shell/mcp/widgets/resources.js';
import { makeBudgetRepo } from './shell/repo/budget-repo.js';
import { makeBudgetDiscoveryRepo } from './shell/repo/discovery-repo.js';
import { makeGroupedAnalyticsRepo } from './shell/repo/grouped-analytics-repo.js';
import { makeLegacyAnalyticsRepo } from './shell/repo/legacy-analytics-repo.js';
import { makeLegacyDimensionRepo } from './shell/repo/legacy-dimension-repo.js';
import { makeLegacyPopulationRepo } from './shell/repo/legacy-population-repo.js';

import type { BudgetDiscoveryRepo, BudgetRepo } from './core/ports.js';
import type {
  ContributorRegistry,
  GraphqlSlice,
  KernelMcpResource,
  KernelMcpTool,
  Logger,
  ProdDatabase,
  SourceContributor,
} from '@/modules/shared/index.js';
import type { Kysely } from 'kysely';

export interface BudgetModuleDeps {
  readonly db: Kysely<ProdDatabase>;
  readonly registry: ContributorRegistry;
  /** Client base URL for MCP deep links (defaults to the public site). */
  readonly clientBaseUrl?: string;
  /**
   * Reference data for the legacy `executionAnalytics` root's normalization
   * (CPI / FX / GDP / country population). REQUIRED — an absent source would be
   * a silent disarm (values served unadjusted under a "(real …)" label).
   */
  readonly legacyFactors: FactorSource;
  /** Structured logger for the observability hooks (the 10,000-point cap). */
  readonly logger?: Logger;
}

export interface BudgetModule {
  readonly repo: BudgetRepo;
  readonly discovery: BudgetDiscoveryRepo;
  /** The legacy `executionAnalytics` fact-path aggregate (13 §4 row 1). */
  readonly legacyAnalytics: LegacyExecutionAggregateRepo;
  readonly legacyPopulation: PopulationSource;
  readonly graphqlSlice: GraphqlSlice;
  readonly graphqlResolvers: Record<string, unknown>;
  readonly mcpTools: readonly KernelMcpTool[];
  /** MCP App widget templates (SEP-1865) served by the kernel MCP server. */
  readonly mcpResources: readonly KernelMcpResource[];
  readonly contributor: SourceContributor;
}

/** Merge the legacy resolver map over the module's (both add `Query` fields). */
const mergeResolvers = (
  base: Record<string, unknown>,
  legacy: Record<string, unknown>
): Record<string, unknown> => {
  const baseQuery = base['Query'];
  const legacyQuery = legacy['Query'];
  return {
    ...base,
    ...legacy,
    Query: {
      ...(typeof baseQuery === 'object' && baseQuery !== null ? baseQuery : {}),
      ...(typeof legacyQuery === 'object' && legacyQuery !== null ? legacyQuery : {}),
    },
  };
};

export const makeBudgetModule = (deps: BudgetModuleDeps): BudgetModule => {
  const repo = makeBudgetRepo(deps.db);
  const discovery = makeBudgetDiscoveryRepo(deps.db);
  const legacyAnalytics = makeLegacyAnalyticsRepo(deps.db);
  const legacyPopulation = makeLegacyPopulationRepo(deps.db);
  const legacyDimensions = makeLegacyDimensionRepo(deps.db);
  const groupedResolvers = makeBudgetGroupedResolvers({
    grouped: makeGroupedAnalyticsRepo(deps.db),
    factors: deps.legacyFactors,
    population: legacyPopulation,
    onClamped: (info) =>
      deps.logger?.warn(info, 'Grouped analytics limit clamped; pageInfo reports remaining rows'),
  });
  const contributor = makeBudgetContributor(repo);
  const clientBaseUrl = deps.clientBaseUrl ?? 'https://transparenta.eu';

  const legacyResolvers = makeBudgetLegacyResolvers({
    aggregate: legacyAnalytics,
    factors: deps.legacyFactors,
    population: legacyPopulation,
    dimensions: legacyDimensions,
    onClassificationClamped: ({ kind, requested, clamp, totalCount }) =>
      deps.logger?.warn(
        { kind, requested, clamp, totalCount },
        'legacy classification list clamped below the requested limit — rows left behind'
      ),
    onCapped: ({ seriesId, cap }) =>
      deps.logger?.warn(
        { seriesId, cap, max: LEGACY_ANALYTICS_MAX_POINTS },
        'legacy executionAnalytics series hit the point cap — points were dropped'
      ),
  });

  return {
    repo,
    discovery,
    legacyAnalytics,
    legacyPopulation,
    graphqlSlice: {
      source: 'budget',
      typeDefs: `${budgetTypeDefs}\n${budgetLegacyTypeDefs}\n${budgetLegacyCollisionTypeDefs}\n${budgetGroupedTypeDefs}`,
    },
    graphqlResolvers: mergeResolvers(
      makeBudgetResolvers({ repo, discovery, registry: deps.registry }),
      mergeResolvers(legacyResolvers, groupedResolvers)
    ),
    mcpTools: makeBudgetMcpTools({ repo, discovery, clientBaseUrl }),
    mcpResources: makeBudgetMcpResources(),
    contributor,
  };
};

export type { BudgetRepo, BudgetDiscoveryRepo } from './core/ports.js';
export type {
  FactorKind,
  FactorSource,
  LegacyExecutionAggregateRepo,
  PopulationSource,
} from './core/legacy-analytics/ports.js';
export {
  makeDatasetFactorSource,
  type DatasetReader,
} from './shell/factors/dataset-factor-source.js';
export {
  makeFactorSetSource,
  LEGACY_FACTOR_SET_ID,
  LEGACY_FACTOR_SET_DIGEST,
} from './shell/factors/factor-set-source.js';
export * from './core/types.js';
export {
  ACCOUNT_CATEGORIES,
  BUDGET_FLOW_TYPE,
  BUDGET_DOC_TYPES,
  COMMITMENT_REPORT_TYPES,
  EXECUTION_REPORT_TYPES,
} from './core/constants.js';
export { BUDGET_FILTER_SPECS } from './core/filters.js';
export { makeBudgetContributor, toProfileSlice } from './shell/contributor.js';
export { makeBudgetRepo } from './shell/repo/budget-repo.js';
export { makeBudgetDiscoveryRepo } from './shell/repo/discovery-repo.js';

export {
  groupedEntityAnalytics,
  groupedClassificationAnalytics,
  type GroupedAnalyticsDeps,
} from './core/legacy-analytics/grouped-usecase.js';
export type {
  GroupedAnalyticsRepo,
  GroupedInput,
  GroupedEntity,
  GroupedClassification,
} from './core/legacy-analytics/grouped-types.js';
