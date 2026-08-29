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

import { makeCompanyHubStats } from './core/usecases.js';
import { makeCompaniesContributor } from './shell/contributor.js';
import { makeCompaniesResolvers } from './shell/graphql/resolvers.js';
import { companiesTypeDefs } from './shell/graphql/typedefs.js';
import { makeHubStatsProvider } from './shell/hub-stats-cache.js';
import { makeCompaniesMcpTools } from './shell/mcp/tools.js';
import { makeCompaniesRepo } from './shell/repo/companies-repo.js';

import type { CompaniesRepository } from './core/ports.js';
import type {
  ContributorRegistry,
  FlowsRepo,
  GraphqlSlice,
  KernelMcpTool,
  MeiliClient,
  ProdDatabase,
  SourceContributor,
} from '@/modules/shared/index.js';
import type { Kysely } from 'kysely';

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
}

export interface CompaniesModule {
  readonly repo: CompaniesRepository;
  readonly graphqlSlice: GraphqlSlice;
  readonly graphqlResolvers: Record<string, unknown>;
  readonly mcpTools: readonly KernelMcpTool[];
  readonly contributor: SourceContributor;
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
  // `company_hub_stats` therefore always agree, and the ~30s compute happens at
  // most once per TTL window per process (singleflight + stale-while-revalidate).
  const hubStats = makeHubStatsProvider(
    () => makeCompanyHubStats({ repo }),
    deps.hubStatsTtlMs !== undefined ? { ttlMs: deps.hubStatsTtlMs } : {}
  );

  return {
    repo,
    graphqlSlice: { source: 'companies', typeDefs: companiesTypeDefs },
    graphqlResolvers: makeCompaniesResolvers({ ...usecaseDeps, registry: deps.registry, hubStats }),
    mcpTools: makeCompaniesMcpTools({ ...usecaseDeps, clientBaseUrl, hubStats }),
    contributor,
  };
};

export type { CompaniesRepository } from './core/ports.js';
export * from './core/types.js';
export { companiesFilterSpec, COMPANIES_FILTER_SPECS } from './core/filters.js';
export { makeCompaniesContributor } from './shell/contributor.js';
export { makeCompaniesRepo } from './shell/repo/companies-repo.js';
export {
  makeHubStatsProvider,
  HUB_STATS_DEFAULT_TTL_MS,
  type HubStatsProvider,
} from './shell/hub-stats-cache.js';
