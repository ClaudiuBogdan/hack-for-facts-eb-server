/**
 * Primarii-transparency repo (plan §3) — the ONLY reader of
 * `primarii_transparency.*`. Reads through the kernel's typed Kysely instance.
 *
 * KEY INVARIANTS:
 *  - Grain gate (§4): `amount_ron` is surfaced ONLY on salary claims, documented as
 *    a SELF-REPORTED disclosure, and is NEVER aggregated into a spend total here.
 *  - Snapshot scope: category/staffing/organigrama reads scope to the CURRENT
 *    snapshot_id (from current_entity_status) so a future re-research run can't leak
 *    stale rows.
 *  - Territory: this repo NEVER joins core.* directly (§3). Geographic FILTERS
 *    (region/siruta/isUat/population) compile through the kernel cui→territory
 *    builder (`buildTerritoryCuiPredicate`) — a `ces.cui IN (SELECT pe.cui FROM
 *    core.public_entities pe JOIN core.territories t …)` semijoin the kernel owns,
 *    so core.* stays private. When the builder is unavailable (`territoryFilterAvailable
 *    = false`) the filters are capability-gated (InvalidInput, never silently dropped).
 *    `territoryForCui` remains the per-CUI point lookup for the per-entity `territory`
 *    field; the builder is the SET predicate.
 *  - Cursor lists use the kernel envelope keyed on a UNIQUE compound tuple (sort
 *    column + the PK tiebreak), so non-unique sorts never skip/duplicate.
 *  - Raw-pointer / excerpt columns (§8) are never selected.
 */

import { sql, type Kysely, type RawBuilder, type SqlBool } from 'kysely';
import { err, ok, type Result } from 'neverthrow';

import {
  buildNextCursor,
  buildTerritoryCuiPredicate,
  databaseError,
  decodeCursor,
  fhashFor,
  invalidInput,
  normalizeCui,
  toConditionBuilders,
  type ApiError,
  type CursorPageRequest,
  type Cui,
  type FilterInput,
  type ProdDatabase,
  type ResolveHit,
} from '@/modules/shared/index.js';

import {
  boolEq,
  eqValue,
  fieldOf,
  inValues,
  omitVirtualFields,
  territoryFilterValues,
  validateVirtualEnum,
} from './filter-helpers.js';
import {
  mapCategoryStatus,
  mapDocument,
  mapEntityStatus,
  mapLoadIssue,
  mapOrganigrama,
  mapRegistryLink,
  mapSalaryClaim,
  mapSnapshot,
  mapStaffing,
  type EntityStatusRow,
  type SnapshotRow,
} from './mappers.js';
import {
  PRIMARII_DOCUMENT_VIRTUAL_FIELDS,
  PRIMARII_ENTITY_VIRTUAL_FIELDS,
  PRIMARII_TERRITORY_VIRTUAL_FIELDS,
  primariiDocumentFilterSpec,
  primariiEntityFilterSpec,
} from '../../core/filters.js';
import {
  PRIMARII_CATEGORY,
  PRIMARII_CATEGORY_STATE,
  PRIMARII_DATA_QUALITY,
  PRIMARII_ISSUE_SEVERITY,
  PRIMARII_RESULT_STATUS,
  type PrimariiCategoryCoverage,
  type PrimariiCategoryStatus,
  type PrimariiOrganigramaClaim,
  type PrimariiStaffingClaim,
  type PrimariiStatGroupBy,
  type PrimariiStatusBucket,
  type PrimariiDocument,
  type PrimariiEntityProfile,
  type PrimariiEntityStatus,
  type PrimariiLoadIssue,
  type PrimariiRegistryLink,
  type PrimariiSalaryClaim,
  type PrimariiSnapshot,
} from '../../core/types.js';

import type { CountedCursorPage, PrimariiRepository } from '../../core/ports.js';

type Db = Kysely<ProdDatabase>;

const clampFirst = (first: number): number => Math.min(Math.max(Math.floor(first), 1), 100);
const clampLimit = (limit: number, max = 200): number =>
  Math.min(Math.max(Math.floor(limit), 1), max);
const escapeLike = (s: string): string => s.replace(/[%_\\]/gu, '\\$&');

const composeWhere = (conds: readonly RawBuilder<unknown>[]): RawBuilder<SqlBool> =>
  conds.length === 0 ? sql<SqlBool>`true` : sql<SqlBool>`${sql.join(conds, sql` and `)}`;

/** A literal `<col> asc|desc nulls last` order expression (dir is a controlled value). */
const orderByExpr = (col: string, dir: 'asc' | 'desc'): RawBuilder<unknown> => {
  const ref = sql.ref(col);
  return dir === 'asc' ? sql`${ref} asc nulls last` : sql`${ref} desc nulls last`;
};

const CES_COLUMNS = [
  'ces.cui',
  'ces.snapshot_id',
  'ces.entity_name',
  'ces.entity_type',
  'ces.county',
  'ces.website_url',
  'ces.result_status',
  'ces.data_quality_status',
  'ces.confidence',
  'ces.evidence_coverage',
  'ces.missing_required_categories',
  'ces.issue_count',
] as const;

