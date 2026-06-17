/**
 * Reference module — public API (plan §11). Assembles the module-owned repos, the
 * GraphQL slice, MCP tools, and the cross-source contributor from the kernel Kysely
 * instance + the injected KERNEL identity/territory repos. The app registers the
 * slice + tools and registers the contributor into the kernel registry.
 *
 * Reference is the READ surface over `core.*` — it adds NO schema (the kernel
 * already declares every `core.*` table), so there is no `declare module`
 * augmentation here (unlike a new-schema module such as pnrr).
 */

import { makeReferenceContributor } from './shell/contributor.js';
import { makeReferenceResolvers } from './shell/graphql/resolvers.js';
import { referenceTypeDefs } from './shell/graphql/typedefs.js';
import { makeReferenceMcpTools } from './shell/mcp/tools.js';
import { makeClassificationRepo } from './shell/repo/classification-repo.js';
import { makePublicEntityRepo } from './shell/repo/public-entity-repo.js';
import { makeTerritoryQueryRepo } from './shell/repo/territory-query-repo.js';

import type { ClassificationRepo, PublicEntityRepo, TerritoryQueryRepo } from './core/ports.js';
import type { ReferenceDeps } from './core/usecases.js';
import type {
  ContributorRegistry,
  GraphqlSlice,
  IdentityRepo,
  KernelMcpTool,
  ProdDatabase,
  SourceContributor,
  TerritoryRepo,
} from '@/modules/shared/index.js';
import type { Kysely } from 'kysely';

export interface ReferenceModuleDeps {
  readonly db: Kysely<ProdDatabase>;
  /** KERNEL repos — injected, NOT constructed here (§0 reuse rule). */
  readonly identityRepo: IdentityRepo;
  readonly territoryRepo: TerritoryRepo;
  readonly registry: ContributorRegistry;
  /** Client base URL for MCP deep links (defaults to the public site). */
  readonly clientBaseUrl?: string;
}

export interface ReferenceModule {
  readonly publicEntityRepo: PublicEntityRepo;
  readonly classificationRepo: ClassificationRepo;
  readonly territoryQueryRepo: TerritoryQueryRepo;
  readonly graphqlSlice: GraphqlSlice;
  readonly graphqlResolvers: Record<string, unknown>;
  readonly mcpTools: readonly KernelMcpTool[];
  readonly contributor: SourceContributor;
}

export const makeReferenceModule = (deps: ReferenceModuleDeps): ReferenceModule => {
  const publicEntityRepo = makePublicEntityRepo(deps.db);
  const classificationRepo = makeClassificationRepo(deps.db);
  const territoryQueryRepo = makeTerritoryQueryRepo(deps.db);
  const clientBaseUrl = deps.clientBaseUrl ?? 'https://transparenta.eu';

  const usecaseDeps: ReferenceDeps = {
    publicEntities: publicEntityRepo,
    classification: classificationRepo,
    territories: territoryQueryRepo,
    identityRepo: deps.identityRepo,
    territoryRepo: deps.territoryRepo,
  };

  return {
    publicEntityRepo,
    classificationRepo,
    territoryQueryRepo,
    graphqlSlice: { source: 'reference', typeDefs: referenceTypeDefs },
    graphqlResolvers: makeReferenceResolvers({ ...usecaseDeps, registry: deps.registry }),
    mcpTools: makeReferenceMcpTools({ ...usecaseDeps, clientBaseUrl }),
    contributor: makeReferenceContributor(publicEntityRepo),
  };
};

export type { PublicEntityRepo, ClassificationRepo, TerritoryQueryRepo } from './core/ports.js';
export * from './core/types.js';
export { REFERENCE_FILTER_SPECS } from './core/filters.js';
export { makeReferenceContributor, toProfileSlice } from './shell/contributor.js';
export { makePublicEntityRepo } from './shell/repo/public-entity-repo.js';
export { makeClassificationRepo } from './shell/repo/classification-repo.js';
export { makeTerritoryQueryRepo } from './shell/repo/territory-query-repo.js';
