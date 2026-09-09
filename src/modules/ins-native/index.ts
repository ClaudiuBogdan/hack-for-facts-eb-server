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

import { GraphQLError } from 'graphql';

import { makeInsContributor, type InsContributorDeps } from './shell/contributor.js';
import { makeInsLegacyResolvers } from './shell/graphql/legacy/resolvers.js';
import { insLegacyTypeDefs } from './shell/graphql/legacy/typedefs.js';
import { makeInsMcpTools } from './shell/mcp/tools.js';
import {
  NATIVE_MAP_POPULATION_ADMISSION,
  NATIVE_SECTOR_POPULATION_ADMISSION,
} from './shell/population/admissions.js';
import { makeInsAnnualPopulationPort } from './shell/population/port.js';
import { makeInsRepo } from './shell/repo/ins-repo.js';
import { makeInsReadSession, type InsReadSession } from './shell/repo/read-session.js';

import type { AnnualPopulationAdmission } from './core/annual-population.js';
import type { SectorPopulationAdmission } from './core/population-admission.js';
import type { InsRepo } from './core/ports.js';
import type {
  ContributorRegistry,
  GraphqlSlice,
  KernelMcpTool,
  AnnualPopulationPort,
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
  /** CUI → canonical geographic anchor (kernel identity hub); absent = no presence. */
  readonly territoryForCui?: InsContributorDeps['territoryForCui'];
  /** Override the admitted POP107D publication (tests, re-admission rehearsals). */
  readonly populationAdmission?: AnnualPopulationAdmission;
  /** Override the sector supplement; `null` serves no sector supplement at all. */
  readonly sectorPopulationAdmission?: SectorPopulationAdmission | null;
}

export interface InsNativeModule {
  readonly repo: InsRepo;
  readonly createReadSession: () => InsReadSession;
  /** Kernel population port bound to this module's admitted publications (X/F6). */
  readonly population: AnnualPopulationPort;
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
    createReadSession: () => makeInsReadSession(deps.db),
    population: makeInsAnnualPopulationPort({
      db: deps.db,
      admission: deps.populationAdmission ?? NATIVE_MAP_POPULATION_ADMISSION,
      ...(deps.sectorPopulationAdmission === null
        ? {}
        : {
            sectorAdmission: deps.sectorPopulationAdmission ?? NATIVE_SECTOR_POPULATION_ADMISSION,
          }),
    }),
    graphqlSlice: { source: INS_NATIVE_SOURCE, typeDefs: insLegacyTypeDefs },
    graphqlResolvers: makeInsLegacyResolvers({
      repo,
      ...(deps.territoryForCui === undefined ? {} : { territoryForCui: deps.territoryForCui }),
      ...(deps.repo === undefined && {
        repoForContext: async (context: unknown): Promise<InsRepo> => {
          const session = (context as { insReadSession?: InsReadSession } | null)?.insReadSession;
          if (session === undefined) {
            throw new GraphQLError('INS operation session unavailable', {
              extensions: { code: 'SERVICE_UNAVAILABLE' },
            });
          }
          const result = await session.getRepo();
          if (result.isErr()) {
            throw new GraphQLError(result.error.message, {
              extensions: {
                code: result.error.type === 'Timeout' ? 'TIMEOUT' : 'SERVICE_UNAVAILABLE',
              },
            });
          }
          return result.value;
        },
      }),
    }),
    mcpTools: makeInsMcpTools({ repo, clientBaseUrl }),
    contributor: makeInsContributor(
      repo,
      deps.territoryForCui === undefined ? {} : { territoryForCui: deps.territoryForCui }
    ),
  };
};

export type { InsRepo } from './core/ports.js';
export * from './core/types.js';
export {
  insLegacyTypeDefs,
  INS_LEGACY_ROOTS,
  INS_LEGACY_ROOTS_DROPPED,
} from './shell/graphql/legacy/typedefs.js';
export { makeInsRepo, withInsReadSnapshot } from './shell/repo/ins-repo.js';

export { makeInsReadSession, type InsReadSession } from './shell/repo/read-session.js';

export { readInsMapData, type InsMapData, type InsMapDataInput } from './core/map-data.js';

export { parseMemberCode } from './core/identity.js';

export { resolveInsTerritories } from './core/entity-territory.js';
export {
  readAnnualPopulation,
  type AnnualPopulationAdmission,
  type AnnualPopulationResult,
} from './core/annual-population.js';

export { resolveInsTerritoryInputs } from './core/territory-inputs.js';

// ── population (X/F6): the kernel port implementation and the admitted publications ──
export {
  NATIVE_MAP_POPULATION_ADMISSION,
  NATIVE_SECTOR_POPULATION_ADMISSION,
} from './shell/population/admissions.js';
export {
  makeInsAnnualPopulationPort,
  type InsAnnualPopulationPortDeps,
} from './shell/population/port.js';
export { readNativePopulation, type NativePopulationCell } from './shell/population/cells.js';
export { readAdmittedSectorPopulation } from './shell/population/sector.js';
export {
  ADMITTED_SECTOR_YEAR_SETS,
  BUCHAREST_SECTOR_SIRUTAS,
  sectorAdmissionIsWellFormed,
  sectorRowsAreAdmissible,
  sectorRowsDigestInput,
  type SectorPopulationAdmission,
  type SectorPopulationRowLike,
} from './core/population-admission.js';

// ── INS dataset requests (moved from the legacy `ins` module, slice 1 commit 5) ──
// A user asks for a (usually not-yet-loaded) dataset. Writes go to the
// server-owned user database; the catalog check reads the native repository.
export {
  makeInsDatasetRequestRoutes,
  type MakeInsDatasetRequestRoutesDeps,
} from './shell/dataset-requests/routes.js';
export {
  makeInsDatasetRequestRepo,
  makeInsNativeDatasetCatalogReader,
} from './shell/dataset-requests/repo.js';
export type {
  InsDatasetCatalogReader,
  InsDatasetRequestRepository,
} from './core/dataset-requests/ports.js';
export type { DatasetRequestError } from './core/dataset-requests/errors.js';
export { createDatabaseError as createDatasetRequestDatabaseError } from './core/dataset-requests/errors.js';
export type { InsDatasetRequest, InsDatasetRequestInput } from './core/dataset-requests/types.js';
export { MAX_DATASET_REQUEST_NOTE_LENGTH } from './core/dataset-requests/types.js';
export { createInsDatasetRequest } from './core/dataset-requests/create-ins-dataset-request.js';
