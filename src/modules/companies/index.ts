/**
 * Companies module — public API (plan §11). Assembles the repo, GraphQL slice,
 * MCP tools, and the cross-source contributor from a kernel Kysely instance + the
 * kernel FlowsRepo (public-money, payee) + the kernel Meili client (name search).
 *
 * Importing this barrel pulls in `shell/db/schema.ts`, whose `declare module`
 * augments `ProdDatabase` with the `companies_v2.*` tables. The module is the CUI
 * identity spine: it links to the kernel identity hub by CUI (link-not-merge) and
 * never reassigns `org_id`s.
 */

import './shell/db/schema.js';

import { makeCompanySearchContribution } from './core/search-contribution.js';
import { makeCompanyHubStats } from './core/usecases.js';
import { makeClickhouseAnalyticsEngine } from './shell/analytics/clickhouse-engine.js';
import {
  makeClickhouseReader,
  type CompaniesClickhouseConfig,
} from './shell/analytics/clickhouse-reader.js';
import {
  makeAnalyticsLabelSource,
  makeAnalyticsReleaseSource,
} from './shell/analytics/postgres-sources.js';
import { makeCompaniesContributor } from './shell/contributor.js';
import { makeCompanyAnalysisResolvers } from './shell/graphql/analytics-resolvers.js';
import { companyAnalysisTypeDefs } from './shell/graphql/analytics-typedefs.js';
import { makeCompaniesResolvers } from './shell/graphql/resolvers.js';
import { companiesTypeDefs } from './shell/graphql/typedefs.js';
import { makeHubStatsProvider } from './shell/hub-stats-cache.js';
import { makeCompanyAnalysisMcpTools } from './shell/mcp/analytics-tools.js';
import { makeCompaniesMcpTools } from './shell/mcp/tools.js';
import { makeCompaniesRepo } from './shell/repo/companies-repo.js';
import { makeCompanySearchReader } from './shell/repo/search-contribution-sql.js';

import type { CompanyAnalysisContext } from './core/analytics-usecases.js';
import type { CompaniesRepository } from './core/ports.js';
import type {
  ContributorRegistry,
  FlowsRepo,
  GraphqlSlice,
  KernelMcpTool,
  Logger,
  MeiliClient,
  ProdDatabase,
  SearchCompanyContributionPort,
  SourceContributor,
} from '@/modules/shared/index.js';
import type { Kysely } from 'kysely';

/** The companies analytics reader (dedicated `companies_reader` ClickHouse user). */
export interface CompaniesAnalyticsDeps {
  readonly clickhouse: CompaniesClickhouseConfig;
  readonly logger?: Logger;
}

export interface CompaniesModuleDeps {
  readonly db: Kysely<ProdDatabase>;
  readonly registry: ContributorRegistry;
  readonly flowsRepo: FlowsRepo;
  /** Kernel Meili client for name resolution (null → pg fallback only). */
  readonly meili: MeiliClient | null;
  /** Palette index for name resolution (kernel `PROD_MEILI_INDEXES[0]`). */
  readonly meiliEntitiesIndex?: string;
  readonly clientBaseUrl?: string;
  /** `companyHubStats` cache TTL. Defaults to 6h (`HUB_STATS_DEFAULT_TTL_MS`). */
  readonly hubStatsTtlMs?: number;
  /**
   * Absent → the analytics roots/tools stay registered and answer a typed
   * SERVICE_UNAVAILABLE ("not configured"), never an empty success.
   */
  readonly analytics?: CompaniesAnalyticsDeps;
}

export interface CompaniesModule {
  readonly repo: CompaniesRepository;
  readonly graphqlSlice: GraphqlSlice;
  readonly graphqlResolvers: Record<string, unknown>;
  readonly mcpTools: readonly KernelMcpTool[];
  readonly contributor: SourceContributor;
  /**
   * The company contribution of the kernel global search (fresh scope, parent
   * access and company values of a candidate page); registered with the
   * kernel by the composition (`kernel.registerCompanySearch`).
   */
  readonly searchContribution: SearchCompanyContributionPort;
  /** Abort in-flight analytics reads (owning app shutdown). */
  close(): void;
}

