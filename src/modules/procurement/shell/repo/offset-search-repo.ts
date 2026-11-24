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

import {
  databaseError,
  invalidInput,
  isWithheldOrganizationIdentifier,
  upstreamError,
  type ApiError,
  type ProdDatabase,
} from '@/modules/shared/index.js';

import { contractDisplayTitleCandidatesSelect } from './contract-display-title-projection.js';
import { modificationDeltaPctSql } from './filter-helpers.js';
import { mapContract, mapDirectAcquisition, mapModification, mapProcedure } from './mappers.js';
import { servedSupplierNameColumn, servedSupplierNameSql } from './party-name-sql.js';
import { supportedProcedureIdSql } from './procedure-link-policy.js';
import { SEARCH_COUNT_CAP } from '../../core/constants.js';
import { carriesPersonalCode, isFreeTextWithheld } from '../../core/free-text-rule.js';
import { HIGHLIGHT_CLOSE, HIGHLIGHT_OPEN } from '../../core/opensearch-query.js';
import {
  assertDaOffsetSelective,
  CPV_LEVELS,
  escapeLikePattern,
  interpretCappedCount,
  offsetOf,
  Q_COLUMNS,
  resolveSort,
  usesEngineOnlyFilter,
  usesEngineOnlySort,
  type ProcurementSearchFilter,
  type SearchGrain,
  type SqlSearchSort,
} from '../../core/search.js';

