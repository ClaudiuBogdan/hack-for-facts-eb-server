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

import {
  effectiveSemantic,
  type LegalSearchDeps,
  type ResolveLegalFiltersDeps,
} from './core/usecases.js';
import { makeMonitorulSurface } from './mo/index.js';
import { probeLegalHnsw } from './shell/capability.js';
import { makeLegalResolvers } from './shell/graphql/resolvers.js';
import { legalTypeDefs } from './shell/graphql/typedefs.js';
import { makeLegalActLoader } from './shell/loader/legal-act-loader.js';
import { makeLegalMcpTools } from './shell/mcp/tools.js';
import { makeLegalActsRepo } from './shell/repo/acts-repo.js';
import { makeLegalGraphRepo } from './shell/repo/graph-repo.js';
import { makeLegalOutlineRepo } from './shell/repo/outline-repo.js';
import { makeLegalRetrievalRepo } from './shell/repo/retrieval-repo.js';
import { makeLegalVocabRepo } from './shell/repo/vocab-repo.js';

import type {
  LegalActsRepo,
  LegalGraphRepo,
  LegalOutlineRepo,
  LegalRetrievalRepo,
} from './core/ports.js';
import type { LegalRepoBase } from './core/repo-base.js';
import type {
  CapabilityResolver,
  ContributorRegistry,
  GraphqlSlice,
  IdentityRepo,
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
  /** Kernel identity hub — the `mo/` area uses it for issuer-slug→org matching (06). */
  readonly identity: IdentityRepo;
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
  readonly outline: LegalOutlineRepo;
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

  // 1. acts-area repos (LegalActsRepo extends LegalRepoBase) + graph/outline/retrieval.
  const acts = makeLegalActsRepo(deps.db);
  const graph = makeLegalGraphRepo(deps.db);
  const outline = makeLegalOutlineRepo(deps.db);
  const retrieval = makeLegalRetrievalRepo(deps.db);
  const vocab = makeLegalVocabRepo(deps.db);
  const repos: LegalRepos = { base: acts, acts, graph, outline, retrieval };

  // 2. effective semantic gate: kernel slot AND live HNSW indexes (never mutates
  //    the kernel slot — a local AND that degrades to lexical when the index is gone).
  const hnswReady = await probeLegalHnsw(deps.db);
  const semanticReady = effectiveSemantic({ capabilities: deps.capabilities, hnswReady });

  // 3. the cross-module act loader (parliament/judicial consume it).
  const legalActLoader = makeLegalActLoader({
    acts,
    ...(deps.logger !== undefined && { logger: deps.logger }),
  });

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

  // 5. GraphQL slice + MCP tools (acts area).
  const actsResolvers = makeLegalResolvers({ acts, graph, outline, searchDeps, resolveDeps });
  const actsMcpTools = makeLegalMcpTools({
    acts,
    graph,
    outline,
    searchDeps,
    resolveDeps,
    clientBaseUrl,
  });

  // 6. mo/ area (06) — STITCHED INTO the single legal slice (foundation §9). MO adds
  //    Mo* types + `extend type LegalAct`/`Entity`/`Query` to the typeDefs, its
  //    resolvers (deep-merged so the LegalAct/Query maps gain fields, never clobber),
  //    its MCP tools, and the ONE issuer-keyed contributor. From build-app's view
  //    there is still exactly ONE `legal` module to register.
  const mo = makeMonitorulSurface({
    db: deps.db,
    base: acts,
    identity: deps.identity,
    registry: deps.registry,
    cache: deps.cache,
    clientBaseUrl,
  });

  const graphqlResolvers = deepMergeResolvers(actsResolvers, mo.resolvers);
  const mcpTools = [...actsMcpTools, ...mo.mcpTools];

  return {
    graphqlSlice: { source: 'legal', typeDefs: `${legalTypeDefs}\n\n${mo.typeDefs}` },
    graphqlResolvers,
    mcpTools,
    contributors: [mo.contributor], // 06's MO area: source:'monitorul-oficial'.
    repos,
    legalActLoader,
    semanticReady,
  };
};

/**
 * Deep-merge two resolver maps: nested resolver objects (e.g. `Query`, `LegalAct`,
 * `Entity`) merge field-by-field; new `Mo*` type maps are added. MO adds DISTINCT
 * fields (`Query.moX`, `LegalAct.gazetteX`, `Entity.monitorul`), so nothing in the
 * acts area is clobbered. A LEAF collision (the override would overwrite an existing
 * acts-area resolver fn or enum entry) THROWS at build time rather than silently
 * winning (Codex #6) — the only intended overwrites are nested-object merges.
 */
const deepMergeResolvers = (
  base: Record<string, unknown>,
  override: Record<string, unknown>,
  path = ''
): Record<string, unknown> => {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const existing = out[key];
    const here = path === '' ? key : `${path}.${key}`;
    const bothObjects =
      typeof existing === 'object' &&
      existing !== null &&
      !Array.isArray(existing) &&
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value);
    if (bothObjects) {
      out[key] = deepMergeResolvers(
        existing as Record<string, unknown>,
        value as Record<string, unknown>,
        here
      );
    } else if (existing !== undefined) {
      throw new Error(
        `legal resolver merge conflict: '${here}' is defined by both the acts and mo areas`
      );
    } else {
      out[key] = value;
    }
  }
  return out;
};

export type {
  LegalActsRepo,
  LegalGraphRepo,
  LegalOutlineRepo,
  LegalRetrievalRepo,
} from './core/ports.js';
export type { LegalRepoBase, LegalActRef } from './core/repo-base.js';
export * from './core/types.js';
export { legalActsSpec, LEGAL_FILTER_SPECS } from './shell/filters/legal-acts.spec.js';
export { makeLegalActLoader } from './shell/loader/legal-act-loader.js';
export { probeLegalHnsw } from './shell/capability.js';