export const makeCompaniesModule = (deps: CompaniesModuleDeps): CompaniesModule => {
  const repo = makeCompaniesRepo(deps.db, {
    ...(deps.meiliEntitiesIndex !== undefined && {
      meiliEntitiesIndex: deps.meiliEntitiesIndex,
    }),
  });
  const contributor = makeCompaniesContributor(repo);
  const clientBaseUrl = deps.clientBaseUrl ?? 'https://transparenta.eu';
  const usecaseDeps = { repo, flowsRepo: deps.flowsRepo, meili: deps.meili };

  // ONE provider for both surfaces: GraphQL `companyHubStats` and MCP
  // `company_hub_stats` therefore always agree. Every read captures the
  // registry scope fresh; the long compute happens at most once per scope and
  // TTL window per process (singleflight + stale-while-revalidate within one
  // scope; a scope change is never served stale).
  const hubStats = makeHubStatsProvider(
    {
      captureScope: () => repo.captureRegistryScope(),
      compute: (scope) => makeCompanyHubStats({ repo }, scope),
    },
    deps.hubStatsTtlMs !== undefined ? { ttlMs: deps.hubStatsTtlMs } : {}
  );

  // Analytics: PostgreSQL release custody + labels, ClickHouse keys/numbers.
  const analyticsDeps = deps.analytics;
  const reader =
    analyticsDeps === undefined
      ? null
      : makeClickhouseReader(analyticsDeps.clickhouse, analyticsDeps.logger);
  const analytics: CompanyAnalysisContext =
    analyticsDeps === undefined || reader === null
      ? null
      : {
          releases: makeAnalyticsReleaseSource(deps.db, analyticsDeps.logger),
          labels: makeAnalyticsLabelSource(deps.db, analyticsDeps.logger),
          engine: makeClickhouseAnalyticsEngine(reader, analyticsDeps.clickhouse.database),
          database: analyticsDeps.clickhouse.database,
        };

  const resolvers = makeCompaniesResolvers({ ...usecaseDeps, registry: deps.registry, hubStats });
  const analyticsResolvers = makeCompanyAnalysisResolvers(analytics);

  return {
    repo,
    graphqlSlice: {
      source: 'companies',
      typeDefs: `${companiesTypeDefs}\n\n${companyAnalysisTypeDefs}`,
    },
    graphqlResolvers: {
      ...resolvers,
      Query: {
        ...(resolvers['Query'] as Record<string, unknown>),
        ...analyticsResolvers.Query,
      },
    },
    mcpTools: [
      ...makeCompaniesMcpTools({ ...usecaseDeps, clientBaseUrl, hubStats }),
      ...makeCompanyAnalysisMcpTools({ analytics, clientBaseUrl }),
    ],
    contributor,
    searchContribution: makeCompanySearchContribution(repo, makeCompanySearchReader(deps.db)),
    close: () => {
      reader?.close();
    },
  };
};

export type { CompaniesRepository } from './core/ports.js';
export type { CompaniesClickhouseConfig } from './shell/analytics/clickhouse-reader.js';
export * from './core/types.js';
export { companiesFilterSpec, COMPANIES_FILTER_SPECS } from './core/filters.js';
export { registryScopeKey, onrcIdentifierKey, parseOnrcCaenSelector } from './core/registry.js';
export { makeCompaniesContributor } from './shell/contributor.js';
export { makeCompaniesRepo } from './shell/repo/companies-repo.js';
export {
  makeHubStatsProvider,
  HUB_STATS_DEFAULT_TTL_MS,
  type HubStatsProvider,
  type HubStatsSources,
} from './shell/hub-stats-cache.js';
