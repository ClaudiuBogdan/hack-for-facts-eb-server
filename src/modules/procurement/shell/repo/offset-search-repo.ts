/**
 * Procurement module — offset search over the four grains (the client contract).
 *
 * Invariants:
 *  1. `ORDER BY <sort col> <dir> NULLS LAST, <pk> DESC` — a TOTAL order. Without the
 *     pk tiebreak, rows tying on the sort column reshuffle between offset pages.
 *  2. The count is a CAPPED exact count (`select 1 … limit CAP+1` in a subquery) run
 *     in PARALLEL with the page. It may fail; the page must not. A failed/timed-out
 *     count degrades to `total: null, totalEstimated: true`.
 *  3. Canonical-only on contracts + DAs. `procedures` and `contract_modifications`
 *     have no `is_canonical` column — the predicate is structurally absent, not
 *     silently dropped.
 *  4. CPV predicates are index-safe ranges over `cpv_code` (never `substring()`),
 *     and `q` is a bounded, escaped ILIKE. Neither bounds the 26M-row DA grain —
 *     `assertDaOffsetSelective` gates that surface.
 */

import { sql, type Kysely, type RawBuilder, type SqlBool } from 'kysely';
import { err, ok, type Result } from 'neverthrow';

import { databaseError, type ApiError, type ProdDatabase } from '@/modules/shared/index.js';

import {
  mapContract,
  mapDirectAcquisition,
  mapModification,
  mapProcedure,
} from './mappers.js';
import { SEARCH_COUNT_CAP } from '../../core/constants.js';
import {
  assertDaOffsetSelective,
  escapeLikePattern,
  interpretCappedCount,
  offsetOf,
  Q_COLUMNS,
  resolveSort,
  type ProcurementSearchFilter,
  type SearchGrain,
} from '../../core/search.js';

import type {
  OffsetSearchRequest,
  OffsetSearchResult,
  ProcurementContract,
  ProcurementDirectAcquisition,
  ProcurementModification,
  ProcurementProcedure,
} from '../../core/types.js';

type Db = Kysely<ProdDatabase>;

const composeAnd = (conds: readonly RawBuilder<unknown>[]): RawBuilder<SqlBool> =>
  conds.length === 0 ? sql<SqlBool>`true` : sql<SqlBool>`${sql.join(conds, sql` and `)}`;

/** Per-grain physical binding. `dateColumn` is the INDEXED, populated date column. */
interface GrainBinding {
  readonly table: string;
  readonly alias: string;
  readonly dateColumn: string;
  readonly valueColumn: string;
  readonly canonical: boolean;
  readonly hasParties: boolean;
  readonly hasCpv: boolean;
  readonly hasStatus: boolean;
  readonly hasSourceSystem: boolean;
}

const BINDINGS: Readonly<Record<SearchGrain, GrainBinding>> = {
  procedures: {
    table: 'procurement.procedures',
    alias: 'p',
    dateColumn: 'publication_date',
    valueColumn: 'awarded_value_ron',
    canonical: false, // no is_canonical column on procedures
    hasParties: false, // authority only; supplier_cui does not exist
    hasCpv: true,
    hasStatus: true,
    hasSourceSystem: true,
  },
  contracts: {
    table: 'procurement.contracts',
    alias: 'c',
    dateColumn: 'contract_date',
    valueColumn: 'value_ron',
    canonical: true,
    hasParties: true,
    hasCpv: true,
    hasStatus: true,
    hasSourceSystem: true,
  },
  direct_acquisitions: {
    table: 'procurement.direct_acquisitions',
    alias: 'd',
    // The spec's `publicationDate` facet binds here: `publication_date` is 100% NULL
    // on the elicitatie_da half of the table, `finalization_date` is the indexed one.
    dateColumn: 'finalization_date',
    valueColumn: 'value_ron',
    canonical: true,
    hasParties: true,
    hasCpv: true,
    hasStatus: true,
    hasSourceSystem: true,
  },
  modifications: {
    table: 'procurement.contract_modifications',
    alias: 'm',
    dateColumn: 'modification_date',
    valueColumn: 'value_delta_ron',
    canonical: false, // no is_canonical column on contract_modifications
    hasParties: true,
    hasCpv: false,
    hasStatus: false,
    hasSourceSystem: false,
  },
};

const ref = (alias: string, column: string): RawBuilder<unknown> => sql.ref(`${alias}.${column}`);

