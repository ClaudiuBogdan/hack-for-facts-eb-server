/**
 * Procurement module — entity-table repository (plan §3, §3a(1)). The ONLY place
 * that reads `procurement.{procedures,contracts,direct_acquisitions,
 * contract_modifications,cpv_*}` + a read-only `core.*` buyer-territory join.
 *
 * Load-bearing invariants:
 *  1. NO unbounded scan / NO blocking COUNT on the fact tables (§14.4). Every list
 *     is index-driven + keyset cursor (date desc, id desc). DA lists additionally
 *     require a SELECTIVE filter (runtime `assertDaSelective`, §3a(1)).
 *  2. The cursor `fhash` is computed from the FULL filter spec (not the kernel
 *     spec) so the repo-intercepted virtual fields (cpvDivision/year/
 *     includeDuplicates) bind the cursor (review discipline).
 *  3. Money is `::text` at the SQL boundary (precision-safe strings). bigint ids
 *     stay strings. `is_canonical = true` is forced unless includeDuplicates.
 */

import { sql, type Kysely, type RawBuilder, type SqlBool } from 'kysely';
import { err, ok, type Result } from 'neverthrow';

import {
  buildNextCursor,
  databaseError,
  decodeCursor,
  fhashFor,
  invalidInput,
  normalizeCui,
  toConditionBuilders,
  type ApiError,
  type CursorPage,
  type FilterInput,
  type ProdDatabase, type CollectionFilterSpec 
} from '@/modules/shared/index.js';

import {
  assertDaSelective,
  canonicalPredicate,
  cpvDivisionRange,
  yearDateRange,
} from './filter-helpers.js';
import {
  mapContract,
  mapDirectAcquisition,
  mapModification,
  mapProcedure,
} from './mappers.js';
import { DA_LIST_MAX_WINDOW_DAYS_DEFAULT } from '../../core/constants.js';
import {
  assertNoYearDateConflict,
  contractFilterSpec,
  contractKernelSpec,
  CONTRACT_VIRTUAL_FIELDS,
  daFilterSpec,
  daKernelSpec,
  DA_VIRTUAL_FIELDS,
  modificationFilterSpec,
  modificationKernelSpec,
  procedureFilterSpec,
  procedureKernelSpec,
  PROCEDURE_VIRTUAL_FIELDS,
} from '../../core/filters.js';

import type { CursorPageRequest, ProcurementRepo } from '../../core/ports.js';
import type {
  ContractDetail,
  CpvDivision,
  CpvMatch,
  ProcedureDetail,
  ProcurementContract,
  ProcurementDirectAcquisition,
  ProcurementModification,
  ProcurementProcedure,
} from '../../core/types.js';

type Db = Kysely<ProdDatabase>;

const LIST_LIMIT_MAX = 100;
const MODIFICATIONS_CAP = 200;
const CPV_RESOLVE_MAX = 50;

const clamp = (n: number, lo: number, hi: number): number => Math.min(Math.max(Math.floor(n), lo), hi);

const composeAnd = (conds: readonly RawBuilder<unknown>[]): RawBuilder<SqlBool> =>
  conds.length === 0 ? sql<SqlBool>`true` : sql<SqlBool>`${sql.join(conds, sql` and `)}`;

const dirSql = (dir: 'asc' | 'desc'): RawBuilder<unknown> => (dir === 'asc' ? sql`asc` : sql`desc`);

/** Drop the kernel-composer fields that are virtual + emit the repo-intercepted SQL. */
const omit = (input: FilterInput, drop: readonly string[]): FilterInput => {
  const set = new Set(drop);
  const out: FilterInput = {};
  for (const k of Object.keys(input)) if (!set.has(k)) (out as Record<string, unknown>)[k] = input[k];
  return out;
};

/** CUI filter fields that must be normalized before composing (RO-prefix, spaces). */
const CUI_FILTER_FIELDS = ['authorityCui', 'supplierCui'] as const;

