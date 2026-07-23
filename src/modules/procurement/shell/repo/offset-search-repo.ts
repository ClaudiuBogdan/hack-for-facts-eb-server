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

import { mapContract, mapDirectAcquisition, mapModification, mapProcedure } from './mappers.js';
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

import type { OpenSearchQResolver } from './opensearch-q-repo.js';
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
  /** Whether the grain carries the value-model resolution columns. */
  readonly hasValueState: boolean;
  /** Contracts only: the record_kind discriminator (v5 serving convention). */
  readonly hasRecordKind: boolean;
}

const BINDINGS: Readonly<Record<SearchGrain, GrainBinding>> = {
  procedures: {
    table: 'procurement.procedures',
    alias: 'p',
    dateColumn: 'publication_date',
    // Value-model: filter/sort on the RESOLVED comparable measure, not the raw
    // own column — frameworks/conflicts have no comparable and sort/filter out.
    valueColumn: 'value_ron_comparable',
    canonical: false, // no is_canonical column on procedures
    hasParties: false, // authority only; supplier_cui does not exist
    hasCpv: true,
    hasStatus: true,
    hasSourceSystem: true,
    hasValueState: true,
    hasRecordKind: false,
  },
  contracts: {
    table: 'procurement.contracts',
    alias: 'c',
    dateColumn: 'contract_date',
    valueColumn: 'value_ron_comparable',
    canonical: true,
    hasParties: true,
    hasCpv: true,
    hasStatus: true,
    hasSourceSystem: true,
    hasValueState: true,
    hasRecordKind: true,
  },
  direct_acquisitions: {
    table: 'procurement.direct_acquisitions',
    alias: 'd',
    // The spec's `publicationDate` facet binds here: `publication_date` is 100% NULL
    // on the elicitatie_da half of the table, `finalization_date` is the indexed one.
    dateColumn: 'finalization_date',
    valueColumn: 'value_ron_comparable',
    canonical: true,
    hasParties: true,
    hasCpv: true,
    hasStatus: true,
    hasSourceSystem: true,
    hasValueState: true,
    hasRecordKind: false,
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
    hasValueState: false,
    hasRecordKind: false,
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
    if (filter.dateRange.gte !== undefined)
      conds.push(sql`${col} >= ${filter.dateRange.gte}::date`);
    if (filter.dateRange.lte !== undefined)
      conds.push(sql`${col} <= ${filter.dateRange.lte}::date`);
  }
  if (filter.valueState !== undefined && b.hasValueState) {
    conds.push(inList(ref(alias, 'value_state'), filter.valueState));
  }
  if (filter.recordKind !== undefined && b.hasRecordKind) {
    // NULL record_kind = rows not yet stamped by value-rules v5; they read as
    // contract_award so a "purchases" filter never blanks the grain pre-stamp.
    conds.push(
      inList(sql`coalesce(${ref(alias, 'record_kind')}, 'contract_award')`, filter.recordKind)
    );
  }
  if (filter.valueRon !== undefined) {
    const col = ref(alias, b.valueColumn);
    // `::numeric` from a decimal STRING — the value never becomes a float.
    if (filter.valueRon.gte !== undefined)
      conds.push(sql`${col} >= ${filter.valueRon.gte}::numeric`);
    if (filter.valueRon.lte !== undefined)
      conds.push(sql`${col} <= ${filter.valueRon.lte}::numeric`);
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
  'p.procedure_id',
  'p.source_system',
  'p.source_url',
  'p.notice_no',
  'p.notice_kind',
  'p.procedure_type',
  'p.contract_kind',
  'p.title',
  'p.authority_cui',
  'p.authority_name',
  'p.cpv_code',
  'p.currency',
  sql<string | null>`p.estimated_value_ron::text`.as('estimated_value_ron'),
  sql<string | null>`p.awarded_value_ron::text`.as('awarded_value_ron'),
  'p.status',
  'p.county_name',
  sql<string | null>`p.publication_date::text`.as('publication_date'),
  sql<string | null>`p.state_date::text`.as('state_date'),
  'p.value_state',
  'p.value_state_detail',
  sql<string | null>`p.value_ron_comparable::text`.as('value_ron_comparable'),
  'p.value_comparable_basis',
  'p.value_rules_version',
  sql<string | null>`p.value_resolved_at::text`.as('value_resolved_at'),
] as const;

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
  'c.record_kind',
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

/** Per-grain surrogate pk — the column the OpenSearch id-set binds to. */
const PK_COLUMNS: Readonly<Record<SearchGrain, string>> = {
  procedures: 'procedure_id',
  contracts: 'contract_id',
  direct_acquisitions: 'da_id',
  modifications: 'modification_id',
};

/** Conditions plus how the `q` predicate was resolved (drives count semantics). */
interface ResolvedConditions {
  readonly conds: RawBuilder<unknown>[];
  /**
   * True when the OpenSearch id-set hit its cap: the result is a
   * relevance-biased subset, so the count MUST degrade to estimated —
   * an exact count over a truncated set would be a lie.
   */
  readonly countUnreliable: boolean;
}

export const makeOffsetSearchRepo = (
  db: Db,
  daMaxWindowDays: number,
  qResolver?: OpenSearchQResolver,
  logger?: { warn: (obj: Record<string, unknown>, msg: string) => void }
): ProcurementOffsetSearchRepo => {
  /**
   * OpenSearch-first `q`: resolve the text predicate into a bounded pk id-set
   * (Romanian analyzer BM25 — folded diacritics, stemming, fuzziness) and let
   * SQL keep every structured filter, the total order, and the capped count.
   * A resolver failure degrades to the ILIKE predicate with a structured
   * warning (grain + category only — never the query text or credentials);
   * the engine is an accelerator, never a correctness dependency. An empty
   * id-set compiles to `false` (a correct, instant empty page).
   */
  const resolveConditions = async (
    grain: SearchGrain,
    f: ProcurementSearchFilter
  ): Promise<ResolvedConditions> => {
    if (f.q === undefined || qResolver?.canResolve(grain) !== true) {
      return { conds: buildSearchConditions(grain, f), countUnreliable: false };
    }
    const startedAt = Date.now();
    const resolved = await qResolver.resolveIds(grain, f.q);
    if (resolved.isErr()) {
      logger?.warn(
        { grain, category: resolved.error.message, elapsedMs: Date.now() - startedAt },
        'opensearch q resolution failed; falling back to ILIKE'
      );
      return { conds: buildSearchConditions(grain, f), countUnreliable: false };
    }
    const { ids, truncated } = resolved.value;
    const { q, ...rest } = f;
    void q;
    const conds = buildSearchConditions(grain, rest);
    const pk = ref(BINDINGS[grain].alias, PK_COLUMNS[grain]);
    conds.push(ids.length === 0 ? sql`false` : sql`${pk} = any(cast(${ids} as bigint[]))`);
    return { conds, countUnreliable: truncated };
  };

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
    // `sql.table` / `sql.ref` quote trusted internal identifiers (never user input).
    const table = sql.table(b.table);
    const alias = sql.ref(b.alias);
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

  /**
   * Run the page + the capped count concurrently and fold them into the
   * result. A truncated OpenSearch id-set makes any count over it a lie —
   * `countUnreliable` skips the count and degrades to `total: null,
   * estimated: true` (the same disclosure as a timed-out count).
   */
  const withCount = async <Out>(
    grain: SearchGrain,
    resolved: ResolvedConditions,
    pageQuery: Promise<readonly Out[]>
  ): Promise<Result<OffsetSearchResult<Out>, ApiError>> => {
    try {
      const [items, count] = await Promise.all([
        pageQuery,
        resolved.countUnreliable ? Promise.resolve(null) : cappedCount(grain, resolved.conds),
      ]);
      return ok(interpretCappedCount(items, count));
    } catch (error) {
      return err(databaseError(`search ${grain} failed`, error));
    }
  };

  const searchProceduresOffset = async (
    f: ProcurementSearchFilter,
    p: OffsetSearchRequest
  ): Promise<Result<OffsetSearchResult<ProcurementProcedure>, ApiError>> => {
    const resolved = await resolveConditions('procedures', f);
    const rows = db
      .selectFrom('procurement.procedures as p')
      .select(procedureSelect)
      .where(composeAnd(resolved.conds))
      .orderBy(orderClause('procedures', p))
      .limit(p.pageSize)
      .offset(offsetOf(p))
      .execute();
    return withCount(
      'procedures',
      resolved,
      rows.then((r) => r.map(mapProcedure))
    );
  };

  const searchContractsOffset = async (
    f: ProcurementSearchFilter,
    p: OffsetSearchRequest
  ): Promise<Result<OffsetSearchResult<ProcurementContract>, ApiError>> => {
    const resolved = await resolveConditions('contracts', f);
    const rows = db
      .selectFrom('procurement.contracts as c')
      .select(contractSelect)
      .where(composeAnd(resolved.conds))
      .orderBy(orderClause('contracts', p))
      .limit(p.pageSize)
      .offset(offsetOf(p))
      .execute();
    return withCount(
      'contracts',
      resolved,
      rows.then((r) => r.map(mapContract))
    );
  };

  const searchDirectAcquisitionsOffset = async (
    f: ProcurementSearchFilter,
    p: OffsetSearchRequest
  ): Promise<Result<OffsetSearchResult<ProcurementDirectAcquisition>, ApiError>> => {
    const selective = assertDaOffsetSelective(f, daMaxWindowDays);
    if (selective.isErr()) return err(selective.error);
    const resolved = await resolveConditions('direct_acquisitions', f);
    const rows = db
      .selectFrom('procurement.direct_acquisitions as d')
      .select(daSelect)
      .where(composeAnd(resolved.conds))
      .orderBy(orderClause('direct_acquisitions', p))
      .limit(p.pageSize)
      .offset(offsetOf(p))
      .execute();
    return withCount(
      'direct_acquisitions',
      resolved,
      rows.then((r) => r.map(mapDirectAcquisition))
    );
  };

  const searchModificationsOffset = (
    f: ProcurementSearchFilter,
    p: OffsetSearchRequest
  ): Promise<Result<OffsetSearchResult<ProcurementModification>, ApiError>> => {
    const resolved: ResolvedConditions = {
      conds: buildSearchConditions('modifications', f),
      countUnreliable: false,
    };
    const rows = db
      .selectFrom('procurement.contract_modifications as m')
      .select(modificationSelect)
      .where(composeAnd(resolved.conds))
      .orderBy(orderClause('modifications', p))
      .limit(p.pageSize)
      .offset(offsetOf(p))
      .execute();
    return withCount(
      'modifications',
      resolved,
      rows.then((r) => r.map(mapModification))
    );
  };

  return {
    searchProceduresOffset,
    searchContractsOffset,
    searchDirectAcquisitionsOffset,
    searchModificationsOffset,
  };
};