/** `cpv_code` division range — index-safe (never `substring(cpv_code,1,2)`). */
const divisionRange = (alias: string, division: string): RawBuilder<unknown> => {
  const col = ref(alias, 'cpv_code');
  const lo = `${division}000000`;
  if (division === '99') return sql`(${col} >= ${lo} and ${col} <= '99999999')`;
  const hi = `${String(Number(division) + 1).padStart(2, '0')}000000`;
  return sql`(${col} >= ${lo} and ${col} < ${hi})`;
};

/**
 * An exact 8-digit code is an equality on `contracts_cpv_code_idx`; a shorter code
 * is a left-anchored LIKE, which the planner rewrites to an index range under this
 * database's verified C collation.
 */
const cpvCodePredicate = (alias: string, code: string): RawBuilder<unknown> => {
  const col = ref(alias, 'cpv_code');
  if (code.length === 8) return sql`${col} = ${code}`;
  const prefix = `${code.replace(/[\\%_]/gu, (m) => `\\${m}`)}%`;
  return sql`${col} like ${prefix} escape '\\'`;
};

/** `q` → an escaped, bounded ILIKE across the grain's short text columns. */
const qPredicate = (grain: SearchGrain, alias: string, q: string): RawBuilder<unknown> => {
  const pattern = escapeLikePattern(q);
  const clauses = Q_COLUMNS[grain].map(
    (column) => sql`${ref(alias, column)} ilike ${pattern} escape '\\'`
  );
  return sql`(${sql.join(clauses, sql` or `)})`;
};

const inList = (column: RawBuilder<unknown>, values: readonly string[]): RawBuilder<unknown> => {
  // An explicit empty `in: []` means "match nothing" — emit FALSE, never a no-op
  // (dropping the predicate would widen the query to the whole table).
  if (values.length === 0) return sql`false`;
  return sql`${column} in (${sql.join(
    values.map((v) => sql`${v}`),
    sql`, `
  )})`;
};

/** Compile the validated filter into WHERE conditions for one grain. */
export const buildSearchConditions = (
  grain: SearchGrain,
  filter: ProcurementSearchFilter
): RawBuilder<unknown>[] => {
  const b = BINDINGS[grain];
  const { alias } = b;
  const conds: RawBuilder<unknown>[] = [];

  if (b.canonical) conds.push(sql`${ref(alias, 'is_canonical')} = true`);

  if (filter.authorityCui !== undefined) {
    conds.push(sql`${ref(alias, 'authority_cui')} = ${filter.authorityCui}`);
  }
  if (filter.supplierCui !== undefined && b.hasParties) {
    conds.push(sql`${ref(alias, 'supplier_cui')} = ${filter.supplierCui}`);
  }
  if (b.hasCpv) {
    // An exact code is more specific than its division; when both arrive the code wins.
    if (filter.cpvCode !== undefined) conds.push(cpvCodePredicate(alias, filter.cpvCode));
    else if (filter.cpvDivision !== undefined) conds.push(divisionRange(alias, filter.cpvDivision));
  }
  if (b.hasSourceSystem && filter.sourceSystem !== undefined) {
    conds.push(inList(ref(alias, 'source_system'), filter.sourceSystem));
  }
  if (b.hasStatus && filter.status !== undefined) {
    conds.push(inList(ref(alias, 'status'), filter.status));
  }
  if (filter.dateRange !== undefined) {
    const col = ref(alias, b.dateColumn);
    if (filter.dateRange.gte !== undefined) conds.push(sql`${col} >= ${filter.dateRange.gte}::date`);
    if (filter.dateRange.lte !== undefined) conds.push(sql`${col} <= ${filter.dateRange.lte}::date`);
  }
  if (filter.valueRon !== undefined) {
    const col = ref(alias, b.valueColumn);
    // `::numeric` from a decimal STRING — the value never becomes a float.
    if (filter.valueRon.gte !== undefined) conds.push(sql`${col} >= ${filter.valueRon.gte}::numeric`);
    if (filter.valueRon.lte !== undefined) conds.push(sql`${col} <= ${filter.valueRon.lte}::numeric`);
  }
  if (filter.linked !== undefined) {
    const col = ref(alias, 'contract_id');
    conds.push(filter.linked ? sql`${col} is not null` : sql`${col} is null`);
  }
  if (filter.minDeltaPct !== undefined) {
    conds.push(
      sql`(${ref(alias, 'value_delta_ron')} / nullif(${ref(alias, 'value_before_ron')}, 0)) >= ${filter.minDeltaPct}`
    );
  }
  if (filter.q !== undefined) conds.push(qPredicate(grain, alias, filter.q));
  return conds;
};

