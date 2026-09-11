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
import {
  makeNativeBudgetRepo,
  makeNativeExecutionSeries,
  makeNativeGroupedClassifications,
  makeNativeGroupedEntities,
} from './shell/native/index.js';
import { makeBudgetRepo } from './shell/repo/budget-repo.js';
import { makeBudgetDiscoveryRepo } from './shell/repo/discovery-repo.js';
import { makeGroupedAnalyticsRepo } from './shell/repo/grouped-analytics-repo.js';
import { makeLegacyAnalyticsRepo } from './shell/repo/legacy-analytics-repo.js';
import { makeLegacyDimensionRepo } from './shell/repo/legacy-dimension-repo.js';
import { makeLegacyPopulationRepo } from './shell/repo/legacy-population-repo.js';

import type { GroupedInput } from './core/legacy-analytics/grouped-types.js';
import type {
  groupedClassificationAnalytics,
  groupedEntityAnalytics,
} from './core/legacy-analytics/grouped-usecase.js';
import type { nativeExecutionSeries } from './core/legacy-analytics/native-usecase.js';
import type { LegacyAnalyticsInput } from './core/legacy-analytics/types.js';
import type { LegacyDimensionRepo } from './core/legacy-dimensions/ports.js';
import type { BudgetDiscoveryRepo, BudgetRepo } from './core/ports.js';
import type {
  AnnualPopulationPort,
  ContributorRegistry,
  GraphqlSlice,
  KernelMcpResource,
  KernelMcpTool,
  Logger,
  ProdDatabase,
  SourceContributor,
} from '@/modules/shared/index.js';
import type { Kysely } from 'kysely';

/**
 * The kernel-build (native) composition: exact-year population through the
 * kernel port and the promoted factor set. When present, the module builds its
 * own snapshot-bound adapters (repo, execution series, grouped entity and
 * classification analytics); the composition layer only passes the port
 * (review X/F6). The kernel build REQUIRES it whenever `budget` is enabled
 * (N/N6/N7: no silent fallback to the legacy set-1 composition).
 */
export interface BudgetNativeDeps {
  readonly population: AnnualPopulationPort;
  readonly factors: FactorSource;
}