/**
 * Normalize CUI filter values (strip RO/spaces, digits-only) so a base-table filter
 * matches the same rows the aggregate endpoints (which normalize) find — Codex #5.
 * Drops un-normalizable members (e.g. an all-letters token) so they can't match.
 */
const normalizeCuiFilters = (input: FilterInput): FilterInput => {
  let out = input;
  for (const field of CUI_FILTER_FIELDS) {
    const ff = input[field];
    if (ff === undefined || typeof ff !== 'object' || Array.isArray(ff)) continue;
    const bag = ff as Record<string, unknown>;
    const next: Record<string, unknown> = {};
    let changed = false;
    for (const op of Object.keys(bag)) {
      const v = bag[op];
      if (op === 'in' && Array.isArray(v)) {
        const norm = v.map((x) => normalizeCui(String(x))).filter((x): x is string => x !== null);
        next[op] = norm;
        changed = true;
      } else if (op === 'eq' && (typeof v === 'string' || typeof v === 'number')) {
        const norm = normalizeCui(String(v));
        next[op] = norm ?? String(v);
        changed = true;
      } else {
        next[op] = v;
      }
    }
    if (changed) {
      if (out === input) out = { ...input };
      (out as Record<string, unknown>)[field] = next;
    }
  }
  return out;
};

/** Does the input touch a buyer-territory field requiring the core join? */
const needsCoreJoin = (input: FilterInput): boolean =>
  input['countyCode'] !== undefined || input['region'] !== undefined;

