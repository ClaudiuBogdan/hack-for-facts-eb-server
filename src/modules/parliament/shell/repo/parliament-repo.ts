/**
 * Parliament module — repository over the live `parliament.*` schema (plan 04 §3).
 * The ONLY place that reads `parliament.*`. Reads through the kernel's typed
 * Kysely instance (`Kysely<ProdDatabase>` augmented by `shell/db/schema.ts`).
 *
 * BINDING CONTRACTS:
 *  - **vote_records is NEVER scanned unparented** (§3.1): every read is bounded by
 *    `vote_key` (PK prefix) or `mandate_key` (vote_records_mandate_idx).
 *  - **dates emit `::text`** (`YYYY-MM-DD`) — pg returns Date objects otherwise.
 *  - **bigint identity cols → strings** (`::text` at the SQL boundary).
 *  - **C-locale name search** folds diacritics in TS (`foldDiacritics`); the
 *    repo never calls `unaccent()` (not installed).
 *  - **privacy** (§2.6): PII/provenance columns are not selected (the schema type
 *    omits them); `attrs` is whitelisted by the mappers.
 *  - **child cursors are parent-bound**: the ballots / member-votes cursor `fhash`
 *    is derived from the parent key INSIDE the repo (Codex #2), so a cursor cannot
 *    be replayed against a different vote/member.
 */

import { sql, type Kysely, type RawBuilder, type SqlBool } from 'kysely';
import { err, ok, type Result } from 'neverthrow';

import {
  buildNextCursor,
  databaseError,
  decodeCursor,
  fhashFor,
  filterHash,
  invalidInput,
  toConditionBuilders,
  type ApiError,
  type CursorPage,
  type CursorPageRequest,
  type FilterInput,
  type OffsetParams,
  offsetFor,
} from '@/modules/shared/index.js';
import { foldDiacritics } from '@/modules/shared/shell/repo/fold.js';

import {
  mapBill,
  mapBillDocument,
  mapBillEvent,
  mapControlItem,
  mapDeclaration,
  mapGroupInterval,
  mapInitiative,
  mapMember,
  mapPerson,
  mapSpeech,
  mapVote,
  type BillRow,
  type ControlItemRow,
  type MemberRow,
  type PersonRow,
  type VoteRow,
} from './mappers.js';
import { COHESION_VOTE_CAP,
  type ParliamentBallot,
  type ParliamentBill,
  type ParliamentBillActLink,
  type ParliamentBillInitiator,
  type ParliamentBillVoteLink,
  type ParliamentControlItem,
  type ParliamentDeclarationMeta,
  type ParliamentGroup,
  type ParliamentGroupCohesion,
  type ParliamentGroupInterval,
  type ParliamentInitiative,
  type ParliamentMember,
  type ParliamentMemberVote,
  type ParliamentPerson,
  type ParliamentPersonCandidate,
  type ParliamentSpeech,
  type ParliamentVote,
  type ParliamentVoteGroupBreakdown } from '../../core/types.js';
import {
  billsFilterSpec,
  controlItemsFilterSpec,
  membersFilterSpec,
  votesFilterSpec,
} from '../filters/specs.js';


import type {
  BallotResolution,
  LineageVoteRow,
  OffsetResult,
  ParliamentControlSummaryCount,
  ParliamentRepo,
} from '../../core/ports.js';

type Db = Kysely<import('@/modules/shared/index.js').ProdDatabase>;

const LIST_TOTAL_CAP = 10_000;
/** C-locale diacritic fold for SQL translate() — mirrors kernel `foldDiacritics`. */
const FOLD_FROM = 'ăâîșşțţĂÂÎȘŞȚŢ';
const FOLD_TO = 'aaissttaaisstt';

const composeWhere = (conds: readonly RawBuilder<unknown>[]): RawBuilder<SqlBool> =>
  conds.length === 0 ? sql<SqlBool>`true` : sql<SqlBool>`${sql.join(conds, sql` and `)}`;

const escapeLike = (s: string): string => s.replace(/[\\%_]/gu, (m) => `\\${m}`);

/**
 * Validate a decoded cursor's key tuple BEFORE trusting it in SQL (Codex BLOCKER
 * #2). `decodeCursor` only checks the envelope/fhash, so a client that flips
 * `keys` (wrong arity, a non-numeric integer key) would otherwise reach the query
 * and produce silent-empty/duplicate pages or a DB error. We reject with a clean
 * InvalidInput "restart pagination" instead.
 */
const requireCursorKeys = (
  keys: readonly string[],
  arity: number,
  numericIdx: readonly number[] = []
): Result<readonly string[], ApiError> => {
  if (keys.length !== arity) return err(invalidInput('malformed cursor; restart pagination', 'cursor'));
  for (const i of numericIdx) {
    if (!Number.isInteger(Number(keys[i]))) {
      return err(invalidInput('malformed cursor; restart pagination', 'cursor'));
    }
  }
  return ok(keys);
};

/** Field selectors reused across queries (dates `::text`, bigint `::text`). */
const MEMBER_SELECT = [
  'm.mandate_key',
  'm.chamber',
  'm.legislature',
  'm.full_name',
  'm.normalized_name',
  'm.group_name',
  'm.group_id',
  'm.constituency_name',
  sql<string | null>`m.birth_date::text`.as('birth_date'),
  sql<string | null>`m.person_id::text`.as('person_id'),
  'm.attrs',
] as const;

const VOTE_SELECT = [
  'v.vote_key',
  'v.chamber',
  sql<string | null>`v.vote_date::text`.as('vote_date'),
  'v.title',
  'v.pentru',
  'v.impotriva',
  'v.abtinere',
  'v.nu_a_votat',
  'v.present',
  'v.outcome',
  'v.division_number',
  'v.bill_key',
  'v.law_reference',
  'v.attrs',
] as const;

const BILL_SELECT = [
  'b.bill_key',
  'b.plx_number',
  'b.plx_year',
  'b.senate_number',
  'b.senate_year',
  'b.title',
  'b.final_law_number',
  'b.final_law_year',
  // Source-stored classification extracted flat from attrs (Gap 2): the real
  // status string + initiative type the client previously derived from title.
  sql<string | null>`b.attrs->>'status_text'`.as('status_text'),
  sql<string | null>`b.attrs#>>'{procedure,tip_initiativa}'`.as('bill_type'),
  'b.attrs',
  sql<string | null>`b.source_updated_at::text`.as('source_updated_at'),
  sql<string | null>`b.updated_at::text`.as('updated_at'),
] as const;

// ── filter helpers (split virtual / physical) ────────────────────────────────

const fieldFilter = (input: FilterInput, name: string): Record<string, unknown> | undefined => {
  const v = input[name];
  return typeof v === 'object' && !Array.isArray(v) ? v : undefined;
};

/** Pull eq/in string value(s) from a field filter. */
const stringValues = (f: Record<string, unknown> | undefined): { eq?: string; in?: string[] } => {
  if (f === undefined) return {};
  const out: { eq?: string; in?: string[] } = {};
  if (typeof f['eq'] === 'string') out.eq = f['eq'];
  if (Array.isArray(f['in'])) out.in = (f['in'] as unknown[]).filter((x): x is string => typeof x === 'string');
  return out;
};

const containsValue = (f: Record<string, unknown> | undefined): string | undefined => {
  if (f === undefined) return undefined;
  return typeof f['contains'] === 'string' ? f['contains'] : undefined;
};

