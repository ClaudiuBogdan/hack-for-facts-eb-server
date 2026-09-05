/** INS statistics about an entity's canonical area, not its fiscal jurisdiction. */
import { err, ok, type Result } from 'neverthrow';

import {
  resolveInsEntityContext,
  type InsEntityContext,
  type InsEntityContextDeps,
} from '../core/entity-context.js';

import type { InsRepo } from '../core/ports.js';
import type {
  ApiError,
  EntityProfileSlice,
  SourceContributor,
  SourcePresence,
} from '@/modules/shared/index.js';

const INS_SOURCE = 'ins';
export type InsContributorDeps = InsEntityContextDeps;
export interface InsEntityProfileSlice extends EntityProfileSlice {
  readonly source: 'ins';
  readonly kind: 'territory-context';
  readonly data: InsEntityContext & Record<string, unknown>;
}

/** Bind this factory to the operation repo for GraphQL, or the ordinary repo for registry calls. */
export const makeInsContributor = (
  repo: InsRepo,
  deps: InsContributorDeps = {}
): SourceContributor & {
  profileSlice(cui: string): Promise<Result<InsEntityProfileSlice | null, ApiError>>;
} => ({
  source: INS_SOURCE,
  async presenceFor(cui): Promise<Result<SourcePresence | null, ApiError>> {
    // Preserve absence for an unwired optional registry contributor. Explicit profile reads fail.
    if (deps.territoryForCui === undefined) return ok(null);
    const result = await resolveInsEntityContext(repo, deps, cui);
    if (result.isErr()) return err(result.error);
    const context = result.value;
    if (context === null || context.datasetCount === 0) return ok(null);
    return ok({
      source: INS_SOURCE,
      present: true,
      label: 'Statistici INS',
      count: context.datasetCount,
      badges: ['ins', context.territoryLevel.toLowerCase()],
      attrs: {
        territoryCode: context.territoryCode,
        territoryName: context.territoryName,
        territoryLevel: context.territoryLevel,
        ...(context.sirutaCode === null ? {} : { sirutaCode: context.sirutaCode }),
      },
    });
  },
  async profileSlice(cui) {
    const result = await resolveInsEntityContext(repo, deps, cui);
    if (result.isErr()) return err(result.error);
    return ok(
      result.value === null
        ? null
        : {
            source: INS_SOURCE,
            kind: 'territory-context',
            data: { ...result.value },
          }
    );
  },
});
