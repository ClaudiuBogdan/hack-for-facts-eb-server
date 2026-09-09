/**
 * Procurement module — cross-source contributor (kernel §14.7, review M/M10).
 *
 * Registers ONE `SourceContributor` (`source: 'procurement'`) so entity-360
 * badges and the profile report procurement like every other source. Both
 * legs read the bounded presence counts: an entity is "present" when at least
 * one canonical procurement record names it as authority or supplier.
 *
 * Identity is link-not-merge (keyed by CUI on the record tables). Withheld
 * identifiers (>10 digits, CNP-shaped) contribute NOTHING — absence, never a
 * confirmation that a row exists. `flow_type` registered: NONE here (money
 * flows are the budget module's grain gate).
 */
import { err, ok, type Result } from 'neverthrow';

import {
  isWithheldOrganizationIdentifier,
  type ApiError,
  type Cui,
  type EntityProfileSlice,
  type SourceContributor,
  type SourcePresence,
} from '@/modules/shared/index.js';

import type { ProcurementPresence } from '../core/types.js';

const PROCUREMENT_SOURCE = 'procurement';

export interface ProcurementContributorRepo {
  presenceCounts(cui: string): Promise<Result<ProcurementPresence | null, ApiError>>;
}

const authorityTotal = (p: ProcurementPresence): number =>
  p.asAuthority.procedures + p.asAuthority.contracts + p.asAuthority.directAcquisitions;
const supplierTotal = (p: ProcurementPresence): number =>
  p.asSupplier.contracts + p.asSupplier.directAcquisitions;

const plus = (n: number, capped: boolean): string => `${String(n)}${capped ? '+' : ''}`;

/** One sentence per role, only for roles the entity actually plays. */
export const procurementPresenceSummary = (p: ProcurementPresence): string => {
  const parts: string[] = [];
  const a = authorityTotal(p);
  if (a > 0) {
    parts.push(
      `contracting authority on ${plus(a, p.capped)} record(s) (${String(p.asAuthority.procedures)} procedures, ${String(p.asAuthority.contracts)} contracts, ${String(p.asAuthority.directAcquisitions)} direct acquisitions)`
    );
  }
  const s = supplierTotal(p);
  if (s > 0) {
    parts.push(
      `supplier on ${plus(s, p.capped)} record(s) (${String(p.asSupplier.contracts)} contracts, ${String(p.asSupplier.directAcquisitions)} direct acquisitions)`
    );
  }
  return `Public procurement: ${parts.join('; ')}.`;
};

export const makeProcurementContributor = (
  repo: ProcurementContributorRepo
): SourceContributor => ({
  source: PROCUREMENT_SOURCE,
  async presenceFor(cui: Cui): Promise<Result<SourcePresence | null, ApiError>> {
    if (isWithheldOrganizationIdentifier(cui)) return ok(null);
    const res = await repo.presenceCounts(cui);
    if (res.isErr()) return err(res.error);
    const p = res.value;
    if (p === null) return ok(null);
    const badges: string[] = [];
    if (authorityTotal(p) > 0) badges.push('contracting-authority');
    if (supplierTotal(p) > 0) badges.push('supplier');
    const total = authorityTotal(p) + supplierTotal(p);
    return ok({
      source: PROCUREMENT_SOURCE,
      present: true,
      // `count` = canonical procurement records naming the entity in any role.
      // A capped total is NOT published as a count: consumers render `count`
      // unqualified (entity-snapshot widget), so a ministry with 25,000
      // contracts would read "10000". The lower bound rides on the label
      // instead, and `attrs.capped` says why (Codex P2).
      ...(p.capped
        ? { label: `Public procurement (${plus(total, true)} records)` }
        : { label: 'Public procurement', count: total }),
      badges,
      attrs: {
        asAuthority: p.asAuthority,
        asSupplier: p.asSupplier,
        capped: p.capped,
      },
    });
  },
  async profileSlice(cui: Cui): Promise<Result<EntityProfileSlice | null, ApiError>> {
    if (isWithheldOrganizationIdentifier(cui)) return ok(null);
    const res = await repo.presenceCounts(cui);
    if (res.isErr()) return err(res.error);
    const p = res.value;
    if (p === null) return ok(null);
    return ok({
      source: PROCUREMENT_SOURCE,
      kind: 'procurementPresence',
      summary: procurementPresenceSummary(p),
      data: { asAuthority: p.asAuthority, asSupplier: p.asSupplier, capped: p.capped },
    });
  },
});