export const makeParliamentRepo = (db: Db): ParliamentRepo => {
  // ── members / groups / persons ──────────────────────────────────────────────
  const latestLegislature = async (): Promise<Result<string | null, ApiError>> => {
    try {
      const row = await db
        .selectFrom('parliament.members')
        .select(sql<string | null>`max(legislature)`.as('leg'))
        .executeTakeFirst();
      return ok(row?.leg ?? null);
    } catch (e) {
      return err(databaseError('latestLegislature failed', e));
    }
  };

  /** Build the members WHERE: physical (legislature/chamber) + virtual (group/judet/q). */
  const buildMemberConditions = (filter: FilterInput): Result<RawBuilder<unknown>[], ApiError> => {
    const physical: Record<string, unknown> = {};
    for (const key of ['legislature', 'chamber'] as const) {
      if (filter[key] !== undefined) physical[key] = filter[key];
    }
    const built = toConditionBuilders(membersFilterSpec, physical as FilterInput);
    if (built.isErr()) return err(built.error);
    const conds: RawBuilder<unknown>[] = [...built.value];

    const group = stringValues(fieldFilter(filter, 'group'));
    const groupVals = [...(group.eq !== undefined ? [group.eq] : []), ...(group.in ?? [])];
    if (groupVals.length > 0) {
      conds.push(sql`m.group_name in (${sql.join(groupVals.map((g) => sql`${g}`), sql`, `)})`);
    }

    const judet = stringValues(fieldFilter(filter, 'judet'));
    const judetVals = [...(judet.eq !== undefined ? [judet.eq] : []), ...(judet.in ?? [])].map((v) => foldDiacritics(v));
    if (judetVals.length > 0) {
      const foldedCol = sql`lower(translate(m.constituency_name, ${FOLD_FROM}, ${FOLD_TO}))`;
      conds.push(sql`${foldedCol} in (${sql.join(judetVals.map((v) => sql`${v}`), sql`, `)})`);
    }

    const q = containsValue(fieldFilter(filter, 'q'));
    if (q !== undefined && q.trim() !== '') {
      const needle = '%' + escapeLike(foldDiacritics(q)) + '%';
      conds.push(
        sql`lower(translate(coalesce(m.full_name, ''), ${FOLD_FROM}, ${FOLD_TO})) like ${needle} escape '\\'`
      );
    }
    return ok(conds);
  };

  const listMembers = async (
    filter: FilterInput,
    sort: string,
    page: OffsetParams
  ): Promise<Result<OffsetResult<ParliamentMember>, ApiError>> => {
    const condsRes = buildMemberConditions(filter);
    if (condsRes.isErr()) return err(condsRes.error);
    const where = composeWhere(condsRes.value);
    const orderBy = sort === 'mandateKey'
      ? sql`m.mandate_key asc`
      : sql`m.full_name asc nulls last, m.mandate_key asc`;
    try {
      const rows = await db
        .selectFrom('parliament.members as m')
        .select(MEMBER_SELECT)
        .where(where)
        .orderBy(orderBy)
        .limit(page.pageSize)
        .offset(offsetFor(page))
        .execute();
      const countRow = await db
        .selectFrom('parliament.members as m')
        .select(sql<string>`count(*)`.as('cnt'))
        .where(where)
        .executeTakeFirst();
      const total = Number(countRow?.cnt ?? 0);
      return ok({ rows: rows.map((r) => mapMember(r as MemberRow)), total, estimated: false });
    } catch (e) {
      return err(databaseError('listMembers failed', e));
    }
  };

  const findMember = async (mandateKey: string): Promise<Result<ParliamentMember | null, ApiError>> => {
    try {
      const row = await db
        .selectFrom('parliament.members as m')
        .select(MEMBER_SELECT)
        .where('m.mandate_key', '=', mandateKey)
        .limit(1)
        .executeTakeFirst();
      return ok(row === undefined ? null : mapMember(row as MemberRow));
    } catch (e) {
      return err(databaseError('findMember failed', e));
    }
  };

  const listGroupCounts = async (
    legislature: string,
    chamber?: string
  ): Promise<Result<readonly ParliamentGroup[], ApiError>> => {
    try {
      if (chamber !== undefined) {
        // Chamber-scoped: per-chamber group rows (groupId = slug(name)-<chamber>).
        const rows = await db
          .selectFrom('parliament.members as m')
          .select([
            'm.group_id as group_id',
            'm.group_name as name',
            'm.chamber as chamber',
            sql<string>`count(*)`.as('cnt'),
          ])
          .where('m.legislature', '=', legislature)
          .where('m.chamber', '=', chamber)
          .where('m.group_name', 'is not', null)
          .groupBy(['m.group_id', 'm.group_name', 'm.chamber'])
          .orderBy(sql`count(*) desc`)
          .execute();
        return ok(
          rows.map((r) => ({
            groupId: r.group_id ?? '(none)',
            chamber: r.chamber ?? '',
            name: r.name ?? '(none)',
            memberCount: Number(r.cnt),
          }))
        );
      }
      // Whole-parliament: aggregate the party ACROSS chambers (PSD = camera+senat),
      // so "how big is PSD this legislature" returns the party total, not a split.
      const rows = await db
        .selectFrom('parliament.members as m')
        .select(['m.group_name as name', sql<string>`count(*)`.as('cnt')])
        .where('m.legislature', '=', legislature)
        .where('m.group_name', 'is not', null)
        .groupBy('m.group_name')
        .orderBy(sql`count(*) desc`)
        .execute();
      return ok(
        rows.map((r) => ({
          // groupId is the chamber-agnostic party slug at parliament scope.
          groupId: r.name ?? '(none)',
          chamber: '',
          name: r.name ?? '(none)',
          memberCount: Number(r.cnt),
        }))
      );
    } catch (e) {
      return err(databaseError('listGroupCounts failed', e));
    }
  };

  const listGroupMembers = async (
    groupId: string,
    legislature?: string
  ): Promise<Result<readonly ParliamentMember[], ApiError>> => {
    try {
      // The groupId handed in is EITHER a per-chamber `m.group_id` slug
      // (`aur-senat`, from the chamber-scoped parliamentGroups list) OR a
      // party-level `m.group_name` ("AUR", from the whole-parliament list whose
      // groupId is the chamber-agnostic party name). Match either: group_id and
      // group_name values NEVER collide (verified across all legislatures — 0
      // overlaps), so the OR is unambiguous — a party-level id resolves to its
      // full cross-chamber roster (the bug fix) while a slug stays exact.
      let qb = db
        .selectFrom('parliament.members as m')
        .select(MEMBER_SELECT)
        .where((eb) => eb.or([eb('m.group_id', '=', groupId), eb('m.group_name', '=', groupId)]));
      if (legislature !== undefined) qb = qb.where('m.legislature', '=', legislature);
      const rows = await qb.orderBy(sql`m.full_name asc nulls last`).limit(1000).execute();
      return ok(rows.map((r) => mapMember(r as MemberRow)));
    } catch (e) {
      return err(databaseError('listGroupMembers failed', e));
    }
  };

  const PERSON_SELECT = [
    sql<string>`p.person_id::text`.as('person_id'),
    'p.canonical_name',
    'p.normalized_name',
    sql<string | null>`p.birth_date::text`.as('birth_date'),
    'p.confidence',
  ] as const;

  const findPerson = async (personId: string): Promise<Result<ParliamentPerson | null, ApiError>> => {
    try {
      const row = await db
        .selectFrom('parliament.persons as p')
        .select(PERSON_SELECT)
        .where(sql`p.person_id`, '=', personId)
        .limit(1)
        .executeTakeFirst();
      return ok(row === undefined ? null : mapPerson(row as PersonRow));
    } catch (e) {
      return err(databaseError('findPerson failed', e));
    }
  };

  const listPersonMandates = async (personId: string): Promise<Result<readonly ParliamentMember[], ApiError>> => {
    try {
      const rows = await db
        .selectFrom('parliament.members as m')
        .select(MEMBER_SELECT)
        .where(sql`m.person_id`, '=', personId)
        .orderBy('m.legislature', 'desc')
        .execute();
      return ok(rows.map((r) => mapMember(r as MemberRow)));
    } catch (e) {
      return err(databaseError('listPersonMandates failed', e));
    }
  };

  const GROUP_INTERVAL_SELECT = [
    'gi.mandate_key',
    'gi.group_id',
    sql<string>`gi.valid_from::text`.as('valid_from'),
    sql<string | null>`gi.valid_to::text`.as('valid_to'),
    'gi.source',
    'gi.vote_count',
  ] as const;

  const listGroupIntervals = async (mandateKey: string): Promise<Result<readonly ParliamentGroupInterval[], ApiError>> => {
    try {
      const rows = await db
        .selectFrom('parliament.group_membership_intervals as gi')
        .select(GROUP_INTERVAL_SELECT)
        .where('gi.mandate_key', '=', mandateKey)
        .orderBy('gi.valid_from', 'asc')
        .execute();
      return ok(rows.map(mapGroupInterval));
    } catch (e) {
      return err(databaseError('listGroupIntervals failed', e));
    }
  };

  const listGroupIntervalsForPerson = async (
    personId: string
  ): Promise<Result<readonly ParliamentGroupInterval[], ApiError>> => {
    try {
      const rows = await db
        .selectFrom('parliament.group_membership_intervals as gi')
        .innerJoin('parliament.members as m', 'm.mandate_key', 'gi.mandate_key')
        .select(GROUP_INTERVAL_SELECT)
        .where(sql`m.person_id`, '=', personId)
        .orderBy('gi.valid_from', 'asc')
        .execute();
      return ok(rows.map(mapGroupInterval));
    } catch (e) {
      return err(databaseError('listGroupIntervalsForPerson failed', e));
    }
  };

  const searchPersonsByName = async (
    qNorm: string,
    limit: number
  ): Promise<Result<readonly ParliamentPerson[], ApiError>> => {
    const capped = Math.min(Math.max(Math.floor(limit), 1), 50);
    const folded = qNorm.trim();
    if (folded === '') return ok([]);
    try {
      const needle = '%' + escapeLike(folded) + '%';
      // persons.normalized_name is pre-folded by the loader (§13-R1) → match the
      // stored folded form directly (no unaccent, no SQL fold needed).
      const rows = await db
        .selectFrom('parliament.persons as p')
        .select(PERSON_SELECT)
        .where(sql<boolean>`p.normalized_name like ${needle} escape '\\'`)
        .orderBy('p.canonical_name', 'asc')
        .limit(capped)
        .execute();
      return ok(rows.map((r) => mapPerson(r as PersonRow)));
    } catch (e) {
      return err(databaseError('searchPersonsByName failed', e));
    }
  };

  const resolveGroups = async (
    qFolded: string,
    legislature: string | null,
    limit: number
  ): Promise<Result<readonly { value: string; label: string }[], ApiError>> => {
    const capped = Math.min(Math.max(Math.floor(limit), 1), 50);
    try {
      let qb = db
        .selectFrom('parliament.members as m')
        .select(['m.group_name'])
        .where('m.group_name', 'is not', null);
      if (legislature !== null) qb = qb.where('m.legislature', '=', legislature);
      if (qFolded.trim() !== '') {
        const needle = '%' + escapeLike(qFolded) + '%';
        qb = qb.where(
          sql<boolean>`lower(translate(m.group_name, ${FOLD_FROM}, ${FOLD_TO})) like ${needle} escape '\\'`
        );
      }
      const rows = await qb.groupBy('m.group_name').orderBy('m.group_name', 'asc').limit(capped).execute();
      return ok(
        rows
          .filter((r): r is { group_name: string } => r.group_name !== null)
          .map((r) => ({ value: r.group_name, label: r.group_name }))
      );
    } catch (e) {
      return err(databaseError('resolveGroups failed', e));
    }
  };

  const resolveConstituencies = async (qFolded: string, limit: number): Promise<Result<readonly string[], ApiError>> => {
    const capped = Math.min(Math.max(Math.floor(limit), 1), 50);
    try {
      let qb = db
        .selectFrom('parliament.members as m')
        .select(['m.constituency_name'])
        .where('m.constituency_name', 'is not', null);
      if (qFolded.trim() !== '') {
        const needle = '%' + escapeLike(qFolded) + '%';
        qb = qb.where(
          sql<boolean>`lower(translate(m.constituency_name, ${FOLD_FROM}, ${FOLD_TO})) like ${needle} escape '\\'`
        );
      }
      const rows = await qb.groupBy('m.constituency_name').orderBy('m.constituency_name', 'asc').limit(capped).execute();
      return ok(rows.map((r) => r.constituency_name).filter((c): c is string => c !== null));
    } catch (e) {
      return err(databaseError('resolveConstituencies failed', e));
    }
  };

  const resolveRecipients = async (qFolded: string, limit: number): Promise<Result<readonly string[], ApiError>> => {
    const capped = Math.min(Math.max(Math.floor(limit), 1), 50);
    if (qFolded.trim() === '') return ok([]);
    try {
      const needle = '%' + escapeLike(qFolded) + '%';
      const rows = await db
        .selectFrom('parliament.control_items as c')
        .select(['c.recipient'])
        .where('c.recipient', 'is not', null)
        .where(sql<boolean>`lower(translate(c.recipient, ${FOLD_FROM}, ${FOLD_TO})) like ${needle} escape '\\'`)
        .groupBy('c.recipient')
        .orderBy(sql`count(*) desc`)
        .limit(capped)
        .execute();
      return ok(rows.map((r) => r.recipient).filter((c): c is string => c !== null));
    } catch (e) {
      return err(databaseError('resolveRecipients failed', e));
    }
  };

  // ── bills ─────────────────────────────────────────────────────────────────────
  const buildBillConditions = (filter: FilterInput): Result<RawBuilder<unknown>[], ApiError> => {
    const physical: Record<string, unknown> = {};
    if (filter['finalized'] !== undefined) physical['finalized'] = filter['finalized'];
    const built = toConditionBuilders(billsFilterSpec, physical as FilterInput);
    if (built.isErr()) return err(built.error);
    const conds: RawBuilder<unknown>[] = [...built.value];

    // year (virtual): plx_year OR senate_year (Codex SHOULD-FIX — `coalesce` drops
    // a Senate-only year when plx_year is also present-but-different). Each op is
    // applied to BOTH columns under an OR so a bill matching on either year is kept.
    const year = fieldFilter(filter, 'year');
    if (year !== undefined) {
      const yOr = (op: RawBuilder<unknown>, val: number): RawBuilder<unknown> =>
        sql`(b.plx_year ${op} ${val} or b.senate_year ${op} ${val})`;
      if (typeof year['eq'] === 'number') conds.push(yOr(sql`=`, year['eq']));
      if (typeof year['gte'] === 'number') conds.push(yOr(sql`>=`, year['gte']));
      if (typeof year['lte'] === 'number') conds.push(yOr(sql`<=`, year['lte']));
    }

    // hasLaw (virtual): EXISTS a linked bill_act_links row.
    const hasLaw = fieldFilter(filter, 'hasLaw');
    if (hasLaw !== undefined && typeof hasLaw['eq'] === 'boolean') {
      const exists = sql`exists (select 1 from parliament.bill_act_links bal where bal.bill_key = b.bill_key and bal.resolution_status = 'linked')`;
      conds.push(hasLaw['eq'] ? exists : sql`not (${exists})`);
    }

    // actId (virtual): reverse lineage — bills that became act X. Validate numeric
    // BEFORE the ::bigint cast (a non-numeric id would surface as a DB 500 — #SF).
    const actId = stringValues(fieldFilter(filter, 'actId'));
    if (actId.eq !== undefined) {
      if (!/^\d+$/u.test(actId.eq)) return err(invalidInput('actId must be a numeric act_id', 'actId'));
      conds.push(
        sql`exists (select 1 from parliament.bill_act_links bal where bal.bill_key = b.bill_key and bal.target_act_id = ${actId.eq}::bigint)`
      );
    }

    // q (virtual): title / plx-number / senate-number ILIKE (diacritic-folded title).
    const q = containsValue(fieldFilter(filter, 'q'));
    if (q !== undefined && q.trim() !== '') {
      const folded = '%' + escapeLike(foldDiacritics(q)) + '%';
      const raw = '%' + escapeLike(q) + '%';
      conds.push(
        sql`(lower(translate(coalesce(b.title, ''), ${FOLD_FROM}, ${FOLD_TO})) like ${folded} escape '\\'
             or coalesce(b.plx_number, '') like ${raw} escape '\\'
             or coalesce(b.senate_number, '') like ${raw} escape '\\')`
      );
    }
    return ok(conds);
  };

  const billOrderBy = (sort: string): RawBuilder<unknown> => {
    // last_event_date lives in attrs; NULLS LAST. Title sorts are direct.
    const lastEvent = sql`(b.attrs->>'last_event_date')`;
    switch (sort) {
      case 'updated_asc':
        return sql`${lastEvent} asc nulls last, b.bill_key asc`;
      case 'title_asc':
        return sql`b.title asc nulls last, b.bill_key asc`;
      case 'title_desc':
        return sql`b.title desc nulls last, b.bill_key asc`;
      case 'updated_desc':
      default:
        return sql`${lastEvent} desc nulls last, b.bill_key asc`;
    }
  };

  const listBills = async (
    filter: FilterInput,
    sort: string,
    page: OffsetParams
  ): Promise<Result<OffsetResult<ParliamentBill>, ApiError>> => {
    const condsRes = buildBillConditions(filter);
    if (condsRes.isErr()) return err(condsRes.error);
    const where = composeWhere(condsRes.value);
    try {
      const rows = await db
        .selectFrom('parliament.bills as b')
        .select(BILL_SELECT)
        .where(where)
        .orderBy(billOrderBy(sort))
        .limit(page.pageSize)
        .offset(offsetFor(page))
        .execute();
      // bills is ~10k — a direct count is cheap; cap defensively.
      const countRow = await db
        .selectFrom(
          db.selectFrom('parliament.bills as b').select(sql<number>`1`.as('one')).where(where).limit(LIST_TOTAL_CAP + 1).as('capped')
        )
        .select(sql<string>`count(*)`.as('cnt'))
        .executeTakeFirst();
      const rawCount = Number(countRow?.cnt ?? 0);
      const estimated = rawCount > LIST_TOTAL_CAP;
      return ok({ rows: rows.map((r) => mapBill(r as BillRow)), total: estimated ? LIST_TOTAL_CAP : rawCount, estimated });
    } catch (e) {
      return err(databaseError('listBills failed', e));
    }
  };

  const findBill = async (billKey: string): Promise<Result<ParliamentBill | null, ApiError>> => {
    try {
      const row = await db
        .selectFrom('parliament.bills as b')
        .select(BILL_SELECT)
        .where('b.bill_key', '=', billKey)
        .limit(1)
        .executeTakeFirst();
      return ok(row === undefined ? null : mapBill(row as BillRow));
    } catch (e) {
      return err(databaseError('findBill failed', e));
    }
  };

  const getBillEvents = async (billKey: string) => {
    try {
      const rows = await db
        .selectFrom('parliament.bill_events as e')
        .select([
          'e.position',
          sql<string | null>`e.event_date::text`.as('event_date'),
          'e.event_date_text',
          'e.description',
          'e.chamber_code',
          'e.committee',
          'e.vote_idv',
          'e.docs',
        ])
        .where('e.bill_key', '=', billKey)
        .orderBy('e.position', 'asc')
        .execute();
      return ok(rows.map(mapBillEvent));
    } catch (e) {
      return err(databaseError('getBillEvents failed', e));
    }
  };

  const getBillDocuments = async (billKey: string) => {
    try {
      const rows = await db
        .selectFrom('parliament.bill_documents as d')
        .select(['d.url', 'd.label', 'd.kind', 'd.position'])
        .where('d.bill_key', '=', billKey)
        .orderBy('d.position', 'asc')
        .execute();
      return ok(rows.map(mapBillDocument));
    } catch (e) {
      return err(databaseError('getBillDocuments failed', e));
    }
  };

  const getBillInitiators = async (billKey: string): Promise<Result<readonly ParliamentBillInitiator[], ApiError>> => {
    try {
      const rows = await db
        .selectFrom('parliament.member_initiatives as mi')
        .innerJoin('parliament.members as m', 'm.mandate_key', 'mi.mandate_key')
        .select([
          'm.mandate_key',
          'm.full_name',
          'm.group_name',
          'm.chamber',
          sql<string | null>`m.person_id::text`.as('person_id'),
        ])
        .where('mi.bill_key', '=', billKey)
        .orderBy('m.full_name', 'asc')
        .limit(500)
        .execute();
      return ok(
        rows.map((r) => ({
          mandateKey: r.mandate_key,
          fullName: r.full_name,
          groupName: r.group_name,
          chamber: r.chamber,
          personId: r.person_id,
        }))
      );
    } catch (e) {
      return err(databaseError('getBillInitiators failed', e));
    }
  };

  const mapActLink = (r: {
    relationship_kind: string;
    target_act_id: string | null;
    target_act_type: string | null;
    target_act_number: string | null;
    target_act_year: number | null;
    resolution_status: string;
    confidence_label: string | null;
    primary_method: string | null;
  }): ParliamentBillActLink => ({
    relationshipKind: r.relationship_kind,
    targetActId: r.target_act_id,
    targetActType: r.target_act_type,
    targetActNumber: r.target_act_number,
    targetActYear: r.target_act_year,
    resolutionStatus: r.resolution_status,
    confidenceLabel: r.confidence_label ?? 'none',
    primaryMethod: r.primary_method ?? 'unknown',
  });

  const getBillActLinks = async (billKey: string): Promise<Result<readonly ParliamentBillActLink[], ApiError>> => {
    try {
      const rows = await db
        .selectFrom('parliament.bill_act_links as bal')
        .select([
          'bal.relationship_kind',
          sql<string | null>`bal.target_act_id::text`.as('target_act_id'),
          'bal.target_act_type',
          'bal.target_act_number',
          'bal.target_act_year',
          'bal.resolution_status',
          'bal.confidence_label',
          'bal.primary_method',
        ])
        .where('bal.bill_key', '=', billKey)
        .execute();
      return ok(rows.map(mapActLink));
    } catch (e) {
      return err(databaseError('getBillActLinks failed', e));
    }
  };

  const getBillVoteLinks = async (billKey: string): Promise<Result<readonly ParliamentBillVoteLink[], ApiError>> => {
    try {
      const rows = await db
        .selectFrom('parliament.bill_vote_links as bvl')
        .select(['bvl.vote_key', 'bvl.bill_key', 'bvl.role', 'bvl.resolution_status', 'bvl.confidence_label'])
        .where('bvl.bill_key', '=', billKey)
        .execute();
      return ok(
        rows.map((r) => ({
          voteKey: r.vote_key,
          billKey: r.bill_key,
          role: r.role,
          resolutionStatus: r.resolution_status,
          confidenceLabel: r.confidence_label ?? 'none',
        }))
      );
    } catch (e) {
      return err(databaseError('getBillVoteLinks failed', e));
    }
  };

  // ── votes / records ───────────────────────────────────────────────────────────
  const buildVoteConditions = (filter: FilterInput): Result<RawBuilder<unknown>[], ApiError> => {
    const physical: Record<string, unknown> = {};
    for (const key of ['chamber', 'outcome', 'voteDate', 'billKey'] as const) {
      if (filter[key] !== undefined) physical[key] = filter[key];
    }
    const built = toConditionBuilders(votesFilterSpec, physical as FilterInput);
    if (built.isErr()) return err(built.error);
    const conds: RawBuilder<unknown>[] = [...built.value];

    const q = containsValue(fieldFilter(filter, 'q'));
    if (q !== undefined && q.trim() !== '') {
      const folded = '%' + escapeLike(foldDiacritics(q)) + '%';
      conds.push(
        sql`(lower(translate(coalesce(v.title, ''), ${FOLD_FROM}, ${FOLD_TO})) like ${folded} escape '\\'
             or lower(translate(coalesce(v.attrs->>'source_title', ''), ${FOLD_FROM}, ${FOLD_TO})) like ${folded} escape '\\')`
      );
    }
    return ok(conds);
  };

  const listVotes = async (
    filter: FilterInput,
    sort: string,
    dir: 'asc' | 'desc',
    page: CursorPageRequest
  ): Promise<Result<CursorPage<ParliamentVote>, ApiError>> => {
    const condsRes = buildVoteConditions(filter);
    if (condsRes.isErr()) return err(condsRes.error);
    const conds = condsRes.value;
    const fhash = fhashFor(votesFilterSpec, filter);
    const limit = Math.min(Math.max(page.first, 1), 100);

    // Keyset on (vote_date, vote_key). The ORDER BY and the keyset predicate MUST
    // use the IDENTICAL sort expression or pagination skips/duplicates rows at the
    // NULL-date boundary. We coalesce NULL date → '' in BOTH: on a DESC sort '' is
    // the minimum, so NULL-date votes sort LAST (== `NULLS LAST`); on ASC they sort
    // FIRST (== `NULLS FIRST`). `vote_date::text` is YYYY-MM-DD → lexical == chrono.
    const dateKey = sql`coalesce(v.vote_date::text, '')`;
    const cmp = dir === 'desc' ? sql`<` : sql`>`;
    const byKeyOnly = sort === 'voteKey';
    if (page.after !== undefined) {
      const dec = decodeCursor(page.after, { sort, dir, fhash });
      if (dec.isErr()) return err(dec.error);
      if (byKeyOnly) {
        const keys = requireCursorKeys(dec.value.keys, 1);
        if (keys.isErr()) return err(keys.error);
        conds.push(sql`v.vote_key ${cmp} ${keys.value[0] ?? ''}`);
      } else {
        const keys = requireCursorKeys(dec.value.keys, 2);
        if (keys.isErr()) return err(keys.error);
        const [kDate, kKey] = keys.value;
        conds.push(sql`(${dateKey}, v.vote_key) ${cmp} (${kDate ?? ''}, ${kKey ?? ''})`);
      }
    }
    const where = composeWhere(conds);
    const dirSql = dir === 'desc' ? sql`desc` : sql`asc`;
    const order = byKeyOnly
      ? sql`v.vote_key ${dirSql}`
      : sql`${dateKey} ${dirSql}, v.vote_key ${dirSql}`;
    try {
      const rows = await db
        .selectFrom('parliament.votes as v')
        .select(VOTE_SELECT)
        .where(where)
        .orderBy(order)
        .limit(limit + 1)
        .execute();
      const hasMore = rows.length > limit;
      const sliced = hasMore ? rows.slice(0, limit) : rows;
      const items = sliced.map((r) => mapVote(r as VoteRow));
      const last = sliced[sliced.length - 1] as VoteRow | undefined;
      const next =
        hasMore && last !== undefined
          ? buildNextCursor({
              sort,
              dir,
              fhash,
              lastKeys: byKeyOnly ? [last.vote_key] : [last.vote_date ?? '', last.vote_key],
            })
          : null;
      return ok({ items, next });
    } catch (e) {
      return err(databaseError('listVotes failed', e));
    }
  };

  const findVote = async (voteKey: string): Promise<Result<ParliamentVote | null, ApiError>> => {
    try {
      const row = await db
        .selectFrom('parliament.votes as v')
        .select(VOTE_SELECT)
        .where('v.vote_key', '=', voteKey)
        .limit(1)
        .executeTakeFirst();
      return ok(row === undefined ? null : mapVote(row as VoteRow));
    } catch (e) {
      return err(databaseError('findVote failed', e));
    }
  };

  const listVotesForBill = async (billKey: string): Promise<Result<readonly ParliamentVote[], ApiError>> => {
    try {
      const rows = await db
        .selectFrom('parliament.votes as v')
        .select(VOTE_SELECT)
        .where('v.bill_key', '=', billKey)
        .orderBy('v.vote_date', 'asc')
        .limit(500)
        .execute();
      return ok(rows.map((r) => mapVote(r as VoteRow)));
    } catch (e) {
      return err(databaseError('listVotesForBill failed', e));
    }
  };

  // Parent-bound fhash: a ballots cursor is bound to its vote_key (Codex #2).
  const ballotFhash = (voteKey: string): string => filterHash(`ballots:${voteKey}`);
  const memberVoteFhash = (mandateKey: string): string => filterHash(`memberVotes:${mandateKey}`);

  const listVoteRecords = async (
    voteKey: string,
    page: CursorPageRequest
  ): Promise<Result<CursorPage<ParliamentBallot>, ApiError>> => {
    const limit = Math.min(Math.max(page.first, 1), 200);
    const fhash = ballotFhash(voteKey);
    const conds: RawBuilder<unknown>[] = [sql`vr.vote_key = ${voteKey}`];
    if (page.after !== undefined) {
      const dec = decodeCursor(page.after, { sort: 'rowIndex', dir: 'asc', fhash });
      if (dec.isErr()) return err(dec.error);
      const keys = requireCursorKeys(dec.value.keys, 1, [0]);
      if (keys.isErr()) return err(keys.error);
      conds.push(sql`vr.row_index > ${Number(keys.value[0])}`);
    }
    try {
      // LEFT JOIN members to surface the resolved member's constituency on each
      // ballot. Still parent-bound (vr.vote_key = voteKey → low hundreds of rows),
      // so the heavy-query rule holds — this is NOT an unparented vote_records scan.
      const rows = await db
        .selectFrom('parliament.vote_records as vr')
        .leftJoin('parliament.members as m', 'm.mandate_key', 'vr.mandate_key')
        .select([
          'vr.row_index',
          'vr.member_name',
          'vr.group_name',
          'vr.choice',
          'vr.mandate_key',
          'vr.match_method',
          'm.constituency_name',
        ])
        .where(composeWhere(conds))
        .orderBy('vr.row_index', 'asc')
        .limit(limit + 1)
        .execute();
      const hasMore = rows.length > limit;
      const sliced = hasMore ? rows.slice(0, limit) : rows;
      const items: ParliamentBallot[] = sliced.map((r) => ({
        rowIndex: r.row_index,
        memberName: r.member_name,
        groupName: r.group_name,
        choice: r.choice,
        mandateKey: r.mandate_key,
        matchMethod: r.match_method,
        constituencyName: r.constituency_name,
      }));
      const last = sliced[sliced.length - 1];
      const next =
        hasMore && last !== undefined
          ? buildNextCursor({ sort: 'rowIndex', dir: 'asc', fhash, lastKeys: [last.row_index] })
          : null;
      return ok({ items, next });
    } catch (e) {
      return err(databaseError('listVoteRecords failed', e));
    }
  };

  const voteGroupBreakdown = async (voteKey: string): Promise<Result<readonly ParliamentVoteGroupBreakdown[], ApiError>> => {
    try {
      const rows = await db
        .selectFrom('parliament.vote_records as vr')
        .select([
          'vr.group_name',
          sql<string>`count(*) filter (where vr.choice = 'pentru')`.as('pentru'),
          sql<string>`count(*) filter (where vr.choice = 'impotriva')`.as('impotriva'),
          sql<string>`count(*) filter (where vr.choice = 'abtinere')`.as('abtinere'),
          sql<string>`count(*) filter (where vr.choice = 'nu_a_votat')`.as('nu_a_votat'),
        ])
        .where('vr.vote_key', '=', voteKey)
        .groupBy('vr.group_name')
        .orderBy(sql`count(*) desc`)
        .execute();
      return ok(
        rows.map((r) => ({
          groupName: r.group_name,
          pentru: Number(r.pentru),
          impotriva: Number(r.impotriva),
          abtinere: Number(r.abtinere),
          nuAVotat: Number(r.nu_a_votat),
        }))
      );
    } catch (e) {
      return err(databaseError('voteGroupBreakdown failed', e));
    }
  };

  const ballotResolution = async (voteKey: string): Promise<Result<BallotResolution, ApiError>> => {
    try {
      const row = await db
        .selectFrom('parliament.vote_records as vr')
        .select([sql<string>`count(*)`.as('total'), sql<string>`count(vr.mandate_key)`.as('resolved')])
        .where('vr.vote_key', '=', voteKey)
        .executeTakeFirst();
      return ok({ total: Number(row?.total ?? 0), resolved: Number(row?.resolved ?? 0) });
    } catch (e) {
      return err(databaseError('ballotResolution failed', e));
    }
  };

  // ── member activity (parented by mandate_key) ─────────────────────────────────
  const listMemberVotes = async (
    mandateKey: string,
    page: CursorPageRequest
  ): Promise<Result<(CursorPage<ParliamentMemberVote> & { total: number }), ApiError>> => {
    const limit = Math.min(Math.max(page.first, 1), 100);
    const fhash = memberVoteFhash(mandateKey);
    // Materialize the member's bounded ballot set ⋈ votes; stable in-memory sort
    // (vote_date desc, vote_key desc, row_index) — the mandate index has no date.
    try {
      const rows = await db
        .selectFrom('parliament.vote_records as vr')
        .innerJoin('parliament.votes as v', 'v.vote_key', 'vr.vote_key')
        .select([
          'vr.vote_key',
          'vr.row_index',
          'vr.choice',
          'v.chamber',
          sql<string | null>`v.vote_date::text`.as('vote_date'),
          'v.title',
          'v.outcome',
          'v.bill_key',
        ])
        .where('vr.mandate_key', '=', mandateKey)
        .execute();
      const total = rows.length;
      const sorted = rows
        .map((r) => ({
          voteKey: r.vote_key,
          chamber: r.chamber,
          voteDate: r.vote_date,
          title: r.title,
          outcome: r.outcome,
          choice: r.choice,
          rowIndex: r.row_index,
          billKey: r.bill_key,
        }))
        .sort((a, b) => {
          const da = a.voteDate ?? '';
          const db2 = b.voteDate ?? '';
          if (da !== db2) return da < db2 ? 1 : -1; // date desc
          if (a.voteKey !== b.voteKey) return a.voteKey < b.voteKey ? 1 : -1; // key desc
          return a.rowIndex - b.rowIndex;
        });

      let startIdx = 0;
      if (page.after !== undefined) {
        const dec = decodeCursor(page.after, { sort: 'memberVote', dir: 'desc', fhash });
        if (dec.isErr()) return err(dec.error);
        const keys = requireCursorKeys(dec.value.keys, 3, [2]);
        if (keys.isErr()) return err(keys.error);
        const [kDate = '', kKey = '', kRow = '0'] = keys.value;
        startIdx = sorted.findIndex(
          (r) =>
            (r.voteDate ?? '') < kDate ||
            ((r.voteDate ?? '') === kDate && r.voteKey < kKey) ||
            ((r.voteDate ?? '') === kDate && r.voteKey === kKey && r.rowIndex > Number(kRow))
        );
        if (startIdx < 0) startIdx = sorted.length;
      }
      const slice = sorted.slice(startIdx, startIdx + limit);
      const last = slice[slice.length - 1];
      const hasMore = startIdx + limit < sorted.length;
      const next =
        hasMore && last !== undefined
          ? buildNextCursor({ sort: 'memberVote', dir: 'desc', fhash, lastKeys: [last.voteDate ?? '', last.voteKey, last.rowIndex] })
          : null;
      return ok({ items: slice, next, total });
    } catch (e) {
      return err(databaseError('listMemberVotes failed', e));
    }
  };

  const offsetActivity = async <T>(
    label: string,
    run: (where: OffsetParams) => Promise<{ rows: readonly T[]; total: number }>,
    page: OffsetParams
  ): Promise<Result<OffsetResult<T>, ApiError>> => {
    try {
      const { rows, total } = await run(page);
      return ok({ rows, total, estimated: false });
    } catch (e) {
      return err(databaseError(`${label} failed`, e));
    }
  };

  const listMemberControlItems = (mandateKey: string, page: OffsetParams) =>
    offsetActivity<ParliamentControlItem>(
      'listMemberControlItems',
      async (p) => {
        const rows = await db
          .selectFrom('parliament.control_items as c')
          .select([
            'c.item_key', 'c.control_type', 'c.control_type_provenance', 'c.title', 'c.recipient',
            sql<string | null>`c.item_date::text`.as('item_date'),
            'c.response_status', 'c.author_name', 'c.mandate_key',
          ])
          .where('c.mandate_key', '=', mandateKey)
          .orderBy('c.item_date', 'desc')
          .limit(p.pageSize)
          .offset(offsetFor(p))
          .execute();
        const cnt = await db
          .selectFrom('parliament.control_items as c')
          .select(sql<string>`count(*)`.as('cnt'))
          .where('c.mandate_key', '=', mandateKey)
          .executeTakeFirst();
        return { rows: rows.map((r) => mapControlItem(r)), total: Number(cnt?.cnt ?? 0) };
      },
      page
    );

  const listMemberSpeeches = (mandateKey: string, page: OffsetParams) =>
    offsetActivity<ParliamentSpeech>(
      'listMemberSpeeches',
      async (p) => {
        const rows = await db
          .selectFrom('parliament.speeches as s')
          .select([
            's.speech_key', 's.mandate_key', 's.speaker_name', 's.chamber',
            sql<string | null>`s.spoken_at::text`.as('spoken_at'), 's.title', 's.summary',
          ])
          .where('s.mandate_key', '=', mandateKey)
          .where('s.quarantined', '=', false) // §2.6 — quarantined excluded by default
          .orderBy('s.spoken_at', 'desc')
          .limit(p.pageSize)
          .offset(offsetFor(p))
          .execute();
        const cnt = await db
          .selectFrom('parliament.speeches as s')
          .select(sql<string>`count(*)`.as('cnt'))
          .where('s.mandate_key', '=', mandateKey)
          .where('s.quarantined', '=', false)
          .executeTakeFirst();
        return { rows: rows.map(mapSpeech), total: Number(cnt?.cnt ?? 0) };
      },
      page
    );

  const listMemberInitiatives = (mandateKey: string, page: OffsetParams) =>
    offsetActivity<ParliamentInitiative>(
      'listMemberInitiatives',
      async (p) => {
        const rows = await db
          .selectFrom('parliament.member_initiatives as mi')
          .select([
            'mi.initiative_key', 'mi.mandate_key', 'mi.bill_key', 'mi.title', 'mi.status',
            'mi.promulgated_law_number', 'mi.promulgated_law_year',
          ])
          .where('mi.mandate_key', '=', mandateKey)
          .orderBy('mi.initiative_key', 'asc')
          .limit(p.pageSize)
          .offset(offsetFor(p))
          .execute();
        const cnt = await db
          .selectFrom('parliament.member_initiatives as mi')
          .select(sql<string>`count(*)`.as('cnt'))
          .where('mi.mandate_key', '=', mandateKey)
          .executeTakeFirst();
        return { rows: rows.map(mapInitiative), total: Number(cnt?.cnt ?? 0) };
      },
      page
    );

  const listMemberDeclarations = async (mandateKey: string): Promise<Result<readonly ParliamentDeclarationMeta[], ApiError>> => {
    try {
      const rows = await db
        .selectFrom('parliament.member_declarations as d')
        .select(['d.declaration_type', sql<string | null>`d.declaration_date::text`.as('declaration_date'), 'd.label', 'd.file_url'])
        .where('d.mandate_key', '=', mandateKey)
        .orderBy('d.declaration_date', 'desc')
        .execute();
      return ok(rows.map(mapDeclaration));
    } catch (e) {
      return err(databaseError('listMemberDeclarations failed', e));
    }
  };

  // ── standalone control-items list (cursor; bounded — §3.2) ─────────────────────
  const buildControlConditions = (filter: FilterInput): { conds: RawBuilder<unknown>[]; error?: ApiError } => {
    const physical: Record<string, unknown> = {};
    for (const key of ['controlType', 'responseStatus', 'itemDate'] as const) {
      if (filter[key] !== undefined) physical[key] = filter[key];
    }
    const built = toConditionBuilders(controlItemsFilterSpec, physical as FilterInput);
    if (built.isErr()) return { conds: [], error: built.error };
    const conds: RawBuilder<unknown>[] = [...built.value];

    const recipient = fieldFilter(filter, 'recipient');
    if (recipient !== undefined) {
      if (typeof recipient['eq'] === 'string') conds.push(sql`c.recipient = ${recipient['eq']}`);
      const rc = containsValue(recipient);
      if (rc !== undefined) {
        const needle = '%' + escapeLike(foldDiacritics(rc)) + '%';
        conds.push(sql`lower(translate(coalesce(c.recipient, ''), ${FOLD_FROM}, ${FOLD_TO})) like ${needle} escape '\\'`);
      }
    }
    const author = containsValue(fieldFilter(filter, 'author'));
    if (author !== undefined) {
      const needle = '%' + escapeLike(foldDiacritics(author)) + '%';
      conds.push(sql`lower(translate(coalesce(c.author_name, ''), ${FOLD_FROM}, ${FOLD_TO})) like ${needle} escape '\\'`);
    }
    const q = containsValue(fieldFilter(filter, 'q'));
    if (q !== undefined && q.trim() !== '') {
      const needle = '%' + escapeLike(foldDiacritics(q)) + '%';
      conds.push(sql`lower(translate(coalesce(c.title, ''), ${FOLD_FROM}, ${FOLD_TO})) like ${needle} escape '\\'`);
    }
    return { conds };
  };

  const listControlItems = async (
    filter: FilterInput,
    page: CursorPageRequest
  ): Promise<Result<CursorPage<ParliamentControlItem>, ApiError>> => {
    const { conds, error } = buildControlConditions(filter);
    if (error !== undefined) return err(error);
    const limit = Math.min(Math.max(page.first, 1), 100);
    const fhash = fhashFor(controlItemsFilterSpec, filter);
    // The ORDER BY + keyset predicate share the SAME coalesced date key (NULL → ''),
    // so '' sorts last on desc (== NULLS LAST) and pagination stays consistent.
    const dateKey = sql`coalesce(c.item_date::text, '')`;
    if (page.after !== undefined) {
      const dec = decodeCursor(page.after, { sort: 'itemDate', dir: 'desc', fhash });
      if (dec.isErr()) return err(dec.error);
      const keys = requireCursorKeys(dec.value.keys, 2);
      if (keys.isErr()) return err(keys.error);
      const [kDate = '', kKey = ''] = keys.value;
      conds.push(sql`(${dateKey}, c.item_key) < (${kDate}, ${kKey})`);
    }
    try {
      const rows = await db
        .selectFrom('parliament.control_items as c')
        .select([
          'c.item_key', 'c.control_type', 'c.control_type_provenance', 'c.title', 'c.recipient',
          sql<string | null>`c.item_date::text`.as('item_date'),
          'c.response_status', 'c.author_name', 'c.mandate_key',
        ])
        .where(composeWhere(conds))
        .orderBy(sql`${dateKey} desc, c.item_key desc`)
        .limit(limit + 1)
        .execute();
      const hasMore = rows.length > limit;
      const sliced = hasMore ? rows.slice(0, limit) : rows;
      const items = sliced.map((r) => mapControlItem(r));
      const last = sliced[sliced.length - 1] as ControlItemRow | undefined;
      const next =
        hasMore && last !== undefined
          ? buildNextCursor({ sort: 'itemDate', dir: 'desc', fhash, lastKeys: [last.item_date ?? '', last.item_key] })
          : null;
      return ok({ items, next });
    } catch (e) {
      return err(databaseError('listControlItems failed', e));
    }
  };

  // ── lineage (the marquee) ──────────────────────────────────────────────────────
  const votesForActId = async (actId: string, roles: readonly string[]): Promise<Result<readonly LineageVoteRow[], ApiError>> => {
    try {
      let qb = db
        .selectFrom('parliament.bill_act_links as bal')
        .innerJoin('parliament.bill_vote_links as bvl', 'bvl.bill_key', 'bal.bill_key')
        .innerJoin('parliament.votes as v', 'v.vote_key', 'bvl.vote_key')
        .select([...VOTE_SELECT, 'bvl.bill_key as bvl_bill_key', 'bvl.role', 'bvl.resolution_status as bvl_status', 'bvl.confidence_label as bvl_conf'])
        .where(sql`bal.target_act_id`, '=', sql`${actId}::bigint`)
        .where('bal.resolution_status', '=', 'linked');
      if (roles.length > 0) qb = qb.where('bvl.role', 'in', [...roles]);
      const rows = await qb.orderBy('v.vote_date', 'asc').execute();
      return ok(
        rows.map((r) => ({
          vote: mapVote(r as unknown as VoteRow),
          billKey: (r as { bvl_bill_key: string | null }).bvl_bill_key,
          role: (r as { role: string }).role,
          resolutionStatus: (r as { bvl_status: string }).bvl_status,
          confidenceLabel: (r as { bvl_conf: string | null }).bvl_conf ?? 'none',
        }))
      );
    } catch (e) {
      return err(databaseError('votesForActId failed', e));
    }
  };

  const billsForActId = async (actId: string): Promise<Result<readonly ParliamentBill[], ApiError>> => {
    try {
      const rows = await db
        .selectFrom('parliament.bill_act_links as bal')
        .innerJoin('parliament.bills as b', 'b.bill_key', 'bal.bill_key')
        .select(BILL_SELECT)
        .where(sql`bal.target_act_id`, '=', sql`${actId}::bigint`)
        .where('bal.resolution_status', '=', 'linked')
        .execute();
      return ok(rows.map((r) => mapBill(r as BillRow)));
    } catch (e) {
      return err(databaseError('billsForActId failed', e));
    }
  };

  // ── cohesion ────────────────────────────────────────────────────────────────────
  const voteKeysForBill = async (billKey: string): Promise<Result<readonly string[], ApiError>> => {
    try {
      const rows = await db
        .selectFrom('parliament.votes as v')
        .select('v.vote_key')
        .where('v.bill_key', '=', billKey)
        .limit(COHESION_VOTE_CAP + 1)
        .execute();
      return ok(rows.map((r) => r.vote_key));
    } catch (e) {
      return err(databaseError('voteKeysForBill failed', e));
    }
  };

  const voteKeysForWindow = async (
    chamber: string,
    from: string,
    to: string,
    cap: number
  ): Promise<Result<{ voteKeys: readonly string[]; overflow: boolean }, ApiError>> => {
    try {
      const rows = await db
        .selectFrom('parliament.votes as v')
        .select('v.vote_key')
        .where('v.chamber', '=', chamber)
        .where(sql`v.vote_date`, '>=', sql`${from}::date`)
        .where(sql`v.vote_date`, '<=', sql`${to}::date`)
        .limit(cap + 1)
        .execute();
      const overflow = rows.length > cap;
      return ok({ voteKeys: rows.slice(0, cap).map((r) => r.vote_key), overflow });
    } catch (e) {
      return err(databaseError('voteKeysForWindow failed', e));
    }
  };

  const cohesionForVoteKeys = async (
    voteKeys: readonly string[],
    group?: string
  ): Promise<Result<readonly ParliamentGroupCohesion[], ApiError>> => {
    if (voteKeys.length === 0) return ok([]);
    if (voteKeys.length > COHESION_VOTE_CAP) {
      return err(invalidInput(`cohesion vote set exceeds cap (${String(COHESION_VOTE_CAP)})`, 'voteKeys'));
    }
    try {
      let qb = db
        .selectFrom('parliament.vote_records as vr')
        .select([
          'vr.group_name',
          sql<string>`count(*) filter (where vr.choice = 'pentru')`.as('pentru'),
          sql<string>`count(*) filter (where vr.choice = 'impotriva')`.as('impotriva'),
          sql<string>`count(*) filter (where vr.choice = 'abtinere')`.as('abtinere'),
          sql<string>`count(*) filter (where vr.choice = 'nu_a_votat')`.as('nu_a_votat'),
          sql<string>`count(distinct vr.vote_key)`.as('vote_count'),
        ])
        .where('vr.vote_key', 'in', [...voteKeys])
        .where('vr.group_name', 'is not', null);
      if (group !== undefined) qb = qb.where('vr.group_name', '=', group);
      const rows = await qb.groupBy('vr.group_name').execute();
      return ok(
        rows.map((r) => {
          const pentru = Number(r.pentru);
          const impotriva = Number(r.impotriva);
          const abtinere = Number(r.abtinere);
          const absent = Number(r.nu_a_votat);
          const total = pentru + impotriva + abtinere + absent;
          const pct = (n: number): number => (total > 0 ? Math.round((n / total) * 10000) / 100 : 0);
          // Rice cohesion: |for - against| / (for + against), 0..1.
          const decided = pentru + impotriva;
          const cohesionIndex = decided > 0 ? Math.round((Math.abs(pentru - impotriva) / decided) * 1000) / 1000 : 0;
          return {
            groupName: r.group_name ?? '(none)',
            forPct: pct(pentru),
            againstPct: pct(impotriva),
            abstainPct: pct(abtinere),
            absentPct: pct(absent),
            cohesionIndex,
            voteCount: Number(r.vote_count),
          };
        })
      );
    } catch (e) {
      return err(databaseError('cohesionForVoteKeys failed', e));
    }
  };

  // ── data-quality (lean projection; api-key gated at the handler) ───────────────
  const listPersonCandidates = async (
    status: string | undefined,
    page: OffsetParams
  ): Promise<Result<OffsetResult<ParliamentPersonCandidate>, ApiError>> => {
    try {
      let qb = db
        .selectFrom('parliament.person_identity_candidates as pc')
        .select(['pc.mandate_key', sql<string | null>`pc.person_id::text`.as('person_id'), 'pc.status']);
      if (status !== undefined) qb = qb.where('pc.status', '=', status);
      const rows = await qb.orderBy('pc.mandate_key', 'asc').limit(page.pageSize).offset(offsetFor(page)).execute();
      let cntQb = db
        .selectFrom('parliament.person_identity_candidates as pc')
        .select(sql<string>`count(*)`.as('cnt'));
      if (status !== undefined) cntQb = cntQb.where('pc.status', '=', status);
      const cnt = await cntQb.executeTakeFirst();
      return ok({
        rows: rows.map((r) => ({ mandateKey: r.mandate_key, personId: r.person_id, status: r.status })),
        total: Number(cnt?.cnt ?? 0),
        estimated: false,
      });
    } catch (e) {
      return err(databaseError('listPersonCandidates failed', e));
    }
  };

  // ── contributor support (deferred recipient→CUI; returns null today) ───────────
  // Recipient→CUI canonicalization is deferred (§4.4): no CUI-keyed recipient data
  // exists yet, so this always reports "no parliament slice" (null, not error). Not
  // `async` (no DB hit) — returns an already-resolved Promise to satisfy the port.
  const controlPresenceForRecipient = (
    _cui: string
  ): Promise<Result<ParliamentControlSummaryCount | null, ApiError>> =>
    Promise.resolve(ok(null));

  // ── freshness watermark ─────────────────────────────────────────────────────────
  const loaderWatermark = async (): Promise<Result<string | null, ApiError>> => {
    try {
      // Cheapest available signal: the max source_updated_at across the spine.
      // (No etl.load_runs stamp wired at cutover → TTL-only interim, plan §10.)
      const row = await db
        .selectFrom('parliament.votes')
        .select(sql<string | null>`max(updated_at)::text`.as('w'))
        .executeTakeFirst();
      return ok(row?.w ?? null);
    } catch (e) {
      return err(databaseError('loaderWatermark failed', e));
    }
  };

  return {
    latestLegislature,
    listMembers,
    findMember,
    listGroupCounts,
    listGroupMembers,
    findPerson,
    listPersonMandates,
    listGroupIntervals,
    listGroupIntervalsForPerson,
    searchPersonsByName,
    resolveGroups,
    resolveConstituencies,
    resolveRecipients,
    listBills,
    findBill,
    getBillEvents,
    getBillDocuments,
    getBillInitiators,
    getBillActLinks,
    getBillVoteLinks,
    listVotes,
    findVote,
    listVotesForBill,
    listVoteRecords,
    voteGroupBreakdown,
    ballotResolution,
    listMemberVotes,
    listMemberControlItems,
    listMemberSpeeches,
    listMemberInitiatives,
    listMemberDeclarations,
    listControlItems,
    votesForActId,
    billsForActId,
    voteKeysForBill,
    voteKeysForWindow,
    cohesionForVoteKeys,
    listPersonCandidates,
    controlPresenceForRecipient,
    loaderWatermark,
  };
};

export { fhashFor };
