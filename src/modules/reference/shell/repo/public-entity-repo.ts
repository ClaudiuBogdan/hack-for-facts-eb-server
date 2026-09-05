/**
 * Reference module — PublicEntityRepo over `core.public_entities` (plan §3.1).
 *
 * The ONLY reader of `core.public_entities`. Reads through the kernel's typed
 * Kysely instance (`Kysely<ProdDatabase>` — the kernel already declares this table,
 * so the module adds no schema augmentation). Cursor lists use the kernel envelope
 * keyed on a UNIQUE compound tuple (the sort column + the PK `cui` tiebreak), so
 * non-unique names never skip/duplicate rows (review BLOCKER). The `fhash` binds
 * the cursor to the active filter set (§14.3).
 *
 * VIRTUAL filters (`countyCode`/`region`/`parentCui`/`hasIssues`) are intercepted
 * here and stripped from the kernel composer (top-level AND `exclude.*`). PII: this
 * table carries no party/contact PII; `field_trace` is debug-only and selected ONLY
 * when includeTrace is requested — the card path (`cardsForCuis`/`searchByName`/
 * list/children) never selects it.
 */

import { sql, type Kysely, type RawBuilder, type SqlBool } from 'kysely';
import { err, ok, type Result } from 'neverthrow';

import {
  type ApiError,
  type FilterInput,
  type ProdDatabase,
  type ResolveHit,
  buildNextCursor,
  databaseError,
  decodeCursor,
  fhashFor,
  invalidInput,
  normalizeCui,
  toConditionBuilders,
} from '@/modules/shared/index.js';

import {
  boolEq,
  fieldOf,
  omitVirtualFields,
  validateVirtualEnum,
  virtualValues,
} from './filter-helpers.js';
import { mapPublicEntity, type PublicEntityRow } from './mappers.js';
import {
  REFERENCE_PUBLIC_ENTITY_VIRTUAL_FIELDS,
  REFERENCE_REGIONS,
  referencePublicEntityFilterSpec,
} from '../../core/filters.js';
import {
  type ReferenceAggregateDim,
  type ReferenceCountBucket,
  type ReferencePublicEntity,
  type ReferencePublicEntityCard,
} from '../../core/types.js';

import type { CountedCursorPage, CursorPageRequest, PublicEntityRepo } from '../../core/ports.js';

type Db = Kysely<ProdDatabase>;

const clampFirst = (first: number): number => Math.min(Math.max(Math.floor(first), 1), 100);
const clampLimit = (limit: number, max = 100): number =>
  Math.min(Math.max(Math.floor(limit), 1), max);

/**
 * The card columns (NO field_trace). `updated_at` is cast `::text` at the SQL
 * boundary because the pool only overrides the int8 parser — a bare `timestamptz`
 * would come back as a JS `Date`, which breaks the `DateTime` scalar serializer AND
 * the cursor `sortValue` (a non-string would encode as the null sentinel). The
 * cast yields the ISO string the DateTime scalar + keyset expect.
 */
const CARD_COLUMNS = [
  'pe.cui',
  'pe.name',
  'pe.address',
  'pe.entity_type',
  'pe.category',
  'pe.tags',
  'pe.is_uat',
  'pe.is_territorial_executive',
  'pe.territorial_siruta_code',
  'pe.uat_mapping_method',
  'pe.uat_mapping_confidence',
  'pe.uat_unresolved_reason',
  'pe.parent1_cui',
  'pe.parent2_cui',
  'pe.main_creditors',
  'pe.default_report_type',
  'pe.issues',
] as const;

/** Card select with `updated_at::text` appended (the cast that keeps it a string). */
const cardSelect = () =>
  [...CARD_COLUMNS, sql<string>`pe.updated_at::text`.as('updated_at')] as const;

const composeWhere = (conds: readonly RawBuilder<unknown>[]): RawBuilder<SqlBool> =>
  conds.length === 0 ? sql<SqlBool>`true` : sql<SqlBool>`${sql.join(conds, sql` and `)}`;

