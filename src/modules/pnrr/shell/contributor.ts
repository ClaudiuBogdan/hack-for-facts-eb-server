/**
 * PNRR module — cross-source contributor (plan §4.1, §14.7).
 *
 * Registers ONE `SourceContributor` into the kernel registry. `presenceFor`
 * powers entity-360 badges; `profileSlice` is the SINGLE cross-source mechanism —
 * the GraphQL `Entity.pnrr` resolver calls THIS, not a divergent path. The slice
 * wraps the rich `PnrrEntityProfile` (the usecase is the source of truth) into the
 * kernel's open `{ source, kind, summary?, data? }` shape.
 */

import { err, ok, type Result  } from 'neverthrow';

import { getPnrrEntityProfile } from '../core/usecases.js';

import type { PnrrRepository } from '../core/ports.js';
import type { PnrrEntityProfile } from '../core/types.js';
import type {
  ApiError,
  Cui,
  EntityProfileSlice,
  SourceContributor,
  SourcePresence,
} from '@/modules/shared/index.js';


const PNRR_SOURCE = 'pnrr';

/** Build the open profile slice from the rich profile (one projection, no second query). */
export const toProfileSlice = (profile: PnrrEntityProfile): EntityProfileSlice => {
  const p = profile.payments;
  const summary =
    `${String(p.count)} PNRR payment(s)` +
    (p.totalLei !== null ? ` totalling ${p.totalLei} lei` : '') +
    `; ${String(profile.commitments.count)} commitment(s); won ${String(profile.procurement.wonAsContractor)} contract(s).`;
  return {
    source: PNRR_SOURCE,
    kind: 'pnrr_entity_profile',
    summary,
    data: profile as unknown as Record<string, unknown>,
  };
};

export const makePnrrContributor = (repo: PnrrRepository): SourceContributor => ({
  source: PNRR_SOURCE,

  async presenceFor(cui: Cui): Promise<Result<SourcePresence | null, ApiError>> {
    const res = await repo.getEntityProfile(cui);
    if (res.isErr()) return err(res.error);
    const profile = res.value;
    if (profile === null) return ok(null);

    const payCount = profile.payments.count;
    const commitCount = profile.commitments.count;
    const wonCount = profile.procurement.wonAsContractor;
    const acqCount = profile.procurement.acquisitionsAsBeneficiary;
    const present = payCount > 0 || commitCount > 0 || wonCount > 0 || acqCount > 0;

    const badges: string[] = [];
    if (payCount > 0) badges.push('pnrr-beneficiary');
    if (commitCount > 0) badges.push('pnrr-commitments');
    if (acqCount > 0) badges.push('pnrr-procurer');
    if (wonCount > 0) badges.push('pnrr-contractor');

    return ok({
      source: PNRR_SOURCE,
      present,
      label: 'PNRR',
      count: payCount,
      badges,
      ...(profile.dataAsOf !== null && { asOf: { payments: profile.dataAsOf } }),
      attrs: {
        payments: payCount,
        commitments: commitCount,
        acquisitionsAsBeneficiary: acqCount,
        wonAsContractor: wonCount,
      },
    });
  },

  async profileSlice(cui: Cui): Promise<Result<EntityProfileSlice | null, ApiError>> {
    const res = await getPnrrEntityProfile(repo, cui);
    if (res.isErr()) return err(res.error);
    return ok(res.value === null ? null : toProfileSlice(res.value));
  },
});
