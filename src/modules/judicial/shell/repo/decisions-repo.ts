/**
 * Judicial module — stored decisions repo (API-04). Reads the three decision
 * tables: `justice.issuing_bodies` (small reference), `justice.decisions` and
 * `justice.decision_subject_links`. SERVED AS STORED under the scoped human
 * instruction recorded in core/types.ts: both stored privacy classes and the
 * link evidence JSON are returned; nothing is verified, promoted, joined to a
 * subject domain or normalized.
 *
 * NATIVE VALUES. IDs are selected as `::text` (never a JS number); the native
 * `date` renders through `nativeDateDisplay` and the row-operation timestamps
 * through `exactTimestampText` (no JS Date); `decision_year` is the stored
 * smallint; `confidence_score` is exact numeric text; `attrs`/`evidence` are the
 * stored JSON values (pg's jsonb parser; any JSON value, never an `{}` default).
 *
 * INPUTS. Each list filter is normalized ONCE (`normalizeJudicialFilter`) and
 * that object feeds the bound/anchor rule, the cursor identity hash, the kernel
 * composer and the virtual compilers. `first` is an ORIGINAL integer 1..50
 * (rejected, never clamped). Cursors: one canonical signed int8 key, checked
 * with the core predicate by the strict judicial decoder before any SQL, under
 * a collection-specific identity.
 *
 * ORDER. decision_id DESC / link_id DESC only — a surrogate-key order, not
 * "latest decisions" or capture order. The driving indexes are not covering
 * (filter, id) indexes: a bounded predicate plus LIMIT does not prove a
 * 51-row scan.
 */

import { sql, type Kysely, type RawBuilder } from 'kysely';
import { err, ok, type Result } from 'neverthrow';

import {
  buildNextCursor,
  databaseError,
  fhashFor,
  invalidInput,
  toConditionBuilders,
  type ApiError,
  type CursorPage,
  type CursorPageRequest,
  type FieldFilter,
  type FilterInput,
  type ProdDatabase,
} from '@/modules/shared/index.js';

import { decodeJudicialCursor } from './cases-repo.js';
import { composeWhere, fieldOf, normalizeJudicialFilter } from './filter-helpers.js';
import { exactTimestampText, nativeDateDisplay } from './temporal-sql.js';
import {
  isJudicialDecisionPageSize,
  isJudicialDecisionYearOperand,
  isJudicialSignedId,
  type JudicialCursorItem,
  type JudicialDecision,
  type JudicialDecisionLinkStatus,
  type JudicialDecisionPrivacyClass,
  type JudicialDecisionSubjectKind,
  type JudicialDecisionSubjectLink,
  type JudicialIssuingBody,
  type JudicialIssuingBodyKind,
} from '../../core/types.js';
import {
  judicialDecisionSubjectLinksSpec,
  judicialDecisionsSpec,
} from '../filters/judicial.spec.js';

import type { DecisionListOptions, JudicialDecisionRepo } from '../../core/ports.js';

type Db = Kysely<ProdDatabase>;

// ── selections (named stored columns only) ─────────────────────────────────────

const DECISION_SELECT = sql`
  d.decision_id::text as decision_id, d.issuing_body, d.source_system, d.source_ref,
  d.decision_no, d.decision_year, ${nativeDateDisplay(sql`d.decision_date`)} as decision_date,
  d.decision_kind, d.outcome_normalized, d.ecli, d.application_no, d.attrs, d.privacy_class,
  d.source_url, d.source_object_key,
  ${exactTimestampText(sql`d.created_at`)} as created_at,
  ${exactTimestampText(sql`d.updated_at`)} as updated_at
`;

interface DecisionRow {
  decision_id: string;
  issuing_body: string;
  source_system: string;
  source_ref: string;
  decision_no: string | null;
  decision_year: number | null;
  decision_date: string | null;
  decision_kind: string | null;
  outcome_normalized: string | null;
  ecli: string | null;
  application_no: string | null;
  attrs: unknown;
  privacy_class: string;
  source_url: string | null;
  source_object_key: string | null;
  created_at: string;
  updated_at: string;
}

