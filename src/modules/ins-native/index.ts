/**
 * INS native module — public API. Assembles the repository over the kernel
 * Kysely instance, the frozen legacy GraphQL slice, the MCP tools and the
 * cross-source contributor. Replaces `src/modules/ins` (legacy INS DB) at the
 * switch-over (plan INS_SERVING_CUTOVER_PLAN_2026-09-02 §3.5).
 *
 * Importing this barrel pulls in `shell/db/schema.ts`, whose `declare module`
 * augments `ProdDatabase` with the `ins.*` tables.
 */

import './shell/db/schema.js';

import { makeInsContributor } from './shell/contributor.js';
import { makeInsLegacyResolvers } from './shell/graphql/legacy/resolvers.js';
import { insLegacyTypeDefs } from './shell/graphql/legacy/typedefs.js';
import { makeInsMcpTools } from './shell/mcp/tools.js';
import { makeInsRepo } from './shell/repo/ins-repo.js';

import type { InsRepo } from './core/ports.js';
import type {
  ContributorRegistry,
  GraphqlSlice,
  KernelMcpTool,
  ProdDatabase,
  SourceContributor,
} from '@/modules/shared/index.js';
import type { Kysely } from 'kysely';

export interface InsNativeModuleDeps {
  readonly db: Kysely<ProdDatabase>;
  readonly registry: ContributorRegistry;
  /** Client base URL for MCP deep links (defaults to the public site). */
  readonly clientBaseUrl?: string;
  /** Inject a repository (tests); defaults to the Chronos repository. */
  readonly repo?: InsRepo;
}

export interface InsNativeModule {
  readonly repo: InsRepo;
  readonly graphqlSlice: GraphqlSlice;
  readonly graphqlResolvers: Record<string, unknown>;
  readonly mcpTools: readonly KernelMcpTool[];
  readonly contributor: SourceContributor;
}

export const INS_NATIVE_SOURCE = 'ins';

export const makeInsNativeModule = (deps: InsNativeModuleDeps): InsNativeModule => {
  const repo = deps.repo ?? makeInsRepo(deps.db);
  const clientBaseUrl = deps.clientBaseUrl ?? 'https://transparenta.eu';
  return {
    repo,
    graphqlSlice: { source: INS_NATIVE_SOURCE, typeDefs: insLegacyTypeDefs },
    graphqlResolvers: makeInsLegacyResolvers({ repo }),
    mcpTools: makeInsMcpTools({ repo, clientBaseUrl }),
    contributor: makeInsContributor(repo),
  };
};

export type { InsRepo } from './core/ports.js';
export * from './core/types.js';
export {
  insLegacyTypeDefs,
  INS_LEGACY_ROOTS,
  INS_LEGACY_ROOTS_DROPPED,
} from './shell/graphql/legacy/typedefs.js';
export { makeInsRepo } from './shell/repo/ins-repo.js';
