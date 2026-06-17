/**
 * Procurement module — cross-source contributor (plan §4.4, §14.7).
 *
 * Registers ONE `SourceContributor`. `presenceFor` powers entity-360 badges;
 * `profileSlice` is the SINGLE cross-source mechanism — the GraphQL
 * `Entity.procurement` resolver calls THIS (via the kernel), not a divergent path.
 * Both go through the aggregate repo (rollup-backed, gate-aware). Grain Gate
 * (§14.6): the slice reports contract + DA grains SEPARATELY, never one summed total.
 */

import { err, ok, type Result } from 'neverthrow';

import { PROCUREMENT_SOURCE } from '../core/constants.js';

import type { ProcurementAggregateRepo } from '../core/ports.js';
import type { ProcurementProfileSlice } from '../core/types.js';
import type {
  ApiError,
  Cui,
  EntityProfileSlice,
  SourceContributor,
  SourcePresence,
} from '@/modules/shared/index.js';

/** Wrap the rich procurement profile into the kernel's open profile-slice shape. */
export const toProfileSlice = (profile: ProcurementProfileSlice): EntityProfileSlice => {
  const summary =
    `Procurement: as authority ${profile.asAuthority.contractCount} contract-flows / ` +
    `${profile.asAuthority.daCount} direct-acquisition-flows; as supplier ` +
    `${profile.asSupplier.contractCount} / ${profile.asSupplier.daCount}.` +
    (profile.caveats.length > 0 ? ` ${profile.caveats.join(' ')}` : '');
  return {
    source: PROCUREMENT_SOURCE,
    kind: 'procurement_rollup',
    summary,
    data: profile as unknown as Record<string, unknown>,
  };
};

export const makeProcurementContributor = (agg: ProcurementAggregateRepo): SourceContributor => ({
  source: PROCUREMENT_SOURCE,

  async presenceFor(cui: Cui): Promise<Result<SourcePresence | null, ApiError>> {
    return agg.presenceFor(cui);
  },

  async profileSlice(cui: Cui): Promise<Result<EntityProfileSlice | null, ApiError>> {
    const res = await agg.profileSlice(cui);
    if (res.isErr()) return err(res.error);
    return ok(res.value === null ? null : toProfileSlice(res.value));
  },
});