export interface BudgetModuleDeps {
  /** Native composition (kernel build). Tests may still inject the adapters below directly. */
  readonly native?: BudgetNativeDeps;
  readonly executionSeries?: (
    inputs: readonly LegacyAnalyticsInput[]
  ) => ReturnType<typeof nativeExecutionSeries>;
  /** Composition may supply a snapshot-bound native serving adapter. */
  readonly repo?: BudgetRepo;
  readonly entityAnalytics?: (input: GroupedInput) => ReturnType<typeof groupedEntityAnalytics>;
  readonly classificationAnalytics?: (
    input: GroupedInput
  ) => ReturnType<typeof groupedClassificationAnalytics>;
  readonly db: Kysely<ProdDatabase>;
  readonly registry: ContributorRegistry;
  /**
   * The four legacy dimension roots' repository (tests inject a fake so the
   * resolvers' coercion runs without SQL); defaults to the Chronos catalog repo.
   */
  readonly legacyDimensions?: LegacyDimensionRepo;
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

/** The four native adapters, built once from the port and factors; explicit injections win. */
const withNativeAdapters = (deps: BudgetModuleDeps, native: BudgetNativeDeps): BudgetModuleDeps => {
  const warn = (message: string) => (info: Record<string, unknown>) =>
    deps.logger?.warn(info, message);
  const common = { db: deps.db, population: native.population, factors: native.factors };
  return {
    ...deps,
    repo: deps.repo ?? makeNativeBudgetRepo(common),
    executionSeries:
      deps.executionSeries ??
      makeNativeExecutionSeries({
        ...common,
        onCapped: warn('Execution series point cap reached'),
      }),
    entityAnalytics:
      deps.entityAnalytics ??
      makeNativeGroupedEntities({
        ...common,
        onClamped: warn('Grouped analytics limit clamped; pageInfo reports remaining rows'),
      }),
    classificationAnalytics:
      deps.classificationAnalytics ??
      makeNativeGroupedClassifications({
        ...common,
        onClamped: warn('Grouped analytics limit clamped; pageInfo reports remaining rows'),
      }),
  };
};

export const makeBudgetModule = (rawDeps: BudgetModuleDeps): BudgetModule => {
  const deps = rawDeps.native === undefined ? rawDeps : withNativeAdapters(rawDeps, rawDeps.native);
  const repo = deps.repo ?? makeBudgetRepo(deps.db);
  const discovery = makeBudgetDiscoveryRepo(deps.db);
  const legacyAnalytics = makeLegacyAnalyticsRepo(deps.db);
  const legacyPopulation = makeLegacyPopulationRepo(deps.db);
  const legacyDimensions = deps.legacyDimensions ?? makeLegacyDimensionRepo(deps.db);
  const groupedResolvers = makeBudgetGroupedResolvers({
    ...(deps.entityAnalytics === undefined ? {} : { entityAnalytics: deps.entityAnalytics }),
    ...(deps.classificationAnalytics === undefined
      ? {}
      : { classificationAnalytics: deps.classificationAnalytics }),
    grouped: makeGroupedAnalyticsRepo(deps.db),
    factors: deps.legacyFactors,
    population: legacyPopulation,
    onClamped: (info) =>
      deps.logger?.warn(info, 'Grouped analytics limit clamped; pageInfo reports remaining rows'),
  });
  const contributor = makeBudgetContributor(repo);
  const clientBaseUrl = deps.clientBaseUrl ?? 'https://transparenta.eu';

  const legacyResolvers = makeBudgetLegacyResolvers({
    ...(deps.executionSeries === undefined ? {} : { executionSeries: deps.executionSeries }),
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
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- re-exported for the Phase A parity tests until the legacy entrypoint goes (N/P5)
  makeDatasetFactorSource,
  type DatasetReader,
} from './shell/factors/dataset-factor-source.js';
export type {
  FactorSetKind,
  FactorSetReadError,
  FactorSetReaderPort,
  FactorSetRow,
  FactorSetTable,
} from './core/legacy-analytics/factor-set-port.js';
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

export { makeBudgetMapRepo } from './shell/repo/map-analytics-repo.js';
export type {
  BudgetMapGranularity,
  BudgetMapInput,
  BudgetMapYear,
  BudgetMapRepo,
} from './core/legacy-analytics/map-types.js';

export { budgetMapValues, type BudgetMapDeps } from './core/legacy-analytics/map-usecase.js';
export type {
  BudgetMapPopulation,
  BudgetMapPopulationSource,
  BudgetMapResult,
} from './core/legacy-analytics/map-types.js';

export {
  commitmentsMapValues,
  type CommitmentsMapRepo,
} from './core/legacy-analytics/commitments-map.js';
export { makeCommitmentsMapRepo } from './shell/repo/commitments-map-repo.js';

export { budgetMapGroupValues } from './core/legacy-analytics/map-groups.js';

export { readMapPopulationAnchorSets } from './shell/repo/map-population-anchors.js';

export { readGroupedPopulationAnchors } from './shell/repo/grouped-population-anchors.js';
export { makeGroupedAnalyticsRepo } from './shell/repo/grouped-analytics-repo.js';
export { makeLegacyPopulationRepo } from './shell/repo/legacy-population-repo.js';
export { loadMoneyContext } from './core/legacy-analytics/money-context.js';
export { resolveNormalizationPlan } from './core/legacy-analytics/normalize.js';
export { legacyDecimal } from './core/legacy-analytics/decimal.js';
export type { YearlySeries } from './core/legacy-analytics/types.js';

export {
  nativeExecutionSeries,
  type NativeExecutionSeriesDeps,
} from './core/legacy-analytics/native-usecase.js';
export { makeLegacyAnalyticsRepo } from './shell/repo/legacy-analytics-repo.js';
export type { LegacyAnalyticsInput, PopulationScope } from './core/legacy-analytics/types.js';

export { budgetMoneyPlan, needsMoneyFactor } from './core/money-options.js';
export type { BudgetMoneyOptions } from './core/money-options.js';

// ── native (kernel-build) adapters: population via the kernel port (X/F6) ──
export * from './shell/native/index.js';
