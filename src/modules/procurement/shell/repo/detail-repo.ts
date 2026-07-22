/**
 * Procurement module — detail-bundle support: duplicate siblings, the TED notice,
 * batched modifications, and the supplier-records union connection.
 *
 * DUPLICATES. `contracts_dup_canonical_uq` / `das_dup_canonical_uq` are PARTIAL
 * indexes (`WHERE dup_group_id IS NOT NULL AND is_canonical`), so the suppressed
 * (non-canonical) members of a group are NOT index-covered by `dup_group_id`. We
 * therefore drive the lookup from an indexed entity column on the canonical row —
 * `authority_cui`, falling back to `supplier_cui` — and filter the group in the
 * heap. Both null ⇒ no affordable lookup ⇒ `[]` (honest, not fabricated).
 *
 * TED. `procedure_ted_links.procedure_id` is 100% populated (57 965/57 965 rows,
 * verified live), but covers only 57 965 of 622 936 procedures (9.3%). A procedure
 * with no link gets `ted: null` — the notice does not exist, it is not "unknown".
 */

import { sql, type Kysely, type RawBuilder, type SqlBool } from 'kysely';
import { err, ok, type Result } from 'neverthrow';

import {
  databaseError,
  invalidInput,
  type ApiError,
  type ProdDatabase,
} from '@/modules/shared/index.js';

import { mapContract, mapDirectAcquisition, mapModification, mapTedRef } from './mappers.js';
import {
  cursorOf,
  decodeRecordCursor,
  encodeRecordCursor,
  grainRank,
  mergeSupplierRecords,
  type RecordCursor,
} from '../../core/supplier-records.js';

import type {
  DuplicateRef,
  ProcurementContract,
  ProcurementModification,
  SupplierRecord,
  SupplierRecordConnection,
  TedRef,
} from '../../core/types.js';

type Db = Kysely<ProdDatabase>;

/** A dedup group never holds many rows; 20 suppressed siblings is a generous cap. */
const DUPLICATES_CAP = 20;
/** `first` on the supplier connection, per the client contract. */
export const SUPPLIER_RECORDS_FIRST_MAX = 100;
const MODIFICATIONS_PER_CONTRACT_CAP = 200;

const isBigint = (id: string): boolean => /^\d+$/u.test(id);

// Projections must match the mapper row types exactly.
const contractSelect = [
  'c.contract_id',
  'c.contract_key',
  'c.source_system',
  'c.source_url',
  'c.procedure_id',
  'c.notice_no',
  'c.contract_no',
  sql<string | null>`c.contract_date::text`.as('contract_date'),
  'c.title',
  'c.authority_cui',
  'c.authority_name',
  'c.supplier_cui',
  'c.supplier_name',
  'c.cpv_code',
  'c.currency',
  sql<string | null>`c.value_ron::text`.as('value_ron'),
  sql<string | null>`c.estimated_value_ron::text`.as('estimated_value_ron'),
  'c.status',
  'c.county_name',
  'c.is_canonical',
  'c.dup_group_id',
  'c.value_state',
  'c.value_state_detail',
  sql<string | null>`c.value_ron_comparable::text`.as('value_ron_comparable'),
  'c.value_comparable_basis',
  'c.value_rules_version',
  sql<string | null>`c.value_resolved_at::text`.as('value_resolved_at'),
  'c.canonical_value_source',
  'c.value_disagreement',
] as const;

const daSelect = [
  'd.da_id',
  'd.da_key',
  'd.source_system',
  'd.source_url',
  'd.unique_code',
  'd.title',
  'd.authority_cui',
  'd.authority_name',
  'd.supplier_cui',
  'd.supplier_name',
  'd.cpv_code',
  'd.currency',
  sql<string | null>`d.value_ron::text`.as('value_ron'),
  sql<string | null>`d.estimated_value_ron::text`.as('estimated_value_ron'),
  'd.status',
  'd.county_name',
  sql<string | null>`d.publication_date::text`.as('publication_date'),
  sql<string | null>`d.finalization_date::text`.as('finalization_date'),
  'd.is_canonical',
  'd.dup_group_id',
  'd.value_state',
  'd.value_state_detail',
  sql<string | null>`d.value_ron_comparable::text`.as('value_ron_comparable'),
  'd.value_comparable_basis',
  'd.value_rules_version',
  sql<string | null>`d.value_resolved_at::text`.as('value_resolved_at'),
] as const;

