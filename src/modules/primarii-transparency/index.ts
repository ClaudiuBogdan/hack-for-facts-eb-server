/**
 * Primarii-transparency module — public API (plan §11). Assembles the repo, GraphQL
 * slice, MCP tools, and the cross-source contributor from a kernel Kysely instance +
 * the kernel `IdentityRepo` (CUI resolution + per-entity territory via
 * `territoryForCui`).
 *
 * Importing this barrel pulls in `shell/db/schema.ts`, whose `declare module`
 * augments `ProdDatabase` with the `primarii_transparency.*` tables. SURFACE =
 * GraphQL + MCP only (no REST, per the kernel brief).
 *
 * Territory: the module NEVER joins core.* directly (§3). Per-entity territory works
 * via the kernel `territoryForCui` (a 100%-coverage point lookup, verified live);
 * geographic FILTERS (region/siruta/isUat/population) compile through the kernel
 * cui→territory set-predicate builder (`buildTerritoryCuiPredicate`), gated by
 * `territoryFilterAvailable` (the app wires it on).
 */

import './shell/db/schema.js';

import { makePrimariiContributor } from './shell/contributor.js';
import { makePrimariiResolvers } from './shell/graphql/resolvers.js';
import { primariiTypeDefs } from './shell/graphql/typedefs.js';
import { makePrimariiMcpTools } from './shell/mcp/tools.js';
import { makePrimariiRepo } from './shell/repo/primarii-repo.js';

import type { PrimariiRepository } from './core/ports.js';
import type { PrimariiDeps } from './core/usecases.js';
import type {
  ContributorRegistry,
  GraphqlSlice,
  IdentityRepo,
  KernelMcpTool,
  ProdDatabase,
  SourceContributor,
} from '@/modules/shared/index.js';
import type { Kysely } from 'kysely';

export interface PrimariiModuleDeps {
  readonly db: Kysely<ProdDatabase>;
  readonly identityRepo: IdentityRepo; // kernel — CUI resolution + territoryForCui
  readonly registry: ContributorRegistry;
  readonly clientBaseUrl?: string;
  /**
   * Whether to enable the kernel cui→territory SET-PREDICATE builder for geographic
   * FILTERS (region/siruta/isUat/population). `territoryForCui` (per-CUI enrichment)
   * always works; this gates only the filter predicates (§13.0). The builder
   * (`buildTerritoryCuiPredicate`) now exists, so the app wires this `true`; default
   * stays `false` so a caller that omits it keeps the conservative gated behavior
   * (filters return InvalidInput rather than silently dropping the predicate).
   */
  readonly territoryFilterAvailable?: boolean;
}

export interface PrimariiModule {
  readonly repo: PrimariiRepository;
  readonly graphqlSlice: GraphqlSlice;
  readonly graphqlResolvers: Record<string, unknown>;
  readonly mcpTools: readonly KernelMcpTool[];
  readonly contributor: SourceContributor;
}

export const makePrimariiTransparencyModule = (deps: PrimariiModuleDeps): PrimariiModule => {
  const repo = makePrimariiRepo(deps.db, {
    territoryFilterAvailable: deps.territoryFilterAvailable ?? false,
  });
  const usecaseDeps: PrimariiDeps = { repo, identityRepo: deps.identityRepo };
  const contributor = makePrimariiContributor(usecaseDeps);
  const clientBaseUrl = deps.clientBaseUrl ?? 'https://transparenta.eu';

  return {
    repo,
    graphqlSlice: { source: 'primarii_transparency', typeDefs: primariiTypeDefs },
    graphqlResolvers: makePrimariiResolvers({ ...usecaseDeps, registry: deps.registry }),
    mcpTools: makePrimariiMcpTools({ ...usecaseDeps, clientBaseUrl }),
    contributor,
  };
};

export type { PrimariiRepository } from './core/ports.js';
export * from './core/types.js';
export {
  PRIMARII_FILTER_SPECS,
  primariiEntityFilterSpec,
  primariiDocumentFilterSpec,
} from './core/filters.js';
export { makePrimariiContributor, toProfileSlice } from './shell/contributor.js';
export { makePrimariiRepo } from './shell/repo/primarii-repo.js';
