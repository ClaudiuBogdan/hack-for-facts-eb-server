/**
 * Parliament module — public API (plan 04 §11). Assembles the repo, GraphQL slice,
 * MCP tools, and the cross-source contributor from a kernel Kysely instance + the
 * kernel-injected `LegalActByIdLoader` (the bill↔legal cross-link, §6.7).
 *
 * Surface = GraphQL + MCP only (no REST) — like the legal module. Importing this
 * barrel pulls in `shell/db/schema.ts`, whose `declare module` augments
 * `ProdDatabase` with the `parliament.*` tables.
 *
 * The act loader is OPTIONAL: parliament must boot (graceful-degrade) even when the
 * legal module is disabled — `ParliamentBillActLink.legalAct` then resolves null.
 */

import './shell/db/schema.js';

import { makeParliamentContributor } from './shell/contributor.js';
import { makeParliamentResolvers } from './shell/graphql/resolvers.js';
import { parliamentTypeDefs } from './shell/graphql/typedefs.js';
import { makeParliamentMcpTools } from './shell/mcp/tools.js';
import { makeParliamentRepo } from './shell/repo/parliament-repo.js';

import type { ParliamentRepo } from './core/ports.js';
import type {
  ContributorRegistry,
  GraphqlSlice,
  KernelMcpTool,
  LegalActByIdLoader,
  MeiliClient,
  ProdDatabase,
  SourceContributor,
} from '@/modules/shared/index.js';
import type { Kysely } from 'kysely';

export interface ParliamentModuleDeps {
  readonly db: Kysely<ProdDatabase>;
  readonly registry: ContributorRegistry;
  /** Kernel cross-link loader (registered by the legal module). Undefined → legalAct resolves null. */
  readonly legalActLoader: LegalActByIdLoader | undefined;
  /** Kernel Meili client for name resolution (null → pg fallback only). */
  readonly meili: MeiliClient | null;
  /** True when an aux search engine is up (relaxes the votes q-only bound). */
  readonly searchEngineUp?: boolean;
  /** API-key guard for the data-quality surface (§2.6). Default deny. */
  readonly isApiKeyAuthorized?: (context: unknown) => boolean;
  readonly clientBaseUrl?: string;
}

export interface ParliamentModule {
  readonly repo: ParliamentRepo;
  readonly graphqlSlice: GraphqlSlice;
  readonly graphqlResolvers: Record<string, unknown>;
  readonly mcpTools: readonly KernelMcpTool[];
  readonly contributor: SourceContributor;
}

export const makeParliamentModule = (deps: ParliamentModuleDeps): ParliamentModule => {
  const repo = makeParliamentRepo(deps.db);
  const contributor = makeParliamentContributor(repo);
  const clientBaseUrl = deps.clientBaseUrl ?? 'https://transparenta.eu';
  const usecaseDeps = { repo, meili: deps.meili };

  return {
    repo,
    graphqlSlice: { source: 'parliament', typeDefs: parliamentTypeDefs },
    graphqlResolvers: makeParliamentResolvers({
      ...usecaseDeps,
      legalActLoader: deps.legalActLoader,
      searchEngineUp: deps.searchEngineUp ?? false,
      // Default deny: the data-quality surface is closed unless the app wires a guard.
      isApiKeyAuthorized: deps.isApiKeyAuthorized ?? ((): boolean => false),
    }),
    mcpTools: makeParliamentMcpTools({ ...usecaseDeps, clientBaseUrl }),
    contributor,
  };
};

export type { ParliamentRepo } from './core/ports.js';
export * from './core/types.js';
export { makeParliamentContributor } from './shell/contributor.js';
export { makeParliamentRepo } from './shell/repo/parliament-repo.js';
export {
  PARLIAMENT_FILTER_SPECS,
  billsFilterSpec,
  controlItemsFilterSpec,
  memberVotesFhash,
  memberVotesFilterSpec,
  membersFilterSpec,
  votesFilterSpec,
} from './shell/filters/specs.js';
