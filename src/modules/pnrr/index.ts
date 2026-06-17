/**
 * PNRR module — public API (plan §11). Assembles the repo, GraphQL slice, MCP
 * tools, and the cross-source contributor from a kernel Kysely instance. The app
 * registers the slice + tools and the contributor into the kernel registry.
 *
 * Importing this barrel pulls in `shell/db/schema.ts`, whose `declare module`
 * augments `ProdDatabase` with the `pnrr.*` tables (module-augmentation pattern).
 */

import './shell/db/schema.js';

import { makePnrrContributor } from './shell/contributor.js';
import { makePnrrResolvers } from './shell/graphql/resolvers.js';
import { pnrrTypeDefs } from './shell/graphql/typedefs.js';
import { makePnrrMcpTools } from './shell/mcp/tools.js';
import { makePnrrRepo } from './shell/repo/pnrr-repo.js';

import type { PnrrRepository } from './core/ports.js';
import type {
  ContributorRegistry,
  GraphqlSlice,
  KernelMcpTool,
  ProdDatabase,
  SourceContributor,
} from '@/modules/shared/index.js';
import type { Kysely } from 'kysely';

export interface PnrrModuleDeps {
  readonly db: Kysely<ProdDatabase>;
  readonly registry: ContributorRegistry;
  /** Client base URL for MCP deep links (defaults to the public site). */
  readonly clientBaseUrl?: string;
}

export interface PnrrModule {
  readonly repo: PnrrRepository;
  readonly graphqlSlice: GraphqlSlice;
  readonly graphqlResolvers: Record<string, unknown>;
  readonly mcpTools: readonly KernelMcpTool[];
  readonly contributor: SourceContributor;
}

export const makePnrrModule = (deps: PnrrModuleDeps): PnrrModule => {
  const repo = makePnrrRepo(deps.db);
  const contributor = makePnrrContributor(repo);
  const clientBaseUrl = deps.clientBaseUrl ?? 'https://transparenta.eu';

  return {
    repo,
    graphqlSlice: { source: 'pnrr', typeDefs: pnrrTypeDefs },
    graphqlResolvers: makePnrrResolvers({ repo, registry: deps.registry }),
    mcpTools: makePnrrMcpTools({ repo, clientBaseUrl }),
    contributor,
  };
};

export type { PnrrRepository } from './core/ports.js';
export * from './core/types.js';
export { PNRR_FILTER_SPECS } from './core/filters.js';
export { makePnrrContributor, toProfileSlice } from './shell/contributor.js';
export { makePnrrRepo } from './shell/repo/pnrr-repo.js';