const mapDecision = (r: DecisionRow): JudicialDecision => ({
  decisionId: r.decision_id,
  issuingBody: r.issuing_body,
  sourceSystem: r.source_system,
  sourceRef: r.source_ref,
  decisionNo: r.decision_no,
  decisionYear: r.decision_year,
  decisionDate: r.decision_date,
  decisionKind: r.decision_kind,
  outcomeNormalized: r.outcome_normalized,
  ecli: r.ecli,
  applicationNo: r.application_no,
  attrs: r.attrs,
  privacyClass: r.privacy_class as JudicialDecisionPrivacyClass,
  sourceUrl: r.source_url,
  sourceObjectKey: r.source_object_key,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

interface LinkRow {
  link_id: string;
  decision_id: string;
  subject_kind: string;
  subject_ref: string;
  role: string | null;
  method: string | null;
  confidence_score: string | null;
  validation_status: string;
  evidence: unknown;
  resolver_version: string | null;
  created_at: string;
  updated_at: string;
}

const mapLink = (r: LinkRow): JudicialDecisionSubjectLink => ({
  linkId: r.link_id,
  decisionId: r.decision_id,
  subjectKind: r.subject_kind as JudicialDecisionSubjectKind,
  subjectRef: r.subject_ref,
  role: r.role,
  method: r.method,
  confidenceScore: r.confidence_score,
  validationStatus: r.validation_status as JudicialDecisionLinkStatus,
  evidence: r.evidence,
  resolverVersion: r.resolver_version,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

interface IssuingBodyRow {
  issuing_body: string;
  label: string;
  kind: string;
  notes: string | null;
  created_at: string;
}

const mapIssuingBody = (r: IssuingBodyRow): JudicialIssuingBody => ({
  issuingBody: r.issuing_body,
  label: r.label,
  kind: r.kind as JudicialIssuingBodyKind,
  notes: r.notes,
  createdAt: r.created_at,
});

const ISSUING_BODY_SELECT = sql`
  b.issuing_body, b.label, b.kind, b.notes,
  ${exactTimestampText(sql`b.created_at`)} as created_at
`;

// ── cursor identities (collection-specific, envelope v=1 unchanged) ────────────

const DECISIONS_CURSOR = 'judicial_decisions:cursor-v1';
const LINKS_CURSOR = 'judicial_decision_subject_links:cursor-v1';
const DECISION_SORT = 'decisionId';
const LINK_SORT = 'linkId';

/** The decision-list cursor identity over the SAME normalized filter the SQL uses. */
export const decisionCursorFhash = (filter: FilterInput): string =>
  `${DECISIONS_CURSOR}:${fhashFor(judicialDecisionsSpec, filter)}`;

/** The link-list cursor identity: the full structured anchor + status filter, hashed. */
export const decisionLinkCursorFhash = (filter: FilterInput): string =>
  `${LINKS_CURSOR}:${fhashFor(judicialDecisionSubjectLinksSpec, filter)}`;

const PAGE_MESSAGE = 'first must be an integer from 1 to 50';

/** The original page request: `first` an integer 1..50, `after` a string or absent. */
const checkPage = (page: CursorPageRequest): Result<number, ApiError> => {
  if (!isJudicialDecisionPageSize(page.first)) return err(invalidInput(PAGE_MESSAGE, 'first'));
  if (page.after !== undefined && typeof page.after !== 'string') {
    return err(invalidInput('after must be a cursor string', 'after'));
  }
  return ok(page.first);
};

const decodeIdCursor = (
  raw: string | undefined,
  sort: string,
  fhash: string
): Result<string | undefined, ApiError> => {
  if (raw === undefined) return ok(undefined);
  const decoded = decodeJudicialCursor(raw, { sort, dir: 'desc', fhash }, [isJudicialSignedId]);
  if (decoded.isErr()) return err(decoded.error);
  return ok(decoded.value[0]);
};

// ── decision filter: bound + the virtual year ──────────────────────────────────

/** A validated, intersected decision-year predicate (the stored smallint). */
interface DecisionYearPredicate {
  readonly from: number | null;
  readonly to: number | null;
  readonly isNull: boolean | null;
}

const YEAR_MESSAGE = 'decisionYear operands must be 32-bit integers (0 and negative years allowed)';

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Intersect the decisionYear operators ONCE (an `eq` is both bounds); every
 * operand must be an ORIGINAL 32-bit integer number, zero included. Returns
 * null when the field is absent. A contradictory interval is valid and
 * matches nothing.
 */
const decisionYearPredicate = (
  ff: FieldFilter | undefined
): Result<DecisionYearPredicate | null, ApiError> => {
  if (ff === undefined) return ok(null);
  const lower: unknown[] = [];
  const upper: unknown[] = [];
  if (ff['eq'] !== undefined) {
    lower.push(ff['eq']);
    upper.push(ff['eq']);
  }
  if (ff['gte'] !== undefined) lower.push(ff['gte']);
  if (ff['lte'] !== undefined) upper.push(ff['lte']);
  const between = ff['between'];
  if (between !== undefined) {
    if (!isPlainObject(between)) return err(invalidInput(YEAR_MESSAGE, 'decisionYear'));
    if (between.from !== undefined) lower.push(between.from);
    if (between.to !== undefined) upper.push(between.to);
  }
  let from: number | null = null;
  let to: number | null = null;
  for (const operand of lower) {
    if (!isJudicialDecisionYearOperand(operand)) {
      return err(invalidInput(YEAR_MESSAGE, 'decisionYear'));
    }
    from = from === null ? operand : Math.max(from, operand);
  }
  for (const operand of upper) {
    if (!isJudicialDecisionYearOperand(operand)) {
      return err(invalidInput(YEAR_MESSAGE, 'decisionYear'));
    }
    to = to === null ? operand : Math.min(to, operand);
  }
  const isNullOperand = ff['isNull'];
  if (isNullOperand !== undefined && typeof isNullOperand !== 'boolean') {
    return err(invalidInput('decisionYear isNull must be a boolean', 'decisionYear'));
  }
  const isNull = isNullOperand ?? null;
  if (from === null && to === null && isNull === null) return ok(null);
  return ok({ from, to, isNull });
};

/**
 * Compile the year predicate. Operands are bound as explicit `::integer`
 * against the smallint column (PostgreSQL then compares smallint to integer),
 * so an operand outside the smallint range bounds the interval instead of
 * failing as a smallint parameter.
 */
const decisionYearSql = (p: DecisionYearPredicate): RawBuilder<unknown> => {
  const col = sql`d.decision_year`;
  if (p.from !== null && p.to !== null && p.from > p.to) return sql`false`;
  const parts: RawBuilder<unknown>[] = [];
  if (p.isNull === true) parts.push(sql`${col} is null`);
  if (p.isNull === false) parts.push(sql`${col} is not null`);
  if (p.from !== null) parts.push(sql`${col} >= ${p.from}::integer`);
  if (p.to !== null) parts.push(sql`${col} <= ${p.to}::integer`);
  return sql`(${sql.join(parts, sql` and `)})`;
};

interface PreparedDecisionFilter {
  readonly filter: FilterInput;
  readonly year: DecisionYearPredicate | null;
}

const prepareDecisionFilter = (raw: unknown): Result<PreparedDecisionFilter, ApiError> => {
  const normalized = normalizeJudicialFilter(judicialDecisionsSpec, raw);
  if (normalized.isErr()) return err(normalized.error);
  const year = decisionYearPredicate(fieldOf(normalized.value, 'decisionYear'));
  if (year.isErr()) return err(year.error);
  return ok({ filter: normalized.value, year: year.value });
};

/** An explicit text equality (an empty string included) on a bounding field. */
const hasTextEq = (filter: FilterInput, name: string): boolean =>
  typeof fieldOf(filter, name)?.['eq'] === 'string';

// ── link filter: exactly one anchor ────────────────────────────────────────────

interface PreparedLinkFilter {
  readonly filter: FilterInput;
  /** The decision anchor (canonical signed int8), or null for the subject anchor. */
  readonly decisionId: string | null;
}

const ANCHOR_MESSAGE =
  'decision subject links require exactly one anchor: decisionId.eq, or both subjectKind.eq and subjectRef.eq';

const prepareLinkFilter = (raw: unknown): Result<PreparedLinkFilter, ApiError> => {
  const normalized = normalizeJudicialFilter(judicialDecisionSubjectLinksSpec, raw);
  if (normalized.isErr()) return err(normalized.error);
  const filter = normalized.value;
  const decisionAnchor = fieldOf(filter, 'decisionId')?.['eq'];
  const hasKind = hasTextEq(filter, 'subjectKind');
  const hasRef = hasTextEq(filter, 'subjectRef');
  const hasDecision = decisionAnchor !== undefined;
  if (hasDecision === (hasKind || hasRef) || hasKind !== hasRef) {
    return err(invalidInput(ANCHOR_MESSAGE, 'filter'));
  }
  if (hasDecision) {
    if (!isJudicialSignedId(decisionAnchor)) {
      return err(
        invalidInput(
          'decisionId must be a canonical signed int8 decimal string (no leading zeros, no -0)',
          'decisionId'
        )
      );
    }
    return ok({ filter, decisionId: decisionAnchor });
  }
  return ok({ filter, decisionId: null });
};

// ── discovery ──────────────────────────────────────────────────────────────────

const containsPattern = (q: string): string =>
  '%' + q.trim().replace(/[\\%_]/gu, (m) => `\\${m}`) + '%';

/** Re-check a discovery limit for direct callers (the usecase validates the original). */
const checkLimit = (limit: number): Result<number, ApiError> =>
  Number.isInteger(limit) && limit >= 1 && limit <= 50
    ? ok(limit)
    : err(invalidInput('limit must be an integer from 1 to 50', 'limit'));

// ── the repo ───────────────────────────────────────────────────────────────────

export const makeJudicialDecisionRepo = (db: Db): JudicialDecisionRepo => {
  const listIssuingBodies = async (): Promise<Result<readonly JudicialIssuingBody[], ApiError>> => {
    try {
      const r = await sql<IssuingBodyRow>`
        select ${ISSUING_BODY_SELECT}
        from justice.issuing_bodies b
        order by b.issuing_body asc
      `.execute(db);
      return ok(r.rows.map(mapIssuingBody));
    } catch (error) {
      return err(databaseError('decisions.listIssuingBodies failed', error));
    }
  };

  const getById = async (
    decisionId: string
  ): Promise<Result<JudicialDecision | null, ApiError>> => {
    if (!isJudicialSignedId(decisionId)) {
      return err(
        invalidInput(
          'decisionId must be a canonical signed int8 decimal string (no leading zeros, no -0)',
          'decisionId'
        )
      );
    }
    try {
      const r = await sql<DecisionRow>`
        select ${DECISION_SELECT}
        from justice.decisions d
        where d.decision_id = ${decisionId}::bigint
      `.execute(db);
      const row = r.rows[0];
      return ok(row === undefined ? null : mapDecision(row));
    } catch (error) {
      return err(databaseError('decisions.getById failed', error));
    }
  };

  // The port stays string-typed; the parameters are `unknown` here so the repo
  // re-checks the ORIGINAL operand types before SQL (the usecase checks too).
  // Any string is a valid EXACT operand (empty, whitespace, Unicode, delimiters);
  // the fixed messages never echo the operand.
  const getBySource = async (
    sourceSystem: unknown,
    sourceRef: unknown
  ): Promise<Result<JudicialDecision | null, ApiError>> => {
    if (typeof sourceSystem !== 'string') {
      return err(invalidInput('sourceSystem is required (exact text)', 'sourceSystem'));
    }
    if (typeof sourceRef !== 'string') {
      return err(invalidInput('sourceRef is required (exact text)', 'sourceRef'));
    }
    try {
      // The unique (source_system, source_ref) identity: both EXACT text.
      const r = await sql<DecisionRow>`
        select ${DECISION_SELECT}
        from justice.decisions d
        where d.source_system = ${sourceSystem} and d.source_ref = ${sourceRef}
      `.execute(db);
      const row = r.rows[0];
      return ok(row === undefined ? null : mapDecision(row));
    } catch (error) {
      return err(databaseError('decisions.getBySource failed', error));
    }
  };

  const list = async (
    opts: DecisionListOptions
  ): Promise<Result<CursorPage<JudicialCursorItem<JudicialDecision>>, ApiError>> => {
    const prepared = prepareDecisionFilter(opts.filter);
    if (prepared.isErr()) return err(prepared.error);
    const { filter, year } = prepared.value;
    if (!hasTextEq(filter, 'sourceSystem') && !hasTextEq(filter, 'issuingBody')) {
      return err(
        invalidInput('judicial decision list requires sourceSystem.eq or issuingBody.eq', 'filter')
      );
    }
    const first = checkPage(opts.page);
    if (first.isErr()) return err(first.error);
    const fhash = decisionCursorFhash(filter);
    const after = decodeIdCursor(opts.page.after, DECISION_SORT, fhash);
    if (after.isErr()) return err(after.error);
    const built = toConditionBuilders(judicialDecisionsSpec, filter);
    if (built.isErr()) return err(built.error);
    const conds: RawBuilder<unknown>[] = [...built.value];
    if (year !== null) conds.push(decisionYearSql(year));
    if (after.value !== undefined) conds.push(sql`d.decision_id < ${after.value}::bigint`);
    const limit = first.value;
    try {
      const r = await sql<DecisionRow>`
        select ${DECISION_SELECT}
        from justice.decisions d
        where ${composeWhere(conds)}
        order by d.decision_id desc
        limit ${limit + 1}
      `.execute(db);
      const items: JudicialCursorItem<JudicialDecision>[] = r.rows.slice(0, limit).map((row) => ({
        node: mapDecision(row),
        cursor: buildNextCursor({
          sort: DECISION_SORT,
          dir: 'desc',
          fhash,
          lastKeys: [row.decision_id],
        }),
      }));
      const next = r.rows.length > limit ? (items[items.length - 1]?.cursor ?? null) : null;
      return ok({ items, next });
    } catch (error) {
      return err(databaseError('decisions.list failed', error));
    }
  };

  const listSubjectLinks = async (
    opts: DecisionListOptions
  ): Promise<Result<CursorPage<JudicialCursorItem<JudicialDecisionSubjectLink>>, ApiError>> => {
    const prepared = prepareLinkFilter(opts.filter);
    if (prepared.isErr()) return err(prepared.error);
    const { filter, decisionId } = prepared.value;
    const first = checkPage(opts.page);
    if (first.isErr()) return err(first.error);
    const fhash = decisionLinkCursorFhash(filter);
    const after = decodeIdCursor(opts.page.after, LINK_SORT, fhash);
    if (after.isErr()) return err(after.error);
    const built = toConditionBuilders(judicialDecisionSubjectLinksSpec, filter);
    if (built.isErr()) return err(built.error);
    const conds: RawBuilder<unknown>[] = [...built.value];
    if (decisionId !== null) conds.push(sql`l.decision_id = ${decisionId}::bigint`);
    if (after.value !== undefined) conds.push(sql`l.link_id < ${after.value}::bigint`);
    const limit = first.value;
    try {
      const r = await sql<LinkRow>`
        select l.link_id::text as link_id, l.decision_id::text as decision_id,
               l.subject_kind, l.subject_ref, l.role, l.method,
               l.confidence_score::text as confidence_score, l.validation_status,
               l.evidence, l.resolver_version,
               ${exactTimestampText(sql`l.created_at`)} as created_at,
               ${exactTimestampText(sql`l.updated_at`)} as updated_at
        from justice.decision_subject_links l
        where ${composeWhere(conds)}
        order by l.link_id desc
        limit ${limit + 1}
      `.execute(db);
      const items: JudicialCursorItem<JudicialDecisionSubjectLink>[] = r.rows
        .slice(0, limit)
        .map((row) => ({
          node: mapLink(row),
          cursor: buildNextCursor({ sort: LINK_SORT, dir: 'desc', fhash, lastKeys: [row.link_id] }),
        }));
      const next = r.rows.length > limit ? (items[items.length - 1]?.cursor ?? null) : null;
      return ok({ items, next });
    } catch (error) {
      return err(databaseError('decisions.listSubjectLinks failed', error));
    }
  };

  const resolveIssuingBodies = async (
    q: string,
    limit: number
  ): Promise<Result<readonly JudicialIssuingBody[], ApiError>> => {
    const capped = checkLimit(limit);
    if (capped.isErr()) return err(capped.error);
    const pattern = containsPattern(q);
    try {
      const r = await sql<IssuingBodyRow>`
        select ${ISSUING_BODY_SELECT}
        from justice.issuing_bodies b
        where b.issuing_body ilike ${pattern} escape '\\' or b.label ilike ${pattern} escape '\\'
        order by b.issuing_body asc
        limit ${capped.value}
      `.execute(db);
      return ok(r.rows.map(mapIssuingBody));
    } catch (error) {
      return err(databaseError('decisions.resolveIssuingBodies failed', error));
    }
  };

  const resolveSourceSystems = async (
    q: string,
    limit: number
  ): Promise<Result<readonly string[], ApiError>> => {
    const capped = checkLimit(limit);
    if (capped.isErr()) return err(capped.error);
    const pattern = containsPattern(q);
    try {
      // DISTINCT + LIMIT caps the RESULT, not necessarily the work.
      const r = await sql<{ source_system: string }>`
        select distinct d.source_system
        from justice.decisions d
        where d.source_system ilike ${pattern} escape '\\'
        order by d.source_system asc
        limit ${capped.value}
      `.execute(db);
      return ok(r.rows.map((row) => row.source_system));
    } catch (error) {
      return err(databaseError('decisions.resolveSourceSystems failed', error));
    }
  };

  return {
    listIssuingBodies,
    getById,
    getBySource,
    list,
    listSubjectLinks,
    resolveIssuingBodies,
    resolveSourceSystems,
  };
};
