/**
 * Parliament module — the CANONICAL STENOGRAM repository slice (scrapper migration
 * `20260726T140000__parliament_canonical_stenogram.ts`). Composed into
 * `makeParliamentRepo`, so there is still ONE `ParliamentRepo` object; it lives in
 * its own file because the reading surface has its own availability + privacy
 * discipline and is easier to review whole.
 *
 * BINDING CONTRACTS (all four come from the migration, not from a preference):
 *
 *  1. PROJECTION AVAILABILITY IS PROBED, NEVER ASSUMED. The migration is additive
 *     and is NOT applied to the live serving DB (`prod-db/TRACKER.md`: "reserved
 *     2026-07-26; implementation in progress; no live apply authorized"). A missing
 *     relation or column fails at PARSE time, so no runtime `to_regclass` guard
 *     inside the SQL can save the query — the branch must not be emitted at all.
 *     Two memoized probes (the `parliament.speech_texts` pattern: a TRUE result is
 *     cached for the process, a false one only for a short negative TTL so the
 *     migration landing mid-process needs no restart) decide, and every method
 *     returns `TranscriptUnavailable{reason:'projection_unavailable'}` instead of a
 *     Database error, because "we cannot read the reading here" is a different fact
 *     from "the query is broken".
 *
 *  2. PRIVACY IS STRICT AND PER-TABLE (contract §5). `privacy_class` is `text not
 *     null` with a 2-value CHECK on all three new tables, so a NULL cannot exist and
 *     `coalesce(privacy_class,'public')` would be a fail-open no-op. Every read
 *     pins `= 'public'` on EVERY table it touches — session AND segment AND speech
 *     AND redirect — so a restricted row cannot be reached transitively (a public
 *     session must never expose a restricted block, and a public redirect must never
 *     expose a restricted canonical turn).
 *
 *  3. ORDER IS THE OFFICIAL PRINTED ORDER. Segments are always read
 *     `order by position asc` over the unique `(session_key, position)` index; the
 *     session list keysets on `(coalesce(session_date::text,'') desc, session_key
 *     desc)` so a dateless capture sorts LAST and pagination never skips or
 *     duplicates at the null boundary (the `listSpeeches` precedent).
 *
 *  4. IDENTITY IS NEVER GUESSED. `speaker_name` is what the transcript printed;
 *     `mandate_key` is the roster-validated identity and NULL is the expected value
 *     for guests/ministers/unmatched speakers. This repo never derives one from the
 *     other.
 */

import { sql, type Kysely, type RawBuilder, type SqlBool } from 'kysely';
import { err, ok, type Result } from 'neverthrow';

import {
  buildNextCursor,
  databaseError,
  decodeCursor,
  invalidInput,
  toConditionBuilders,
  type CursorPage,
  type CursorPageRequest,
  type FilterInput,
} from '@/modules/shared/index.js';

import {
  mapSpeechRedirect,
  mapStenogramSegment,
  mapStenogramSession,
  mapStenogramSessionRef,
} from './mappers.js';
import {
  transcriptUnavailable,
  type ParliamentSittingNavigation,
  type ParliamentSpeechRedirect,
  type ParliamentStenogramError,
  type ParliamentStenogramSegment,
  type ParliamentStenogramSession,
} from '../../core/types.js';
import { stenogramSessionsFhash, stenogramSessionsFilterSpec } from '../filters/specs.js';

import type { ParliamentStenogramRepo } from '../../core/ports.js';

type Db = Kysely<import('@/modules/shared/index.js').ProdDatabase>;

/** Cap for the sessions `total` (the `listSpeeches` capped-count pattern). */
const SESSION_TOTAL_CAP = 10_000;

/** Negative-TTL for both canonical probes — see the header, contract 1. */
const CANONICAL_PROBE_NEG_TTL_MS = 60_000;

const composeWhere = (conds: readonly RawBuilder<unknown>[]): RawBuilder<SqlBool> =>
  conds.length === 0 ? sql<SqlBool>`true` : sql<SqlBool>`${sql.join(conds, sql` and `)}`;