/** Sort field → physical column + direction. The repo always appends `cui` as a unique tiebreak. */
const SORT_COLUMN: Record<string, { col: string; dir: 'asc' | 'desc' }> = {
  name: { col: 'pe.name', dir: 'asc' },
  cui: { col: 'pe.cui', dir: 'asc' },
  entity_type: { col: 'pe.entity_type', dir: 'asc' },
  updated_at: { col: 'pe.updated_at', dir: 'desc' },
};

/**
 * The cursor direction for a public-entity sort field — the SINGLE source of
 * truth the GraphQL resolver reuses when re-encoding edge cursors (a divergent map
 * would invalidate page-2 cursors, since the repo's decodeCursor validates dir).
 */
export const publicEntitySortDir = (field: string): 'asc' | 'desc' =>
  (SORT_COLUMN[field] ?? DEFAULT_PE_SORT).dir;

const escapeLike = (s: string): string => s.replace(/[%_\\]/gu, '\\$&');

export const makePublicEntityRepo = (db: Db): PublicEntityRepo => {
  /**
   * Build the EXISTS predicate for a virtual territory-join field (`countyCode`/
   * `region`): the entity's canonical territory_id links to a territory whose
   * `county_code`/`region` is in the supplied values. Used for both the inclusion
   * predicate and (negated) the exclude predicate.
   */
  const territoryExists = (
    column: 'county_code' | 'region',
    values: readonly string[]
  ): RawBuilder<unknown> =>
    sql`exists (select 1 from core.territories t where t.id = pe.territory_id and ${sql.ref(`t.${column}`)} in (${sql.join(
      values.map((v) => sql`${v}`),
      sql`, `
    )}))`;

  /** Resolve the virtual public-entity filters into SQL fragments (incl. exclude branch). */
  const virtualConditions = (input: FilterInput): RawBuilder<unknown>[] => {
    const conds: RawBuilder<unknown>[] = [];

    for (const field of ['countyCode', 'region'] as const) {
      const column = field === 'countyCode' ? 'county_code' : 'region';
      const { include, exclude } = virtualValues(input, field);
      if (include !== undefined) {
        // Preserve the kernel contract: an explicit empty `in` (or a disjoint
        // `eq` + `in`) is FALSE, never an omitted predicate that widens results.
        conds.push(include.length === 0 ? sql`false` : territoryExists(column, include));
      }
      // Excluding an empty intersection is `NOT FALSE` (TRUE), so it contributes
      // no condition and avoids an unnecessary territory semijoin.
      if (exclude !== undefined && exclude.length > 0) {
        conds.push(sql`not ${territoryExists(column, exclude)}`);
      }
    }

    // parentCui: parent1_cui OR parent2_cui (eq only).
    const parent = fieldOf(input, 'parentCui');
    const parentEq = parent?.['eq'];
    if (typeof parentEq === 'string' && parentEq !== '') {
      conds.push(sql`(pe.parent1_cui = ${parentEq} or pe.parent2_cui = ${parentEq})`);
    }

    // hasIssues: jsonb_array_length(issues) > 0 (true) / = 0 (false).
    const hasIssues = boolEq(fieldOf(input, 'hasIssues'));
    if (hasIssues === true) {
      conds.push(sql`coalesce(jsonb_array_length(pe.issues), 0) > 0`);
    } else if (hasIssues === false) {
      conds.push(sql`coalesce(jsonb_array_length(pe.issues), 0) = 0`);
    }
    return conds;
  };

  /** Validate virtual filters (the kernel composer never sees them). */
  const validateVirtual = (input: FilterInput): Result<void, ApiError> => {
    const region = validateVirtualEnum(input, 'region', REFERENCE_REGIONS);
    if (region.isErr()) return region;
    return ok(undefined);
  };

  /** Compose the kernel conditions (after stripping virtual fields) + the virtual fragments. */
  const buildConditions = (input: FilterInput): Result<RawBuilder<unknown>[], ApiError> => {
    const physical = omitVirtualFields(input, [...REFERENCE_PUBLIC_ENTITY_VIRTUAL_FIELDS]);
    const kernel = toConditionBuilders(referencePublicEntityFilterSpec, physical);
    if (kernel.isErr()) return err(kernel.error);
    return ok([...kernel.value, ...virtualConditions(input)]);
  };

  const findByCui = async (
    rawCui: string,
    includeTrace: boolean
  ): Promise<Result<ReferencePublicEntity | null, ApiError>> => {
    const cui = normalizeCui(rawCui);
    if (cui === null) return err(invalidInput('invalid CUI format', 'cui'));
    try {
      const row = await db
        .selectFrom('core.public_entities as pe')
        .select(includeTrace ? [...cardSelect(), 'pe.field_trace'] : [...cardSelect()])
        .where('pe.cui', '=', cui)
        .limit(1)
        .executeTakeFirst();
      if (row === undefined) return ok(null);
      // Detail does NOT embed territory here; the usecase resolves it via the
      // kernel TerritoryRepo (one extra point lookup) to avoid forking the join.
      return ok(mapPublicEntity(row as PublicEntityRow, null, includeTrace));
    } catch (error) {
      return err(databaseError('findByCui failed', error));
    }
  };

  const list = async (
    f: FilterInput,
    page: CursorPageRequest
  ): Promise<Result<CountedCursorPage<ReferencePublicEntityCard>, ApiError>> => {
    const vv = validateVirtual(f);
    if (vv.isErr()) return err(vv.error);

    const sort = pickSort(page.sort);
    const limit = clampFirst(page.first);
    const fhash = fhashFor(referencePublicEntityFilterSpec, f);

    let cursorKeys: readonly string[] | undefined;
    if (page.after !== undefined) {
      const decoded = decodeCursor(page.after, { sort: sort.field, dir: sort.dir, fhash });
      if (decoded.isErr()) return err(decoded.error);
      cursorKeys = decoded.value.keys;
    }

    const condsRes = buildConditions(f);
    if (condsRes.isErr()) return err(condsRes.error);
    // `baseConds` = filters only → the COUNT(*) denominator (the FILTERED total,
    // not "rows remaining after the cursor"). `pageConds` adds the keyset predicate
    // for the page slice only (review BLOCKER).
    const baseConds = [...condsRes.value];
    const pageConds = [...baseConds];
    if (cursorKeys?.length === 2) {
      pageConds.push(keysetPredicate(sort, cursorKeys[0] ?? '', cursorKeys[1] ?? ''));
    }

    try {
      const [rows, totalRow] = await Promise.all([
        db
          .selectFrom('core.public_entities as pe')
          .select(cardSelect())
          .where(composeWhere(pageConds))
          .orderBy(orderByExpr(sort.col, sort.dir))
          .orderBy('pe.cui', sort.dir)
          .limit(limit + 1)
          .execute(),
        db
          .selectFrom('core.public_entities as pe')
          .select(sql<string>`count(*)`.as('cnt'))
          .where(composeWhere(baseConds))
          .executeTakeFirst(),
      ]);

      const hasMore = rows.length > limit;
      const pageRows = hasMore ? rows.slice(0, limit) : rows;
      const items = pageRows.map((r) => mapPublicEntity(r as PublicEntityRow, null, false));
      let next: string | null = null;
      if (hasMore) {
        const last = pageRows[pageRows.length - 1];
        if (last !== undefined) {
          next = buildNextCursor({
            sort: sort.field,
            dir: sort.dir,
            fhash,
            lastKeys: [sortValue(sort, last), last.cui],
          });
        }
      }
      return ok({ items, next, totalCount: Number(totalRow?.cnt ?? 0) });
    } catch (error) {
      return err(databaseError('list failed', error));
    }
  };

  const searchByName = async (
    q: string,
    limit: number
  ): Promise<Result<readonly ReferencePublicEntityCard[], ApiError>> => {
    const needle = q.trim();
    if (needle === '') return ok([]);
    const capped = clampLimit(limit, 50);
    const pattern = `%${escapeLike(needle)}%`;
    try {
      const rows = await db
        .selectFrom('core.public_entities as pe')
        .select(cardSelect())
        .where(sql<boolean>`pe.name ilike ${pattern} escape '\\'`)
        // similarity() ordering when pg_trgm is present; the GIN trgm index backs it.
        .orderBy(sql`similarity(pe.name, ${needle}) desc`)
        .orderBy('pe.name', 'asc')
        .limit(capped)
        .execute();
      return ok(rows.map((r) => mapPublicEntity(r as PublicEntityRow, null, false)));
    } catch (error) {
      return err(databaseError('searchByName failed', error));
    }
  };

  const findChildren = async (
    rawParentCui: string
  ): Promise<Result<readonly ReferencePublicEntityCard[], ApiError>> => {
    const cui = normalizeCui(rawParentCui);
    if (cui === null) return err(invalidInput('invalid CUI format', 'cui'));
    try {
      const rows = await db
        .selectFrom('core.public_entities as pe')
        .select(cardSelect())
        .where(sql<boolean>`pe.parent1_cui = ${cui} or pe.parent2_cui = ${cui}`)
        .orderBy('pe.name', 'asc')
        .limit(2000)
        .execute();
      return ok(rows.map((r) => mapPublicEntity(r as PublicEntityRow, null, false)));
    } catch (error) {
      return err(databaseError('findChildren failed', error));
    }
  };

  const aggregate = async (
    by: ReferenceAggregateDim,
    f: FilterInput
  ): Promise<Result<readonly ReferenceCountBucket[], ApiError>> => {
    const vv = validateVirtual(f);
    if (vv.isErr()) return err(vv.error);
    const condsRes = buildConditions(f);
    if (condsRes.isErr()) return err(condsRes.error);
    const where = composeWhere(condsRes.value);

    try {
      if (by === 'county') {
        const rows = await db
          .selectFrom('core.public_entities as pe')
          .leftJoin('core.territories as t', 't.id', 'pe.territory_id')
          .select([
            sql<string | null>`t.county_code`.as('key'),
            sql<string | null>`max(t.county_name)`.as('label'),
            sql<string>`count(*)`.as('cnt'),
          ])
          .where(where)
          .groupBy('t.county_code')
          .orderBy(sql`count(*) desc`)
          .limit(100)
          .execute();
        return ok(
          rows.map((r) => ({ key: r.key ?? '(none)', label: r.label, count: Number(r.cnt) }))
        );
      }

      const keyExpr =
        by === 'entity_type'
          ? sql<string | null>`pe.entity_type`
          : by === 'category'
            ? sql<string | null>`pe.category`
            : sql<string | null>`pe.is_uat::text`; // is_uat
      const rows = await db
        .selectFrom('core.public_entities as pe')
        .select([keyExpr.as('key'), sql<string>`count(*)`.as('cnt')])
        .where(where)
        .groupBy(() => keyExpr)
        .orderBy(sql`count(*) desc`)
        .limit(200)
        .execute();
      return ok(rows.map((r) => ({ key: r.key ?? '(none)', label: null, count: Number(r.cnt) })));
    } catch (error) {
      return err(databaseError('aggregate failed', error));
    }
  };

  const resolve = async (
    q: string,
    limit: number
  ): Promise<Result<readonly ResolveHit[], ApiError>> => {
    const needle = q.trim();
    if (needle === '') return ok([]);
    const capped = clampLimit(limit, 50);
    const pattern = `%${escapeLike(needle)}%`;
    try {
      const rows = await db
        .selectFrom('core.public_entities as pe')
        .leftJoin('core.territories as t', 't.id', 'pe.territory_id')
        .select([
          'pe.cui as value',
          'pe.name as label',
          sql<string | null>`max(t.county_name)`.as('hint'),
          sql<number>`max(similarity(pe.name, ${needle}))`.as('score'),
        ])
        .where(sql<boolean>`pe.name ilike ${pattern} escape '\\'`)
        .groupBy(['pe.cui', 'pe.name'])
        .orderBy(sql`max(similarity(pe.name, ${needle})) desc`)
        .limit(capped)
        .execute();
      return ok(
        rows.map((r): ResolveHit => ({
          kind: 'public_entity',
          value: r.value,
          label: r.label,
          ...(typeof r.score === 'number' && { score: r.score }),
          ...(r.hint !== null && { hint: r.hint }),
        }))
      );
    } catch (error) {
      return err(databaseError('resolve failed', error));
    }
  };

  const cardsForCuis = async (
    cuis: readonly string[]
  ): Promise<Result<ReadonlyMap<string, ReferencePublicEntityCard>, ApiError>> => {
    const normalized = [
      ...new Set(cuis.map((c) => normalizeCui(c)).filter((c): c is string => c !== null)),
    ];
    if (normalized.length === 0) return ok(new Map());
    try {
      const rows = await db
        .selectFrom('core.public_entities as pe')
        .select(cardSelect())
        .where('pe.cui', 'in', normalized)
        .execute();
      const map = new Map<string, ReferencePublicEntityCard>();
      for (const r of rows) map.set(r.cui, mapPublicEntity(r, null, false));
      return ok(map);
    } catch (error) {
      return err(databaseError('cardsForCuis failed', error));
    }
  };

  return { findByCui, list, searchByName, findChildren, aggregate, resolve, cardsForCuis };
};