export const makeProcurementRepo = (db: Db, daMaxWindowDays = DA_LIST_MAX_WINDOW_DAYS_DEFAULT): ProcurementRepo => {
  // ───────────────────────────────────────────────────────────────────────────
  // shared list machinery
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Build the repo-intercepted predicates (cpvDivision range, year→date range,
   * canonical) + the kernel-composed physical predicates. Returns the full WHERE
   * condition list, or an error from any intercepted field.
   */
  const buildConditions = (
    input: FilterInput,
    alias: string,
    dateColumn: string,
    kernelSpec: CollectionFilterSpec,
    virtualFields: readonly string[],
    opts: { canonical: boolean }
  ): Result<RawBuilder<unknown>[], ApiError> => {
    const conds: RawBuilder<unknown>[] = [];

    const physical = omit(normalizeCuiFilters(input), virtualFields);
    const built = toConditionBuilders(kernelSpec, physical);
    if (built.isErr()) return err(built.error);
    conds.push(...built.value);

    const cpv = cpvDivisionRange(input, alias);
    if (cpv.isErr()) return err(cpv.error);
    if (cpv.value !== undefined) conds.push(cpv.value);

    const yr = yearDateRange(input, alias, dateColumn);
    if (yr.isErr()) return err(yr.error);
    if (yr.value !== undefined) conds.push(yr.value);

    if (opts.canonical) {
      const canon = canonicalPredicate(input, alias);
      if (canon !== undefined) conds.push(canon);
    }
    return ok(conds);
  };

  /** Keyset cursor predicate for `(dateCol desc, idCol desc)` (the only sort dir here). */
  const keysetPredicate = (
    alias: string,
    dateColumn: string,
    idColumn: string,
    keys: readonly string[]
  ): RawBuilder<unknown> | undefined => {
    const date = keys[0] ?? '';
    const id = keys[1] ?? '';
    if (id === '') return undefined;
    const dateRef = sql.ref(`${alias}.${dateColumn}`);
    const idRef = sql.ref(`${alias}.${idColumn}`);
    // NULLS LAST on the date desc ordering: a null-date row sorts after all dated
    // rows. The cursor encodes a null date as ''. Walk the date-desc/id-desc keyset.
    if (date === '') {
      // already in the trailing null-date section: only further rows by id.
      return sql`(${dateRef} is null and ${idRef} < ${id}::bigint)`;
    }
    return sql`(${dateRef} < ${date}::date or ${dateRef} is null or (${dateRef} = ${date}::date and ${idRef} < ${id}::bigint))`;
  };

  // ───────────────────────────────────────────────────────────────────────────
  // procedures
  // ───────────────────────────────────────────────────────────────────────────

  const procedureSelect = [
    'p.procedure_id', 'p.notice_no', 'p.notice_kind', 'p.procedure_type', 'p.contract_kind',
    'p.title', 'p.authority_cui', 'p.authority_name', 'p.cpv_code', 'p.currency',
    sql<string | null>`p.estimated_value_ron::text`.as('estimated_value_ron'),
    sql<string | null>`p.awarded_value_ron::text`.as('awarded_value_ron'),
    'p.status', 'p.county_name',
    // date columns → ::text (pg returns `date` as a JS Date otherwise, which breaks
    // the YYYY-MM-DD contract AND the cursor key serialization).
    sql<string | null>`p.publication_date::text`.as('publication_date'),
    sql<string | null>`p.state_date::text`.as('state_date'),
  ] as const;

  const listProcedures = async (
    filter: FilterInput,
    page: CursorPageRequest
  ): Promise<Result<CursorPage<ProcurementProcedure>, ApiError>> => {
    const conflict = assertNoYearDateConflict(filter, 'publicationDate');
    if (!conflict.ok) return err(invalidInput('cannot combine year and publicationDate range', conflict.field));
    const limit = clamp(page.first, 1, LIST_LIMIT_MAX);
    const fhash = fhashFor(procedureFilterSpec, filter);
    const cursor = decodeCursorKeys(page.after, fhash, 'publication_date');
    if (cursor.isErr()) return err(cursor.error);

    const condsR = buildConditions(filter, 'p', 'publication_date', procedureKernelSpec, PROCEDURE_VIRTUAL_FIELDS, { canonical: false });
    if (condsR.isErr()) return err(condsR.error);
    const conds = condsR.value;
    if (cursor.value !== undefined) {
      const k = keysetPredicate('p', 'publication_date', 'procedure_id', cursor.value);
      if (k !== undefined) conds.push(k);
    }
    try {
      let base = db.selectFrom('procurement.procedures as p');
      if (needsCoreJoin(filter)) {
        base = base
          .leftJoin('core.public_entities as e', 'e.cui', 'p.authority_cui')
          .leftJoin('core.territories as t', 't.territorial_siruta_code', 'e.territorial_siruta_code');
      }
      const rows = await base
        .select(procedureSelect)
        .where(composeAnd(conds))
        .orderBy(sql`p.publication_date ${dirSql('desc')} nulls last`)
        .orderBy('p.procedure_id', 'desc')
        .limit(limit + 1)
        .execute();
      return ok(toPage(rows, limit, fhash, 'publication_date', mapProcedure, (r) => [r.publication_date, r.procedure_id]));
    } catch (error) {
      return err(databaseError('listProcedures failed', error));
    }
  };

  const getProcedure = async (id: string): Promise<Result<ProcurementProcedure | null, ApiError>> => {
    if (!/^\d+$/u.test(id)) return err(invalidInput('id must be a bigint', 'id'));
    try {
      const row = await db
        .selectFrom('procurement.procedures as p')
        .select(procedureSelect)
        .where('p.procedure_id', '=', id)
        .limit(1)
        .executeTakeFirst();
      return ok(row !== undefined ? mapProcedure(row) : null);
    } catch (error) {
      return err(databaseError('getProcedure failed', error));
    }
  };

  const getProcedureDetail = async (id: string): Promise<Result<ProcedureDetail | null, ApiError>> => {
    const procR = await getProcedure(id);
    if (procR.isErr()) return err(procR.error);
    if (procR.value === null) return ok(null);
    try {
      const rows = await db
        .selectFrom('procurement.contracts as c')
        .select(contractSelect)
        .where('c.procedure_id', '=', id)
        .where('c.is_canonical', '=', true)
        .orderBy('c.contract_date', 'desc')
        .orderBy('c.contract_id', 'desc')
        .limit(50)
        .execute();
      return ok({ procedure: procR.value, contracts: rows.map(mapContract) });
    } catch (error) {
      return err(databaseError('getProcedureDetail failed', error));
    }
  };

  // ───────────────────────────────────────────────────────────────────────────
  // contracts
  // ───────────────────────────────────────────────────────────────────────────

  const contractSelect = [
    'c.contract_id', 'c.contract_key', 'c.procedure_id', 'c.notice_no', 'c.contract_no',
    sql<string | null>`c.contract_date::text`.as('contract_date'),
    'c.title', 'c.authority_cui', 'c.authority_name', 'c.supplier_cui',
    'c.supplier_name', 'c.cpv_code', 'c.currency',
    sql<string | null>`c.value_ron::text`.as('value_ron'),
    sql<string | null>`c.estimated_value_ron::text`.as('estimated_value_ron'),
    'c.status', 'c.county_name', 'c.is_canonical', 'c.dup_group_id',
  ] as const;

  const listContracts = async (
    filter: FilterInput,
    page: CursorPageRequest
  ): Promise<Result<CursorPage<ProcurementContract>, ApiError>> => {
    const conflict = assertNoYearDateConflict(filter, 'contractDate');
    if (!conflict.ok) return err(invalidInput('cannot combine year and contractDate range', conflict.field));
    const limit = clamp(page.first, 1, LIST_LIMIT_MAX);
    const fhash = fhashFor(contractFilterSpec, filter);
    const cursor = decodeCursorKeys(page.after, fhash, 'contract_date');
    if (cursor.isErr()) return err(cursor.error);

    const condsR = buildConditions(filter, 'c', 'contract_date', contractKernelSpec, CONTRACT_VIRTUAL_FIELDS, { canonical: true });
    if (condsR.isErr()) return err(condsR.error);
    const conds = condsR.value;
    if (cursor.value !== undefined) {
      const k = keysetPredicate('c', 'contract_date', 'contract_id', cursor.value);
      if (k !== undefined) conds.push(k);
    }
    try {
      let base = db.selectFrom('procurement.contracts as c');
      if (needsCoreJoin(filter)) {
        base = base
          .leftJoin('core.public_entities as e', 'e.cui', 'c.authority_cui')
          .leftJoin('core.territories as t', 't.territorial_siruta_code', 'e.territorial_siruta_code');
      }
      const rows = await base
        .select(contractSelect)
        .where(composeAnd(conds))
        .orderBy(sql`c.contract_date ${dirSql('desc')} nulls last`)
        .orderBy('c.contract_id', 'desc')
        .limit(limit + 1)
        .execute();
      return ok(toPage(rows, limit, fhash, 'contract_date', mapContract, (r) => [r.contract_date, r.contract_id]));
    } catch (error) {
      return err(databaseError('listContracts failed', error));
    }
  };

  const getContract = async (id: string): Promise<Result<ProcurementContract | null, ApiError>> => {
    if (!/^\d+$/u.test(id)) return err(invalidInput('id must be a bigint', 'id'));
    try {
      const row = await db
        .selectFrom('procurement.contracts as c')
        .select(contractSelect)
        .where('c.contract_id', '=', id)
        .limit(1)
        .executeTakeFirst();
      return ok(row !== undefined ? mapContract(row) : null);
    } catch (error) {
      return err(databaseError('getContract failed', error));
    }
  };

  const modificationSelect = [
    'm.modification_id', 'm.contract_id', 'm.link_method', 'm.link_confidence',
    'm.authority_cui', 'm.supplier_cui', 'm.contract_no', 'm.notice_no',
    sql<string | null>`m.modification_date::text`.as('modification_date'),
    sql<string | null>`m.value_before_ron::text`.as('value_before_ron'),
    sql<string | null>`m.value_after_ron::text`.as('value_after_ron'),
    sql<string | null>`m.value_delta_ron::text`.as('value_delta_ron'),
    'm.modification_type', 'm.year',
  ] as const;

  const getContractModifications = async (
    id: string
  ): Promise<Result<readonly ProcurementModification[], ApiError>> => {
    if (!/^\d+$/u.test(id)) return err(invalidInput('id must be a bigint', 'id'));
    try {
      const rows = await db
        .selectFrom('procurement.contract_modifications as m')
        .select(modificationSelect)
        .where('m.contract_id', '=', id)
        .orderBy('m.modification_date', 'desc')
        .orderBy('m.modification_id', 'desc')
        .limit(MODIFICATIONS_CAP)
        .execute();
      return ok(rows.map(mapModification));
    } catch (error) {
      return err(databaseError('getContractModifications failed', error));
    }
  };

  const getContractDetail = async (id: string): Promise<Result<ContractDetail | null, ApiError>> => {
    const contractR = await getContract(id);
    if (contractR.isErr()) return err(contractR.error);
    if (contractR.value === null) return ok(null);
    const contract = contractR.value;
    const [modsR, procR] = await Promise.all([
      getContractModifications(id),
      contract.procedureId !== null ? getProcedure(contract.procedureId) : Promise.resolve(ok(null)),
    ]);
    if (modsR.isErr()) return err(modsR.error);
    if (procR.isErr()) return err(procR.error);
    return ok({ contract, procedure: procR.value, modifications: modsR.value });
  };

  // ───────────────────────────────────────────────────────────────────────────
  // direct acquisitions (HIGH VOLUME — selective filter required)
  // ───────────────────────────────────────────────────────────────────────────

  const daSelect = [
    'd.da_id', 'd.da_key', 'd.source_system', 'd.unique_code', 'd.title',
    'd.authority_cui', 'd.authority_name', 'd.supplier_cui', 'd.supplier_name', 'd.cpv_code', 'd.currency',
    sql<string | null>`d.value_ron::text`.as('value_ron'),
    sql<string | null>`d.estimated_value_ron::text`.as('estimated_value_ron'),
    'd.status', 'd.county_name',
    sql<string | null>`d.publication_date::text`.as('publication_date'),
    sql<string | null>`d.finalization_date::text`.as('finalization_date'),
    'd.is_canonical', 'd.dup_group_id',
  ] as const;

  const listDirectAcquisitions = async (
    filter: FilterInput,
    page: CursorPageRequest
  ): Promise<Result<CursorPage<ProcurementDirectAcquisition>, ApiError>> => {
    // §3a(1): a selective filter is REQUIRED on all surfaces (runtime check).
    const selective = assertDaSelective(filter, daMaxWindowDays);
    if (selective.isErr()) return err(selective.error);
    // DA date filter binds to finalization_date (publication_date is null on elicitatie_da).
    const conflict = assertNoYearDateConflict(filter, 'finalizationDate');
    if (!conflict.ok) return err(invalidInput('cannot combine year and finalizationDate range', conflict.field));

    const limit = clamp(page.first, 1, LIST_LIMIT_MAX);
    const fhash = fhashFor(daFilterSpec, filter);
    const cursor = decodeCursorKeys(page.after, fhash, 'finalization_date');
    if (cursor.isErr()) return err(cursor.error);

    const condsR = buildConditions(filter, 'd', 'finalization_date', daKernelSpec, DA_VIRTUAL_FIELDS, { canonical: true });
    if (condsR.isErr()) return err(condsR.error);
    const conds = condsR.value;
    if (cursor.value !== undefined) {
      const k = keysetPredicate('d', 'finalization_date', 'da_id', cursor.value);
      if (k !== undefined) conds.push(k);
    }
    try {
      // No core join for DAs (supplier territory unavailable; buyer county is the
      // denormalized county_name — no county_code filter surfaced for DAs).
      const rows = await db
        .selectFrom('procurement.direct_acquisitions as d')
        .select(daSelect)
        .where(composeAnd(conds))
        .orderBy(sql`d.finalization_date ${dirSql('desc')} nulls last`)
        .orderBy('d.da_id', 'desc')
        .limit(limit + 1)
        .execute();
      return ok(toPage(rows, limit, fhash, 'finalization_date', mapDirectAcquisition, (r) => [r.finalization_date, r.da_id]));
    } catch (error) {
      return err(databaseError('listDirectAcquisitions failed', error));
    }
  };

  const getDirectAcquisition = async (id: string): Promise<Result<ProcurementDirectAcquisition | null, ApiError>> => {
    if (!/^\d+$/u.test(id)) return err(invalidInput('id must be a bigint', 'id'));
    try {
      const row = await db
        .selectFrom('procurement.direct_acquisitions as d')
        .select(daSelect)
        .where('d.da_id', '=', id)
        .limit(1)
        .executeTakeFirst();
      return ok(row !== undefined ? mapDirectAcquisition(row) : null);
    } catch (error) {
      return err(databaseError('getDirectAcquisition failed', error));
    }
  };

  // ───────────────────────────────────────────────────────────────────────────
  // modifications (PC-8)
  // ───────────────────────────────────────────────────────────────────────────

  const listModificationsInternal = async (
    filter: FilterInput,
    page: CursorPageRequest,
    minDeltaPct?: number
  ): Promise<Result<CursorPage<ProcurementModification>, ApiError>> => {
    const limit = clamp(page.first, 1, LIST_LIMIT_MAX);
    const fhash = fhashFor(modificationFilterSpec, filter);
    // Bind minDeltaPct into the cursor sort key so a cursor minted under one PC-8
    // threshold cannot be replayed against another (it isn't a spec field, so it
    // wouldn't otherwise affect the fhash) — Codex #7.
    const sortKey = minDeltaPct !== undefined ? `modification_date|d${String(minDeltaPct)}` : 'modification_date';
    const cursor = decodeCursorKeys(page.after, fhash, sortKey);
    if (cursor.isErr()) return err(cursor.error);

    const built = toConditionBuilders(modificationKernelSpec, normalizeCuiFilters(filter));
    if (built.isErr()) return err(built.error);
    const conds = [...built.value];
    if (minDeltaPct !== undefined) {
      // delta_pct = value_delta_ron / nullif(value_before_ron, 0) ≥ pct (PC-8).
      conds.push(sql`(m.value_delta_ron / nullif(m.value_before_ron, 0)) >= ${minDeltaPct}`);
    }
    if (cursor.value !== undefined) {
      const k = keysetPredicate('m', 'modification_date', 'modification_id', cursor.value);
      if (k !== undefined) conds.push(k);
    }
    try {
      const rows = await db
        .selectFrom('procurement.contract_modifications as m')
        .select(modificationSelect)
        .where(composeAnd(conds))
        .orderBy(sql`m.modification_date ${dirSql('desc')} nulls last`)
        .orderBy('m.modification_id', 'desc')
        .limit(limit + 1)
        .execute();
      return ok(toPage(rows, limit, fhash, sortKey, mapModification, (r) => [r.modification_date, r.modification_id]));
    } catch (error) {
      return err(databaseError('listModifications failed', error));
    }
  };

  const listModifications = (
    filter: FilterInput,
    page: CursorPageRequest
  ): Promise<Result<CursorPage<ProcurementModification>, ApiError>> => listModificationsInternal(filter, page);

  const listModificationsAboveDelta = (
    pct: number,
    filter: FilterInput,
    page: CursorPageRequest
  ): Promise<Result<CursorPage<ProcurementModification>, ApiError>> => {
    if (!Number.isFinite(pct)) return Promise.resolve(err(invalidInput('pct must be a number', 'pct')));
    return listModificationsInternal(filter, page, pct);
  };

  // ───────────────────────────────────────────────────────────────────────────
  // CPV discovery (cpv_divisions clean; cpv_codes best-effort label)
  // ───────────────────────────────────────────────────────────────────────────

  const listCpvDivisions = async (): Promise<Result<readonly CpvDivision[], ApiError>> => {
    try {
      const rows = await db
        .selectFrom('procurement.cpv_divisions as cd')
        .select(['cd.division_code', 'cd.label_en', 'cd.label_ro'])
        .orderBy('cd.division_code', 'asc')
        .execute();
      return ok(rows.map((r) => ({ code: r.division_code, labelEn: r.label_en, labelRo: r.label_ro })));
    } catch (error) {
      return err(databaseError('listCpvDivisions failed', error));
    }
  };

  const resolveCpv = async (q: string, limit: number): Promise<Result<readonly CpvMatch[], ApiError>> => {
    const lim = clamp(limit, 1, CPV_RESOLVE_MAX);
    const term = q.trim();
    if (term === '') return ok([]);
    const pattern = `%${term.replace(/[\\%_]/gu, (m) => `\\${m}`)}%`;
    try {
      // Divisions are the reliable hierarchy (cpv_codes labels are best-effort).
      const divs = await db
        .selectFrom('procurement.cpv_divisions as cd')
        .select(['cd.division_code', 'cd.label_en', 'cd.label_ro'])
        .where(sql<SqlBool>`cd.label_en ilike ${pattern} escape '\\' or cd.label_ro ilike ${pattern} escape '\\' or cd.division_code = ${term}`)
        .orderBy('cd.division_code', 'asc')
        .limit(lim)
        .execute();
      const divMatches: CpvMatch[] = divs.map((d) => ({
        code: d.division_code,
        label: d.label_ro ?? d.label_en,
        level: 'division',
        confidence: 0.9,
      }));
      if (divMatches.length >= lim) return ok(divMatches.slice(0, lim));
      // Best-effort 8-digit codes (flagged low-confidence; label_ro coverage is poor).
      const codes = await db
        .selectFrom('procurement.cpv_codes as cc')
        .select(['cc.cpv_code', 'cc.label_ro'])
        .where(sql<SqlBool>`cc.label_ro ilike ${pattern} escape '\\' or cc.cpv_code like ${`${term.replace(/[\\%_]/gu, (m) => `\\${m}`)}%`}`)
        .orderBy('cc.cpv_code', 'asc')
        .limit(lim - divMatches.length)
        .execute();
      const codeMatches: CpvMatch[] = codes.map((c) => ({
        code: c.cpv_code,
        label: c.label_ro,
        level: 'code',
        confidence: 0.4,
      }));
      return ok([...divMatches, ...codeMatches]);
    } catch (error) {
      return err(databaseError('resolveCpv failed', error));
    }
  };

  // ── helpers ────────────────────────────────────────────────────────────────

  /** Decode the cursor against the active fhash + the declared keyset sort. */
  function decodeCursorKeys(
    after: string | undefined,
    fhash: string,
    sortKey: string
  ): Result<readonly string[] | undefined, ApiError> {
    if (after === undefined) return ok(undefined);
    const decoded = decodeCursor(after, { sort: sortKey, dir: 'desc', fhash });
    return decoded.isErr() ? err(decoded.error) : ok(decoded.value.keys);
  }

  /** Build a CursorPage from limit+1 rows + a per-row keyset extractor. */
  function toPage<Row, Out>(
    rows: readonly Row[],
    limit: number,
    fhash: string,
    sortKey: string,
    map: (r: Row) => Out,
    keysOf: (r: Row) => readonly (string | null)[]
  ): CursorPage<Out> {
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const items = pageRows.map(map);
    let next: string | null = null;
    if (hasMore) {
      const last = pageRows[pageRows.length - 1];
      if (last !== undefined) {
        next = buildNextCursor({ sort: sortKey, dir: 'desc', fhash, lastKeys: keysOf(last) });
      }
    }
    return { items, next };
  }

  return {
    listProcedures,
    getProcedure,
    getProcedureDetail,
    listContracts,
    getContract,
    getContractDetail,
    getContractModifications,
    listDirectAcquisitions,
    getDirectAcquisition,
    listModifications,
    listModificationsAboveDelta,
    listCpvDivisions,
    resolveCpv,
  };
};