// ── projections (mirror the cursor repo; money + dates cast to text) ──────────

const procedureSelect = [
  'p.procedure_id', 'p.source_system', 'p.source_url', 'p.notice_no', 'p.notice_kind',
  'p.procedure_type', 'p.contract_kind',
  'p.title', 'p.authority_cui', 'p.authority_name', 'p.cpv_code', 'p.currency',
  sql<string | null>`p.estimated_value_ron::text`.as('estimated_value_ron'),
  sql<string | null>`p.awarded_value_ron::text`.as('awarded_value_ron'),
  'p.status', 'p.county_name',
  sql<string | null>`p.publication_date::text`.as('publication_date'),
  sql<string | null>`p.state_date::text`.as('state_date'),
] as const;

const contractSelect = [
  'c.contract_id', 'c.contract_key', 'c.source_system', 'c.source_url', 'c.procedure_id',
  'c.notice_no', 'c.contract_no',
  sql<string | null>`c.contract_date::text`.as('contract_date'),
  'c.title', 'c.authority_cui', 'c.authority_name', 'c.supplier_cui',
  'c.supplier_name', 'c.cpv_code', 'c.currency',
  sql<string | null>`c.value_ron::text`.as('value_ron'),
  sql<string | null>`c.estimated_value_ron::text`.as('estimated_value_ron'),
  'c.status', 'c.county_name', 'c.is_canonical', 'c.dup_group_id',
] as const;

const daSelect = [
  'd.da_id', 'd.da_key', 'd.source_system', 'd.source_url', 'd.unique_code', 'd.title',
  'd.authority_cui', 'd.authority_name', 'd.supplier_cui', 'd.supplier_name', 'd.cpv_code',
  'd.currency',
  sql<string | null>`d.value_ron::text`.as('value_ron'),
  sql<string | null>`d.estimated_value_ron::text`.as('estimated_value_ron'),
  'd.status', 'd.county_name',
  sql<string | null>`d.publication_date::text`.as('publication_date'),
  sql<string | null>`d.finalization_date::text`.as('finalization_date'),
  'd.is_canonical', 'd.dup_group_id',
] as const;

const modificationSelect = [
  'm.modification_id', 'm.contract_id', 'm.source_url', 'm.link_method', 'm.link_confidence',
  'm.authority_cui', 'm.supplier_cui', 'm.contract_no', 'm.notice_no',
  sql<string | null>`m.modification_date::text`.as('modification_date'),
  sql<string | null>`m.value_before_ron::text`.as('value_before_ron'),
  sql<string | null>`m.value_after_ron::text`.as('value_after_ron'),
  sql<string | null>`m.value_delta_ron::text`.as('value_delta_ron'),
  'm.modification_type', 'm.year',
] as const;

export interface ProcurementOffsetSearchRepo {
  searchProceduresOffset(
    f: ProcurementSearchFilter,
    p: OffsetSearchRequest
  ): Promise<Result<OffsetSearchResult<ProcurementProcedure>, ApiError>>;
  searchContractsOffset(
    f: ProcurementSearchFilter,
    p: OffsetSearchRequest
  ): Promise<Result<OffsetSearchResult<ProcurementContract>, ApiError>>;
  searchDirectAcquisitionsOffset(
    f: ProcurementSearchFilter,
    p: OffsetSearchRequest
  ): Promise<Result<OffsetSearchResult<ProcurementDirectAcquisition>, ApiError>>;
  searchModificationsOffset(
    f: ProcurementSearchFilter,
    p: OffsetSearchRequest
  ): Promise<Result<OffsetSearchResult<ProcurementModification>, ApiError>>;
}

/** `ORDER BY <col> <dir> NULLS LAST, <pk> DESC` — the total order (invariant 1). */
const orderClause = (grain: SearchGrain, page: OffsetSearchRequest): RawBuilder<unknown> => {
  const b = BINDINGS[grain];
  const sort = resolveSort(grain, page.sort);
  const dir = sort.direction === 'asc' ? sql`asc` : sql`desc`;
  return sql`${ref(b.alias, sort.column)} ${dir} nulls last, ${ref(b.alias, sort.pk)} desc`;
};