// ── sort + keyset helpers ──────────────────────────────────────────────────────

interface ResolvedSort {
  readonly field: string;
  readonly col: string;
  readonly dir: 'asc' | 'desc';
}

const DEFAULT_PE_SORT = { col: 'pe.name', dir: 'asc' } as const;

/** Pick the active sort from the requested sort field (validated), else the spec default. */
const pickSort = (requested: string | undefined): ResolvedSort => {
  const field =
    requested !== undefined && requested in SORT_COLUMN
      ? requested
      : referencePublicEntityFilterSpec.sort.default;
  const def = SORT_COLUMN[field] ?? DEFAULT_PE_SORT;
  return { field, col: def.col, dir: def.dir };
};

/** A literal `<col> asc|desc nulls last` order expression (no sql.raw — dir is a controlled value). */
const orderByExpr = (col: string, dir: 'asc' | 'desc'): RawBuilder<unknown> => {
  const ref = sql.ref(col);
  return dir === 'asc' ? sql`${ref} asc nulls last` : sql`${ref} desc nulls last`;
};

/** The sort-column value of a row (string-encoded for the cursor; columns are scalar text/date/int). */
const sortValue = (sort: ResolvedSort, row: Record<string, unknown>): string => {
  const key = sort.col.replace(/^pe\./u, '');
  const v = row[key];
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return '';
};

/**
 * Keyset predicate for `ORDER BY <col> <dir> NULLS LAST, cui <dir>`. The cursor
 * encodes `(sortValue, cui)`. NULL sort values sort AFTER non-null (NULLS LAST), so
 * the `'' sentinel` marks the null section.
 */
const keysetPredicate = (sort: ResolvedSort, cVal: string, cKey: string): RawBuilder<unknown> => {
  const col = sql.ref(sort.col);
  const cmp = sort.dir === 'asc' ? sql`>` : sql`<`;
  if (cVal === '') {
    // already inside the null section — only further rows by the key tiebreak.
    return sql`(${col} is null and pe.cui ${cmp} ${cKey})`;
  }
  return sql`(${col} ${cmp} ${cVal} or ${col} is null or (${col} = ${cVal} and pe.cui ${cmp} ${cKey}))`;
};
