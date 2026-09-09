/**
 * Procurement presence for entity-360 (review M/M10): how many canonical
 * procurement records name a CUI as the contracting authority or as the
 * supplier. ONE round trip, every leg an indexed CUI lookup
 * (`*_authority_cui_idx` / `*_supplier_cui_idx`, verified live 2026-09-09),
 * each leg bounded by `PRESENCE_COUNT_CAP + 1` rows so a ministry with a
 * million contracts costs a capped index scan, not a full count.
 *
 * Population rules mirror the record surfaces: contracts and direct
 * acquisitions are canonical rows only; cancelled direct acquisitions are
 * excluded (no purchase happened — the same rule as `supplierRecords`);
 * procedures have no canonical flag (schema note, verified 2026-07-09). Every
 * leg pins `privacy_class = 'public'`: a restricted record must never reach a
 * count or a role badge (AGENTS.md privacy rule; Codex P2 on the first cut).
 */
import { sql, type Kysely } from 'kysely';
import { err, ok, type Result } from 'neverthrow';

import { databaseError, type ApiError, type ProdDatabase } from '@/modules/shared/index.js';

import type { ProcurementPresence } from '../../core/types.js';

/** Counts above this are reported as the cap with `capped: true`. */
export const PRESENCE_COUNT_CAP = 10_000;

interface PresenceRow {
  readonly authority_procedures: string;
  readonly authority_contracts: string;
  readonly authority_direct_acquisitions: string;
  readonly supplier_contracts: string;
  readonly supplier_direct_acquisitions: string;
}

const boundedCount = (leg: ReturnType<typeof sql>) =>
  sql<string>`(select count(*) from (${leg} limit ${sql.lit(PRESENCE_COUNT_CAP + 1)}) bounded)`;

const toCount = (raw: string): { value: number; capped: boolean } => {
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 0) return { value: 0, capped: false };
  return n > PRESENCE_COUNT_CAP
    ? { value: PRESENCE_COUNT_CAP, capped: true }
    : { value: n, capped: false };
};

export interface ProcurementPresenceRepo {
  presenceCounts(cui: string): Promise<Result<ProcurementPresence | null, ApiError>>;
}

export const makeProcurementPresenceRepo = (db: Kysely<ProdDatabase>): ProcurementPresenceRepo => ({
  async presenceCounts(cui) {
    try {
      const row = (await db
        .selectNoFrom([
          boundedCount(
            sql`select 1 from procurement.procedures p where p.authority_cui = ${cui} and p.privacy_class = 'public'`
          ).as('authority_procedures'),
          boundedCount(
            sql`select 1 from procurement.contracts c where c.authority_cui = ${cui} and c.is_canonical = true and c.privacy_class = 'public'`
          ).as('authority_contracts'),
          boundedCount(
            sql`select 1 from procurement.direct_acquisitions d where d.authority_cui = ${cui} and d.is_canonical = true and d.status <> 'cancelled' and d.privacy_class = 'public'`
          ).as('authority_direct_acquisitions'),
          boundedCount(
            sql`select 1 from procurement.contracts c where c.supplier_cui = ${cui} and c.is_canonical = true and c.privacy_class = 'public'`
          ).as('supplier_contracts'),
          boundedCount(
            sql`select 1 from procurement.direct_acquisitions d where d.supplier_cui = ${cui} and d.is_canonical = true and d.status <> 'cancelled' and d.privacy_class = 'public'`
          ).as('supplier_direct_acquisitions'),
        ])
        .executeTakeFirst()) as PresenceRow | undefined;
      if (row === undefined) return ok(null);
      const legs = {
        authorityProcedures: toCount(row.authority_procedures),
        authorityContracts: toCount(row.authority_contracts),
        authorityDirectAcquisitions: toCount(row.authority_direct_acquisitions),
        supplierContracts: toCount(row.supplier_contracts),
        supplierDirectAcquisitions: toCount(row.supplier_direct_acquisitions),
      };
      const presence: ProcurementPresence = {
        asAuthority: {
          procedures: legs.authorityProcedures.value,
          contracts: legs.authorityContracts.value,
          directAcquisitions: legs.authorityDirectAcquisitions.value,
        },
        asSupplier: {
          contracts: legs.supplierContracts.value,
          directAcquisitions: legs.supplierDirectAcquisitions.value,
        },
        capped: Object.values(legs).some((leg) => leg.capped),
      };
      const total =
        presence.asAuthority.procedures +
        presence.asAuthority.contracts +
        presence.asAuthority.directAcquisitions +
        presence.asSupplier.contracts +
        presence.asSupplier.directAcquisitions;
      return ok(total === 0 ? null : presence);
    } catch (error) {
      return err(databaseError('procurement presenceCounts failed', error));
    }
  },
});