/** Contract 2: strict per-table public gates. Never `coalesce(..., 'public')`. */
const SESSION_PUBLIC = sql`ss.privacy_class = 'public'`;
const SEGMENT_PUBLIC = sql`sg.privacy_class = 'public'`;
const REDIRECT_PUBLIC = sql`sr.privacy_class = 'public'`;
/**
 * The canonical `parliament.speeches` row a SPEECH block points at must ALSO be
 * public and non-quarantined. FAIL-CLOSED and written as an implication rather than a
 * join: a block with no `speech_key` (narration, agenda heading) passes, while a block
 * that DOES name a speech row must find that row public — so a missing or restricted
 * canonical row withholds the block instead of defaulting it open.
 */
const CANONICAL_SPEECH_PUBLIC = sql`(
  sg.speech_key is null
  or exists (
    select 1 from parliament.speeches cs
    where cs.speech_key = sg.speech_key
      and cs.privacy_class = 'public'
      and cs.quarantined = false
  )
)`;

const SESSION_SELECT = [
  'ss.session_key',
  'ss.chamber',
  sql<string | null>`ss.session_date::text`.as('session_date'),
  'ss.session_date_source',
  'ss.title',
  'ss.source_system',
  'ss.availability',
  'ss.source_url',
  'ss.source_url_kind',
  'ss.sitting_key',
  'ss.presiding_text',
  'ss.start_time_text',
  'ss.end_time_text',
  'ss.segment_count',
  'ss.speech_count',
  'ss.speaker_count',
  'ss.capture_digest',
  'ss.canonical_digest',
  sql<string | null>`ss.source_updated_at::text`.as('source_updated_at'),
] as const;

/** The navigation-target projection — a label plus a destination, nothing more. */
const SESSION_REF_SELECT = [
  'ss.session_key',
  'ss.chamber',
  sql<string | null>`ss.session_date::text`.as('session_date'),
  'ss.title',
  'ss.availability',
  'ss.source_url',
  'ss.source_url_kind',
] as const;

const SEGMENT_SELECT = [
  'sg.segment_key',
  'sg.session_key',
  'sg.position',
  'sg.segment_kind',
  'sg.text',
  'sg.text_chars',
  'sg.speaker_name',
  'sg.speaker_ref',
  'sg.mandate_key',
  'sg.speech_key',
  'sg.agenda_ref',
  'sg.source_url',
  'sg.source_url_kind',
] as const;

/**
 * The speaker-identity columns (scrapper migration 20260727T140000), selected only
 * when the database actually has them.
 *
 * Same shape-preserving trick the canonical speech columns use: when the migration
 * is absent we still select the four ALIASES as SQL literals, so the row type and
 * the mapper have ONE shape on both kinds of database and no call site has to
 * branch. The literals are the honest defaults — "no identity recorded" is exactly
 * what a pre-migration row is. Naming a missing column instead would fail at PARSE
 * time and take down every transcript read, not just the identity part of it.
 */
const segmentIdentitySelect = (hasIdentity: boolean) =>
  [
    sql<string | null>`${hasIdentity ? sql`sg.person_id::text` : sql`null::text`}`.as('person_id'),
    sql<string | null>`${hasIdentity ? sql`sg.speaker_resolution` : sql`null::text`}`.as(
      'speaker_resolution'
    ),
    sql<string | null>`${hasIdentity ? sql`sg.speaker_method` : sql`null::text`}`.as(
      'speaker_method'
    ),
    sql<string | null>`${hasIdentity ? sql`sg.speaker_confidence` : sql`null::text`}`.as(
      'speaker_confidence'
    ),
  ] as const;

/** The deduped, non-empty string values a virtual field's eq + in select. */
const virtualStrings = (filter: FilterInput, name: string): readonly string[] => {
  const ff: unknown = filter[name];
  if (ff === null || typeof ff !== 'object' || Array.isArray(ff)) return [];
  const f = ff as { eq?: unknown; in?: unknown };
  const picked = [
    ...(typeof f.eq === 'string' && f.eq !== '' ? [f.eq] : []),
    ...(Array.isArray(f.in)
      ? (f.in as unknown[]).filter((x): x is string => typeof x === 'string' && x !== '')
      : []),
  ];
  return [...new Set(picked)];
};