import type { OpenSearchListEngine } from './opensearch-list-repo.js';
import type {
  OffsetSearchRequest,
  OffsetSearchResult,
  ProcurementContract,
  ProcurementDirectAcquisition,
  ProcurementModification,
  ProcurementProcedure,
  SearchHighlight,
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

/** Finest level first — a category scope beats a class scope beats a group. */
const CPV_LEVEL_ORDER = ['cpvCategory', 'cpvClass', 'cpvGroup'] as const;

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

/** A `q` column: a supplier name is matched as served (masked for a person), never raw. */
const qColumn = (alias: string, column: string): RawBuilder<unknown> =>
  column === 'supplier_name' ? servedSupplierNameSql(alias) : ref(alias, column);

/** `q` → an escaped, bounded ILIKE across the grain's short text columns. */
const qPredicate = (grain: SearchGrain, alias: string, q: string): RawBuilder<unknown> => {
  const pattern = escapeLikePattern(q);
  const clauses = Q_COLUMNS[grain].map(
    (column) => sql`${qColumn(alias, column)} ilike ${pattern} escape '\\'`
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

/**
 * The analysis fact row for a grain, which carries the BUYER's resolved
 * territory. Buyer geography is therefore NOT index-only: an `exists` on the
 * fact primary key filters it in SQL too.
 *
 * Measured on the DA grain (26M rows), the case that forced this: a 2025 window
 * + `q` + `buyer_region` ran in 2.66 s, and the join contributed ~1,773 primary-
 * key lookups on top of a date scan the query already performed. Before it, the
 * list DROPPED territory and showed 1,736 records under a header counting 31.
 *
 * `modifications` is the one grain with no fact row of its own — which is the
 * whole reason it had no territory filter. It does not need one: an amendment
 * belongs to a contract, and 52,257 of 52,295 rows (99.93%) carry that
 * `contract_id`, so it resolves through the PARENT's fact row on the same
 * primary key. Measured: 80 ms for a region-filtered page, covering 51,201 rows
 * (97.9%); the remainder are amendments whose parent has no resolved territory.
 *
 * Supplier territory is in NO fact table — it resolves through
 * `companies_v2.territory_resolution` at index-build time and stays engine-only.
 */
/**
 * Title-safe q (PROC-R87F S1): candidates per batch, and how many batches
 * before the total falls back to an estimate. Exactness then fails only when
 * more than (batches × batch − cap) withheld rows match: about 40,000.
 */
const TITLE_SAFE_BATCH = SEARCH_COUNT_CAP + 1;
const TITLE_SAFE_MAX_BATCHES = 5;

/** A hydrated page, and each hydrated row's raw title when the free-text rule allows it. */
interface Hydrated<Out> {
  readonly items: Out[];
  readonly missing: number;
  readonly publicTitles?: ReadonlyMap<string, string>;
  readonly codedNames?: ReadonlyMap<string, ReadonlySet<NameField>>;
}

/** pk (as a string) → raw title, for the hydrated rows whose title the rule allows. */
export const publicTitlesOf = (
  rows: readonly Record<string, unknown>[],
  pkColumn: string
): Map<string, string> =>
  new Map(
    rows.flatMap((row) => {
      const title = row['title'];
      return typeof title === 'string' && !isFreeTextWithheld(title)
        ? [[String(row[pkColumn]), title] as const]
        : [];
    })
  );

const untagged = (fragment: string): string =>
  fragment.replaceAll(HIGHLIGHT_OPEN, '').replaceAll(HIGHLIGHT_CLOSE, '');

/** The name fields a highlight can quote, by their raw column. */
const NAME_COLUMNS = [
  ['authorityName', 'authority_name'],
  ['supplierName', 'supplier_name'],
] as const;
type NameField = (typeof NAME_COLUMNS)[number][0];

/**
 * pk (as a string) → the hydrated row's name fields whose fragments are withheld, whatever part of
 * the name they quote: a name that may carry a personal numeric code ("never a CNP"), and a
 * person's supplier name (served masked; the index holds it raw).
 */
export const codedNamesOf = (
  rows: readonly Record<string, unknown>[],
  pkColumn: string
): Map<string, ReadonlySet<NameField>> =>
  new Map(
    rows.flatMap((row) => {
      const supplierCode = row['supplier_cui'];
      // A person's supplier name is served masked: a fragment of the indexed raw name never is.
      const personSupplier =
        typeof supplierCode === 'string' && isWithheldOrganizationIdentifier(supplierCode);
      const coded = new Set(
        NAME_COLUMNS.flatMap(([field, column]) => {
          const name = row[column];
          if (field === 'supplierName' && personSupplier) return [field];
          return typeof name === 'string' && carriesPersonalCode(name) ? [field] : [];
        })
      );
      return coded.size > 0 ? [[String(row[pkColumn]), coded] as const] : [];
    })
  );

/**
 * A title fragment is served only when it quotes the row's CURRENT public
 * title (PROC-37DX): never for a row Postgres no longer serves, whose title it
 * withholds, or whose title changed since the index was built (a stale hit
 * quotes the old text). A fragment is part of a withheld title even when it
 * does not carry the marker itself.
 *
 * A name fragment is withheld when it, or the row's raw name, may carry a
 * personal numeric code ("never a CNP"); other name fragments are served.
 */
export const withPublicTitleHighlights = (
  highlights: readonly SearchHighlight[],
  publicTitles: ReadonlyMap<string, string> | undefined,
  codedNames?: ReadonlyMap<string, ReadonlySet<NameField>>
): SearchHighlight[] =>
  highlights.flatMap((highlight) => {
    const coded = codedNames?.get(highlight.id);
    const nameServed = (field: NameField, fragment: string): boolean =>
      coded?.has(field) !== true && !carriesPersonalCode(untagged(fragment));
    const title =
      highlight.title !== undefined &&
      publicTitles?.get(highlight.id)?.includes(untagged(highlight.title)) === true
        ? highlight.title
        : undefined;
    const served: SearchHighlight = {
      id: highlight.id,
      ...(title !== undefined && { title }),
      ...(highlight.authorityName !== undefined &&
        nameServed('authorityName', highlight.authorityName) && {
          authorityName: highlight.authorityName,
        }),
      ...(highlight.supplierName !== undefined &&
        nameServed('supplierName', highlight.supplierName) && {
          supplierName: highlight.supplierName,
        }),
    };
    return served.title !== undefined ||
      served.authorityName !== undefined ||
      served.supplierName !== undefined
      ? [served]
      : [];
  });

const FACT_TABLES: Readonly<Partial<Record<SearchGrain, { table: string; pk: string }>>> = {
  procedures: { table: 'procurement.analysis_facts_procedures', pk: 'procedure_id' },
  contracts: { table: 'procurement.analysis_facts_contracts', pk: 'contract_id' },
  direct_acquisitions: {
    table: 'procurement.analysis_facts_direct_acquisitions',
    pk: 'da_id',
  },
  // Same table and same join column as `contracts` — an amendment inherits its
  // contract's buyer, so its territory is the contract's territory.
  modifications: { table: 'procurement.analysis_facts_contracts', pk: 'contract_id' },
};

const BUYER_GEO_COLUMNS = {
  region: 'buyer_region',
  countyCode: 'buyer_county_code',
  siruta: 'buyer_siruta',
} as const;

/** `exists (select 1 from <facts> f where f.<pk> = <alias>.<pk> and f.<geo> = …)`. */
const buyerGeoPredicate = (
  grain: SearchGrain,
  alias: string,
  geo: NonNullable<ProcurementSearchFilter['buyerGeo']>
): RawBuilder<unknown> | null => {
  const facts = FACT_TABLES[grain];
  if (facts === undefined) return null;
  const conds: RawBuilder<unknown>[] = [];
  for (const [key, column] of Object.entries(BUYER_GEO_COLUMNS)) {
    const value = geo[key as keyof typeof BUYER_GEO_COLUMNS];
    if (value !== undefined) conds.push(sql`${ref('afg', column)} = ${value}`);
  }
  if (conds.length === 0) return null;
  return sql`exists (select 1 from ${sql.table(facts.table)} as ${sql.ref('afg')}
    where ${ref('afg', facts.pk)} = ${ref(alias, facts.pk)} and ${composeAnd(conds)})`;
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
    // Finest wins: an exact code beats a mid-level, which beats the division —
    // the same precedence the engine applies. A level is its canonical 8-digit
    // code truncated to the level's digit length, which `cpvCodePredicate`
    // compiles to the same left-anchored index range as a short code, so the
    // mid-levels are NOT index-only either.
    const level = CPV_LEVEL_ORDER.map((key) => {
      const code = filter[key];
      return code === undefined ? null : code.slice(0, CPV_LEVELS[key].digits);
    }).find((prefix): prefix is string => prefix !== null);
    if (filter.cpvCode !== undefined) conds.push(cpvCodePredicate(alias, filter.cpvCode));
    else if (level !== undefined) conds.push(cpvCodePredicate(alias, level));
    else if (filter.cpvDivision !== undefined) conds.push(divisionRange(alias, filter.cpvDivision));
  }

  if (filter.buyerGeo !== undefined) {
    const geo = buyerGeoPredicate(grain, alias, filter.buyerGeo);
    if (geo !== null) conds.push(geo);
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
    conds.push(sql`${modificationDeltaPctSql(alias)} >= ${filter.minDeltaPct}`);
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
  supportedProcedureIdSql('c').as('procedure_id'),
  'c.notice_no',
  'c.contract_no',
  sql<string | null>`c.contract_date::text`.as('contract_date'),
  'c.title',
  'c.authority_cui',
  'c.authority_name',
  'c.supplier_cui',
  servedSupplierNameColumn('c'),
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
  contractDisplayTitleCandidatesSelect(),
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
  servedSupplierNameColumn('d'),
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
  // Projected because `q` MATCHES on them: without the names a party-name hit
  // arrives with nothing on the card explaining why it matched (637 live rows
  // matched on a name alone).
  'm.authority_name',
  'm.supplier_cui',
  servedSupplierNameColumn('m'),
  'm.contract_no',
  'm.notice_no',
  sql<string | null>`m.modification_date::text`.as('modification_date'),
  sql<string | null>`m.value_before_ron::text`.as('value_before_ron'),
  sql<string | null>`m.value_after_ron::text`.as('value_after_ron'),
  sql<string | null>`m.value_delta_ron::text`.as('value_delta_ron'),
  'm.currency',
  sql<string | null>`m.source_value_before::text`.as('source_value_before'),
  sql<string | null>`m.source_value_after::text`.as('source_value_after'),
  'm.modification_type',
  'm.year',
] as const;

export interface ProcurementOffsetSearchRepo {
  searchProceduresOffset(
    f: ProcurementSearchFilter,
    p: OffsetSearchRequest,
    facets?: readonly string[]
  ): Promise<Result<OffsetSearchResult<ProcurementProcedure>, ApiError>>;
  searchContractsOffset(
    f: ProcurementSearchFilter,
    p: OffsetSearchRequest,
    facets?: readonly string[]
  ): Promise<Result<OffsetSearchResult<ProcurementContract>, ApiError>>;
  searchDirectAcquisitionsOffset(
    f: ProcurementSearchFilter,
    p: OffsetSearchRequest,
    facets?: readonly string[]
  ): Promise<Result<OffsetSearchResult<ProcurementDirectAcquisition>, ApiError>>;
  searchModificationsOffset(
    f: ProcurementSearchFilter,
    p: OffsetSearchRequest
  ): Promise<Result<OffsetSearchResult<ProcurementModification>, ApiError>>;
}

/** `ORDER BY <col> <dir> NULLS LAST, <pk> DESC` — the total order (invariant 1). */
const orderClause = (grain: SearchGrain, sort: SqlSearchSort): RawBuilder<unknown> => {
  const b = BINDINGS[grain];
  const resolved = resolveSort(grain, sort);
  const dir = resolved.direction === 'asc' ? sql`asc` : sql`desc`;
  return sql`${ref(b.alias, resolved.column)} ${dir} nulls last, ${ref(b.alias, resolved.pk)} desc`;
};

/**
 * Narrow a request sort to one SQL can express, or null. `relevance` is BM25:
 * there is no column for it, and answering a relevance request with a date order
 * under the same label is exactly the silent substitution this surface refuses.
 */
const sqlSort = (page: OffsetSearchRequest): SqlSearchSort | null =>
  page.sort === 'relevance' ? null : page.sort;

const relevanceUnavailable = (): ApiError =>
  upstreamError(
    'sort=relevance needs the search engine, which cannot serve this request',
    'opensearch'
  );

/** Per-grain surrogate pk — the column an engine-served page hydrates on. */
const PK_COLUMNS: Readonly<Record<SearchGrain, string>> = {
  procedures: 'procedure_id',
  contracts: 'contract_id',
  direct_acquisitions: 'da_id',
  modifications: 'modification_id',
};

/** Conditions plus how the count must be interpreted. */
interface ResolvedConditions {
  readonly conds: RawBuilder<unknown>[];
  /** True when an exact count over these conditions would be a lie. */
  readonly countUnreliable: boolean;
}

/**
 * The Postgres path's conditions. Reachable only for filters SQL can honor:
 * `searchViaEngine` fails the request outright when an engine-only dimension
 * (geography, CPV mid-levels) cannot be served, so a predicate is never
 * silently dropped here.
 */
const sqlConditions = (grain: SearchGrain, f: ProcurementSearchFilter): ResolvedConditions => ({
  conds: buildSearchConditions(grain, f),
  countUnreliable: false,
});

export const makeOffsetSearchRepo = (
  db: Db,
  daMaxWindowDays: number,
  engine?: OpenSearchListEngine,
  logger?: { warn: (obj: Record<string, unknown>, msg: string) => void }
): ProcurementOffsetSearchRepo => {
  /**
   * Restore the engine's order over the hydrated rows. Rows the index still
   * lists but Postgres no longer serves (a record de-canonicalized or removed
   * since the index build) are dropped and counted — a stale generation may
   * shorten a page, but it must never surface a row the database withholds.
   */
  const hydrateInOrder = <Row extends Record<string, unknown>, Out>(
    grain: SearchGrain,
    pks: readonly (number | string)[],
    pkColumn: string,
    rows: readonly Row[],
    map: (row: Row) => Out
  ): Hydrated<Out> => {
    // bigint columns arrive as strings — key on the string form, not the number.
    const byPk = new Map(rows.map((row) => [String(row[pkColumn]), row]));
    const items: Out[] = [];
    for (const pk of pks) {
      const row = byPk.get(String(pk));
      if (row !== undefined) items.push(map(row));
    }
    const missing = pks.length - items.length;
    if (missing > 0) {
      logger?.warn({ grain, missing }, 'search index lists rows postgres no longer serves');
    }
    // The mapper withholds the title; its highlight must go too (PROC-37DX).
    return {
      items,
      missing,
      publicTitles: publicTitlesOf(rows, pkColumn),
      codedNames: codedNamesOf(rows, pkColumn),
    };
  };

  /**
   * Engine-first list: OpenSearch owns the filters, the total order, the page
   * window and the count; Postgres hydrates the page by primary key.
   *
   * Returns `null` to mean "fall back to SQL" — only ever when the filter is
   * SQL-capable. Geography and the CPV mid-levels exist ONLY in the index, so
   * when the engine cannot answer them the request fails explicitly rather
   * than silently answering a wider question.
   */
  const searchViaEngine = async <Out>(
    grain: SearchGrain,
    f: ProcurementSearchFilter,
    p: OffsetSearchRequest,
    facets: readonly string[] | undefined,
    hydrate: (pks: readonly (number | string)[]) => Promise<Hydrated<Out>>
  ): Promise<Result<OffsetSearchResult<Out>, ApiError> | null> => {
    // A relevance ORDER is as engine-only as a geography FILTER: the SQL path
    // has no `_score`, so falling back would silently reorder the answer.
    //
    // And on a grain the engine IS configured for, a free-text `q` is
    // engine-only too. The two paths do not mean the same thing — the engine
    // requires every analyzed term across title and both party names, SQL runs
    // one literal `ILIKE '%q%'` over fewer columns — so falling back would
    // answer a different question under the same query. Where no index is
    // configured, SQL remains the declared behaviour for that grain.
    const engineConfigured = engine?.canServe(grain) === true;
    const engineOnly =
      usesEngineOnlyFilter(f) ||
      usesEngineOnlySort(p.sort) ||
      (engineConfigured && f.q !== undefined);
    if (!engineConfigured) {
      return engineOnly
        ? err(
            upstreamError(
              `search engine not configured for grain ${grain}; supplier geography, an explicit q mode and relevance sort cannot be served`,
              'opensearch'
            )
          )
        : null;
    }
    const startedAt = Date.now();
    const result = await engine.search(grain, f, p, facets);
    if (result.isErr()) {
      // Structured warning, category only — never the query text or credentials.
      logger?.warn(
        { grain, category: result.error.message, elapsedMs: Date.now() - startedAt },
        engineOnly
          ? 'opensearch list query failed; filter is not SQL-serveable'
          : 'opensearch list query failed; falling back to SQL'
      );
      return engineOnly
        ? err(upstreamError('search engine unavailable; try again shortly', 'opensearch'))
        : null;
    }
    const page = result.value;
    try {
      const { items, missing, publicTitles, codedNames } = await hydrate(page.pks);
      // A hydration miss means the index and the database disagree about
      // membership. The page is short by construction, so the engine's count
      // can no longer be claimed exact — degrade it rather than assert a total
      // the server already knows is wrong.
      const exact = page.totalExhaustive && missing === 0;
      return ok({
        items,
        // A capped count is a lower bound, not a total: keep the existing
        // `total: null` + estimated disclosure the client renders as "10000+".
        total: exact ? page.total : null,
        estimated: !exact,
        facets: page.facets,
        highlights: withPublicTitleHighlights(page.highlights, publicTitles, codedNames),
        provenance: { engine: 'opensearch' as const, asOf: page.asOf },
      });
    } catch (error) {
      return err(databaseError(`hydrate ${grain} page failed`, error));
    }
  };

  const hydrateProcedures = async (pks: readonly (number | string)[], executor: Db = db) => {
    if (pks.length === 0) return { items: [], missing: 0 };
    const rows = await executor
      .selectFrom('procurement.procedures as p')
      .select(procedureSelect)
      .where(sql<SqlBool>`p.procedure_id = any(cast(${pks} as bigint[]))`)
      .execute();
    return hydrateInOrder('procedures', pks, PK_COLUMNS.procedures, rows, mapProcedure);
  };

  const hydrateContracts = async (pks: readonly (number | string)[], executor: Db = db) => {
    if (pks.length === 0) return { items: [], missing: 0 };
    const rows = await executor
      .selectFrom('procurement.contracts as c')
      .select(contractSelect)
      .where(sql<SqlBool>`c.contract_id = any(cast(${pks} as bigint[])) and c.is_canonical`)
      .execute();
    return hydrateInOrder('contracts', pks, PK_COLUMNS.contracts, rows, mapContract);
  };

  const hydrateDirectAcquisitions = async (
    pks: readonly (number | string)[],
    executor: Db = db
  ) => {
    if (pks.length === 0) return { items: [], missing: 0 };
    const rows = await executor
      .selectFrom('procurement.direct_acquisitions as d')
      .select(daSelect)
      .where(sql<SqlBool>`d.da_id = any(cast(${pks} as bigint[])) and d.is_canonical`)
      .execute();
    return hydrateInOrder(
      'direct_acquisitions',
      pks,
      PK_COLUMNS.direct_acquisitions,
      rows,
      mapDirectAcquisition
    );
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

  /**
   * `q` on a title-bearing grain, SQL path (PROC-R87F S1). The ILIKE also
   * matches raw titles the free-text rule withholds, and a match the mapper
   * then serves with a null title still confirms the term. So the candidates
   * (pk, raw title, whether a non-title column matched) are read under the
   * page's own filters and order, up to the count cap; a row that matches only
   * through a withheld title is dropped; the rest are counted, paged and
   * hydrated as before. A row that also matches a party name or a code stays,
   * its title still masked by the mapper. Above the cap the total stays an
   * estimate, as today, so it never says how many rows were dropped.
   */
  const searchTitleSafe = async <Out>(
    grain: 'procedures' | 'contracts' | 'direct_acquisitions',
    q: string,
    resolved: ResolvedConditions,
    sort: SqlSearchSort,
    p: OffsetSearchRequest,
    hydrate: (pks: readonly string[], executor: Db) => Promise<Hydrated<Out>>
  ): Promise<Result<OffsetSearchResult<Out>, ApiError>> => {
    const b = BINDINGS[grain];
    const pattern = escapeLikePattern(q);
    const others = Q_COLUMNS[grain].filter((column) => column !== 'title');
    const otherMatch =
      others.length === 0
        ? sql`false`
        : sql`(${sql.join(
            others.map((column) => sql`${qColumn(b.alias, column)} ilike ${pattern} escape '\\'`),
            sql` or `
          )})`;
    /** Append the kept rows' keys; true when the batch was the last one. */
    const keep = (
      rows: readonly { pk: string; title: string | null; other_match: boolean | null }[],
      into: string[]
    ): boolean => {
      for (const row of rows) {
        if (row.other_match === true || row.title === null || !isFreeTextWithheld(row.title)) {
          into.push(row.pk);
        }
      }
      return rows.length < TITLE_SAFE_BATCH;
    };
    try {
      // One read-only snapshot for the candidates and the page: a title that
      // changes between the two reads cannot slip a row past the rule.
      return await db
        .transaction()
        .setIsolationLevel('repeatable read')
        .setAccessMode('read only')
        .execute(async (trx) => {
          // Candidates are read in batches until more KEPT rows than the cap
          // exist (or the matches run out): dropping withheld rows before the
          // cap decides "exact or estimate" means the total and the page sizes
          // never depend on how many were dropped.
          const kept: string[] = [];
          let exhausted = false;
          const offset = offsetOf(p);
          for (let batch = 0; batch < TITLE_SAFE_MAX_BATCHES; batch += 1) {
            // `sql.table` / `ref` quote trusted internal identifiers (never user input).
            const read = sql<{
              pk: string;
              title: string | null;
              other_match: boolean | null;
            }>`
              select ${ref(b.alias, PK_COLUMNS[grain])}::text as pk,
                     ${ref(b.alias, 'title')} as title,
                     ${otherMatch} as other_match
                from ${sql.table(b.table)} as ${sql.ref(b.alias)}
               where ${composeAnd(resolved.conds)}
               order by ${orderClause(grain, sort)}
               limit ${sql.lit(TITLE_SAFE_BATCH)} offset ${sql.lit(batch * TITLE_SAFE_BATCH)}
            `;
            if (batch === 0) {
              // The first batch's failure is the page's failure.
              const first = await read.execute(trx);
              if (keep(first.rows, kept)) {
                exhausted = true;
                break;
              }
              if (kept.length > SEARCH_COUNT_CAP) break;
              continue;
            }
            // A later batch only decides exact or estimate. Its failure (e.g.
            // the statement timeout) degrades the total to an estimate, as a
            // failed count did, while the page is already covered; a savepoint
            // keeps the snapshot usable for hydration.
            await sql`savepoint title_safe_batch`.execute(trx);
            try {
              const next = await read.execute(trx);
              await sql`release savepoint title_safe_batch`.execute(trx);
              if (keep(next.rows, kept)) {
                exhausted = true;
                break;
              }
              if (kept.length > SEARCH_COUNT_CAP) break;
            } catch (error) {
              await sql`rollback to savepoint title_safe_batch`.execute(trx);
              if (kept.length < offset + p.pageSize) throw error;
              break;
            }
          }
          const { items } = await hydrate(kept.slice(offset, offset + p.pageSize), trx);
          const exact = exhausted && kept.length <= SEARCH_COUNT_CAP && !resolved.countUnreliable;
          return ok(interpretCappedCount(items, exact ? kept.length : null));
        });
    } catch (error) {
      return err(databaseError(`search ${grain} failed`, error));
    }
  };

  const searchProceduresOffset = async (
    f: ProcurementSearchFilter,
    p: OffsetSearchRequest,
    facets?: readonly string[]
  ): Promise<Result<OffsetSearchResult<ProcurementProcedure>, ApiError>> => {
    const viaEngine = await searchViaEngine('procedures', f, p, facets, hydrateProcedures);
    if (viaEngine !== null) return viaEngine;
    const sort = sqlSort(p);
    if (sort === null) return err(relevanceUnavailable());
    const resolved = sqlConditions('procedures', f);
    if (f.q !== undefined)
      return searchTitleSafe('procedures', f.q, resolved, sort, p, hydrateProcedures);
    const rows = db
      .selectFrom('procurement.procedures as p')
      .select(procedureSelect)
      .where(composeAnd(resolved.conds))
      .orderBy(orderClause('procedures', sort))
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
    p: OffsetSearchRequest,
    facets?: readonly string[]
  ): Promise<Result<OffsetSearchResult<ProcurementContract>, ApiError>> => {
    const viaEngine = await searchViaEngine('contracts', f, p, facets, hydrateContracts);
    if (viaEngine !== null) return viaEngine;
    const sort = sqlSort(p);
    if (sort === null) return err(relevanceUnavailable());
    const resolved = sqlConditions('contracts', f);
    if (f.q !== undefined)
      return searchTitleSafe('contracts', f.q, resolved, sort, p, hydrateContracts);
    const rows = db
      .selectFrom('procurement.contracts as c')
      .select(contractSelect)
      .where(composeAnd(resolved.conds))
      .orderBy(orderClause('contracts', sort))
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
    p: OffsetSearchRequest,
    facets?: readonly string[]
  ): Promise<Result<OffsetSearchResult<ProcurementDirectAcquisition>, ApiError>> => {
    // The selectivity gate is a Postgres planner constraint, not a product
    // rule: the engine sorts this grain under any predicate (measured 86 ms
    // for a county scope over 12.7M docs), so it only guards the SQL path.
    const viaEngine = await searchViaEngine(
      'direct_acquisitions',
      f,
      p,
      facets,
      hydrateDirectAcquisitions
    );
    if (viaEngine !== null) return viaEngine;
    const sort = sqlSort(p);
    if (sort === null) return err(relevanceUnavailable());
    const selective = assertDaOffsetSelective(f, daMaxWindowDays);
    if (selective.isErr()) return err(selective.error);
    const resolved = sqlConditions('direct_acquisitions', f);
    if (f.q !== undefined)
      return searchTitleSafe(
        'direct_acquisitions',
        f.q,
        resolved,
        sort,
        p,
        hydrateDirectAcquisitions
      );
    const rows = db
      .selectFrom('procurement.direct_acquisitions as d')
      .select(daSelect)
      .where(composeAnd(resolved.conds))
      .orderBy(orderClause('direct_acquisitions', sort))
      .limit(p.pageSize)
      .offset(offsetOf(p))
      .execute();
    return withCount(
      'direct_acquisitions',
      resolved,
      rows.then((r) => r.map(mapDirectAcquisition))
    );
  };

  // Modifications are not indexed — this grain is SQL-only, by construction.
  const searchModificationsOffset = (
    f: ProcurementSearchFilter,
    p: OffsetSearchRequest
  ): Promise<Result<OffsetSearchResult<ProcurementModification>, ApiError>> => {
    // Defence in depth: the arg translation already rejects engine-only
    // dimensions here, and SQL would silently ignore them. Answering a wider
    // question than the one asked is the failure mode this guards.
    if (usesEngineOnlyFilter(f)) {
      return Promise.resolve(
        err(
          invalidInput(
            'supplier geography, CPV filters and an explicit q mode are not available on the modifications grain',
            'filter'
          )
        )
      );
    }
    const sort = sqlSort(p);
    if (sort === null) {
      return Promise.resolve(
        err(invalidInput('sort=relevance is not available on the modifications grain', 'sort'))
      );
    }
    const resolved = sqlConditions('modifications', f);
    const rows = db
      .selectFrom('procurement.contract_modifications as m')
      .select(modificationSelect)
      .where(composeAnd(resolved.conds))
      .orderBy(orderClause('modifications', sort))
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