export const makeOffsetSearchRepo = (
  db: Db,
  daMaxWindowDays: number
): ProcurementOffsetSearchRepo => {
  /**
   * The capped exact count. Deliberately swallows its OWN failure: a count that hits
   * the 15s statement timeout degrades `total` to null; the page still serves
   * (invariant 2). Only the page query's failure is an error.
   */
  const cappedCount = async (
    grain: SearchGrain,
    conds: readonly RawBuilder<unknown>[]
  ): Promise<number | null> => {
    const b = BINDINGS[grain];
    const table = sql.table(b.table);
    const alias = sql.raw(b.alias);
    try {
      const result = await sql<{ n: string }>`
        select count(*)::text as n from (
          select 1 from ${table} as ${alias}
           where ${composeAnd(conds)}
           limit ${sql.lit(SEARCH_COUNT_CAP + 1)}
        ) t
      `.execute(db);
      const n = Number(result.rows[0]?.n ?? '');
      return Number.isInteger(n) ? n : null;
    } catch {
      return null;
    }
  };

  /** Run the page + the capped count concurrently and fold them into the result. */
  const withCount = async <Out>(
    grain: SearchGrain,
    conds: readonly RawBuilder<unknown>[],
    pageQuery: Promise<readonly Out[]>
  ): Promise<Result<OffsetSearchResult<Out>, ApiError>> => {
    try {
      const [items, count] = await Promise.all([pageQuery, cappedCount(grain, conds)]);
      return ok(interpretCappedCount(items, count));
    } catch (error) {
      return err(databaseError(`search ${grain} failed`, error));
    }
  };

  const searchProceduresOffset = (
    f: ProcurementSearchFilter,
    p: OffsetSearchRequest
  ): Promise<Result<OffsetSearchResult<ProcurementProcedure>, ApiError>> => {
    const conds = buildSearchConditions('procedures', f);
    const rows = db
      .selectFrom('procurement.procedures as p')
      .select(procedureSelect)
      .where(composeAnd(conds))
      .orderBy(orderClause('procedures', p))
      .limit(p.pageSize)
      .offset(offsetOf(p))
      .execute();
    return withCount('procedures', conds, rows.then((r) => r.map(mapProcedure)));
  };

  const searchContractsOffset = (
    f: ProcurementSearchFilter,
    p: OffsetSearchRequest
  ): Promise<Result<OffsetSearchResult<ProcurementContract>, ApiError>> => {
    const conds = buildSearchConditions('contracts', f);
    const rows = db
      .selectFrom('procurement.contracts as c')
      .select(contractSelect)
      .where(composeAnd(conds))
      .orderBy(orderClause('contracts', p))
      .limit(p.pageSize)
      .offset(offsetOf(p))
      .execute();
    return withCount('contracts', conds, rows.then((r) => r.map(mapContract)));
  };

  const searchDirectAcquisitionsOffset = async (
    f: ProcurementSearchFilter,
    p: OffsetSearchRequest
  ): Promise<Result<OffsetSearchResult<ProcurementDirectAcquisition>, ApiError>> => {
    const selective = assertDaOffsetSelective(f, daMaxWindowDays);
    if (selective.isErr()) return err(selective.error);
    const conds = buildSearchConditions('direct_acquisitions', f);
    const rows = db
      .selectFrom('procurement.direct_acquisitions as d')
      .select(daSelect)
      .where(composeAnd(conds))
      .orderBy(orderClause('direct_acquisitions', p))
      .limit(p.pageSize)
      .offset(offsetOf(p))
      .execute();
    return withCount('direct_acquisitions', conds, rows.then((r) => r.map(mapDirectAcquisition)));
  };

  const searchModificationsOffset = (
    f: ProcurementSearchFilter,
    p: OffsetSearchRequest
  ): Promise<Result<OffsetSearchResult<ProcurementModification>, ApiError>> => {
    const conds = buildSearchConditions('modifications', f);
    const rows = db
      .selectFrom('procurement.contract_modifications as m')
      .select(modificationSelect)
      .where(composeAnd(conds))
      .orderBy(orderClause('modifications', p))
      .limit(p.pageSize)
      .offset(offsetOf(p))
      .execute();
    return withCount('modifications', conds, rows.then((r) => r.map(mapModification)));
  };

  return {
    searchProceduresOffset,
    searchContractsOffset,
    searchDirectAcquisitionsOffset,
    searchModificationsOffset,
  };
};