/** The deduped calendar years a virtual `year` field's eq + in select. */
const virtualYears = (filter: FilterInput, name: string): readonly number[] => {
  const ff: unknown = filter[name];
  if (ff === null || typeof ff !== 'object' || Array.isArray(ff)) return [];
  const f = ff as { eq?: unknown; in?: unknown };
  const inList: readonly unknown[] = Array.isArray(f.in) ? (f.in as unknown[]) : [];
  const raw: readonly unknown[] = [...(f.eq !== undefined ? [f.eq] : []), ...inList];
  const years = raw
    .map((x) => (typeof x === 'number' ? x : Number(x)))
    .filter((n) => Number.isInteger(n) && n >= 1990 && n <= 2100);
  return [...new Set(years)];
};

/**
 * True when a filter FIELD carries at least one operand — i.e. the caller asked for
 * something on this field. Used to tell "no `year` filter" (widen) apart from "a
 * `year` filter whose operands are all invalid" (refuse), which must never silently
 * become the former.
 */
const fieldHasOperand = (filter: FilterInput, name: string): boolean => {
  const ff: unknown = filter[name];
  if (ff === null || typeof ff !== 'object' || Array.isArray(ff)) return false;
  return Object.values(ff as Record<string, unknown>).some((v) => v !== undefined && v !== null);
};

