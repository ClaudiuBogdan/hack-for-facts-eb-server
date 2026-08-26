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

import { makeBudgetContributor } from './shell/contributor.js';
import { makeBudgetResolvers } from './shell/graphql/resolvers.js';
import { budgetTypeDefs } from './shell/graphql/typedefs.js';
import { makeBudgetMcpTools } from './shell/mcp/tools.js';
import { makeBudgetMcpResources } from './shell/mcp/widgets/resources.js';
import { makeBudgetRepo } from './shell/repo/budget-repo.js';
import { makeBudgetDiscoveryRepo } from './shell/repo/discovery-repo.js';

import type { BudgetDiscoveryRepo, BudgetRepo } from './core/ports.js';
import type {
  ContributorRegistry,
  GraphqlSlice,
  KernelMcpResource,
  KernelMcpTool,
  ProdDatabase,
  SourceContributor,
} from '@/modules/shared/index.js';
import type { Kysely } from 'kysely';

export interface BudgetModuleDeps {
  readonly db: Kysely<ProdDatabase>;
  readonly registry: ContributorRegistry;
  /** Client base URL for MCP deep links (defaults to the public site). */
  readonly clientBaseUrl?: string;
}

export interface BudgetModule {
  readonly repo: BudgetRepo;
  readonly discovery: BudgetDiscoveryRepo;
  readonly graphqlSlice: GraphqlSlice;
  readonly graphqlResolvers: Record<string, unknown>;
  readonly mcpTools: readonly KernelMcpTool[];
  /** MCP App widget templates (SEP-1865) served by the kernel MCP server. */
  readonly mcpResources: readonly KernelMcpResource[];
  readonly contributor: SourceContributor;
}

export const makeBudgetModule = (deps: BudgetModuleDeps): BudgetModule => {
  const repo = makeBudgetRepo(deps.db);
  const discovery = makeBudgetDiscoveryRepo(deps.db);
  const contributor = makeBudgetContributor(repo);
  const clientBaseUrl = deps.clientBaseUrl ?? 'https://transparenta.eu';

  return {
    repo,
    discovery,
    graphqlSlice: { source: 'budget', typeDefs: budgetTypeDefs },
    graphqlResolvers: makeBudgetResolvers({ repo, discovery, registry: deps.registry }),
    mcpTools: makeBudgetMcpTools({ repo, discovery, clientBaseUrl }),
    mcpResources: makeBudgetMcpResources(),
    contributor,
  };
};

export type { BudgetRepo, BudgetDiscoveryRepo } from './core/ports.js';
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
