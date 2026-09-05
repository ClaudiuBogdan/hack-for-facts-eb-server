/** INS statistics about an entity's canonical area, not its fiscal jurisdiction. */
import { err, ok, type Result } from 'neverthrow';

import { resolveInsEntityTerritory } from '../core/entity-territory.js';

import type { InsRepo } from '../core/ports.js';
import type {
  ApiError,
  Cui,
  SourceContributor,
  SourcePresence,
  Territory,
} from '@/modules/shared/index.js';

const INS_SOURCE = 'ins';

export interface InsContributorDeps {
  /** Kernel identity hub retains withholding policy and canonical level/kind. */
  territoryForCui?(cui: Cui): Promise<Result<Territory | null, ApiError>>;
}

export const makeInsContributor = (
  repo: InsRepo,
  deps: InsContributorDeps = {}
): SourceContributor => ({
  source: INS_SOURCE,
  async presenceFor(cui): Promise<Result<SourcePresence | null, ApiError>> {
    if (deps.territoryForCui === undefined) return ok(null);
    const territory = await deps.territoryForCui(cui);
    if (territory.isErr()) return err(territory.error);
    if (territory.value === null) return ok(null);
    const anchor = territory.value;
    return repo.withSnapshot(async (snapshot) => {
      const resolved = await resolveInsEntityTerritory(snapshot, anchor);
      if (resolved.isErr()) return err(resolved.error);
      const node = resolved.value;
      if (node === null) return ok(null);
      const coverage = await snapshot.datasetsForTerritory(node.territoryId);
      if (coverage.isErr()) return err(coverage.error);
      if (coverage.value.length === 0) return ok(null);
      return ok({
        source: INS_SOURCE,
        present: true,
        label: 'Statistici INS',
        count: coverage.value.length,
        badges: ['ins', node.level.toLowerCase()],
        attrs: {
          territoryCode: node.code,
          territoryName: node.nameRo,
          territoryLevel: node.level,
          ...(node.sirutaCode === null ? {} : { sirutaCode: node.sirutaCode }),
        },
      });
    });
  },
});