const modificationSelect = [
  'm.modification_id',
  'm.contract_id',
  'm.source_url',
  'm.link_method',
  'm.link_confidence',
  'm.authority_cui',
  'm.supplier_cui',
  'm.contract_no',
  'm.notice_no',
  sql<string | null>`m.modification_date::text`.as('modification_date'),
  sql<string | null>`m.value_before_ron::text`.as('value_before_ron'),
  sql<string | null>`m.value_after_ron::text`.as('value_after_ron'),
  sql<string | null>`m.value_delta_ron::text`.as('value_delta_ron'),
  'm.modification_type',
  'm.year',
] as const;

/** The canonical row's identity, as far as the duplicate lookup needs it. */
export interface DuplicateAnchor {
  readonly id: string;
  readonly dupGroupId: string | null;
  readonly authorityCui: string | null;
  readonly supplierCui: string | null;
}

export interface ProcurementDetailRepo {
  duplicatesForContract(
    anchor: DuplicateAnchor
  ): Promise<Result<readonly DuplicateRef[], ApiError>>;
  duplicatesForDirectAcquisition(
    anchor: DuplicateAnchor
  ): Promise<Result<readonly DuplicateRef[], ApiError>>;
  tedForProcedure(procedureId: string): Promise<Result<TedRef | null, ApiError>>;
  /** Batched for the per-request DataLoader — one statement per tick, never N+1. */
  modificationsForContracts(
    contractIds: readonly string[]
  ): Promise<Result<ReadonlyMap<string, readonly ProcurementModification[]>, ApiError>>;
  contractsByIds(
    contractIds: readonly string[]
  ): Promise<Result<ReadonlyMap<string, ProcurementContract>, ApiError>>;
  supplierRecords(
    supplierCui: string,
    first: number,
    after: string | undefined,
    includeCancelled: boolean
  ): Promise<Result<SupplierRecordConnection, ApiError>>;
}

/**
 * Choose the INDEXED column that drives the duplicate lookup. `authority_cui` first
 * (`contracts_authority_cui_idx` / `das_authority_cui_idx`), then `supplier_cui`.
 * No dup group, or neither cui ⇒ null: the group is unreachable without scanning a
 * 3.3M/26M-row table, so we report nothing rather than guess.
 */
export const pickDuplicateDriver = (
  anchor: DuplicateAnchor
): { readonly column: string; readonly value: string } | null => {
  if (anchor.dupGroupId === null) return null;
  if (anchor.authorityCui !== null) return { column: 'authority_cui', value: anchor.authorityCui };
  if (anchor.supplierCui !== null) return { column: 'supplier_cui', value: anchor.supplierCui };
  return null;
};

