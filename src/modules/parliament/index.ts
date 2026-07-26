/**
 * Parliament module — public API (plan 04 §11). Assembles the repo, GraphQL slice,
 * MCP tools, and the cross-source contributor from a kernel Kysely instance + the
 * kernel-injected `LegalActByIdLoader` (the bill↔legal cross-link, §6.7).
 *
 * Surface = GraphQL + MCP, plus ONE REST route: the cacheable canonical
 * full-transcript read (`routesPlugin`, mounted under `/api/v1/parliament`). REST is
 * limited to that payload on purpose — it is the one parliament response that is
 * large, effectively immutable, and fetched by things that want HTTP cache semantics
 * (ETag / If-None-Match) rather than a POSTed GraphQL query. Every other read stays
 * GraphQL + MCP. Importing this barrel pulls in `shell/db/schema.ts`, whose
 * `declare module` augments `ProdDatabase` with the `parliament.*` tables.
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
import { makeParliamentRoutes } from './shell/rest/routes.js';
import { makeParliamentTranscriptSearch } from './shell/search/transcript-search.js';

import type { ParliamentRepo, ParliamentTranscriptSearchPort } from './core/ports.js';
import type {
  ContributorRegistry,
  GraphqlSlice,
  KernelMcpTool,
  LegalActByIdLoader,
  MeiliClient,
  ProdDatabase,
  SourceContributor,
} from '@/modules/shared/index.js';
import type { FastifyPluginAsync } from 'fastify';
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
  /**
   * Cache TTL for the REST full-transcript route. A canonical transcript changes only
   * when its stored capture is re-parsed, so the default (1h) is conservative and the
   * ETag keeps revalidation cheap after it expires.
   */
  readonly transcriptCacheTtlSeconds?: number;
}

export interface ParliamentModule {
  readonly repo: ParliamentRepo;
  readonly graphqlSlice: GraphqlSlice;
  readonly graphqlResolvers: Record<string, unknown>;
  readonly mcpTools: readonly KernelMcpTool[];
  readonly contributor: SourceContributor;
  /**
   * The canonical full-transcript REST route. Mount under `/api/v1/parliament`
   * (`app.register(parliament.routesPlugin, { prefix: '/api/v1/parliament' })`).
   */
  readonly routesPlugin: FastifyPluginAsync;
  /**
   * The canonical full-history transcript search projection, exposed so the app (and
   * tests) can inspect its `docType` / availability without reaching into the shell.
   */
  readonly transcriptSearch: ParliamentTranscriptSearchPort;
}

export const makeParliamentModule = (deps: ParliamentModuleDeps): ParliamentModule => {
  const repo = makeParliamentRepo(deps.db);
  const contributor = makeParliamentContributor(repo);
  const clientBaseUrl = deps.clientBaseUrl ?? 'https://transparenta.eu';
  // The canonical transcript search projection reads the kernel-owned, rebuildable
  // `search.documents` — it is NOT a second source of truth, and it reports itself
  // unavailable (rather than empty) when the projection has not been built, so a
  // full-history `q` fails loudly instead of answering a narrower question.
  const transcriptSearch = makeParliamentTranscriptSearch(deps.db);
  const usecaseDeps = { repo, meili: deps.meili };
  const stenogramDeps = { ...usecaseDeps, transcriptSearch };

  return {
    repo,
    graphqlSlice: { source: 'parliament', typeDefs: parliamentTypeDefs },
    graphqlResolvers: makeParliamentResolvers({
      ...stenogramDeps,
      legalActLoader: deps.legalActLoader,
      searchEngineUp: deps.searchEngineUp ?? false,
      // Default deny: the data-quality surface is closed unless the app wires a guard.
      isApiKeyAuthorized: deps.isApiKeyAuthorized ?? ((): boolean => false),
    }),
    mcpTools: makeParliamentMcpTools({ ...stenogramDeps, clientBaseUrl }),
    contributor,
    routesPlugin: makeParliamentRoutes({
      ...stenogramDeps,
      ...(deps.transcriptCacheTtlSeconds !== undefined && {
        transcriptCacheTtlSeconds: deps.transcriptCacheTtlSeconds,
      }),
    }),
    transcriptSearch,
  };
};

export type {
  ParliamentRepo,
  ParliamentStenogramRepo,
  ParliamentTranscriptSearchPort,
} from './core/ports.js';
export * from './core/types.js';
export { makeParliamentContributor } from './shell/contributor.js';
export { makeParliamentRepo } from './shell/repo/parliament-repo.js';
export { makeParliamentStenogramRepo } from './shell/repo/stenogram-repo.js';
export { makeParliamentTranscriptSearch } from './shell/search/transcript-search.js';
export { makeParliamentRoutes, type MakeParliamentRoutesDeps } from './shell/rest/routes.js';
export {
  PARLIAMENT_FILTER_SPECS,
  billsFilterSpec,
  controlItemsFilterSpec,
  memberSpeechesFhash,
  memberSpeechesFilterSpec,
  memberVotesFhash,
  memberVotesFilterSpec,
  membersFilterSpec,
  parliamentSpeechesFhash,
  parliamentSpeechesFilterSpec,
  stenogramSessionsFhash,
  stenogramSessionsFilterSpec,
  votesFilterSpec,
} from './shell/filters/specs.js';
