/**
 * Legal module — public API (plan §11). **ONE module, two authoring areas**
 * (`acts/` owned by 05, `mo/` owned by 06) — resolves the foundation §10 "a source
 * module never imports another source module" tension: portal + MO co-own
 * `src/modules/legal/`, so there is no INTER-module import; both areas share
 * `core/` via ordinary intra-module imports and are composed by THIS factory.
 *
 * `makeLegalModule(deps)` is the SINGLE factory. From `build-redesign-app.ts`'s
 * view there is exactly one `legal` module to register. It returns the GraphQL
 * slice (acts typedefs; 06 stitches its `extend type LegalAct` + Mo* typedefs in
 * here before contribution), MCP tools, the v1 contributor set (NONE from acts;
 * 06's MO area adds the issuer-keyed `monitorul-oficial` contributor), the repos
 * (so 06 builds MO repos on `repos.base`), and the `LegalActByIdLoader`
 * (registered by the app via `kernel.registerLegalActLoader`).
 *
 * Importing this barrel pulls in `shell/db/schema.ts`, whose `declare module`
 * augments `ProdDatabase` with the acts/sections `legal.*` tables.
 */

import './shell/db/schema.js';

import { effectiveSemantic, type LegalSearchDeps, type ResolveLegalFiltersDeps } from './core/usecases.js';
import { probeLegalHnsw } from './shell/capability.js';
import { makeLegalResolvers } from './shell/graphql/resolvers.js';
import { legalTypeDefs } from './shell/graphql/typedefs.js';
import { makeLegalActLoader } from './shell/loader/legal-act-loader.js';
import { makeLegalMcpTools } from './shell/mcp/tools.js';
import { makeLegalActsRepo } from './shell/repo/acts-repo.js';
import { makeLegalGraphRepo } from './shell/repo/graph-repo.js';
import { makeLegalRetrievalRepo } from './shell/repo/retrieval-repo.js';
import { makeLegalTreeRepo } from './shell/repo/tree-repo.js';
import { makeLegalVocabRepo } from './shell/repo/vocab-repo.js';

import type { LegalActsRepo, LegalGraphRepo, LegalRetrievalRepo, LegalTreeRepo } from './core/ports.js';
import type { LegalRepoBase } from './core/repo-base.js';
import type {
  CapabilityResolver,
  ContributorRegistry,
  GraphqlSlice,
  KernelCache,
  KernelMcpTool,
  LegalActByIdLoader,
  MeiliClient,
  OpenSearchClient,
  ProdDatabase,
  SourceContributor,
  SyntheticClient,
} from '@/modules/shared/index.js';
import type { Kysely } from 'kysely';

/** Minimal logger surface (Fastify's logger satisfies it). */
export interface LegalModuleLogger {
  warn?: (obj: Record<string, unknown>, msg: string) => void;
  info?: (obj: Record<string, unknown>, msg: string) => void;
}

export interface LegalModuleDeps {
  readonly db: Kysely<ProdDatabase>;
  readonly meiliClient: MeiliClient;
  readonly openSearchClient: OpenSearchClient;
  readonly synthetic: SyntheticClient;
  readonly capabilities: CapabilityResolver;
  readonly cache: KernelCache;
  /** The kernel contributor registry (06's MO contributor registers here). */
  readonly registry: ContributorRegistry;
  /** The discovered/overridden embedding model id (nomic; `search_query:` prefix). */
  readonly embeddingModel: string;
  readonly clientBaseUrl?: string;
  readonly logger?: LegalModuleLogger;
}

/** The acts-area repo set 06 reuses (`base` is the skeleton join target). */
export interface LegalRepos {
  readonly base: LegalRepoBase;
  readonly acts: LegalActsRepo;
  readonly graph: LegalGraphRepo;
  readonly tree: LegalTreeRepo;
  readonly retrieval: LegalRetrievalRepo;
}

export interface LegalModule {
  readonly graphqlSlice: GraphqlSlice;
  readonly graphqlResolvers: Record<string, unknown>;
  readonly mcpTools: readonly KernelMcpTool[];
  /**
   * The module's contributor set. v1: empty from the acts area (no per-CUI legal
   * slice — §4). 06's MO area pushes one `source:'monitorul-oficial'` contributor
   * here (composed inside this factory once `mo/` lands).
   */
  readonly contributors: readonly SourceContributor[];
  readonly repos: LegalRepos;
  /** Registered by the app via `kernel.registerLegalActLoader(...)`. */
  readonly legalActLoader: LegalActByIdLoader;
  /** Effective semantic readiness (kernel slot AND live HNSW), exposed for tests/health. */
  readonly semanticReady: boolean;
}

/**
 * Construct the legal module. Async because it probes the live HNSW indexes once
 * at boot to compute the effective semantic gate (kernel slot AND index present).
 */
export const makeLegalModule = async (deps: LegalModuleDeps): Promise<LegalModule> => {
  const clientBaseUrl = deps.clientBaseUrl ?? 'https://transparenta.eu';

  // 1. acts-area repos (LegalActsRepo extends LegalRepoBase) + graph/tree/retrieval.
  const acts = makeLegalActsRepo(deps.db);
  const graph = makeLegalGraphRepo(deps.db);
  const tree = makeLegalTreeRepo(deps.db);
  const retrieval = makeLegalRetrievalRepo(deps.db);
  const vocab = makeLegalVocabRepo(deps.db);
  const repos: LegalRepos = { base: acts, acts, graph, tree, retrieval };

  // 2. effective semantic gate: kernel slot AND live HNSW indexes (never mutates
  //    the kernel slot — a local AND that degrades to lexical when the index is gone).
  const hnswReady = await probeLegalHnsw(deps.db);
  const semanticReady = effectiveSemantic({ capabilities: deps.capabilities, hnswReady });

  // 3. the cross-module act loader (parliament/judicial consume it).
  const legalActLoader = makeLegalActLoader({ acts, ...(deps.logger !== undefined && { logger: deps.logger }) });

  // 4. usecase dep bundles (shared by GraphQL + MCP — tri-surface equivalence).
  const searchDeps: LegalSearchDeps = {
    retrieval,
    acts,
    synthetic: deps.synthetic,
    capabilities: deps.capabilities,
    embeddingModel: deps.embeddingModel,
    semanticReady,
    clientBaseUrl,
  };
  const resolveDeps: ResolveLegalFiltersDeps = { base: acts, acts, vocab };

  // 5. GraphQL slice + MCP tools (acts area). 06 stitches its `extend type LegalAct`
  //    + Mo* typedefs into this slice and pushes its contributor before contribution.
  const graphqlResolvers = makeLegalResolvers({ acts, graph, tree, searchDeps, resolveDeps });
  const mcpTools = makeLegalMcpTools({ acts, graph, tree, searchDeps, resolveDeps, clientBaseUrl });

  return {
    graphqlSlice: { source: 'legal', typeDefs: legalTypeDefs },
    graphqlResolvers,
    mcpTools,
    contributors: [], // acts area: none in v1 (§4). 06's MO area appends here.
    repos,
    legalActLoader,
    semanticReady,
  };
};

export type { LegalActsRepo, LegalGraphRepo, LegalRetrievalRepo, LegalTreeRepo } from './core/ports.js';
export type { LegalRepoBase, LegalActRef } from './core/repo-base.js';
export * from './core/types.js';
export { legalActsSpec, LEGAL_FILTER_SPECS } from './shell/filters/legal-acts.spec.js';
export { makeLegalActLoader } from './shell/loader/legal-act-loader.js';
export { probeLegalHnsw } from './shell/capability.js';