export const makeProcurementDetailRepo = (db: Db): ProcurementDetailRepo => {
  // ── duplicates ─────────────────────────────────────────────────────────────

  const duplicatesFor = async (
    table: 'contracts' | 'direct_acquisitions',
    anchor: DuplicateAnchor
  ): Promise<Result<readonly DuplicateRef[], ApiError>> => {
    const driver = pickDuplicateDriver(anchor);
    if (driver === null) return ok([]);
    // `dupGroupId` is non-null whenever a driver exists (see pickDuplicateDriver).
    const dupGroupId = anchor.dupGroupId ?? '';

    const idColumn = table === 'contracts' ? 'contract_id' : 'da_id';
    try {
      const result = await sql<{ id: string; source_system: string }>`
        select ${sql.ref(idColumn)}::text as id, source_system
          from ${sql.table(`procurement.${table}`)}
         where ${sql.ref(driver.column)} = ${driver.value}
           and dup_group_id = ${dupGroupId}::bigint
           and ${sql.ref(idColumn)} <> ${anchor.id}::bigint
         limit ${sql.lit(DUPLICATES_CAP)}
      `.execute(db);
      return ok(result.rows.map((r) => ({ sourceSystem: r.source_system, id: r.id })));
    } catch (error) {
      return err(databaseError(`duplicatesFor ${table} failed`, error));
    }
  };

  // ── TED ────────────────────────────────────────────────────────────────────

  const tedForProcedure = async (procedureId: string): Promise<Result<TedRef | null, ApiError>> => {
    if (!isBigint(procedureId)) return err(invalidInput('id must be a bigint', 'id'));
    try {
      const row = await db
        .selectFrom('procurement.procedure_ted_links as l')
        .innerJoin('procurement.ted_notices as t', 't.ted_notice_id', 'l.ted_notice_id')
        .select(['t.publication_number', 't.source_url'])
        .where('l.procedure_id', '=', procedureId)
        .limit(1)
        .executeTakeFirst();
      return ok(row !== undefined ? mapTedRef(row) : null);
    } catch (error) {
      return err(databaseError('tedForProcedure failed', error));
    }
  };

  // ── batched joins (DataLoader-backed; no N+1) ──────────────────────────────

  const modificationsForContracts = async (
    contractIds: readonly string[]
  ): Promise<Result<ReadonlyMap<string, readonly ProcurementModification[]>, ApiError>> => {
    const ids = contractIds.filter(isBigint);
    if (ids.length === 0) return ok(new Map());
    try {
      // The cap must be PER CONTRACT. A single global `limit CAP * ids.length`
      // ordered by contract_id lets one modification-heavy contract consume the
      // whole budget and starve every later contract in the batch, which comes
      // back with an empty trail. A window rank caps each parent independently.
      const rows = await db
        .selectFrom(
          db
            .selectFrom('procurement.contract_modifications as m')
            .select(modificationSelect)
            .select(
              sql<number>`row_number() over (
                partition by m.contract_id
                order by m.modification_date asc nulls last, m.modification_id asc
              )`.as('rn')
            )
            .where('m.contract_id', 'in', ids)
            .as('r')
        )
        .selectAll('r')
        .where('r.rn', '<=', MODIFICATIONS_PER_CONTRACT_CAP)
        .orderBy('r.contract_id')
        .orderBy('r.rn')
        .execute();
      const byContract = new Map<string, ProcurementModification[]>();
      for (const row of rows) {
        if (row.contract_id === null) continue;
        const bucket = byContract.get(row.contract_id) ?? [];
        bucket.push(mapModification(row));
        byContract.set(row.contract_id, bucket);
      }
      return ok(byContract);
    } catch (error) {
      return err(databaseError('modificationsForContracts failed', error));
    }
  };

  const contractsByIds = async (
    contractIds: readonly string[]
  ): Promise<Result<ReadonlyMap<string, ProcurementContract>, ApiError>> => {
    const ids = contractIds.filter(isBigint);
    if (ids.length === 0) return ok(new Map());
    try {
      // Canonical-only: a modification must never resolve its parent to a
      // suppressed duplicate.
      const rows = await db
        .selectFrom('procurement.contracts as c')
        .select(contractSelect)
        .where('c.contract_id', 'in', ids)
        .where('c.is_canonical', '=', true)
        .execute();
      return ok(new Map(rows.map((r) => [r.contract_id, mapContract(r)])));
    } catch (error) {
      return err(databaseError('contractsByIds failed', error));
    }
  };

  // ── supplier records (two keyset queries, merged in TS) ────────────────────

  /**
   * "Strictly after the cursor" in the merge order `(date DESC NULLS LAST,
   * grainRank ASC, id DESC)`, expressed for ONE table whose grain rank is fixed.
   * A null cursor date means we are already inside the trailing null-date section,
   * so only null-date rows can follow.
   */
  const keysetPredicate = (
    alias: string,
    dateColumn: string,
    idColumn: string,
    tableGrainRank: number,
    cursor: RecordCursor
  ): RawBuilder<SqlBool> => {
    const date = sql.ref(`${alias}.${dateColumn}`);
    const id = sql.ref(`${alias}.${idColumn}`);
    const cursorRank = grainRank(cursor.grain);
    // On a date tie, a table ranked AFTER the cursor's grain still owes its whole
    // tied bucket; one ranked BEFORE has already emitted it.
    const tiedBucketRemains = tableGrainRank > cursorRank;
    const sameGrain = tableGrainRank === cursorRank;

    if (cursor.date === null) {
      if (tiedBucketRemains) return sql<SqlBool>`${date} is null`;
      if (sameGrain) return sql<SqlBool>`(${date} is null and ${id} < ${cursor.id}::bigint)`;
      return sql<SqlBool>`false`;
    }
    const tie = tiedBucketRemains
      ? sql`${date} = ${cursor.date}::date`
      : sameGrain
        ? sql`(${date} = ${cursor.date}::date and ${id} < ${cursor.id}::bigint)`
        : sql`false`;
    return sql<SqlBool>`(${date} is null or ${date} < ${cursor.date}::date or ${tie})`;
  };

  const supplierRecords = async (
    supplierCui: string,
    first: number,
    after: string | undefined,
    includeCancelled: boolean
  ): Promise<Result<SupplierRecordConnection, ApiError>> => {
    const limit = Math.min(Math.max(Math.floor(first), 1), SUPPLIER_RECORDS_FIRST_MAX);
    let cursor: RecordCursor | undefined;
    if (after !== undefined) {
      const decoded = decodeRecordCursor(after, supplierCui);
      if (decoded.isErr()) return err(decoded.error);
      cursor = decoded.value;
    }

    const contractRank = grainRank('procurement_contract');
    const daRank = grainRank('direct_acquisition');
    try {
      let contractQuery = db
        .selectFrom('procurement.contracts as c')
        .select(contractSelect)
        .where('c.is_canonical', '=', true)
        .where('c.supplier_cui', '=', supplierCui);
      let daQuery = db
        .selectFrom('procurement.direct_acquisitions as d')
        .select(daSelect)
        .where('d.is_canonical', '=', true)
        .where('d.supplier_cui', '=', supplierCui);
      // Cancelled DAs (refused/lapsed offers — no purchase happened) are excluded
      // by default so this list agrees with the flow-backed aggregates above it;
      // the contracts leg keeps every status, matching the list-page defaults.
      if (!includeCancelled) {
        daQuery = daQuery.where('d.status', '<>', 'cancelled');
      }

      if (cursor !== undefined) {
        contractQuery = contractQuery.where(
          keysetPredicate('c', 'contract_date', 'contract_id', contractRank, cursor)
        );
        daQuery = daQuery.where(keysetPredicate('d', 'finalization_date', 'da_id', daRank, cursor));
      }

      // `first + 1` per table so the merge can tell "more rows exist" without a count.
      const [contractRows, daRows] = await Promise.all([
        contractQuery
          .orderBy(sql`c.contract_date desc nulls last`)
          .orderBy('c.contract_id', 'desc')
          .limit(limit + 1)
          .execute(),
        daQuery
          .orderBy(sql`d.finalization_date desc nulls last`)
          .orderBy('d.da_id', 'desc')
          .limit(limit + 1)
          .execute(),
      ]);

      const contracts: SupplierRecord[] = contractRows.map((r) => ({
        grain: 'procurement_contract',
        contract: mapContract(r),
      }));
      const das: SupplierRecord[] = daRows.map((r) => ({
        grain: 'direct_acquisition',
        directAcquisition: mapDirectAcquisition(r),
      }));

      const { page, hasNextPage } = mergeSupplierRecords(contracts, das, limit);
      const edges = page.map((node) => ({
        cursor: encodeRecordCursor(cursorOf(node, supplierCui)),
        node,
      }));
      return ok({
        // An exact count across a 3.3M and a 26M-row table is not affordable here.
        total: null,
        edges,
        hasNextPage,
        endCursor: edges.length > 0 ? (edges[edges.length - 1]?.cursor ?? null) : null,
      });
    } catch (error) {
      return err(databaseError('supplierRecords failed', error));
    }
  };

  return {
    duplicatesForContract: (anchor) => duplicatesFor('contracts', anchor),
    duplicatesForDirectAcquisition: (anchor) => duplicatesFor('direct_acquisitions', anchor),
    tedForProcedure,
    modificationsForContracts,
    contractsByIds,
    supplierRecords,
  };
};