/** current_entity_status select with `updated_at::text` (keeps it an ISO string). */
const cesSelect = () =>
  [...CES_COLUMNS, sql<string>`ces.updated_at::text`.as('updated_at')] as const;

// ── entity sort (keyset; always tiebroken on the PK `cui`) ───────────────────────

interface ResolvedSort {
  readonly field: string;
  readonly col: string;
  readonly dir: 'asc' | 'desc';
}

const ENTITY_SORT: Record<string, { col: string; dir: 'asc' | 'desc' }> = {
  data_quality: { col: 'ces.data_quality_status', dir: 'asc' },
  confidence: { col: 'ces.confidence', dir: 'desc' },
  evidence_coverage: { col: 'ces.evidence_coverage', dir: 'desc' },
  issue_count: { col: 'ces.issue_count', dir: 'desc' },
  entity_name: { col: 'ces.entity_name', dir: 'asc' },
  updated_at: { col: 'ces.updated_at', dir: 'desc' },
};
const DEFAULT_ENTITY_SORT = { col: 'ces.data_quality_status', dir: 'asc' as const };

export const primariiEntitySortDir = (field: string): 'asc' | 'desc' =>
  (ENTITY_SORT[field] ?? DEFAULT_ENTITY_SORT).dir;

const pickEntitySort = (requested: string | undefined): ResolvedSort => {
  const field =
    requested !== undefined && requested in ENTITY_SORT
      ? requested
      : primariiEntityFilterSpec.sort.default;
  const def = ENTITY_SORT[field] ?? DEFAULT_ENTITY_SORT;
  return { field, col: def.col, dir: def.dir };
};

/** The sort-column value of a row (string-encoded for the cursor). */
const sortValue = (col: string, row: Record<string, unknown>): string => {
  const key = col.replace(/^[a-z]+\./u, '');
  const v = row[key];
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return '';
};

/**
 * Keyset predicate for `ORDER BY <col> <dir> NULLS LAST, <pkCol> <dir>`. The cursor
 * encodes `(sortValue, pk)`. NULLS LAST → `''` sentinel marks the null section.
 */
const keysetPredicate = (
  col: string,
  pkCol: string,
  dir: 'asc' | 'desc',
  sVal: string,
  pkVal: string
): RawBuilder<unknown> => {
  const c = sql.ref(col);
  const pk = sql.ref(pkCol);
  const cmp = dir === 'asc' ? sql`>` : sql`<`;
  if (sVal === '') {
    return sql`(${c} is null and ${pk} ${cmp} ${pkVal})`;
  }
  return sql`(${c} ${cmp} ${sVal} or ${c} is null or (${c} = ${sVal} and ${pk} ${cmp} ${pkVal}))`;
};

