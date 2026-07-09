/**
 * Procurement module — public API (plan §11). Assembles the two repos (entity +
 * aggregate), the GraphQL slice, MCP tools, and the cross-source contributor from a
 * kernel Kysely instance. The app registers the slice + tools and the contributor;
 * the procurement flow types (`procurement_contract`, `direct_acquisition`) are
 * already live in the kernel `flows.money_flows` — the module just registers the
 * contributor over them.
 *
 * Importing this barrel pulls in `shell/db/schema.ts`, whose `declare module`
 * augments `ProdDatabase` with the `procurement.*` tables + MVs.
 */

import './shell/db/schema.js';

import { DA_LIST_MAX_WINDOW_DAYS_DEFAULT } from './core/constants.js';
import {
  scopeCategoryBreakdown,
  scopeSpendOverTime,
  scopeStats,
  scopeTopAuthorities,
  scopeTopSuppliers,
} from './core/usecases.js';
import { makeProcurementContributor } from './shell/contributor.js';
import { makeProcurementResolvers } from './shell/graphql/resolvers.js';
import { procurementTypeDefs } from './shell/graphql/typedefs.js';
import { makeProcurementMcpTools } from './shell/mcp/tools.js';
import { makeProcurementAggregateRepo } from './shell/repo/aggregate-repo.js';
import { makeProcurementRepo } from './shell/repo/procurement-repo.js';

import type { ProcurementAggregateRepo, ProcurementRepo } from './core/ports.js';
import type {
  ContributorRegistry,
  GraphqlSlice,
  KernelMcpTool,
  ProdDatabase,
  SourceContributor,
} from '@/modules/shared/index.js';
import type { Kysely } from 'kysely';

export interface ProcurementModuleDeps {
  readonly db: Kysely<ProdDatabase>;
  readonly registry: ContributorRegistry;
  readonly clientBaseUrl?: string;
  /** Cap on a bare-date DA list window (days). Default 366. Env: PROCUREMENT_DA_LIST_MAX_WINDOW_DAYS. */
  readonly daListMaxWindowDays?: number;
  /** Warm the empty-scope aggregate cache at init (default true). Tests pass false. */
  readonly warmCache?: boolean;
}

export interface ProcurementModule {
  readonly repo: ProcurementRepo;
  readonly aggregate: ProcurementAggregateRepo;
  readonly graphqlSlice: GraphqlSlice;
  readonly graphqlResolvers: Record<string, unknown>;
  readonly mcpTools: readonly KernelMcpTool[];
  readonly contributor: SourceContributor;
}

/**
 * Pre-load the platform-wide (empty-scope) aggregates into the in-process cache so
 * the first landing-page request does not pay the ~3.6s cold cost of five concurrent
 * matview scans. Fire-and-forget: a warm failure (DB not reachable at boot, matview
 * mid-refresh) must never crash the process — the queries simply run live instead.
 */
const warmEmptyScope = (aggregate: ProcurementAggregateRepo, repo: ProcurementRepo): void => {
  void (async (): Promise<void> => {
    try {
      await Promise.all([
        scopeStats(aggregate, repo, {}, null),
        scopeTopAuthorities(aggregate, {}, null, 10),
        scopeTopSuppliers(aggregate, {}, null, 10),
        scopeCategoryBreakdown(aggregate, {}, null),
        scopeSpendOverTime(aggregate, {}, null),
      ]);
    } catch {
      // Intentionally swallowed — see above.
    }
  })();
};

export const makeProcurementModule = (deps: ProcurementModuleDeps): ProcurementModule => {
  const repo = makeProcurementRepo(deps.db, deps.daListMaxWindowDays ?? DA_LIST_MAX_WINDOW_DAYS_DEFAULT);
  const aggregate = makeProcurementAggregateRepo(deps.db);
  const contributor = makeProcurementContributor(aggregate);
  const clientBaseUrl = deps.clientBaseUrl ?? 'https://transparenta.eu';

  if (deps.warmCache !== false) warmEmptyScope(aggregate, repo);

  return {
    repo,
    aggregate,
    graphqlSlice: { source: 'procurement', typeDefs: procurementTypeDefs },
    graphqlResolvers: makeProcurementResolvers({ repo, aggregate, registry: deps.registry }),
    mcpTools: makeProcurementMcpTools({ repo, aggregate, clientBaseUrl }),
    contributor,
  };
};

export type { ProcurementRepo, ProcurementAggregateRepo } from './core/ports.js';
export * from './core/types.js';
export {
  PROCUREMENT_FLOW_TYPES,
  PROCUREMENT_DOC_TYPES,
  PROCUREMENT_GRAINS,
  PROCUREMENT_GRAIN_NOTE,
} from './core/constants.js';
export { PROCUREMENT_FILTER_SPECS } from './core/filters.js';
export { makeProcurementContributor, toProfileSlice } from './shell/contributor.js';
export { makeProcurementRepo } from './shell/repo/procurement-repo.js';
export { makeProcurementAggregateRepo } from './shell/repo/aggregate-repo.js';