export const makeParliamentStenogramRepo = (db: Db): ParliamentStenogramRepo => {
  // ── contract 1: the two availability probes ─────────────────────────────────
  const makeProbe = (probeSql: RawBuilder<unknown>): (() => Promise<boolean>) => {
    let usable = false;
    let lastNegativeAt = 0;
    let inFlight: Promise<boolean> | undefined;
    return () => {
      if (usable) return Promise.resolve(true);
      if (inFlight !== undefined) return inFlight;
      if (Date.now() - lastNegativeAt < CANONICAL_PROBE_NEG_TTL_MS) return Promise.resolve(false);
      inFlight = (async () => {
        try {
          await probeSql.execute(db);
          usable = true;
          return true;
        } catch {
          lastNegativeAt = Date.now();
          return false;
        } finally {
          inFlight = undefined;
        }
      })();
      return inFlight;
    };
  };

  // `limit 0` proves the relations AND the named columns are queryable without
  // reading a row. Raw SQL (not `selectFrom`) keeps the probe independent of the
  // Kysely types, which DO carry the tables even where the DB does not.
  const stenogramProjectionAvailable = makeProbe(
    sql`select ss.session_key, sg.segment_key
        from parliament.stenogram_sessions ss
        left join parliament.stenogram_segments sg on false
        limit 0`
  );
  const canonicalSpeechColumnsAvailable = makeProbe(
    sql`select is_canonical, stenogram_session_key, stenogram_segment_key
        from parliament.speeches limit 0`
  );
  const speakerIdentityColumnsAvailable = makeProbe(
    sql`select person_id, speaker_resolution, speaker_method, speaker_confidence
        from parliament.stenogram_segments limit 0`
  );
  /**
   * The block projection, identity included when the DB has it. One place, so a new
   * read cannot accidentally ship a segment without its speaker provenance — the
   * failure mode would be an unlinked name with no stated reason, which is exactly
   * what this whole change exists to end.
   */
  const segmentSelect = async () =>
    [...SEGMENT_SELECT, ...segmentIdentitySelect(await speakerIdentityColumnsAvailable())] as const;

  const unavailable = (sessionKey: string | null): ParliamentStenogramError =>
    transcriptUnavailable(
      'the canonical stenogram projection is not available on this database',
      sessionKey,
      'projection_unavailable'
    );

  /**
   * Physical spec conditions + the strict session privacy gate + the two
   * repo-intercepted virtual fields. `year` compiles to a date range per year
   * (OR-ed) so the `session_date desc` index still drives the scan — wrapping the
   * indexed column in `extract(year …)` would forfeit it. `mandateKey` compiles to
   * an EXISTS over PUBLIC SPEECH blocks: a speaker is a property of the reading, not
   * of the session row.
   */
  const buildSessionConditions = (
    filter: FilterInput
  ): Result<RawBuilder<unknown>[], ParliamentStenogramError> => {
    const physical: Record<string, unknown> = {};
    for (const key of ['chamber', 'sessionDate', 'availability', 'sourceSystem'] as const) {
      // Read as unknown: FilterInput omits null, but a GraphQL-nullable field CAN
      // arrive as null at runtime — treat null as absent.
      const v: unknown = filter[key];
      if (v !== undefined && v !== null) physical[key] = v;
    }
    const built = toConditionBuilders(stenogramSessionsFilterSpec, physical as FilterInput);
    if (built.isErr()) return err(built.error);
    const conds: RawBuilder<unknown>[] = [...built.value, SESSION_PUBLIC];

    const years = virtualYears(filter, 'year');
    if (years.length > 0) {
      const ranges = years.map(
        (y) =>
          sql`(ss.session_date >= ${`${String(y)}-01-01`} and ss.session_date <= ${`${String(y)}-12-31`})`
      );
      conds.push(sql`(${sql.join(ranges, sql` or `)})`);
    } else if (fieldHasOperand(filter, 'year')) {
      // An operand was PRESENT but no valid year survived (a non-integer, an
      // out-of-range value): refuse rather than silently widening to every year, which
      // would answer a different question than the caller asked.
      return err(invalidInput('year must be an integer between 1990 and 2100', 'year'));
    }

    const mandateKeys = virtualStrings(filter, 'mandateKey');
    if (mandateKeys.length > 0) {
      conds.push(
        sql`exists (
          select 1 from parliament.stenogram_segments sg
          where sg.session_key = ss.session_key
            and sg.segment_kind = 'SPEECH'
            and sg.mandate_key in (${sql.join(
              mandateKeys.map((k) => sql`${k}`),
              sql`, `
            )})
            and ${SEGMENT_PUBLIC}
        )`
      );
    }
    return ok(conds);
  };

  const listStenogramSessions = async (
    page: CursorPageRequest,
    filter: FilterInput,
    q: string | undefined,
    sessionKeys: readonly string[] | undefined
  ): Promise<
    Result<
      CursorPage<ParliamentStenogramSession> & { total: number; totalEstimated: boolean },
      ParliamentStenogramError
    >
  > => {
    if (!(await stenogramProjectionAvailable())) return err(unavailable(null));
    const limit = Math.min(Math.max(page.first, 1), 100);
    const fhash = stenogramSessionsFhash(filter, q);
    const condsRes = buildSessionConditions(filter);
    if (condsRes.isErr()) return err(condsRes.error);
    const baseConds = condsRes.value;

    // The search projection has already resolved `q` to a bounded key set; an EMPTY
    // set means "searched, nothing matched" and must yield an empty page — never an
    // unfiltered one.
    if (sessionKeys !== undefined) {
      if (sessionKeys.length === 0) {
        return ok({ items: [], next: null, total: 0, totalEstimated: false });
      }
      baseConds.push(
        sql`ss.session_key in (${sql.join(
          sessionKeys.map((k) => sql`${k}`),
          sql`, `
        )})`
      );
    }

    const dateKey = sql`coalesce(ss.session_date::text, '')`;
    const pageConds = [...baseConds];
    if (page.after !== undefined) {
      const dec = decodeCursor(page.after, { sort: 'sessionDate', dir: 'desc', fhash });
      if (dec.isErr()) return err(dec.error);
      if (dec.value.keys.length !== 2) {
        return err(invalidInput('malformed cursor; restart pagination', 'cursor'));
      }
      const [kDate, kKey] = dec.value.keys;
      pageConds.push(sql`(${dateKey}, ss.session_key) < (${kDate ?? ''}, ${kKey ?? ''})`);
    }

    try {
      const [rows, countRow] = await Promise.all([
        db
          .selectFrom('parliament.stenogram_sessions as ss')
          .select(SESSION_SELECT)
          .where(composeWhere(pageConds))
          .orderBy(sql`${dateKey} desc, ss.session_key desc`)
          .limit(limit + 1)
          .execute(),
        db
          .selectFrom(
            db
              .selectFrom('parliament.stenogram_sessions as ss')
              .select(sql<number>`1`.as('one'))
              .where(composeWhere(baseConds))
              .limit(SESSION_TOTAL_CAP + 1)
              .as('capped')
          )
          .select(sql<string>`count(*)`.as('cnt'))
          .executeTakeFirst(),
      ]);
      const hasMore = rows.length > limit;
      const sliced = hasMore ? rows.slice(0, limit) : rows;
      const items = sliced.map((r) => mapStenogramSession(r));
      const last = sliced[sliced.length - 1];
      const next =
        hasMore && last !== undefined
          ? buildNextCursor({
              sort: 'sessionDate',
              dir: 'desc',
              fhash,
              lastKeys: [last.session_date ?? '', last.session_key],
            })
          : null;
      const rawCount = Number(countRow?.cnt ?? 0);
      const totalEstimated = rawCount > SESSION_TOTAL_CAP;
      return ok({
        items,
        next,
        total: totalEstimated ? SESSION_TOTAL_CAP : rawCount,
        totalEstimated,
      });
    } catch (e) {
      return err(databaseError('listStenogramSessions failed', e));
    }
  };

  const findStenogramSession = async (
    sessionKey: string
  ): Promise<Result<ParliamentStenogramSession | null, ParliamentStenogramError>> => {
    if (!(await stenogramProjectionAvailable())) return err(unavailable(sessionKey));
    try {
      const row = await db
        .selectFrom('parliament.stenogram_sessions as ss')
        .select(SESSION_SELECT)
        .where('ss.session_key', '=', sessionKey)
        // A non-public session resolves NULL, exactly like an unknown key — a deep
        // link must not distinguish "restricted" from "absent".
        .where(sql<SqlBool>`${SESSION_PUBLIC}`)
        .executeTakeFirst();
      return ok(row === undefined ? null : mapStenogramSession(row));
    } catch (e) {
      return err(databaseError('findStenogramSession failed', e));
    }
  };

  const listStenogramSegments = async (
    sessionKey: string,
    slice: { readonly offset: number; readonly limit: number }
  ): Promise<
    Result<
      { segments: readonly ParliamentStenogramSegment[]; total: number },
      ParliamentStenogramError
    >
  > => {
    if (!(await stenogramProjectionAvailable())) return err(unavailable(sessionKey));
    // The session gate is joined in, not assumed from a prior read: a restricted
    // session must never leak its blocks even if a caller passes its key directly.
    const where = composeWhere([
      sql`sg.session_key = ${sessionKey}`,
      SEGMENT_PUBLIC,
      sql`exists (
        select 1 from parliament.stenogram_sessions ss
        where ss.session_key = sg.session_key and ${SESSION_PUBLIC}
      )`,
      CANONICAL_SPEECH_PUBLIC,
    ]);
    try {
      const [rows, countRow] = await Promise.all([
        db
          .selectFrom('parliament.stenogram_segments as sg')
          .select(await segmentSelect())
          .where(where)
          // Contract 3: the OFFICIAL printed order, over the unique
          // (session_key, position) index.
          .orderBy('sg.position', 'asc')
          .offset(Math.max(slice.offset, 0))
          .limit(Math.max(slice.limit, 0))
          .execute(),
        db
          .selectFrom('parliament.stenogram_segments as sg')
          .select(sql<string>`count(*)`.as('cnt'))
          .where(where)
          .executeTakeFirst(),
      ]);
      return ok({
        segments: rows.map((r) => mapStenogramSegment(r)),
        total: Number(countRow?.cnt ?? 0),
      });
    } catch (e) {
      return err(databaseError('listStenogramSegments failed', e));
    }
  };

  /**
   * One segment by an indexed equality, with ALL THREE privacy gates applied: the
   * block, its parent session, and — when the block carries one — the canonical
   * `parliament.speeches` row it points at. The three tables carry INDEPENDENT
   * `privacy_class` values, so a public block whose canonical speech row is
   * restricted (or quarantined) must not be served through it. Fail-closed: the
   * canonical-speech gate is an `and not exists(... restricted ...)`-style EXISTS on
   * the public row, so a MISSING speech row also withholds the block rather than
   * defaulting it open.
   */
  const findSegmentBy = async (
    column: 'speech_key' | 'segment_key',
    value: string
  ): Promise<Result<ParliamentStenogramSegment | null, ParliamentStenogramError>> => {
    if (!(await stenogramProjectionAvailable())) return err(unavailable(null));
    try {
      const row = await db
        .selectFrom('parliament.stenogram_segments as sg')
        .select(await segmentSelect())
        .where(sql<SqlBool>`sg.${sql.ref(column)} = ${value}`)
        .where(sql<SqlBool>`${SEGMENT_PUBLIC}`)
        .where(
          sql<SqlBool>`exists (
            select 1 from parliament.stenogram_sessions ss
            where ss.session_key = sg.session_key and ${SESSION_PUBLIC}
          )`
        )
        .where(sql<SqlBool>`${CANONICAL_SPEECH_PUBLIC}`)
        .executeTakeFirst();
      return ok(row === undefined ? null : mapStenogramSegment(row));
    } catch (e) {
      return err(databaseError(`findSegmentBy ${column} failed`, e));
    }
  };

  const canonicalSpeechIsPublic = async (
    speechKey: string
  ): Promise<Result<boolean, ParliamentStenogramError>> => {
    if (!(await stenogramProjectionAvailable())) return err(unavailable(null));
    try {
      const row = await db
        .selectFrom('parliament.speeches as s')
        .select(sql<number>`1`.as('one'))
        .where('s.speech_key', '=', speechKey)
        .where(sql<SqlBool>`s.privacy_class = 'public'`)
        .where(sql<SqlBool>`s.quarantined = false`)
        .limit(1)
        .executeTakeFirst();
      return ok(row !== undefined);
    } catch (e) {
      return err(databaseError('canonicalSpeechIsPublic failed', e));
    }
  };

  const adjacentSessions = async (anchor: {
    readonly sessionKey: string;
    readonly sessionDate: string | null;
    readonly chamber: string;
  }): Promise<Result<ParliamentSittingNavigation, ParliamentStenogramError>> => {
    if (!(await stenogramProjectionAvailable())) return err(unavailable(anchor.sessionKey));
    // The SAME coalesced keyset the list orders by, so stepping with prev/next and
    // paging the list can never disagree about what comes before what. Chamber-scoped
    // (see ParliamentSittingNavigation) and public-only.
    const anchorDate = anchor.sessionDate ?? '';
    const key = sql`coalesce(ss.session_date::text, '')`;
    const base = [sql`ss.chamber = ${anchor.chamber}`, SESSION_PUBLIC];
    try {
      const [prevRow, nextRow] = await Promise.all([
        db
          .selectFrom('parliament.stenogram_sessions as ss')
          .select(SESSION_REF_SELECT)
          .where(
            composeWhere([
              ...base,
              sql`(${key}, ss.session_key) < (${anchorDate}, ${anchor.sessionKey})`,
            ])
          )
          // "Previous" = the greatest sitting strictly before the anchor.
          .orderBy(sql`${key} desc, ss.session_key desc`)
          .limit(1)
          .executeTakeFirst(),
        db
          .selectFrom('parliament.stenogram_sessions as ss')
          .select(SESSION_REF_SELECT)
          .where(
            composeWhere([
              ...base,
              sql`(${key}, ss.session_key) > (${anchorDate}, ${anchor.sessionKey})`,
            ])
          )
          // "Next" = the least sitting strictly after the anchor.
          .orderBy(sql`${key} asc, ss.session_key asc`)
          .limit(1)
          .executeTakeFirst(),
      ]);
      return ok({
        previous: prevRow === undefined ? null : mapStenogramSessionRef(prevRow),
        next: nextRow === undefined ? null : mapStenogramSessionRef(nextRow),
      });
    } catch (e) {
      return err(databaseError('adjacentSessions failed', e));
    }
  };

  const findSpeechRedirect = async (
    legacySpeechKey: string
  ): Promise<Result<ParliamentSpeechRedirect | null, ParliamentStenogramError>> => {
    if (!(await stenogramProjectionAvailable())) return err(unavailable(null));
    try {
      const row = await db
        .selectFrom('parliament.speech_redirects as sr')
        .select([
          'sr.legacy_speech_key',
          'sr.session_key',
          'sr.canonical_speech_key',
          'sr.canonical_segment_key',
          'sr.canonical_position',
          'sr.mapping_kind',
          'sr.match_method',
          // `evidence` is internal matcher state — omitted from the schema type, so
          // selecting it would not even compile.
        ])
        .where('sr.legacy_speech_key', '=', legacySpeechKey)
        .where(sql<SqlBool>`${REDIRECT_PUBLIC}`)
        .executeTakeFirst();
      return ok(row === undefined ? null : mapSpeechRedirect(row));
    } catch (e) {
      return err(databaseError('findSpeechRedirect failed', e));
    }
  };

  const adjacentContributions = async (
    sessionKey: string,
    position: number
  ): Promise<
    Result<
      { previous: ParliamentStenogramSegment | null; next: ParliamentStenogramSegment | null },
      ParliamentStenogramError
    >
  > => {
    if (!(await stenogramProjectionAvailable())) return err(unavailable(sessionKey));
    // The neighbouring CONTRIBUTION, not the neighbouring printed block: the block
    // physically next to a turn is usually narration/agenda, so a "next speech"
    // navigation built on position±1 would step onto non-speech text.
    const base = [
      sql`sg.session_key = ${sessionKey}`,
      sql`sg.segment_kind = 'SPEECH'`,
      SEGMENT_PUBLIC,
      sql`exists (
        select 1 from parliament.stenogram_sessions ss
        where ss.session_key = sg.session_key and ${SESSION_PUBLIC}
      )`,
      CANONICAL_SPEECH_PUBLIC,
    ];
    try {
      const [prevRow, nextRow] = await Promise.all([
        db
          .selectFrom('parliament.stenogram_segments as sg')
          .select(await segmentSelect())
          .where(composeWhere([...base, sql`sg.position < ${position}`]))
          .orderBy('sg.position', 'desc')
          .limit(1)
          .executeTakeFirst(),
        db
          .selectFrom('parliament.stenogram_segments as sg')
          .select(await segmentSelect())
          .where(composeWhere([...base, sql`sg.position > ${position}`]))
          .orderBy('sg.position', 'asc')
          .limit(1)
          .executeTakeFirst(),
      ]);
      return ok({
        previous: prevRow === undefined ? null : mapStenogramSegment(prevRow),
        next: nextRow === undefined ? null : mapStenogramSegment(nextRow),
      });
    } catch (e) {
      return err(databaseError('adjacentContributions failed', e));
    }
  };

  return {
    canonicalSpeechColumnsAvailable,
    speakerIdentityColumnsAvailable,
    stenogramProjectionAvailable,
    listStenogramSessions,
    findStenogramSession,
    listStenogramSegments,
    adjacentSessions,
    findSegmentBySpeechKey: (speechKey: string) => findSegmentBy('speech_key', speechKey),
    findSegmentByKey: (segmentKey: string) => findSegmentBy('segment_key', segmentKey),
    canonicalSpeechIsPublic,
    findSpeechRedirect,
    adjacentContributions,
  };
};