export const makePrimariiRepo = (
  db: Db,
  deps: { territoryFilterAvailable: boolean }
): PrimariiRepository => {
  // ── entity virtual conditions ──────────────────────────────────────────────
  /**
   * hasIssues + publishesCategory(+categoryState) + territory → SQL. Territory
   * compiles to the kernel cui→territory semijoin (when available; gated in
   * `validateEntityVirtual` otherwise, so the predicate is never silently dropped).
   * Returns a Result because the territory projection validates the population range.
   */
  const entityVirtualConditions = (input: FilterInput): Result<RawBuilder<unknown>[], ApiError> => {
    const conds: RawBuilder<unknown>[] = [];

    // hasIssues: issue_count > 0 / = 0
    const hasIssues = boolEq(fieldOf(input, 'hasIssues'));
    if (hasIssues === true) conds.push(sql`ces.issue_count > 0`);
    else if (hasIssues === false) conds.push(sql`ces.issue_count = 0`);

    // publishesCategory + categoryState: semijoin entity_category_statuses scoped to
    // the CURRENT snapshot (AND ecs.snapshot_id = ces.snapshot_id). Default state = found.
    // An EXPLICIT empty `in: []` means "match nothing" (mirrors the kernel composer's
    // empty-in → FALSE rule, #60h) — NOT "no filter".
    const publishes = inValues(fieldOf(input, 'publishesCategory'));
    if (publishes !== undefined) {
      if (publishes.length === 0) {
        conds.push(sql`false`);
      } else {
        const state = eqValue(fieldOf(input, 'categoryState')) ?? 'found';
        const cats = sql.join(
          publishes.map((c) => sql`${c}`),
          sql`, `
        );
        conds.push(
          sql`exists (select 1 from primarii_transparency.entity_category_statuses ecs
            where ecs.cui = ces.cui and ecs.snapshot_id = ces.snapshot_id
            and ecs.category in (${cats}) and ecs.status = ${state})`
        );
      }
    }

    // territory (region/siruta/isUat/population) → kernel cui→territory semijoin over
    // ces.cui. Reached only when the builder is available (validateEntityVirtual gates
    // it otherwise), so an unavailable resolver never silently drops the predicate.
    if (deps.territoryFilterAvailable) {
      const tvalues = territoryFilterValues(input);
      if (tvalues.isErr()) return err(tvalues.error);
      const predicate = buildTerritoryCuiPredicate({ alias: 'ces', column: 'cui' }, tvalues.value);
      if (predicate !== undefined) conds.push(predicate);
    }
    return ok(conds);
  };

  /** Validate the virtual enum/gated fields the kernel composer never sees. */
  const validateEntityVirtual = (input: FilterInput): Result<void, ApiError> => {
    const pub = validateVirtualEnum(input, 'publishesCategory', PRIMARII_CATEGORY);
    if (pub.isErr()) return pub;
    const st = validateVirtualEnum(input, 'categoryState', PRIMARII_CATEGORY_STATE);
    if (st.isErr()) return st;
    // Territory filters resolve through the kernel cui→territory builder. When the
    // builder is unavailable they are capability-gated (InvalidInput — never silently
    // dropped). When available, validate the projected values (e.g. the population
    // range) here so a malformed value fails the same way the kernel composer would.
    if (!deps.territoryFilterAvailable) {
      for (const f of PRIMARII_TERRITORY_VIRTUAL_FIELDS) {
        const present =
          fieldOf(input, f) !== undefined ||
          (input.exclude !== undefined && fieldOf(input.exclude, f) !== undefined);
        if (present) {
          return err(
            invalidInput(
              `geographic resolution unavailable: filter '${f}' requires the kernel cui→territory filter builder (use 'county' for best-effort county filtering)`,
              f
            )
          );
        }
      }
    } else {
      const tvalues = territoryFilterValues(input);
      if (tvalues.isErr()) return err(tvalues.error);
    }
    return ok(undefined);
  };

  /** Compose kernel conditions (after stripping virtuals) + the entity virtual fragments. */
  const buildEntityConditions = (input: FilterInput): Result<RawBuilder<unknown>[], ApiError> => {
    const physical = omitVirtualFields(input, [...PRIMARII_ENTITY_VIRTUAL_FIELDS]);
    const kernel = toConditionBuilders(primariiEntityFilterSpec, physical);
    if (kernel.isErr()) return err(kernel.error);
    const virtual = entityVirtualConditions(input);
    if (virtual.isErr()) return err(virtual.error);
    return ok([...kernel.value, ...virtual.value]);
  };

  // ── listEntities ────────────────────────────────────────────────────────────
  const listEntities = async (
    f: FilterInput,
    page: CursorPageRequest
  ): Promise<Result<CountedCursorPage<PrimariiEntityStatus>, ApiError>> => {
    const vv = validateEntityVirtual(f);
    if (vv.isErr()) return err(vv.error);

    const sort = pickEntitySort(page.sort);
    const limit = clampFirst(page.first);
    const fhash = fhashFor(primariiEntityFilterSpec, f);

    let cursorKeys: readonly string[] | undefined;
    if (page.after !== undefined) {
      const decoded = decodeCursor(page.after, { sort: sort.field, dir: sort.dir, fhash });
      if (decoded.isErr()) return err(decoded.error);
      cursorKeys = decoded.value.keys;
    }

    const condsRes = buildEntityConditions(f);
    if (condsRes.isErr()) return err(condsRes.error);
    const baseConds = [...condsRes.value];
    const pageConds = [...baseConds];
    if (cursorKeys?.length === 2) {
      pageConds.push(
        keysetPredicate(sort.col, 'ces.cui', sort.dir, cursorKeys[0] ?? '', cursorKeys[1] ?? '')
      );
    }

    try {
      const [rows, totalRow] = await Promise.all([
        db
          .selectFrom('primarii_transparency.current_entity_status as ces')
          .select(cesSelect())
          .where(composeWhere(pageConds))
          .orderBy(orderByExpr(sort.col, sort.dir))
          .orderBy('ces.cui', sort.dir)
          .limit(limit + 1)
          .execute(),
        db
          .selectFrom('primarii_transparency.current_entity_status as ces')
          .select(sql<string>`count(*)`.as('cnt'))
          .where(composeWhere(baseConds))
          .executeTakeFirst(),
      ]);

      const hasMore = rows.length > limit;
      const pageRows = hasMore ? rows.slice(0, limit) : rows;
      const items = pageRows.map((r) => mapEntityStatus(r as EntityStatusRow));
      let next: string | null = null;
      if (hasMore) {
        const last = pageRows[pageRows.length - 1];
        if (last !== undefined) {
          next = buildNextCursor({
            sort: sort.field,
            dir: sort.dir,
            fhash,
            lastKeys: [sortValue(sort.col, last), last.cui],
          });
        }
      }
      return ok({ items, next, totalCount: Number(totalRow?.cnt ?? 0) });
    } catch (error) {
      return err(databaseError('listEntities failed', error));
    }
  };

  // ── getEntity ───────────────────────────────────────────────────────────────
  const getEntity = async (rawCui: Cui): Promise<Result<PrimariiEntityStatus | null, ApiError>> => {
    const cui = normalizeCui(rawCui);
    if (cui === null) return err(invalidInput('invalid CUI format', 'cui'));
    try {
      const row = await db
        .selectFrom('primarii_transparency.current_entity_status as ces')
        .select(cesSelect())
        .where('ces.cui', '=', cui)
        .limit(1)
        .executeTakeFirst();
      return ok(row === undefined ? null : mapEntityStatus(row as EntityStatusRow));
    } catch (error) {
      return err(databaseError('getEntity failed', error));
    }
  };

  // ── category / claim detail (scoped to current snapshot) ─────────────────────
  const getCategoryStatuses = async (
    rawCui: Cui
  ): Promise<Result<readonly PrimariiCategoryStatus[], ApiError>> => {
    const cui = normalizeCui(rawCui);
    if (cui === null) return err(invalidInput('invalid CUI format', 'cui'));
    try {
      const rows = await db
        .selectFrom('primarii_transparency.entity_category_statuses as ecs')
        .innerJoin('primarii_transparency.current_entity_status as ces', (j) =>
          j.onRef('ces.cui', '=', 'ecs.cui').onRef('ces.snapshot_id', '=', 'ecs.snapshot_id')
        )
        .select(['ecs.category', 'ecs.status', 'ecs.evidence_count', 'ecs.missing_evidence_count'])
        .where('ecs.cui', '=', cui)
        .orderBy('ecs.category', 'asc')
        .execute();
      return ok(rows.map((r) => mapCategoryStatus(r)));
    } catch (error) {
      return err(databaseError('getCategoryStatuses failed', error));
    }
  };

  const getStaffing = async (
    rawCui: Cui
  ): Promise<Result<PrimariiStaffingClaim | null, ApiError>> => {
    const cui = normalizeCui(rawCui);
    if (cui === null) return err(invalidInput('invalid CUI format', 'cui'));
    try {
      const row = await db
        .selectFrom('primarii_transparency.staffing_claims as sc')
        .innerJoin('primarii_transparency.current_entity_status as ces', (j) =>
          j.onRef('ces.cui', '=', 'sc.cui').onRef('ces.snapshot_id', '=', 'sc.snapshot_id')
        )
        .select([
          'sc.total_positions',
          'sc.occupied_positions',
          'sc.vacant_positions',
          'sc.as_of_date',
          'sc.confidence',
        ])
        .where('sc.cui', '=', cui)
        .limit(1)
        .executeTakeFirst();
      return ok(row === undefined ? null : mapStaffing(row));
    } catch (error) {
      return err(databaseError('getStaffing failed', error));
    }
  };

  const getOrganigrama = async (
    rawCui: Cui
  ): Promise<Result<PrimariiOrganigramaClaim | null, ApiError>> => {
    const cui = normalizeCui(rawCui);
    if (cui === null) return err(invalidInput('invalid CUI format', 'cui'));
    try {
      const row = await db
        .selectFrom('primarii_transparency.organigrama_claims as oc')
        .innerJoin('primarii_transparency.current_entity_status as ces', (j) =>
          j.onRef('ces.cui', '=', 'oc.cui').onRef('ces.snapshot_id', '=', 'oc.snapshot_id')
        )
        .select(['oc.status', 'oc.effective_date', 'oc.summary', 'oc.confidence'])
        .where('oc.cui', '=', cui)
        .limit(1)
        .executeTakeFirst();
      return ok(row === undefined ? null : mapOrganigrama(row));
    } catch (error) {
      return err(databaseError('getOrganigrama failed', error));
    }
  };

  // ── getEntityProfile (bundle) ─────────────────────────────────────────────────
  const getEntityProfile = async (
    rawCui: Cui
  ): Promise<Result<PrimariiEntityProfile | null, ApiError>> => {
    const cui = normalizeCui(rawCui);
    if (cui === null) return err(invalidInput('invalid CUI format', 'cui'));

    const statusRes = await getEntity(cui);
    if (statusRes.isErr()) return err(statusRes.error);
    if (statusRes.value === null) return ok(null);

    const [catRes, staffRes, orgRes] = await Promise.all([
      getCategoryStatuses(cui),
      getStaffing(cui),
      getOrganigrama(cui),
    ]);
    if (catRes.isErr()) return err(catRes.error);
    if (staffRes.isErr()) return err(staffRes.error);
    if (orgRes.isErr()) return err(orgRes.error);

    try {
      // Document counts are PER-CUI by design (the `documents_cui_category_idx`
      // grain + the evidence-inventory model, plan §3) — NOT snapshot-scoped. Today
      // each CUI has one snapshot so this is identical; if re-research ever adds
      // snapshots, documents/salary claims are evidence that accumulates per UAT, so
      // the inventory deliberately spans them (history is via /snapshots, not here).
      const docRows = await db
        .selectFrom('primarii_transparency.documents as d')
        .select(['d.category', sql<string>`count(*)`.as('cnt')])
        .where('d.cui', '=', cui)
        .groupBy('d.category')
        .orderBy('d.category', 'asc')
        .execute();
      const documentCounts = docRows.map((r) => ({
        category: r.category ?? '(none)',
        count: Number(r.cnt),
      }));

      return ok({
        status: statusRes.value,
        categories: [...catRes.value],
        staffing: staffRes.value,
        organigrama: orgRes.value,
        documentCounts,
      });
    } catch (error) {
      return err(databaseError('getEntityProfile doc counts failed', error));
    }
  };

  // ── listSalaryClaims (per-CUI, keyset on amount desc then PK) ─────────────────
  const listSalaryClaims = async (
    rawCui: Cui,
    page: CursorPageRequest
  ): Promise<Result<CountedCursorPage<PrimariiSalaryClaim>, ApiError>> => {
    const cui = normalizeCui(rawCui);
    if (cui === null) return err(invalidInput('invalid CUI format', 'cui'));
    const limit = clampFirst(page.first);
    const fhash = `salary:${cui}`;
    const sortCol = 'sac.amount_ron';
    const dir: 'asc' | 'desc' = 'desc';

    let cursorKeys: readonly string[] | undefined;
    if (page.after !== undefined) {
      const decoded = decodeCursor(page.after, { sort: 'amount_ron', dir, fhash });
      if (decoded.isErr()) return err(decoded.error);
      cursorKeys = decoded.value.keys;
    }

    const conds: RawBuilder<unknown>[] = [sql`sac.cui = ${cui}`];
    const pageConds = [...conds];
    if (cursorKeys?.length === 2) {
      pageConds.push(
        keysetPredicate(
          sortCol,
          'sac.salary_amount_claim_id',
          dir,
          cursorKeys[0] ?? '',
          cursorKeys[1] ?? ''
        )
      );
    }

    try {
      const [rows, totalRow] = await Promise.all([
        db
          .selectFrom('primarii_transparency.salary_amount_claims as sac')
          .select([
            'sac.salary_amount_claim_id',
            'sac.cui',
            'sac.document_pk',
            sql<string>`sac.amount_ron::text`.as('amount_ron'),
            'sac.role_title',
            sql<string | null>`sac.period_start::text`.as('period_start'),
            sql<string | null>`sac.period_end::text`.as('period_end'),
            'sac.confidence',
          ])
          .where(composeWhere(pageConds))
          .orderBy(orderByExpr(sortCol, dir))
          .orderBy('sac.salary_amount_claim_id', dir)
          .limit(limit + 1)
          .execute(),
        db
          .selectFrom('primarii_transparency.salary_amount_claims as sac')
          .select(sql<string>`count(*)`.as('cnt'))
          .where(composeWhere(conds))
          .executeTakeFirst(),
      ]);

      const hasMore = rows.length > limit;
      const pageRows = hasMore ? rows.slice(0, limit) : rows;
      const items = pageRows.map((r) => mapSalaryClaim(r));
      let next: string | null = null;
      if (hasMore) {
        const last = pageRows[pageRows.length - 1];
        if (last !== undefined) {
          next = buildNextCursor({
            sort: 'amount_ron',
            dir,
            fhash,
            lastKeys: [last.amount_ron, last.salary_amount_claim_id],
          });
        }
      }
      return ok({ items, next, totalCount: Number(totalRow?.cnt ?? 0) });
    } catch (error) {
      return err(databaseError('listSalaryClaims failed', error));
    }
  };

  // ── listDocuments (requires cui or category) ──────────────────────────────────
  const DOC_COLUMNS = [
    'd.document_pk',
    'd.cui',
    'd.category',
    'd.document_type',
    'd.title',
    'd.source_url',
    'd.content_sha256',
    'd.content_bytes',
    'd.published_date',
    'd.effective_date',
  ] as const;

  const docVirtualConditions = (input: FilterInput): RawBuilder<unknown>[] => {
    const conds: RawBuilder<unknown>[] = [];
    const hasContentField = fieldOf(input, 'hasContent');
    const hasContent = boolEq(hasContentField);
    const isNull = hasContentField?.['isNull'];
    if (hasContent === true) conds.push(sql`d.content_sha256 is not null`);
    else if (hasContent === false) conds.push(sql`d.content_sha256 is null`);
    if (isNull === true) conds.push(sql`d.content_sha256 is null`);
    else if (isNull === false) conds.push(sql`d.content_sha256 is not null`);
    return conds;
  };

  const DOC_SORT: Record<string, { col: string; dir: 'asc' | 'desc' }> = {
    cui: { col: 'd.cui', dir: 'asc' },
    category: { col: 'd.category', dir: 'asc' },
  };

  const listDocuments = async (
    f: FilterInput,
    page: CursorPageRequest
  ): Promise<Result<CountedCursorPage<PrimariiDocument>, ApiError>> => {
    // Require at least one MEANINGFUL driving predicate (cui or category) — no
    // unbounded scan. A bare `{ cui: {} }` (field present, no op) does NOT count;
    // an explicit empty `in: []` is meaningful (kernel composes it as match-none).
    const drives = (name: string): boolean => {
      const ff = fieldOf(f, name);
      if (ff === undefined) return false;
      return eqValue(ff) !== undefined || inValues(ff) !== undefined;
    };
    if (!drives('cui') && !drives('category')) {
      return err(invalidInput('listDocuments requires a cui or category filter', 'filter'));
    }

    const sortField =
      page.sort !== undefined && page.sort in DOC_SORT
        ? page.sort
        : primariiDocumentFilterSpec.sort.default;
    const def = DOC_SORT[sortField] ?? DOC_SORT['cui'] ?? { col: 'd.cui', dir: 'asc' as const };
    const limit = clampFirst(page.first);
    const fhash = fhashFor(primariiDocumentFilterSpec, f);

    let cursorKeys: readonly string[] | undefined;
    if (page.after !== undefined) {
      const decoded = decodeCursor(page.after, { sort: sortField, dir: def.dir, fhash });
      if (decoded.isErr()) return err(decoded.error);
      cursorKeys = decoded.value.keys;
    }

    const physical = omitVirtualFields(f, [...PRIMARII_DOCUMENT_VIRTUAL_FIELDS]);
    const kernel = toConditionBuilders(primariiDocumentFilterSpec, physical);
    if (kernel.isErr()) return err(kernel.error);
    const baseConds = [...kernel.value, ...docVirtualConditions(f)];
    const pageConds = [...baseConds];
    if (cursorKeys?.length === 2) {
      pageConds.push(
        keysetPredicate(def.col, 'd.document_pk', def.dir, cursorKeys[0] ?? '', cursorKeys[1] ?? '')
      );
    }

    try {
      const [rows, totalRow] = await Promise.all([
        db
          .selectFrom('primarii_transparency.documents as d')
          .select(DOC_COLUMNS)
          .where(composeWhere(pageConds))
          .orderBy(orderByExpr(def.col, def.dir))
          .orderBy('d.document_pk', def.dir)
          .limit(limit + 1)
          .execute(),
        db
          .selectFrom('primarii_transparency.documents as d')
          .select(sql<string>`count(*)`.as('cnt'))
          .where(composeWhere(baseConds))
          .executeTakeFirst(),
      ]);

      const hasMore = rows.length > limit;
      const pageRows = hasMore ? rows.slice(0, limit) : rows;
      const items = pageRows.map((r) => mapDocument(r));
      let next: string | null = null;
      if (hasMore) {
        const last = pageRows[pageRows.length - 1];
        if (last !== undefined) {
          next = buildNextCursor({
            sort: sortField,
            dir: def.dir,
            fhash,
            lastKeys: [sortValue(def.col, last), last.document_pk],
          });
        }
      }
      return ok({ items, next, totalCount: Number(totalRow?.cnt ?? 0) });
    } catch (error) {
      return err(databaseError('listDocuments failed', error));
    }
  };

  // ── listSnapshots (per-CUI, keyset on loaded_at desc then PK) ─────────────────
  const listSnapshots = async (
    rawCui: Cui,
    page: CursorPageRequest
  ): Promise<Result<CountedCursorPage<PrimariiSnapshot>, ApiError>> => {
    const cui = normalizeCui(rawCui);
    if (cui === null) return err(invalidInput('invalid CUI format', 'cui'));
    const limit = clampFirst(page.first);
    const fhash = `snapshots:${cui}`;
    const sortCol = 'es.loaded_at';
    const dir: 'asc' | 'desc' = 'desc';

    let cursorKeys: readonly string[] | undefined;
    if (page.after !== undefined) {
      const decoded = decodeCursor(page.after, { sort: 'loaded_at', dir, fhash });
      if (decoded.isErr()) return err(decoded.error);
      cursorKeys = decoded.value.keys;
    }

    const conds: RawBuilder<unknown>[] = [sql`es.cui = ${cui}`];
    const pageConds = [...conds];
    if (cursorKeys?.length === 2) {
      pageConds.push(
        keysetPredicate(sortCol, 'es.snapshot_id', dir, cursorKeys[0] ?? '', cursorKeys[1] ?? '')
      );
    }

    try {
      const [rows, totalRow] = await Promise.all([
        db
          .selectFrom('primarii_transparency.entity_snapshots as es')
          .select([
            'es.snapshot_id',
            'es.cui',
            'es.entity_name',
            'es.entity_type',
            'es.county',
            'es.website_url',
            'es.wikipedia_url',
            'es.source_result_version_id',
            'es.schema_version',
            'es.result_status',
            'es.confidence',
            sql<string | null>`es.researched_at::text`.as('researched_at'),
            'es.organigrama_status',
            'es.numar_angajati_status',
            'es.salarii_status',
            'es.missing_required_categories',
            'es.validation_issues',
            sql<string>`es.loaded_at::text`.as('loaded_at'),
          ])
          .where(composeWhere(pageConds))
          .orderBy(orderByExpr(sortCol, dir))
          .orderBy('es.snapshot_id', dir)
          .limit(limit + 1)
          .execute(),
        db
          .selectFrom('primarii_transparency.entity_snapshots as es')
          .select(sql<string>`count(*)`.as('cnt'))
          .where(composeWhere(conds))
          .executeTakeFirst(),
      ]);

      const hasMore = rows.length > limit;
      const pageRows = hasMore ? rows.slice(0, limit) : rows;
      const items = pageRows.map((r) => mapSnapshot(r as SnapshotRow));
      let next: string | null = null;
      if (hasMore) {
        const last = pageRows[pageRows.length - 1];
        if (last !== undefined) {
          next = buildNextCursor({
            sort: 'loaded_at',
            dir,
            fhash,
            lastKeys: [last.loaded_at, last.snapshot_id],
          });
        }
      }
      return ok({ items, next, totalCount: Number(totalRow?.cnt ?? 0) });
    } catch (error) {
      return err(databaseError('listSnapshots failed', error));
    }
  };

  // ── aggregateStatus ──────────────────────────────────────────────────────────
  const aggregateStatus = async (
    groupBy: PrimariiStatGroupBy,
    f: FilterInput
  ): Promise<Result<readonly PrimariiStatusBucket[], ApiError>> => {
    if (groupBy === 'region') {
      // region requires the kernel cui→territory filter/group builder (§13.0) — gated.
      return err(
        invalidInput(
          "geographic grouping 'region' requires the kernel cui→territory builder (unavailable); use county",
          'groupBy'
        )
      );
    }
    const vv = validateEntityVirtual(f);
    if (vv.isErr()) return err(vv.error);
    const condsRes = buildEntityConditions(f);
    if (condsRes.isErr()) return err(condsRes.error);
    const where = composeWhere(condsRes.value);

    const keyCol: Record<Exclude<PrimariiStatGroupBy, 'region'>, string> = {
      county: 'ces.county',
      data_quality_status: 'ces.data_quality_status',
      result_status: 'ces.result_status',
      entity_type: 'ces.entity_type',
    };
    const col = keyCol[groupBy];

    try {
      const rows = await db
        .selectFrom('primarii_transparency.current_entity_status as ces')
        .select([
          sql<string | null>`${sql.ref(col)}`.as('key'),
          sql<string>`count(*)`.as('total'),
          sql<string>`count(*) filter (where ces.evidence_coverage > 0)`.as('with_evidence'),
        ])
        .where(where)
        .groupBy(() => sql.ref(col))
        .orderBy(sql`count(*) desc`)
        .limit(200)
        .execute();
      return ok(
        rows.map((r) => ({
          key: r.key ?? '(none)',
          total: Number(r.total),
          // count(*) filter (...) is never null in Postgres — always a value.
          withEvidence: Number(r.with_evidence),
        }))
      );
    } catch (error) {
      return err(databaseError('aggregateStatus failed', error));
    }
  };

  // ── aggregateCategoryCoverage ─────────────────────────────────────────────────
  const aggregateCategoryCoverage = async (
    f: FilterInput
  ): Promise<Result<readonly PrimariiCategoryCoverage[], ApiError>> => {
    const vv = validateEntityVirtual(f);
    if (vv.isErr()) return err(vv.error);
    const condsRes = buildEntityConditions(f);
    if (condsRes.isErr()) return err(condsRes.error);
    // Scope category statuses to the CURRENT snapshot via the join + the entity filter.
    const where = composeWhere(condsRes.value);

    try {
      const rows = await db
        .selectFrom('primarii_transparency.entity_category_statuses as ecs')
        .innerJoin('primarii_transparency.current_entity_status as ces', (j) =>
          j.onRef('ces.cui', '=', 'ecs.cui').onRef('ces.snapshot_id', '=', 'ecs.snapshot_id')
        )
        .select([
          'ecs.category',
          sql<string>`count(*) filter (where ecs.status = 'found')`.as('found'),
          sql<string>`count(*) filter (where ecs.status = 'not_found')`.as('not_found'),
          sql<string>`count(*) filter (where ecs.status = 'unknown')`.as('unknown'),
          sql<string>`count(*) filter (where ecs.status = 'blocked')`.as('blocked'),
          sql<string>`count(*)`.as('total'),
        ])
        .where(where)
        .groupBy('ecs.category')
        .orderBy('ecs.category', 'asc')
        .execute();
      return ok(
        rows.map((r) => {
          const total = Number(r.total);
          const found = Number(r.found);
          return {
            category: r.category,
            found,
            notFound: Number(r.not_found),
            unknown: Number(r.unknown),
            blocked: Number(r.blocked),
            coverage: total > 0 ? found / total : 0,
          };
        })
      );
    } catch (error) {
      return err(databaseError('aggregateCategoryCoverage failed', error));
    }
  };

  // ── listLoadIssues (bounded capped list) ──────────────────────────────────────
  const listLoadIssues = async (
    filter: { cui?: string; severity?: string; issueCode?: string },
    limit: number
  ): Promise<Result<readonly PrimariiLoadIssue[], ApiError>> => {
    const capped = clampLimit(limit, 200);
    try {
      let q = db
        .selectFrom('primarii_transparency.load_issues as li')
        .select([
          'li.severity',
          'li.issue_code',
          'li.cui',
          'li.message',
          sql<string>`li.created_at::text`.as('created_at'),
        ]);
      if (filter.cui !== undefined && filter.cui !== '') {
        const cui = normalizeCui(filter.cui);
        if (cui === null) return err(invalidInput('invalid CUI format', 'cui'));
        q = q.where('li.cui', '=', cui);
      }
      if (filter.severity !== undefined && filter.severity !== '') {
        const sev = filter.severity.trim();
        if (!(PRIMARII_ISSUE_SEVERITY as readonly string[]).includes(sev)) {
          return err(
            invalidInput(
              `severity must be one of ${PRIMARII_ISSUE_SEVERITY.join(', ')}`,
              'severity'
            )
          );
        }
        q = q.where('li.severity', '=', sev);
      }
      if (filter.issueCode !== undefined && filter.issueCode !== '') {
        q = q.where('li.issue_code', '=', filter.issueCode.trim());
      }
      const rows = await q
        .orderBy('li.created_at', 'desc')
        .orderBy('li.load_issue_id', 'desc')
        .limit(capped)
        .execute();
      return ok(rows.map((r) => mapLoadIssue(r)));
    } catch (error) {
      return err(databaseError('listLoadIssues failed', error));
    }
  };

  // ── resolve (entity/county/status; siruta handled by the usecase) ─────────────
  const resolve = async (
    dim: 'entity' | 'county' | 'status',
    q: string,
    limit: number
  ): Promise<Result<readonly ResolveHit[], ApiError>> => {
    const needle = q.trim();
    if (needle === '') return ok([]);
    const capped = clampLimit(limit, 50);
    try {
      if (dim === 'entity') {
        const pattern = `%${escapeLike(needle)}%`;
        const rows = await db
          .selectFrom('primarii_transparency.current_entity_status as ces')
          .select(['ces.cui as value', 'ces.entity_name as label', 'ces.county as hint'])
          .where(sql<boolean>`ces.entity_name ilike ${pattern} escape '\\'`)
          .orderBy('ces.entity_name', 'asc')
          .limit(capped)
          .execute();
        return ok(
          rows.map(
            (r): ResolveHit => ({
              kind: 'entity',
              value: r.value,
              label: r.label,
              ...(r.hint !== null && { hint: r.hint }),
            })
          )
        );
      }
      if (dim === 'county') {
        const pattern = `%${escapeLike(needle)}%`;
        const rows = await db
          .selectFrom('primarii_transparency.current_entity_status as ces')
          .select(['ces.county as value', sql<string>`count(*)`.as('cnt')])
          .where('ces.county', 'is not', null)
          .where(sql<boolean>`ces.county ilike ${pattern} escape '\\'`)
          .groupBy('ces.county')
          .orderBy(sql`count(*) desc`)
          .limit(capped)
          .execute();
        return ok(
          rows.map(
            (r): ResolveHit => ({
              kind: 'county',
              value: r.value ?? '',
              label: r.value ?? '',
              hint: `${r.cnt} UATs`,
            })
          )
        );
      }
      // status: match a data-quality OR result-status enum by substring of its value.
      const lc = needle.toLowerCase();
      const dq = PRIMARII_DATA_QUALITY.filter((s) => s.includes(lc)).map(
        (s): ResolveHit => ({ kind: 'data_quality_status', value: s, label: s })
      );
      const rs = PRIMARII_RESULT_STATUS.filter((s) => s.includes(lc)).map(
        (s): ResolveHit => ({ kind: 'result_status', value: s, label: s })
      );
      return ok([...dq, ...rs].slice(0, capped));
    } catch (error) {
      return err(databaseError('resolve failed', error));
    }
  };

  // ── getRegistryLinks (DDL-only; returns [] today) ─────────────────────────────
  const getRegistryLinks = async (
    rawCui: Cui
  ): Promise<Result<readonly PrimariiRegistryLink[], ApiError>> => {
    const cui = normalizeCui(rawCui);
    if (cui === null) return err(invalidInput('invalid CUI format', 'cui'));
    try {
      const rows = await db
        .selectFrom('primarii_transparency.entity_registry_links as erl')
        .select(['erl.registry', 'erl.registry_cui', 'erl.link_confidence'])
        .where('erl.cui', '=', cui)
        .limit(100)
        .execute();
      return ok(rows.map((r) => mapRegistryLink(r)));
    } catch (error) {
      return err(databaseError('getRegistryLinks failed', error));
    }
  };

  // ── presenceFor (contributor support) ─────────────────────────────────────────
  const presenceFor = async (
    rawCui: Cui
  ): Promise<
    Result<{ present: boolean; status?: string; dataQuality?: string } | null, ApiError>
  > => {
    const cui = normalizeCui(rawCui);
    if (cui === null) return err(invalidInput('invalid CUI format', 'cui'));
    try {
      const row = await db
        .selectFrom('primarii_transparency.current_entity_status as ces')
        .select(['ces.result_status', 'ces.data_quality_status'])
        .where('ces.cui', '=', cui)
        .limit(1)
        .executeTakeFirst();
      if (row === undefined) return ok(null);
      return ok({ present: true, status: row.result_status, dataQuality: row.data_quality_status });
    } catch (error) {
      return err(databaseError('presenceFor failed', error));
    }
  };

  return {
    listEntities,
    getEntity,
    getEntityProfile,
    getCategoryStatuses,
    getStaffing,
    getOrganigrama,
    listSalaryClaims,
    listDocuments,
    listSnapshots,
    aggregateStatus,
    aggregateCategoryCoverage,
    listLoadIssues,
    resolve,
    getRegistryLinks,
    presenceFor,
  };
};
