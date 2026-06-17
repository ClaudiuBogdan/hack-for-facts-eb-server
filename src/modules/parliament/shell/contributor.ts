/**
 * Parliament module — cross-source contributor (plan 04 §4.4, §14.7).
 *
 * Registers ONE `SourceContributor` (`source: 'parliament'`). Members have NO CUI
 * (people aren't orgs; party→CUI deferred), so parliament contributes to
 * entity-360 ONLY via the institutional `recipient` dimension of control items —
 * and only once recipient→CUI canonicalization exists (deferred).
 *
 * GRACEFUL DEGRADE (§4.4): until canonicalization lands, `presenceFor` and
 * `profileSlice` return `ok(null)` — entity-360 simply shows no parliament slice
 * for a CUI, never an error. The contributor is wired now so turning it on later
 * needs no kernel edit. Registers NO `flow_type` (parliament has no money flow).
 */

import { err, ok, type Result } from 'neverthrow';

import type { ParliamentRepo } from '../core/ports.js';
import type {
  ApiError,
  Cui,
  EntityProfileSlice,
  SourceContributor,
  SourcePresence,
} from '@/modules/shared/index.js';

const PARLIAMENT_SOURCE = 'parliament';

export const makeParliamentContributor = (repo: ParliamentRepo): SourceContributor => ({
  source: PARLIAMENT_SOURCE,

  async presenceFor(cui: Cui): Promise<Result<SourcePresence | null, ApiError>> {
    const res = await repo.controlPresenceForRecipient(cui);
    if (res.isErr()) return err(res.error);
    const p = res.value;
    if (p === null) return ok(null); // deferred recipient→CUI → no parliament slice (not an error)
    return ok({
      source: PARLIAMENT_SOURCE,
      present: true,
      label: 'Parliamentary control',
      count: p.count,
      badges: ['parliament-controls'],
      ...(p.lastDate !== null && { asOf: { controls: p.lastDate } }),
      attrs: { controlItemCount: p.count, lastItemDate: p.lastDate, topRecipient: p.topRecipient },
    });
  },

  async profileSlice(cui: Cui): Promise<Result<EntityProfileSlice | null, ApiError>> {
    const res = await repo.controlPresenceForRecipient(cui);
    if (res.isErr()) return err(res.error);
    const p = res.value;
    if (p === null) return ok(null);
    return ok({
      source: PARLIAMENT_SOURCE,
      kind: 'parliament_controls',
      summary: `${String(p.count)} parliamentary control item(s) addressed to this institution.`,
      data: { controlItemCount: p.count, lastItemDate: p.lastDate, topRecipient: p.topRecipient },
    });
  },
});
