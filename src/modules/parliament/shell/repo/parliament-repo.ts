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
  mapAiBillMetadata,
  mapAiControlItemMetadata,
  mapBill,
  mapAgenda,
  mapAgendaItem,
  mapBillDocument,
  mapBillEvent,
  mapBillScheduling,
  mapCommittee,
  mapCommitteeDocument,
  mapCommitteeMembership,
  mapControlItem,
  mapDeclaration,
  mapGroupInterval,
  mapInitiative,
  mapMember,
  mapPerson,
  mapSpeech,
  mapVote,
  type AiBillMetadataRow,
  type AiControlItemMetadataRow,
  type CommitteeMembershipCoreRow,
  type CommitteeRow,
  type ControlItemRow,
  type MemberRow,
  type PersonRow,
  type VoteRow,
} from './mappers.js';
import { makeParliamentStenogramRepo } from './stenogram-repo.js';
import {
  BILL_CHILD_PER_VIEW_LIMIT,
  COMMITTEE_DOCUMENT_ORD_SENTINEL,
  COMMITTEE_DOCUMENT_PAGE_LIMIT,
  isCommitteeDocumentOrd,
  PARLIAMENT_BALLOT_PAGE_LIMIT,
} from '../../core/constants.js';
import {
  COHESION_VOTE_CAP,
  type ParliamentActivityCounts,
  type ParliamentAiBillMetadata,
  type ParliamentAiControlItemMetadata,
  type ParliamentBallot,
  type ParliamentBill,
  type ParliamentBillActivity,
  type ParliamentBillActLink,
  type ParliamentBillVoteLink,
  type ParliamentCommittee,
  type ParliamentCommitteeMembership,
  type ParliamentControlItem,
  type ParliamentDataFreshness,
  type ParliamentDeclarationMeta,
  type ParliamentGroup,
  type ParliamentGroupCohesion,
  type ParliamentGroupInterval,
  type ParliamentInitiative,
  type ParliamentMember,
  type ParliamentMemberSpeechActivity,
  type ParliamentMemberVote,
  type ParliamentMemberVoteActivity,
  type ParliamentPerson,
  type ParliamentPersonCandidate,
  type ParliamentSpeech,
  type ParliamentSpeechActivity,
  type ParliamentVoteActivity,
  type ParliamentVoteGapStatus,
  type ParliamentSpeechPopulation,
  type ParliamentSpeechSearchDepth,
  type ParliamentAgendaFilter,
  type ParliamentVote,
  type ParliamentVoteGroupBreakdown,
} from '../../core/types.js';
import {
  BILL_STATUSES,
  BILL_TYPES,
  VOTE_CHOICES,
  VOTE_KINDS,
  VOTE_KIND_TITLE_RULES,
  billsFilterSpec,
  controlItemsFilterSpec,
  memberSpeechesFhash,
  memberSpeechesFilterSpec,
  memberVotesFhash,
  memberVotesFilterSpec,
  membersFilterSpec,
  parliamentSpeechesFhash,
  parliamentSpeechesFilterSpec,
  votesFilterSpec,
} from '../filters/specs.js';

import type {
  BallotResolution,
  CommitteeDocumentPage,
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

/**
 * The folded vote title the kind rules are matched against — lower + diacritics,
 * exactly like the `q` fallback, so `Prezenţa` and `prezenta` are one needle.
 *
 * ONE definition, two embeddings: the WHERE form binds the fold strings as
 * parameters, the SELECT form inlines them (see `voteKindExpr`). Splitting it
 * into two template literals would be two things to keep in step.
 *
 * Declared here rather than beside `voteKindPredicate` because `VOTE_SELECT`
 * consumes `voteKindExpr` at module-init time and `const` has no hoisting.
 */
const foldedTitle = (embed: (s: string) => RawBuilder<string>): RawBuilder<string> =>
  sql<string>`lower(translate(coalesce(v.title, ''), ${embed(FOLD_FROM)}, ${embed(FOLD_TO)}))`;

const foldedVoteTitle = foldedTitle((s) => sql<string>`${s}`);

/**
 * Every constant inlined below is a compile-time literal from a frozen rule
 * table, never user input — but `sql.lit` is a raw splice, so this asserts the
 * property rather than trusting that a future rule keeps it. A pattern needing
 * an apostrophe must switch to a bound parameter, not slip through.
 */
for (const s of [
  FOLD_FROM,
  FOLD_TO,
  ...VOTE_KIND_TITLE_RULES.flatMap((r) => [r.pattern, r.kind]),
]) {
  if (s.includes("'") || s.includes('\\\\')) {
    throw new Error(`vote-kind constant is not safe to inline: ${s}`);
  }
}

/**
 * The vote-kind partition as a SELECTED VALUE — `ParliamentVote.kind`.
 *
 * Compiled from the SAME `VOTE_KIND_TITLE_RULES` as the `kind` FILTER
 * (`voteKindPredicate`, below) and as the GraphQL description. A CASE is
 * first-match-wins, which is exactly the precedence that predicate spells out as
 * an explicit "fails every earlier rule" chain — so `kind: X` returns precisely
 * the rows whose `kind` field reads `X`. Verified on prod rather than argued:
 * field and filter agree on all 20,745 rows, zero off-diagonal.
 *
 * Everything here is INLINED rather than bound. A selected expression sits ahead
 * of the whole WHERE clause, so twelve bind parameters here would renumber every
 * placeholder in every vote query — which is both a diff across unrelated tests
 * and a numbering that shifts again each time a rule is added.
 *
 * Cost is within measurement noise, because unlike the filter these regexes run
 * only over the rows a page has already selected, never across the 20,745-row
 * table: prod, a 21-row page, 27.4ms without the expression and 22.0ms with it
 * (both dominated by the ORDER BY sort); the 500-row bill path, 0.12ms.
 */
const voteKindExpr: RawBuilder<string> = sql<string>`(case
    when v.bill_key is not null then 'legislative'
    ${sql.join(
      VOTE_KIND_TITLE_RULES.map(
        (r) =>
          sql`when ${foldedTitle((s) => sql.lit(s))} ~ ${sql.lit(r.pattern)} then ${sql.lit(r.kind)}`
      ),
      sql` `
    )}
    else 'unclassified' end)`;

const composeWhere = (conds: readonly RawBuilder<unknown>[]): RawBuilder<SqlBool> =>
  conds.length === 0 ? sql<SqlBool>`true` : sql<SqlBool>`${sql.join(conds, sql` and `)}`;

const escapeLike = (s: string): string => s.replace(/[\\%_]/gu, (m) => `\\${m}`);

/** Negative-TTL for the speech_texts usability probe (see `speechTextsExists`). */
const SPEECH_TEXTS_NEG_TTL_MS = 60_000;

/**
 * Member-speech full-text `q` predicate: a literal (diacritic-sensitive) ILIKE
 * substring over `s.title` OR `s.summary`, plus — only when `speech_texts` exists —
 * an EXISTS over `parliament.speech_texts.full_text`. LIKE wildcards in the user
 * token are escaped (`escapeLike` + `ESCAPE '\'`). `hasTexts` MUST come from the
 * memoized `speechTextsExists` probe: referencing a missing relation fails at PARSE
 * time regardless of any runtime `to_regclass` guard, so the branch is added only
 * when the table is present. Exported for unit coverage (escape + branch shape).
 */
export const speechSearchPredicate = (q: string, hasTexts: boolean): RawBuilder<unknown> => {
  const needle = '%' + escapeLike(q) + '%';
  const textsBranch = hasTexts
    ? sql` or exists (select 1 from parliament.speech_texts t where t.speech_key = s.speech_key and t.privacy_class = 'public' and t.full_text ilike ${needle} escape '\\')`
    : sql``;
  return sql`(s.title ilike ${needle} escape '\\' or s.summary ilike ${needle} escape '\\'${textsBranch})`;
};

/**
 * Largest-remainder (Hamilton) apportionment of `counts` to 2-decimal percentages that
 * sum to EXACTLY 100.00 when total>0 (else all zero). Naive per-field half-up rounding
 * drifts to 99.99 / 100.01 (M12). Works in hundredths-of-a-percent (the set sums to 10000).
 */
const largestRemainderPct = (counts: readonly number[], total: number): number[] => {
  if (total <= 0) return counts.map(() => 0);
  const scaled = counts.map((n) => (n / total) * 10000);
  const floors = scaled.map((x) => Math.floor(x));
  const deficit = 10000 - floors.reduce((a, b) => a + b, 0);
  const byFrac = scaled
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac);
  for (let k = 0; k < deficit && k < byFrac.length; k++) {
    const entry = byFrac[k];
    if (entry === undefined) break;
    floors[entry.i] = (floors[entry.i] ?? 0) + 1;
  }
  return floors.map((u) => u / 100);
};

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
  if (keys.length !== arity)
    return err(invalidInput('malformed cursor; restart pagination', 'cursor'));
  for (const i of numericIdx) {
    if (!Number.isInteger(Number(keys[i]))) {
      return err(invalidInput('malformed cursor; restart pagination', 'cursor'));
    }
  }
  return ok(keys);
};

/**
 * Extract ONE attrs key as text, and only when it genuinely holds a JSON string.
 *
 * Two guards, both inherited from the `safeAttrs` whitelist this replaced:
 *  - `jsonb_typeof(…) = 'string'` reproduces its primitives-only rule. `->>`
 *    stringifies whatever it finds, so without this an object landing in, say,
 *    `object_of_regulation` would be published to readers as raw JSON. Every key
 *    published here is type `string` on all live rows (Chronos 2026-08-05), so the
 *    guard changes no row today; it is the contract, not a correction.
 *  - `nullif(btrim(…), '')` makes a whitespace-only value read as ABSENT rather
 *    than as a blank label. (No published key holds an empty value today either.)
 *
 * Built with `sql.ref` + `sql.lit` and a fold of `->`, never `sql.raw` (banned in
 * repositories): the column is a quoted reference and each path segment is an
 * escaped literal, so nothing here can be interpolated as SQL text.
 */
const attrText = (
  column: 'b.attrs' | 'v.attrs' | 'm.attrs',
  ...path: readonly [string, ...string[]]
): RawBuilder<string | null> => {
  // Fold `->` over the whole path: `attrs->'procedure'->'caracter'`. Then `#>>'{}'`
  // takes that jsonb value out as text — which, for the string values this guard
  // admits, is the unquoted string.
  const asJson = path.reduce<RawBuilder<unknown>>(
    (acc, key) => sql`${acc}->${sql.lit(key)}`,
    sql.ref(column)
  );
  return sql<string | null>`case when jsonb_typeof(${asJson}) = 'string'
    then nullif(btrim(${asJson}#>>'{}'), '')
    else null
  end`;
};

/**
 * Field selectors reused across queries (dates `::text`, bigint `::text`).
 *
 * NONE of these select the raw `attrs` jsonb. Every published key is extracted by
 * name here, so this list is the privacy gate — see "THE `attrs` RULE" in
 * `core/types.ts` for why the previous select-the-bag-then-whitelist-in-TS design
 * was replaced, AND for the two passthrough bags that rule does not cover (one of
 * them is `'e.docs'` in `getBillEvents`, in this same file).
 */
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
  'm.is_current',
  sql<string | null>`m.mandate_end_date::text`.as('mandate_end_date'),
  'm.mandate_end_reason',
  // The member attrs bag averages 328B of which 82B was ever used; it also carries
  // `senate_current_roster_alias_evidence` (internal match evidence) and eight
  // sibling provenance keys that must never reach a public surface.
  //
  // This projection also fans out further than any other: `ParliamentBallot.member`
  // resolves through `findMember` PER BALLOT, so `ballots(first:500){member{…}}`
  // runs this select 500 times (the N+1 itself is tracked separately). A bill's
  // initiators reach 268. Per-row waste is multiplied by those factors.
  attrText('m.attrs', 'profile_url').as('profile_url'),
  attrText('m.attrs', 'cv_pdf_url').as('cv_pdf_url'),
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
  // E2 source-traceability (§6): the EXACT cdep.ro/senat.ro division page.
  'v.source_url',
  // What the chamber printed for this division — for a division with no bill
  // link, this and the tally are all a card has.
  //
  // COALESCED, and the fallback is the fix for "a filter you cannot see": the
  // vote free-text search matches `source_title` (line ~2162), but only
  // `vote_action` was ever DISPLAYED. So 7,753 divisions were searchable by a
  // label the page never showed — you could match "Verificare prezenta" and get
  // a card carrying only a bill title, with none of your words on it.
  //
  // Safe as a fallback rather than a replacement, measured over all 20,871
  // votes: `vote_action` is present on 11,630 and `source_title` on 19,383, and
  // on every one of the 11,630 where both exist `source_title` CONTAINS
  // `vote_action` (0 exceptions) — it is the same label plus a bill-reference
  // prefix the card already shows. So preferring `vote_action` keeps the
  // shorter, non-redundant text where we have it, and the 7,753 that had
  // nothing gain the chamber's own words. No row loses anything.
  sql<string | null>`coalesce(
    ${attrText('v.attrs', 'vote_action')},
    ${attrText('v.attrs', 'source_title')}
  )`.as('vote_subject'),
  // The division's printed date+time ('DD.MM.YYYY HH:MM', CDep's own TIME_VOT).
  // The only source of a clock time — `vote_date` is a DATE and carries none.
  attrText('v.attrs', 'vote_datetime_text').as('vote_datetime_text'),
  // PRESENCE only. `tally_mismatch` is a jsonb OBJECT holding the per-choice
  // official-vs-recorded split on 925 votes; the internals stay private (§2.6), so
  // the flag is reduced to a boolean HERE and the object never crosses the wire.
  //
  // `jsonb_typeof(…) <> 'null'` and NOT `is not null`: it reproduces the mapper's
  // old `rawAttrs['tally_mismatch'] != null` EXACTLY, including that a JSON-null
  // value reads false. `(attrs->'k') is not null` would flip those rows to true,
  // because `->` returns jsonb 'null' — not SQL NULL — when the key holds a null.
  // Live today all 925 values are objects, so this changes no row; it keeps the
  // predicate correct if the loader ever writes a null.
  sql<boolean>`coalesce(jsonb_typeof(v.attrs->'tally_mismatch') <> 'null', false)`.as(
    'tally_mismatch'
  ),
  // What the chamber was voting ON, for the 8,408 divisions with no bill link
  // and no printed subject — where title and tally are all a card otherwise has.
  voteKindExpr.as('kind'),
  // W1.3 resolution contract. Served alongside the legacy `bill_key` rather than
  // replacing it, so no existing consumer breaks in the same deploy that
  // introduces the honest answer.
  'v.resolution_status',
  'v.resolution_method',
  'v.resolved_display_bill_key',
] as const;

/** Speech projection reused by the offset list AND the cursor connection (dates `::text`). */
const SPEECH_SELECT = [
  's.speech_key',
  's.mandate_key',
  's.speaker_name',
  's.chamber',
  sql<string | null>`s.spoken_at::text`.as('spoken_at'),
  's.title',
  's.summary',
  's.source_url',
  's.source_url_kind',
] as const;

/**
 * The three ADDITIVE canonical pointers (scrapper migration 20260726T140000),
 * appended to the speech projection ONLY when the canonical probe says the columns
 * exist — they are not applied to the live serving DB yet, and selecting a missing
 * column fails at PARSE time, which would break EVERY existing speech query rather
 * than just the canonical read.
 *
 * When absent we still select the three ALIASES, as SQL literals, so the projection
 * keeps a FIXED shape and arity on both kinds of database: one row type, one mapper,
 * no optional-column branching at the call sites. The literals are the honest
 * defaults (`false` / NULL / NULL) — i.e. "not canonical / not available", which is
 * exactly what a pre-migration row is.
 *
 * PREFERENCE IS EXPRESSED, NOT IMPOSED. Canonical contributions are the better read
 * (whole turn + a provable position), and every surface says so — `isCanonical` is on
 * the view model and the SDL/tool descriptions tell clients to prefer it. What we do
 * NOT do is inject `is_canonical desc` into the existing keyset ORDER BY: that would
 * change the legacy list contract and invalidate every in-flight speech cursor (the
 * fhash covers the filter, not the sort columns). Callers that want canonical-only
 * reading go through the stenogram surface, which is canonical by construction.
 */
const speechCanonicalSelect = (hasCanonical: boolean) =>
  [
    sql<boolean>`${hasCanonical ? sql`s.is_canonical` : sql`false`}`.as('is_canonical'),
    sql<string | null>`${hasCanonical ? sql`s.stenogram_session_key` : sql`null::text`}`.as(
      'stenogram_session_key'
    ),
    sql<string | null>`${hasCanonical ? sql`s.stenogram_segment_key` : sql`null::text`}`.as(
      'stenogram_segment_key'
    ),
  ] as const;

/**
 * `speeches.person_id` (scrapper migration 20260727T140000) — the career-stable id
 * behind the per-legislature mandate key.
 *
 * Its OWN probe, deliberately not folded into the canonical one: the two columns
 * come from two different migrations and a database can legitimately have one
 * without the other. Sharing a probe would make a partially-migrated DB either lose
 * a column it has or name one it does not (a PARSE error that would take down every
 * speech read, not just this field).
 *
 * Same shape-preserving literal on the absent path, for the same reason.
 */
const speechPersonSelect = (hasPerson: boolean) =>
  [
    sql<string | null>`${hasPerson ? sql`s.person_id::text` : sql`null::text`}`.as('person_id'),
  ] as const;

// control-population.v2 (user decision 2026-07-22): motions leaked into
// control_items via a shared attachment lane (6 rows) but are a different
// public act — every served control read excludes them. Prod rows retained
// untouched pending the dedicated motions domain (READINESS_TODO T4).
const CONTROL_NO_MOTION = sql`c.control_type is distinct from 'motion'`;

/**
 * PRIVACY (contract §5) — the anonymous surface serves `privacy_class='public'`
 * ONLY, and the predicate is STRICT: `privacy_class` is `text not null default
 * 'public'` with a `check (privacy_class in ('public','restricted'))` on every
 * `parliament.*` base table (prod migration `20260701T171000`, and
 * `20260706T120000` for `speech_texts`), so a NULL cannot exist and the old
 * `coalesce(privacy_class,'public')` was a fail-open no-op. Strict equality is
 * row-for-row identical on prod today and default-DENIES a future NULL/unknown
 * class instead of publishing it.
 */
const SPEECH_PUBLIC = sql`s.privacy_class = 'public'`;

/**
 * THE DEFAULT-SERVING POPULATION RULE for every anonymous speech collection.
 *
 * `parliament.speeches` carries two generations of rows for the same words — LEGACY
 * over-split fragments and CANONICAL whole-turn rows (`canon:` key-space, migration
 * 20260726T140000). Serving both would double-surface every re-derived sitting and
 * inflate member intervention counts and heatmaps by the over-split factor.
 *
 * So a legacy row is SUPPRESSED exactly when the loader has PROVEN where its content
 * now lives: a `speech_redirects` row pointing into a canonical sitting. Equivalence is
 * never inferred from text, speaker name, or date — only from that source-keyed mapping.
 *
 * WHAT THE PREDICATE CONDITIONS ON, AND WHY:
 *  - `s.is_canonical` — a canonical row is always served; it IS the preferred shape.
 *  - a legacy row survives unless a redirect maps it into a **public** sitting:
 *      · `sr.privacy_class='public'` — a restricted redirect is not evidence we may act
 *        on, so the legacy row stays (never suppressed by a row we must not read).
 *      · `ss.privacy_class='public'` — if the canonical SITTING is restricted, its
 *        canonical rows are unservable, so suppressing the legacy row would make the
 *        sitting vanish from the API entirely.
 *  - it does NOT condition on the individual canonical speech row's class. Suppression
 *    is decided at SITTING grain deliberately: a `session_only` redirect proves the
 *    sitting but not the turn, and the canonical sitting may hold several contributions
 *    by that member. Conditioning per-row would keep the legacy fragments of a sitting
 *    that IS canonically served — the double-surfacing this exists to prevent.
 *
 * DIRECTION OF FAILURE. The predicate only ever REMOVES rows, so it cannot expose
 * anything; and it removes only when a public replacement sitting exists, so it cannot
 * silently empty the corpus. A legacy row with no redirect is always retained.
 *
 * Emitted ONLY when BOTH canonical probes pass (the additive `speeches.is_canonical`
 * column AND the two new relations). Pre-migration the predicate is absent entirely and
 * every surface is byte-identical to its legacy self.
 */
const SPEECH_CANONICAL_PREFERRED = sql`(
  s.is_canonical
  or not exists (
    select 1
    from parliament.speech_redirects sr
    join parliament.stenogram_sessions ss on ss.session_key = sr.session_key
    where sr.legacy_speech_key = s.speech_key
      and sr.privacy_class = 'public'
      and ss.privacy_class = 'public'
  )
)`;
/** Same gate on the 1:1 transcript side table (§6) — a text row carries its own class. */
const SPEECH_TEXT_PUBLIC = sql`t.privacy_class = 'public'`;
const CONTROL_PUBLIC = sql`c.privacy_class = 'public'`;
const VOTE_PUBLIC = sql`v.privacy_class = 'public'`;
const INITIATIVE_PUBLIC = sql`mi.privacy_class = 'public'`;
const DECLARATION_PUBLIC = sql`d.privacy_class = 'public'`;

type VotePositionAlias = 'vp' | 'gp';

/**
 * One population rule for every public ballot reader. A position participates
 * when it is the current public derivation; its choice participates only when
 * the derivation confirmed one effective choice.
 */
const votePositionPopulation = (alias: VotePositionAlias): RawBuilder<SqlBool> =>
  sql`${sql.ref(`${alias}.is_current`)} = true and ${sql.ref(`${alias}.privacy_class`)} = 'public'`;
const votePositionHasEffectiveChoice = (alias: VotePositionAlias): RawBuilder<SqlBool> =>
  sql`${sql.ref(`${alias}.position_status`)} = 'confirmed'
      and ${sql.ref(`${alias}.effective_choice`)} is not null`;

const observedChoicesOf = (value: unknown): readonly string[] =>
  Array.isArray(value)
    ? value.filter((choice): choice is string => typeof choice === 'string')
    : [];

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
  attrText('b.attrs', 'status_text').as('status_text'),
  attrText('b.attrs', 'procedure', 'tip_initiativa').as('bill_type'),
  // last_event_date (already ISO YYYY-MM-DD in attrs) — the key the default
  // 'updated_desc' sort uses; surfaced flat so the client can show/verify recency.
  attrText('b.attrs', 'last_event_date').as('last_event_date'),
  // B1 canonicality (§3): is_canonical drives default list visibility; canonical_bill_key
  // points a suppressed Senate twin at its canonical CDep key (null on a canonical row).
  'b.is_canonical',
  'b.canonical_bill_key',
  // ── attrs.procedure: HOW the bill travels ────────────────────────────────
  // Published for the first time here. `procedure` is a jsonb OBJECT, and the old
  // TS whitelist kept primitives only, so these were fetched on every request and
  // silently dropped — acquired, held, and shown nowhere.
  //
  // decision_chamber comes from the COLUMN, not from attrs: it is recomputed
  // whole-table in the loader's `derives` stage, its drift from
  // `attrs.procedure.camera_decizionala` is a blocking gate term (live 0/41,990),
  // and it already maps the source's '-' placeholder to null.
  'b.decision_chamber',
  attrText('b.attrs', 'procedure', 'caracter').as('law_character'),
  // 'da' → true, 'nu' → false, ANYTHING else → null. A future third value must not
  // silently become "not urgent"; null says "the source did not tell us".
  sql<boolean | null>`case lower(${attrText('b.attrs', 'procedure', 'procedura_urgenta')})
    when 'da' then true
    when 'nu' then false
    else null
  end`.as('procedure_urgency'),
  attrText('b.attrs', 'procedure', 'procedura_legislativa').as('procedure_regime'),
  // ── Narrative the source printed ─────────────────────────────────────────
  attrText('b.attrs', 'object_of_regulation').as('object_of_regulation'),
  attrText('b.attrs', 'last_event_description').as('last_event_description'),
  // The other end of the timeline (20,747 bills). It was on the old whitelist and
  // so reached the view model, but no SDL field ever served it — acquired data with
  // no reader, which is the defect this whole change is about. Published now that
  // the cost of a named field is one line.
  attrText('b.attrs', 'first_event_date').as('first_event_date'),
  attrText('b.attrs', 'last_event_source').as('last_event_source'),
  // ── Human-openable source pages ──────────────────────────────────────────
  attrText('b.attrs', 'cdep_project_url').as('cdep_project_url'),
  attrText('b.attrs', 'senate_detail_url').as('senate_detail_url'),
  attrText('b.attrs', 'senate_fisa_url').as('senate_file_url'),
  attrText('b.attrs', 'senate_opinions_url').as('senate_opinions_url'),
  // ── Cross-source identifiers ─────────────────────────────────────────────
  attrText('b.attrs', 'senate_cod').as('senate_cod'),
  // Both stay TEXT. government_e_year is a string in the source; casting it to a
  // number would turn any non-numeric value into a silent null.
  attrText('b.attrs', 'government_e_number').as('government_e_number'),
  attrText('b.attrs', 'government_e_year').as('government_e_year'),
  // ── DERIVED by us, not printed by the chamber ────────────────────────────
  attrText('b.attrs', 'initiator_classification', 'value').as('initiator_type'),
  attrText('b.attrs', 'initiator_classification', 'confidence').as('initiator_type_confidence'),
  attrText('b.attrs', 'initiator_classification', 'method').as('initiator_type_method'),
  sql<string | null>`b.source_updated_at::text`.as('source_updated_at'),
  sql<string | null>`b.updated_at::text`.as('updated_at'),
] as const;

// ── filter helpers (split virtual / physical) ────────────────────────────────

const fieldFilter = (input: FilterInput, name: string): Record<string, unknown> | undefined => {
  // Read as `unknown`: the FilterInput type omits `null`, but a GraphQL nullable
  // input field CAN arrive as `null` at runtime. `null` is `typeof 'object'`, so
  // guard it — else `filter:{field:null}` would be treated as a field-filter object
  // and `stringValues(null)` would crash on `null['eq']` (Codex round-2 #2).
  const v: unknown = input[name];
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
};

/** Pull eq/in string value(s) from a field filter. */
const stringValues = (f: Record<string, unknown> | undefined): { eq?: string; in?: string[] } => {
  if (f === undefined) return {};
  const out: { eq?: string; in?: string[] } = {};
  if (typeof f['eq'] === 'string') out.eq = f['eq'];
  if (Array.isArray(f['in']))
    out.in = (f['in'] as unknown[]).filter((x): x is string => typeof x === 'string');
  return out;
};

/**
 * Resolve a virtual ENUM field's selected values (eq + in), deduped, and VALIDATE
 * each against the allowed set. An unknown value is a clean InvalidInput (400),
 * never a silent empty/full result — the kernel composer can't validate a virtual
 * field, so the repo enforces the domain itself.
 *
 * `eq` and `in` use the kernel's within-field AND semantics: `eq:x` plus an `in`
 * containing x narrows to x; a disjoint or empty `in` matches nothing. The caller
 * emits `sql\`false\`` in that case so a virtual field mirrors physical fields.
 */
export const enumSelection = (
  f: Record<string, unknown> | undefined,
  allowed: readonly string[]
): Result<{ values: string[]; matchNothing: boolean }, ApiError> => {
  const { eq, in: inVals } = stringValues(f);
  const operands = [...(eq !== undefined ? [eq] : []), ...(inVals ?? [])];
  for (const v of new Set(operands)) {
    if (!allowed.includes(v)) {
      return err(
        invalidInput(`unknown value '${v}'; expected one of ${allowed.join(', ')}`, 'filter')
      );
    }
  }

  const values =
    eq !== undefined && inVals !== undefined
      ? inVals.includes(eq)
        ? [eq]
        : []
      : eq !== undefined
        ? [eq]
        : [...new Set(inVals ?? [])];
  return ok({
    values,
    matchNothing: inVals !== undefined && values.length === 0,
  });
};

const containsValue = (f: Record<string, unknown> | undefined): string | undefined => {
  if (f === undefined) return undefined;
  return typeof f['contains'] === 'string' ? f['contains'] : undefined;
};

/** A real calendar day, not merely a string matching the ISO date shape. */
const isValidIsoDay = (value: unknown): value is string => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};

/**
 * Compile one repo-owned date range while preserving the kernel filter law:
 * gte, lte and between operands are AND-composed. The GraphQL Date scalar is
 * deliberately transport-only, so virtual JSON date fields validate here
 * before any value can reach PostgreSQL.
 */
const virtualDateRangeConditions = (
  f: Record<string, unknown> | undefined,
  expression: RawBuilder<unknown>,
  fieldName: string
): Result<RawBuilder<unknown>[], ApiError> => {
  if (f === undefined) return ok([]);
  const conditions: RawBuilder<unknown>[] = [];
  const dateError = (): ApiError =>
    invalidInput(`${fieldName} dates must be valid YYYY-MM-DD values`, fieldName);
  const addLower = (value: unknown): Result<true, ApiError> => {
    if (value === undefined || value === null) return ok(true);
    if (!isValidIsoDay(value)) return err(dateError());
    conditions.push(sql`${expression} >= ${value}`);
    return ok(true);
  };
  const addUpper = (value: unknown): Result<true, ApiError> => {
    if (value === undefined || value === null) return ok(true);
    if (!isValidIsoDay(value)) return err(dateError());
    conditions.push(sql`${expression} <= ${value}`);
    return ok(true);
  };

  const lower = addLower(f['gte']);
  if (lower.isErr()) return err(lower.error);
  const upper = addUpper(f['lte']);
  if (upper.isErr()) return err(upper.error);

  const between: unknown = f['between'];
  if (between !== undefined && between !== null) {
    if (typeof between !== 'object' || Array.isArray(between)) return err(dateError());
    const range = between as Record<string, unknown>;
    const from = addLower(range['from']);
    if (from.isErr()) return err(from.error);
    const to = addUpper(range['to']);
    if (to.isErr()) return err(to.error);
  }
  return ok(conditions);
};

/** A member of a composite field, treating a runtime `null` as absent. */
const compositeMember = (f: Record<string, unknown>, name: string): unknown => {
  const v: unknown = f[name];
  return v === null ? undefined : v;
};

/**
 * `votes.groupVote` (virtual, COMPOSITE) → votes seen through ONE group's ballots.
 * It compiles TWO different predicates, and `choice` picks which:
 *
 *  (A) NO `choice` — PARTICIPATION: every current logical position contributes,
 *      including conflicting and unknown positions.
 *
 *  (B) WITH `choice` — the group's PLURALITY stance on the vote, i.e. (A) plus an
 *      argmax. A group has no stance in the data — its members each cast a ballot —
 *      so the stance is DERIVED as the choice with the MOST confirmed effective
 *      positions for that group on that vote. Conflicts and unknowns never become a
 *      choice. Three rules are visible in the SQL below:
 *
 *  1. PLURALITY over ALL FOUR choices, nu_a_votat included: "the group mostly did
 *     not show up" is a real, honest answer, so a vote CAN be attributed to
 *     nu_a_votat. Computing it over cast ballots only would silently re-attribute
 *     those votes to whatever the handful of attendees did.
 *  2. A TIE matches NEITHER tied choice — hence STRICT `>` against every other
 *     choice, not `>=`. Picking a winner by sort order would invent a position the
 *     group never took. (Real example: cdep:37014, PSD 38 pentru / 38 nu_a_votat.)
 *  3. A group with NO ballots on a vote never matches — the `> 0` guard, since an
 *     ungrouped aggregate over zero rows still yields one all-zeros row.
 *
 * `group_name` is matched EXACTLY (surrounding whitespace trimmed, nothing else):
 * ballot observations and the parliamentGroups nomenclator disagree on vocabulary, and
 * fuzzy-bridging that gap would answer a question the caller did not ask.
 *
 * Returns `null` when the field is absent (nothing to add), an InvalidInput when
 * `group` is missing or `choice` is present but unknown — never a silently dropped
 * predicate, which would widen the result set to every vote. A MISSING `choice` is
 * not a dropped predicate: it is reading (A), which still names a group.
 */
export const buildGroupVoteCondition = (
  f: Record<string, unknown> | undefined
): Result<RawBuilder<unknown> | null, ApiError> => {
  if (f === undefined) return ok(null);
  const rawGroup = compositeMember(f, 'group');
  const rawChoice = compositeMember(f, 'choice');
  // Neither member present (`groupVote:{}`) = the field was not used.
  if (rawGroup === undefined && rawChoice === undefined) return ok(null);

  const group = typeof rawGroup === 'string' ? rawGroup.trim() : '';
  if (group === '') {
    // Still an error when only `choice` arrives: "votes with any pentru ballot" is
    // nearly the whole corpus, so honouring it alone would answer a question nobody
    // asked while looking like a filter.
    return err(
      invalidInput(
        'groupVote.group is required — use the exact group name returned by the vote position',
        'groupVote.group'
      )
    );
  }
  // Correlated on vote_key, using one representative immutable observation only
  // for source group spelling. This prevents repeated captures from inflating the
  // group's tally while preserving exact source vocabulary.
  const scoped = sql`select 1
                     from parliament.vote_positions gp
                     join parliament.vote_observations go
                       on go.observation_key = gp.representative_observation_key
                     where gp.vote_key = v.vote_key
                       and go.group_name = ${group}
                       and gp.group_name_variant_count = 1
                       and ${votePositionPopulation('gp')}`;
  // (A) PARTICIPATION: the group appears on the ballot sheet at all. A bare semi-join
  // — no `having`, so it stops at the first matching row instead of tallying four
  // counts per candidate vote.
  if (rawChoice === undefined) return ok(sql`exists (${scoped})`);

  if (
    typeof rawChoice !== 'string' ||
    !VOTE_CHOICES.includes(rawChoice as (typeof VOTE_CHOICES)[number])
  ) {
    return err(
      invalidInput(`groupVote.choice must be one of ${VOTE_CHOICES.join(', ')}`, 'groupVote.choice')
    );
  }

  const tally = (choice: string): RawBuilder<unknown> =>
    sql`count(*) filter (
      where ${votePositionHasEffectiveChoice('gp')}
        and gp.effective_choice = ${choice}
    )`;
  const target = tally(rawChoice);
  const beatsEveryOther = VOTE_CHOICES.filter((c) => c !== rawChoice).map(
    (c) => sql`${target} > ${tally(c)}`
  );
  // (B) PLURALITY: the same scoped rows, argmaxed.
  return ok(
    sql`exists (${scoped}
                having ${target} > 0 and ${sql.join(beatsEveryOther, sql` and `)})`
  );
};

/**
 * `votes.kind` (virtual) → the ordered vote-kind partition, compiled from the
 * SAME `VOTE_KIND_TITLE_RULES` the GraphQL description is rendered from — the
 * documented regex IS the executed regex, by construction.
 *
 * The shape of every bucket:
 *   - `legislative`      → `v.bill_key is not null` (the COLUMN; votes_bill_idx).
 *   - a title rule       → `v.bill_key is null` AND it fails every EARLIER rule
 *                          AND it matches its own — that "fails every earlier"
 *                          chain is what makes the buckets disjoint instead of
 *                          overlapping (44 non-bill votes match two rules).
 *   - `unclassified`     → `v.bill_key is null` AND it fails EVERY rule. It is a
 *                          served bucket, not a silent remainder: 14.4% of the
 *                          corpus has no usable title signal and a citizen
 *                          filtering the list must be able to see that set.
 *
 * The title is folded (lower + diacritics) exactly like the `q` fallback, so
 * `Prezenţa` and `prezenta` are one needle. No title index exists — this is a
 * sequential scan of a 20,745-row table (~65ms measured, count included), which
 * is why it needs no bound guard, unlike `groupVote`.
 *
 * `foldedVoteTitle` and the SELECTED form of this partition (`voteKindExpr`) are
 * declared near the top of the file — `VOTE_SELECT` needs them at module init.
 */

const voteKindPredicate = (kind: string): RawBuilder<unknown> => {
  if (kind === 'legislative') return sql`v.bill_key is not null`;
  const index = VOTE_KIND_TITLE_RULES.findIndex((r) => r.kind === kind);
  // `unclassified` (index -1 — it has no rule of its own) fails every rule;
  // a title rule fails every EARLIER rule and matches its own.
  const earlier = (
    index === -1 ? VOTE_KIND_TITLE_RULES : VOTE_KIND_TITLE_RULES.slice(0, index)
  ).map((r) => sql`${foldedVoteTitle} !~ ${r.pattern}`);
  const own = VOTE_KIND_TITLE_RULES[index];
  const parts: RawBuilder<unknown>[] = [
    sql`v.bill_key is null`,
    ...earlier,
    ...(own === undefined ? [] : [sql`${foldedVoteTitle} ~ ${own.pattern}`]),
  ];
  return sql`(${sql.join(parts, sql` and `)})`;
};

export const buildVoteKindCondition = (
  f: Record<string, unknown> | undefined
): Result<RawBuilder<unknown> | null, ApiError> => {
  if (f === undefined) return ok(null);
  const eq: unknown = f['eq'] ?? undefined;
  const inList: unknown = f['in'] ?? undefined;
  // Honouring one and dropping the other would answer a different question than
  // the caller asked; the buckets are disjoint, so the two can never be combined
  // into anything but the empty set.
  if (eq !== undefined && inList !== undefined) {
    return err(invalidInput('kind takes eq OR in, not both', 'kind'));
  }
  const raw: unknown = eq ?? inList;
  if (raw === undefined) return ok(null);
  const wanted = Array.isArray(raw) ? (raw as unknown[]) : [raw];
  // `in: []` means "match nothing", never "no filter" — a dropped predicate would
  // widen the list to the whole corpus (kernel #60h, kept in the virtual path).
  if (wanted.length === 0) return ok(sql`false`);
  const kinds: string[] = [];
  for (const value of wanted) {
    if (typeof value !== 'string' || !VOTE_KINDS.includes(value as (typeof VOTE_KINDS)[number])) {
      return err(invalidInput(`kind must be one of ${VOTE_KINDS.join(', ')}`, 'kind'));
    }
    if (!kinds.includes(value)) kinds.push(value);
  }
  // The buckets are disjoint, so a multi-value `in` is a plain OR of them.
  return ok(sql`(${sql.join(kinds.map(voteKindPredicate), sql` or `)})`);
};

export const makeParliamentRepo = (db: Db): ParliamentRepo => {
  // The canonical-stenogram slice (scrapper migration 20260726T140000). Built first
  // because the LEGACY speech projection consults its
  // `canonicalSpeechColumnsAvailable()` probe before selecting the three additive
  // `parliament.speeches` columns.
  const stenogram = makeParliamentStenogramRepo(db);

  /**
   * Which population the speech surfaces may serve right now. Requires BOTH probes:
   * `SPEECH_CANONICAL_PREFERRED` reads the additive `speeches.is_canonical` column AND
   * joins the two new relations, and a missing column or relation fails at PARSE time —
   * so the predicate must not be emitted unless both are queryable. Either probe
   * negative ⇒ exact legacy behaviour.
   */
  const speechPopulation = async (): Promise<ParliamentSpeechPopulation> => {
    const [columns, relations] = await Promise.all([
      stenogram.canonicalSpeechColumnsAvailable(),
      stenogram.stenogramProjectionAvailable(),
    ]);
    return columns && relations ? 'CANONICAL_PREFERRED' : 'LEGACY';
  };

  /**
   * The population predicate for a given applied population, or `[]` pre-migration.
   * Spread into a condition list so the legacy SQL is unchanged, not merely equivalent.
   */
  const populationConds = (
    population: ParliamentSpeechPopulation
  ): readonly RawBuilder<unknown>[] =>
    population === 'CANONICAL_PREFERRED' ? [SPEECH_CANONICAL_PREFERRED] : [];

  // `parliament.speech_texts` is created by a parallel backfill that may be running
  // RIGHT NOW, so we probe USABILITY (can we read full_text?), not mere catalog
  // existence — and we do NOT permanently memoize a negative result: a TRUE result is
  // cached for the process lifetime, but a false/error is cached only for a short
  // negative-TTL so the table appearing mid-process enables transcripts WITHOUT a
  // restart. Single-flight: concurrent callers share one in-flight probe. Raw SQL (not
  // `selectFrom`) keeps the read independent of the Kysely schema types, which do not
  // yet carry the table.
  let speechTextsUsable = false;
  let lastNegativeProbeAt = 0;
  let speechTextsProbeInFlight: Promise<boolean> | undefined;
  const speechTextsExists = (): Promise<boolean> => {
    if (speechTextsUsable) return Promise.resolve(true);
    if (speechTextsProbeInFlight !== undefined) return speechTextsProbeInFlight;
    if (Date.now() - lastNegativeProbeAt < SPEECH_TEXTS_NEG_TTL_MS) return Promise.resolve(false);
    speechTextsProbeInFlight = (async () => {
      try {
        // `limit 0` proves the relation AND the `full_text` column are queryable
        // without reading a row; a missing table/column throws → caught below.
        await sql`select full_text from parliament.speech_texts limit 0`.execute(db);
        speechTextsUsable = true;
        return true;
      } catch {
        lastNegativeProbeAt = Date.now();
        return false;
      } finally {
        speechTextsProbeInFlight = undefined;
      }
    })();
    return speechTextsProbeInFlight;
  };

  /**
   * Same probe shape for the additive vote-coverage relations (scrapper migration
   * 20260727T142000). The counts and the coverage annotation deploy on their own
   * schedules, and a heatmap that hard-fails because its caveat table has not been
   * migrated yet is strictly worse than one that draws the counts and declines to
   * claim what it covers — which is exactly the two-state reading the client had
   * before coverage existed, and it already handles an absent block.
   */
  let voteCoverageUsable = false;
  let lastCoverageNegativeProbeAt = 0;
  let voteCoverageProbeInFlight: Promise<boolean> | undefined;
  const voteCoverageExists = (): Promise<boolean> => {
    if (voteCoverageUsable) return Promise.resolve(true);
    if (voteCoverageProbeInFlight !== undefined) return voteCoverageProbeInFlight;
    if (Date.now() - lastCoverageNegativeProbeAt < SPEECH_TEXTS_NEG_TTL_MS)
      return Promise.resolve(false);
    voteCoverageProbeInFlight = (async () => {
      try {
        // Readiness is about ROWS, not schema. `limit 0` proves only that the
        // migration ran; between the migration and the first derive the tables
        // exist and are empty, and an empty coverage array is indistinguishable
        // from "this API is too old to know" — which the client renders as its
        // two-state grid. Serving an empty annotation in that window would let a
        // never-crawled day read as a confirmed quiet one. So the probe latches
        // positive only once a coverage row is actually there.
        const row = await sql`select 1 as ok from parliament.vote_capture_coverage limit 1`.execute(
          db
        );
        await sql`select gap_date from parliament.vote_capture_gaps limit 0`.execute(db);
        if (row.rows.length === 0) {
          lastCoverageNegativeProbeAt = Date.now();
          return false;
        }
        voteCoverageUsable = true;
        return true;
      } catch {
        lastCoverageNegativeProbeAt = Date.now();
        return false;
      } finally {
        voteCoverageProbeInFlight = undefined;
      }
    })();
    return voteCoverageProbeInFlight;
  };

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

  /** Build the members WHERE: physical (legislature/chamber/current) + virtual (group/judet/q). */
  const buildMemberConditions = (filter: FilterInput): Result<RawBuilder<unknown>[], ApiError> => {
    const physical: Record<string, unknown> = {};
    // `current` is physical (compiles to `m.is_current = $`) — composition/roster
    // ONLY. It is applied HERE (the parliamentMembers list), and separately in
    // listGroupCounts + listGroupMembers; it is NEVER threaded into any
    // vote_records / initiative / control / member-detail / career query.
    for (const key of ['legislature', 'chamber', 'current'] as const) {
      // Read as unknown: FilterInput omits null, but a GraphQL nullable field CAN arrive
      // as null at runtime — skip it (treat null as absent) so the kernel composer never
      // sees a null value (which it would mishandle).
      const v: unknown = filter[key];
      if (v !== undefined && v !== null) physical[key] = v;
    }
    const built = toConditionBuilders(membersFilterSpec, physical as FilterInput);
    if (built.isErr()) return err(built.error);
    const conds: RawBuilder<unknown>[] = [...built.value];

    // group/judet are VIRTUAL (repo-intercepted), but they MUST follow the kernel op
    // contract: multiple ops on one field are ANDed, and an EXPLICIT empty `in: []`
    // matches NOTHING (#60h) — even alongside an `eq`. H6: match the chamber-slug
    // group_id OR the party-name group_name (case-insensitive; the two value sets never
    // overlap). H7: empty in:[] -> sql`false`, not a dropped predicate (which matched all).
    const matchGroupCols = (vals: readonly string[]): RawBuilder<unknown> => {
      const inList = sql.join(
        vals.map((v) => sql`${v.toLowerCase()}`),
        sql`, `
      );
      return sql`(lower(m.group_name) in (${inList}) or lower(m.group_id) in (${inList}))`;
    };
    const groupF = fieldFilter(filter, 'group');
    if (groupF !== undefined) {
      const { eq, in: inVals } = stringValues(groupF);
      if (eq !== undefined) conds.push(matchGroupCols([eq]));
      if (Array.isArray(groupF['in'])) {
        conds.push(inVals !== undefined && inVals.length > 0 ? matchGroupCols(inVals) : sql`false`);
      }
    }

    const matchJudetCol = (vals: readonly string[]): RawBuilder<unknown> => {
      const foldedCol = sql`lower(translate(m.constituency_name, ${FOLD_FROM}, ${FOLD_TO}))`;
      const inList = sql.join(
        vals.map((v) => sql`${foldDiacritics(v)}`),
        sql`, `
      );
      return sql`${foldedCol} in (${inList})`;
    };
    const judetF = fieldFilter(filter, 'judet');
    if (judetF !== undefined) {
      const { eq, in: inVals } = stringValues(judetF);
      if (eq !== undefined) conds.push(matchJudetCol([eq]));
      if (Array.isArray(judetF['in'])) {
        conds.push(inVals !== undefined && inVals.length > 0 ? matchJudetCol(inVals) : sql`false`);
      }
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
    const orderBy =
      sort === 'mandateKey'
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
      return ok({ rows: rows.map((r) => mapMember(r)), total, estimated: false });
    } catch (e) {
      return err(databaseError('listMembers failed', e));
    }
  };

  const findMember = async (
    mandateKey: string
  ): Promise<Result<ParliamentMember | null, ApiError>> => {
    try {
      const row = await db
        .selectFrom('parliament.members as m')
        .select(MEMBER_SELECT)
        .where('m.mandate_key', '=', mandateKey)
        .limit(1)
        .executeTakeFirst();
      return ok(row === undefined ? null : mapMember(row));
    } catch (e) {
      return err(databaseError('findMember failed', e));
    }
  };

  const listGroupCounts = async (
    legislature: string,
    chamber?: string,
    current?: boolean
  ): Promise<Result<readonly ParliamentGroup[], ApiError>> => {
    // SC-1: current=true restricts the composition counts to currently-seated
    // members (camera 330 / senat 134 vs all-mandate 335 / 137). Composition ONLY.
    try {
      if (chamber !== undefined) {
        // Chamber-scoped: per-chamber group rows (groupId = slug(name)-<chamber>).
        let qb = db
          .selectFrom('parliament.members as m')
          .select([
            'm.group_id as group_id',
            'm.group_name as name',
            'm.chamber as chamber',
            sql<string>`count(*)`.as('cnt'),
          ])
          .where('m.legislature', '=', legislature)
          .where('m.chamber', '=', chamber)
          .where('m.group_name', 'is not', null);
        if (current === true) qb = qb.where('m.is_current', '=', true);
        const rows = await qb
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
      let qb = db
        .selectFrom('parliament.members as m')
        .select(['m.group_name as name', sql<string>`count(*)`.as('cnt')])
        .where('m.legislature', '=', legislature)
        .where('m.group_name', 'is not', null);
      if (current === true) qb = qb.where('m.is_current', '=', true);
      const rows = await qb
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
    legislature?: string,
    current?: boolean
  ): Promise<Result<readonly ParliamentMember[], ApiError>> => {
    try {
      // The groupId handed in is EITHER a per-chamber `m.group_id` slug
      // (`aur-senat`, from the chamber-scoped parliamentGroups list) OR a
      // party-level `m.group_name` ("AUR", from the whole-parliament list whose
      // groupId is the chamber-agnostic party name). Match either: group_id and
      // group_name values NEVER collide (verified across all legislatures — 0
      // overlaps), so the OR is unambiguous — a party-level id resolves to its
      // full cross-chamber roster (the bug fix) while a slug stays exact.
      const needle = groupId.toLowerCase();
      let qb = db
        .selectFrom('parliament.members as m')
        .select(MEMBER_SELECT)
        // Case-insensitive match on EITHER group_id slug or group_name; the two value
        // sets never overlap, so the OR is unambiguous. (groupMembers("psd") now == "PSD".)
        .where(sql<boolean>`(lower(m.group_id) = ${needle} or lower(m.group_name) = ${needle})`);
      if (legislature !== undefined) qb = qb.where('m.legislature', '=', legislature);
      // SC-1: current=true → currently-seated roster only (composition/roster ONLY).
      if (current === true) qb = qb.where('m.is_current', '=', true);
      // H9: NO .limit() — the prior .limit(1000) silently truncated a cross-chamber party
      // roster (e.g. PSD = 1,336) with no `total` for the caller to detect the loss. The
      // roster is naturally bounded by the members table (~5,289 rows).
      const rows = await qb.orderBy(sql`m.full_name asc nulls last`).execute();
      return ok(rows.map((r) => mapMember(r)));
    } catch (e) {
      return err(databaseError('listGroupMembers failed', e));
    }
  };

  const findGroup = async (groupId: string): Promise<Result<ParliamentGroup | null, ApiError>> => {
    try {
      // Resolve against the parliamentary_groups REGISTRY (73 rows, slug-keyed) — it
      // covers historical/migrated groups (POT, PIR) that no longer appear in any
      // current member's group_id, which is why ParliamentGroupInterval.group needs it
      // (H1b/M7). Slug-keyed → exactly one row; case-insensitive for safety.
      const row = await db
        .selectFrom('parliament.parliamentary_groups as pg')
        .select(['pg.group_id', 'pg.chamber', 'pg.name'])
        .where(sql<boolean>`lower(pg.group_id) = ${groupId.toLowerCase()}`)
        .limit(1)
        .executeTakeFirst();
      return ok(
        row === undefined
          ? null
          : { groupId: row.group_id, chamber: row.chamber, name: row.name, memberCount: null }
      );
    } catch (e) {
      return err(databaseError('findGroup failed', e));
    }
  };

  const PERSON_SELECT = [
    sql<string>`p.person_id::text`.as('person_id'),
    'p.canonical_name',
    'p.normalized_name',
    sql<string | null>`p.birth_date::text`.as('birth_date'),
    'p.confidence',
    // identity-v2 source-traceability (§6): the canonical CDep mandate page.
    'p.source_url',
  ] as const;

  const findPerson = async (
    personId: string
  ): Promise<Result<ParliamentPerson | null, ApiError>> => {
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

  const listPersonMandates = async (
    personId: string
  ): Promise<Result<readonly ParliamentMember[], ApiError>> => {
    try {
      const rows = await db
        .selectFrom('parliament.members as m')
        .select(MEMBER_SELECT)
        .where(sql`m.person_id`, '=', personId)
        .orderBy('m.legislature', 'desc')
        .execute();
      return ok(rows.map((r) => mapMember(r)));
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

  const listGroupIntervals = async (
    mandateKey: string
  ): Promise<Result<readonly ParliamentGroupInterval[], ApiError>> => {
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
      const rows = await qb
        .groupBy('m.group_name')
        .orderBy('m.group_name', 'asc')
        .limit(capped)
        .execute();
      return ok(
        rows
          .filter((r): r is { group_name: string } => r.group_name !== null)
          .map((r) => ({ value: r.group_name, label: r.group_name }))
      );
    } catch (e) {
      return err(databaseError('resolveGroups failed', e));
    }
  };

  const resolveConstituencies = async (
    qFolded: string,
    limit: number
  ): Promise<Result<readonly string[], ApiError>> => {
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
      const rows = await qb
        .groupBy('m.constituency_name')
        .orderBy('m.constituency_name', 'asc')
        .limit(capped)
        .execute();
      return ok(rows.map((r) => r.constituency_name).filter((c): c is string => c !== null));
    } catch (e) {
      return err(databaseError('resolveConstituencies failed', e));
    }
  };

  const resolveRecipients = async (
    qFolded: string,
    limit: number
  ): Promise<Result<readonly string[], ApiError>> => {
    const capped = Math.min(Math.max(Math.floor(limit), 1), 50);
    if (qFolded.trim() === '') return ok([]);
    try {
      const needle = '%' + escapeLike(qFolded) + '%';
      const rows = await db
        .selectFrom('parliament.control_items as c')
        .select(['c.recipient'])
        .where('c.recipient', 'is not', null)
        .where(sql<SqlBool>`${CONTROL_NO_MOTION}`)
        .where(sql<SqlBool>`${CONTROL_PUBLIC}`)
        .where(
          sql<boolean>`lower(translate(c.recipient, ${FOLD_FROM}, ${FOLD_TO})) like ${needle} escape '\\'`
        )
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

    // lastEventDate (virtual): attrs.last_event_date is the exact current-recency
    // key the list selects/sorts and the hub heatmap groups. Keeping the range
    // in this ONE predicate builder makes a clicked heatmap day reconcile with
    // parliamentBills and parliamentBillActivity by construction.
    const lastEvent = sql`(b.attrs->>'last_event_date')`;
    const lastEventRange = virtualDateRangeConditions(
      fieldFilter(filter, 'lastEventDate'),
      lastEvent,
      'lastEventDate'
    );
    if (lastEventRange.isErr()) return err(lastEventRange.error);
    if (lastEventRange.value.length > 0) {
      conds.push(sql`${lastEvent} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'`);
      conds.push(...lastEventRange.value);
    }

    // hasLaw (virtual): EXISTS a linked (consolidated act) bill_act_links row.
    const hasLaw = fieldFilter(filter, 'hasLaw');
    if (hasLaw !== undefined && typeof hasLaw['eq'] === 'boolean') {
      const exists = sql`exists (select 1 from parliament.bill_act_links bal where bal.bill_key = b.bill_key and bal.resolution_status = 'linked')`;
      conds.push(hasLaw['eq'] ? exists : sql`not (${exists})`);
    }

    // publishedInMo (virtual, H4): EXISTS a linked_mo bill_act_links row (MO-published,
    // not yet consolidated). The third resolution state between hasLaw and unresolved.
    const publishedInMo = fieldFilter(filter, 'publishedInMo');
    if (publishedInMo !== undefined && typeof publishedInMo['eq'] === 'boolean') {
      const exists = sql`exists (select 1 from parliament.bill_act_links bal where bal.bill_key = b.bill_key and bal.resolution_status = 'linked_mo')`;
      conds.push(publishedInMo['eq'] ? exists : sql`not (${exists})`);
    }

    // actId (virtual): reverse lineage — bills that became act X. Validate numeric
    // BEFORE the ::bigint cast (a non-numeric id would surface as a DB 500 — #SF).
    const actId = stringValues(fieldFilter(filter, 'actId'));
    if (actId.eq !== undefined) {
      if (!/^\d+$/u.test(actId.eq))
        return err(invalidInput('actId must be a numeric act_id', 'actId'));
      conds.push(
        sql`exists (select 1 from parliament.bill_act_links bal where bal.bill_key = b.bill_key and bal.target_act_id = ${actId.eq}::bigint)`
      );
    }

    // billType (virtual enum): source-aware initiative kind. CDep evidence =
    // PREFIX on procedure.tip_initiativa; Senate evidence =
    // attrs.initiator_classification.value (Senate register projection; the two
    // paths are non-overlapping on live data — re-verified 2026-07-22; the
    // CDep-only prefix silently omitted 1,548 classifiable Senate bills).
    // Multiple values are OR-ed (in:[government,parliamentary] keeps either).
    // Bills with neither signal match neither value (NULL ILIKE → NULL).
    const billTypeVals = enumSelection(fieldFilter(filter, 'billType'), BILL_TYPES);
    if (billTypeVals.isErr()) return err(billTypeVals.error);
    if (billTypeVals.value.matchNothing)
      conds.push(sql`false`); // explicit in:[] → match nothing (#60h)
    else if (billTypeVals.value.values.length > 0) {
      // Read through `attrText`, the SAME expression BILL_SELECT serves these two
      // keys with. A second, raw `->>` copy here would be free to disagree with the
      // value the card renders — the filter could bucket a bill whose billType reads
      // null, or miss one it displays. (Live today: 0 of 41,990 bills hold a
      // non-string or whitespace-padded value in either key, so this unifies a
      // divergence that has not happened yet.)
      const tipInitiativa = attrText('b.attrs', 'procedure', 'tip_initiativa');
      const initiatorValue = attrText('b.attrs', 'initiator_classification', 'value');
      const pred = (v: string): RawBuilder<unknown> =>
        v === 'government'
          ? sql`(${tipInitiativa} ilike 'Proiect de Lege%'
                 or ${initiatorValue} = 'government')`
          : sql`(${tipInitiativa} ilike 'Propunere legislativa%'
                 or ${initiatorValue} = 'parliamentary')`;
      conds.push(sql`(${sql.join(billTypeVals.value.values.map(pred), sql` or `)})`);
    }

    // status (virtual enum): lifecycle bucket on status_text (v2, 5 disjoint
    // buckets — see BILL_STATUSES in specs.ts for the measured partition).
    // promulgated = became law, in TWO equivalent source phrasings — 'Lege
    // <nr>/…' (these also carry final_law_number) AND 'A devenit Legea <nr>/…'
    // (final_law_number NOT backfilled, so status_text is the ONLY became-law
    // signal). The bucket MUST union both or it silently drops promulgated
    // bills into in_progress — caught by the Codex/GLM dual-model critique.
    // withdrawn/lapsed are terminal buckets split out of in_progress 2026-07-22
    // (they had grown to 34.9% of it after the Senate register expansion).
    // in_progress = NOT(any other bucket) so the partition stays exhaustive.
    const statusVals = enumSelection(fieldFilter(filter, 'status'), BILL_STATUSES);
    if (statusVals.isErr()) return err(statusVals.error);
    if (statusVals.value.matchNothing)
      conds.push(sql`false`); // explicit in:[] → match nothing (#60h)
    else if (statusVals.value.values.length > 0) {
      // Same one-definition rule as billType above: `attrText` is what BILL_SELECT
      // serves `statusText` with, so bucket and card can never read different text.
      const st = sql`lower(coalesce(${attrText('b.attrs', 'status_text')}, ''))`;
      const promulgated = sql`(${st} like 'lege %' or ${st} = 'lege' or ${st} like 'a devenit lege%')`;
      const rejected = sql`${st} like 'respins%'`;
      const withdrawn = sql`(${st} like 'retras%' or ${st} like 'restituit%')`;
      const lapsed = sql`(${st} like 'clasat%' or ${st} like 'procedura legislativa încetat%')`;
      const pred = (v: string): RawBuilder<unknown> => {
        if (v === 'promulgated') return promulgated;
        if (v === 'rejected') return rejected;
        if (v === 'withdrawn') return sql`(${withdrawn} and not (${promulgated} or ${rejected}))`;
        if (v === 'lapsed')
          return sql`(${lapsed} and not (${promulgated} or ${rejected} or ${withdrawn}))`;
        // in_progress
        return sql`not (${promulgated} or ${rejected} or ${withdrawn} or ${lapsed})`;
      };
      conds.push(sql`(${sql.join(statusVals.value.values.map(pred), sql` or `)})`);
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
    // `attrText` again — the list must ORDER BY exactly the value its cards print
    // as 'Actualizat'. No index is lost: there is no expression index on this key
    // (checked on Chronos 2026-08-05), so the sort was already a full expression sort.
    const lastEvent = attrText('b.attrs', 'last_event_date');
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
    // PARLIAMENT_CONTRACT §3 (LOCKED): the default-visible bill list is the B1 CANONICAL
    // set only. Without this the list double-surfaces bicameral bills (22,248 suppressed
    // navetă twins as of the 2026-07-01 finish-wave). Applied to BOTH the rows and the
    // count `where` (shared below). Explicit-key reads (findBill, lineage) stay unfiltered.
    const where = composeWhere([...condsRes.value, sql<boolean>`b.is_canonical`]);
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
          db
            .selectFrom('parliament.bills as b')
            .select(sql<number>`1`.as('one'))
            .where(where)
            .limit(LIST_TOTAL_CAP + 1)
            .as('capped')
        )
        .select(sql<string>`count(*)`.as('cnt'))
        .executeTakeFirst();
      const rawCount = Number(countRow?.cnt ?? 0);
      const estimated = rawCount > LIST_TOTAL_CAP;
      return ok({
        rows: rows.map((r) => mapBill(r)),
        total: estimated ? LIST_TOTAL_CAP : rawCount,
        estimated,
      });
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
      return ok(row === undefined ? null : mapBill(row));
    } catch (e) {
      return err(databaseError('findBill failed', e));
    }
  };

  // Dossier view set (2026-07-22 readiness fix): a canonical bill is a display
  // view, not a complete dossier — its suppressed navetă twin owns its own
  // events/documents/vote links (657k/38k/6.2k platform-wide, panel tie-break).
  // Returns every bill_key whose children belong in the requested bill's dossier:
  //   - the bill itself, always;
  //   - its dup-group siblings ONLY when the group is a RESOLVED PAIR (exactly
  //     2 views, exactly 1 canonical). Ambiguous multi-Senate review groups
  //     (3+ views or 0/2+ canonicals) stay single-view — they are review
  //     clusters, not accepted dossiers, and must never be blended.
  const getBillDossierViewKeys = async (
    billKey: string
  ): Promise<Result<readonly string[], ApiError>> => {
    try {
      const rows = await db
        .selectFrom('parliament.bills as b')
        .select(['b.bill_key', 'b.is_canonical'])
        // dup_review is deliberately UNBOUND in ParliamentBillsTable (internal
        // dedup provenance) — read it as a raw expression, not a binding.
        .select(sql<string | null>`b.dup_review`.as('dup_review'))
        .where(
          sql<SqlBool>`b.dup_group_id is not null and b.dup_group_id = (select b2.dup_group_id from parliament.bills b2 where b2.bill_key = ${billKey})`
        )
        .execute();
      const canonicalCount = rows.filter((r) => r.is_canonical).length;
      // A review mark on ANY member quarantines the WHOLE group. This makes the
      // "dup-review groups are never blended" promise self-enforcing rather
      // than incidental: today only `multi_senate` groups carry a mark and they
      // already fail the pair rule (measured 2026-08-05: 19,078 blending
      // pairs, 0 reviewed; 46 reviewed groups, none pair-shaped), but the
      // CHECK also reserves `law_inconsistent`, and a future 2-row group with
      // that mark and one canonical row would blend silently without this.
      const underReview = rows.some((r) => r.dup_review !== null);
      if (rows.length === 2 && canonicalCount === 1 && !underReview) {
        // Requested view first so downstream merges keep a stable anchor.
        const keys = rows.map((r) => r.bill_key);
        return ok([billKey, ...keys.filter((k) => k !== billKey)]);
      }
      return ok([billKey]);
    } catch (e) {
      return err(databaseError('getBillDossierViewKeys failed', e));
    }
  };

  /**
   * Dossier child reads take the ACCEPTED VIEW SET, not a single key (batching
   * fix, 2026-08-05). A resolved navetă pair used to cost 2 statements per
   * family — 12 for one bill — and on the measured ~23ms API↔DB path (Phoenix →
   * Chronos) that was ~6 sequential waves for one page while the database itself
   * executed 2.4ms. One statement per family halves the waves, and on a list
   * page it removes the per-row × per-view multiplication entirely.
   *
   * `bill_key = any($1)` does NOT preserve the array's order, and the merge laws
   * in BILL_CHILD_FAMILIES ride on requested-view-first: concatenation order for
   * events/documents/actLinks/voteLinks, and dedupe-KEEPS-FIRST for initiators
   * (by mandate_key) and relatedVotes (by vote_key). Both readers below
   * therefore rank by `array_position` FIRST and only then apply the family's
   * own within-view order — without it, "keeps first" would be whatever order
   * the planner happened to emit.
   */
  const anyOfViews = (billKeys: readonly string[], col: string): RawBuilder<SqlBool> =>
    sql<SqlBool>`${sql.ref(col)} = any(${billKeys}::text[])`;

  const viewRank = (billKeys: readonly string[], col: string): RawBuilder<number> =>
    sql<number>`array_position(${billKeys}::text[], ${sql.ref(col)})`;

  const getBillEvents = async (billKeys: readonly string[]) => {
    try {
      // The procedure model is 1:1 with the captured event, so it rides on the
      // same row rather than as a second collection. LEFT JOIN, because an event
      // loaded before the derive last ran is legitimately unclassified and the
      // timeline must still render it.
      //
      // `links` are the edges presented UNDER this step (step_position), NOT the
      // ones whose anchor happens to sit on this row: an anchor found on an
      // attachment belongs to the step that attachment folds into. On prod that
      // carries 206,130 edges up to a step they would otherwise be stranded
      // beneath.
      const rows = await db
        .selectFrom('parliament.bill_events as e')
        .leftJoin('parliament.bill_procedure_steps as s', (join) =>
          join.onRef('s.bill_key', '=', 'e.bill_key').onRef('s.position', '=', 'e.position')
        )
        .select([
          'e.bill_key',
          'e.position',
          sql<string | null>`e.event_date::text`.as('event_date'),
          'e.event_date_text',
          'e.description',
          'e.chamber_code',
          'e.committee',
          'e.vote_idv',
          'e.docs',
          's.row_kind',
          's.parent_position',
          's.step_kind',
          's.actor_kind',
          sql`coalesce((
            select jsonb_agg(jsonb_build_object(
              'linkKind', l.link_kind,
              'targetKey', l.target_key,
              'sourceHref', l.source_href,
              'sourceText', l.source_text,
              'resolutionStatus', l.resolution_status,
              'matchMethod', l.match_method
            ) order by l.link_kind, l.source_href)
            from parliament.bill_step_links l
            where l.bill_key = e.bill_key and l.step_position = e.position
          ), '[]'::jsonb)`.as('links'),
        ])
        .where(anyOfViews(billKeys, 'e.bill_key'))
        .orderBy(viewRank(billKeys, 'e.bill_key'))
        .orderBy('e.position', 'asc')
        .execute();
      return ok(rows.map(mapBillEvent));
    } catch (e) {
      return err(databaseError('getBillEvents failed', e));
    }
  };

  // ── plenary agenda (ordinea de zi) ─────────────────────────────────────────
  //
  // Two rules run through every query here. Items are filtered `is_current`,
  // because the lane retains superseded revisions (107,404 tombstones against
  // 97,348 live rows) and serving a withdrawn order of business as the live one
  // is a correctness bug, not a display nit. And ordering is by date with
  // `sitting_date is null` sorted into its own bucket rather than silently
  // last — an undated sitting has no place in a chronology.

  const agendaSittingsJson = sql`coalesce((
    select jsonb_agg(jsonb_build_object(
      'sittingKey', st.sitting_key,
      'chamber', st.chamber,
      'date', st.sitting_date::text,
      'dateSource', st.sitting_date_source,
      'title', st.title,
      'stenogramSessionKey', case when st.stenogram_ids is null then null
                                  else 'cdep:' || st.stenogram_ids end,
      'resolutionStatus', m.resolution_status
    ) order by st.sitting_date asc nulls last, st.sitting_key asc)
    from parliament.sitting_agenda_sittings m
    join parliament.sittings st on st.sitting_key = m.sitting_key
    where m.agenda_key = a.agenda_key
      and m.privacy_class = 'public'
      and st.privacy_class = 'public'
  ), '[]'::jsonb)`.as('sittings');

  const agendaCounts = [
    // Counts must describe exactly the population the detail read serves, or
    // the header promises points the page will not show.
    sql<number>`(select count(*)::int from parliament.sitting_agenda_items i
      where i.agenda_key = a.agenda_key and i.is_current
        and i.privacy_class = 'public')`.as('item_count'),
    sql<number>`(select count(distinct i.bill_key)::int from parliament.sitting_agenda_items i
      where i.agenda_key = a.agenda_key and i.is_current and i.bill_key is not null
        and i.privacy_class = 'public')`.as('bill_count'),
    // Bills the agenda NAMES, whether or not we hold a dossier for one.
    //
    // `bill_count` answers "how many can I open", which is not the same question
    // and undercounts by exactly the bills too new to have been ingested — 151
    // items across 112 agendas, but concentrated in the freshest agenda, which
    // is the one a list features. The order of business for 27-31 July 2026
    // names six bills and links three.
    sql<number>`(select count(distinct i.bill_label)::int from parliament.sitting_agenda_items i
      where i.agenda_key = a.agenda_key and i.is_current and i.bill_label is not null)`.as(
      'named_bill_count'
    ),
  ];

  const agendaWhere = (filter: ParliamentAgendaFilter | null | undefined): RawBuilder<SqlBool> => {
    const conds: RawBuilder<unknown>[] = [sql`a.privacy_class = 'public'`];
    const chamber = filter?.chamber ?? null;
    if (chamber !== null && chamber !== '') conds.push(sql`a.chamber = ${chamber}`);
    const from = filter?.dateFrom ?? null;
    if (from !== null && from !== '') conds.push(sql`a.approved_date >= ${from}::date`);
    const to = filter?.dateTo ?? null;
    if (to !== null && to !== '') conds.push(sql`a.approved_date <= ${to}::date`);
    const year = filter?.year ?? null;
    if (year !== null) conds.push(sql`extract(year from a.approved_date) = ${year}`);
    // Sitting bounds. An agenda covering a week matches if ANY of its days falls
    // in range, which is what "agendas from March" means to a reader. Unlike the
    // approval bounds above these lose nothing: every agenda has a sitting date,
    // while 391 have no approval date, spread 8%-54% across every year.
    const sittingFrom = filter?.sittingFrom ?? null;
    if (sittingFrom !== null && sittingFrom !== '') {
      conds.push(sql`exists (select 1 from parliament.sitting_agenda_sittings s
        where s.agenda_key = a.agenda_key and s.sitting_date >= ${sittingFrom}::date)`);
    }
    const sittingTo = filter?.sittingTo ?? null;
    if (sittingTo !== null && sittingTo !== '') {
      conds.push(sql`exists (select 1 from parliament.sitting_agenda_sittings s
        where s.agenda_key = a.agenda_key and s.sitting_date <= ${sittingTo}::date)`);
    }
    const sittingYear = filter?.sittingYear ?? null;
    if (sittingYear !== null) {
      conds.push(sql`exists (select 1 from parliament.sitting_agenda_sittings s
        where s.agenda_key = a.agenda_key
          and extract(year from s.sitting_date) = ${sittingYear})`);
    }
    const q = (filter?.q ?? '').trim();
    if (q !== '') {
      const needle = `%${escapeLike(foldDiacritics(q).toLowerCase())}%`;
      conds.push(
        sql`translate(lower(coalesce(a.title, '')), ${FOLD_FROM}, ${FOLD_TO}) like ${needle}`
      );
    }
    return composeWhere(conds);
  };

  const listAgendas = async (
    filter: ParliamentAgendaFilter | null | undefined,
    offset: number,
    limit: number
  ) => {
    try {
      const where = agendaWhere(filter);
      const rows = await db
        .selectFrom('parliament.sitting_agendas as a')
        .select([
          'a.agenda_key',
          'a.chamber',
          'a.title',
          sql<string | null>`a.approved_date::text`.as('approved_date'),
          'a.approved_date_text',
          'a.pdf_url',
          agendaSittingsJson,
          ...agendaCounts,
        ])
        .where(where)
        // Newest SITTING first, not newest approval.
        //
        // Ordering by approval date put the 391 agendas that carry none — 30% of
        // the archive, and 8%-54% of every individual year — in one lump at the
        // very end, so a 2011 plan landed below a 2001 one for no reason a
        // reader could see. Every agenda has a sitting date, so this orders the
        // whole archive on the axis the page is actually about.
        .orderBy(
          sql`(select max(s.sitting_date) from parliament.sitting_agenda_sittings s
                      where s.agenda_key = a.agenda_key) desc nulls last`
        )
        .orderBy('a.agenda_key', 'desc')
        .offset(offset)
        .limit(limit)
        .execute();
      const totalRow = await db
        .selectFrom('parliament.sitting_agendas as a')
        .select(sql<number>`least(count(*), ${LIST_TOTAL_CAP})::int`.as('total'))
        .where(where)
        .executeTakeFirst();
      return ok({
        nodes: rows.map(mapAgenda),
        total: totalRow?.total ?? 0,
      });
    } catch (e) {
      return err(databaseError('listAgendas failed', e));
    }
  };

  const getAgenda = async (agendaKey: string) => {
    try {
      const row = await db
        .selectFrom('parliament.sitting_agendas as a')
        .select([
          'a.agenda_key',
          'a.chamber',
          'a.title',
          sql<string | null>`a.approved_date::text`.as('approved_date'),
          'a.approved_date_text',
          'a.pdf_url',
          agendaSittingsJson,
          ...agendaCounts,
        ])
        .where('a.agenda_key', '=', agendaKey)
        .where(sql<SqlBool>`a.privacy_class = 'public'`)
        .executeTakeFirst();
      if (row === undefined) return ok(null);

      const items = await db
        .selectFrom('parliament.sitting_agenda_items as i')
        .select([
          'i.agenda_item_key',
          'i.row_index',
          'i.item_number_text',
          'i.item_kind',
          'i.bill_key',
          'i.bill_label',
          'i.bill_family',
          'i.title_text',
          'i.description_text',
          'i.law_category',
          'i.senate_disposition',
          sql<string | null>`i.senate_disposition_date::text`.as('senate_disposition_date'),
          'i.committee_rapporteurs',
          'i.procedure_urgency',
          'i.decisional_chamber',
          'i.debate_reservation',
          'i.resolution_status',
          sql`coalesce((
            select jsonb_agg(jsonb_build_object(
              'url', d.document_url,
              'label', d.label,
              'date', d.document_date::text,
              'manifestSide', d.manifest_side
            ) order by d.document_url)
            from parliament.sitting_agenda_item_documents d
            where d.agenda_item_key = i.agenda_item_key
              and d.is_current
              and d.privacy_class = 'public'
          ), '[]'::jsonb)`.as('documents'),
        ])
        .where('i.agenda_key', '=', agendaKey)
        .where('i.is_current', '=', true)
        .where(sql<SqlBool>`i.privacy_class = 'public'`)
        .orderBy('i.row_index', 'asc')
        .execute();

      return ok({ ...mapAgenda(row), items: items.map(mapAgendaItem) });
    } catch (e) {
      return err(databaseError('getAgenda failed', e));
    }
  };

  const getBillScheduling = async (billKey: string) => {
    try {
      const rows = await db
        .selectFrom('parliament.bill_sitting_links as l')
        .innerJoin('parliament.sittings as st', 'st.sitting_key', 'l.sitting_key')
        .innerJoin('parliament.sitting_agendas as a', 'a.agenda_key', 'l.agenda_key')
        .innerJoin('parliament.sitting_agenda_items as i', 'i.agenda_item_key', 'l.agenda_item_key')
        .select([
          'l.agenda_key',
          'l.agenda_item_key',
          'a.title as agenda_title',
          'l.sitting_key',
          sql<string | null>`st.sitting_date::text`.as('sitting_date'),
          'st.sitting_date_source',
          'st.chamber',
          'l.relationship_kind',
          'l.resolution_status',
          'i.item_number_text',
          sql<string | null>`case when st.stenogram_ids is null then null
                                  else 'cdep:' || st.stenogram_ids end`.as('stenogram_session_key'),
        ])
        .where('l.bill_key', '=', billKey)
        // Default-deny across EVERY table the row exposes: a public link must
        // not leak a restricted agenda, sitting or point through its join.
        .where('l.privacy_class', '=', 'public')
        .where('st.privacy_class', '=', 'public')
        .where('a.privacy_class', '=', 'public')
        .where('i.privacy_class', '=', 'public')
        // Only CURRENT points: a bill dropped from a revised order of business
        // must not still read as scheduled.
        .where('i.is_current', '=', true)
        .orderBy(sql`st.sitting_date asc nulls last`)
        .orderBy('l.sitting_key', 'asc')
        .execute();
      return ok(rows.map(mapBillScheduling));
    } catch (e) {
      return err(databaseError('getBillScheduling failed', e));
    }
  };

  const getBillDocuments = async (billKeys: readonly string[]) => {
    try {
      const rows = await db
        .selectFrom('parliament.bill_documents as d')
        .select(['d.bill_key', 'd.url', 'd.label', 'd.kind', 'd.position'])
        .where(anyOfViews(billKeys, 'd.bill_key'))
        .orderBy(viewRank(billKeys, 'd.bill_key'))
        .orderBy('d.position', 'asc')
        // Tiebreak to a TOTAL order: the primary key is (bill_key, url), so
        // `position` alone is not unique within a view (and is nullable). Same
        // nondeterminism class the live differential caught in getBillVoteLinks.
        .orderBy('d.url', 'asc')
        .execute();
      return ok(rows.map(mapBillDocument));
    } catch (e) {
      return err(databaseError('getBillDocuments failed', e));
    }
  };

  const getBillInitiators = async (
    billKeys: readonly string[]
  ): Promise<Result<readonly ParliamentMember[], ApiError>> => {
    try {
      // H10: select the FULL member columns and map via mapMember, so an initiator
      // reached through a bill has the SAME shape as parliamentMember(s) —
      // legislature/normalizedName/constituencyName/birthDate/profileUrl plus the nested
      // group/person/interval resolvers. The set is NOT filtered by is_current
      // (attribution is never gated; a superseded/deceased initiator is kept).
      // Per-view cap, preserved exactly under batching. It does not bite today
      // (largest real bill: 268 initiators, measured 2026-08-05) but it is kept
      // PER VIEW rather than shared across the pair, so the day a bill does
      // exceed it the paired dossier truncates each view independently instead
      // of letting the requested view starve its twin.
      const ranked = db
        .selectFrom('parliament.member_initiatives as mi')
        .innerJoin('parliament.members as m', 'm.mandate_key', 'mi.mandate_key')
        .select(MEMBER_SELECT)
        .select(viewRank(billKeys, 'mi.bill_key').as('view_rank'))
        .select(
          // mandate_key tiebreaks to a TOTAL order: two members can share a
          // full_name (and it is nullable), so name alone leaves both the served
          // order and the cap's row choice to the planner.
          sql<number>`row_number() over (partition by mi.bill_key order by m.full_name asc, m.mandate_key asc)`.as(
            'view_row'
          )
        )
        .where(anyOfViews(billKeys, 'mi.bill_key'));
      const rows = await db
        .selectFrom(ranked.as('t'))
        .selectAll()
        .where('t.view_row', '<=', BILL_CHILD_PER_VIEW_LIMIT)
        .orderBy('t.view_rank')
        .orderBy('t.full_name', 'asc')
        .orderBy('t.mandate_key', 'asc')
        .execute();
      return ok(rows.map((r) => mapMember(r as MemberRow)));
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
    target_mo_act_key: string | null;
    resolution_status: string;
    confidence_label: string | null;
    primary_method: string | null;
  }): ParliamentBillActLink => ({
    relationshipKind: r.relationship_kind,
    targetActId: r.target_act_id,
    targetActType: r.target_act_type,
    targetActNumber: r.target_act_number,
    targetActYear: r.target_act_year,
    targetMoActKey: r.target_mo_act_key,
    resolutionStatus: r.resolution_status,
    confidenceLabel: r.confidence_label ?? 'none',
    primaryMethod: r.primary_method ?? 'unknown',
  });

  const getBillActLinks = async (
    billKeys: readonly string[]
  ): Promise<Result<readonly ParliamentBillActLink[], ApiError>> => {
    try {
      const rows = await db
        .selectFrom('parliament.bill_act_links as bal')
        .select([
          'bal.relationship_kind',
          sql<string | null>`bal.target_act_id::text`.as('target_act_id'),
          'bal.target_act_type',
          'bal.target_act_number',
          'bal.target_act_year',
          'bal.target_mo_act_key',
          'bal.resolution_status',
          'bal.confidence_label',
          'bal.primary_method',
        ])
        .where(anyOfViews(billKeys, 'bal.bill_key'))
        .orderBy(viewRank(billKeys, 'bal.bill_key'))
        // Total order WITHIN a view, matching `bill_act_links_current_uq` minus
        // its leading bill_key. Act links carry no natural sequence, so before
        // this the served order was whatever plan the planner picked — stable
        // by luck under a single-key index scan, and observably NOT stable once
        // the read batches both views. An observation list the client renders
        // in order must not reshuffle between requests.
        .orderBy(sql`bal.relationship_kind`)
        .orderBy(sql`coalesce(bal.target_act_type, '')`)
        .orderBy(sql`coalesce(bal.target_act_number, '')`)
        .orderBy(sql`coalesce(bal.target_act_year, 0)`)
        .orderBy(sql`coalesce(bal.target_issuer_slug, '')`)
        .execute();
      return ok(rows.map(mapActLink));
    } catch (e) {
      return err(databaseError('getBillActLinks failed', e));
    }
  };

  const getBillVoteLinks = async (
    billKeys: readonly string[]
  ): Promise<Result<readonly ParliamentBillVoteLink[], ApiError>> => {
    try {
      const rows = await db
        .selectFrom('parliament.bill_vote_links as bvl')
        .select([
          'bvl.vote_key',
          'bvl.bill_key',
          'bvl.role',
          'bvl.resolution_status',
          'bvl.confidence_label',
        ])
        .where(anyOfViews(billKeys, 'bvl.bill_key'))
        // 'retracted' means the resolver no longer derives this edge. Excluded
        // rather than filtered to 'linked' because this surface deliberately
        // EXPOSES resolutionStatus — a candidate/ambiguous edge is informative
        // evidence, a retracted one is a claim we have withdrawn.
        .where('bvl.resolution_status', '!=', 'retracted')
        .orderBy(viewRank(billKeys, 'bvl.bill_key'))
        // Total order WITHIN a view: `bill_vote_links_current_uq` is
        // (vote_key, coalesce(bill_key,'')), so vote_key alone is unique once
        // bill_key is fixed. Added with the batching change because the live
        // differential caught this family — and only this family — returning
        // the same 12 rows in a different order for senat:68-2017 once both
        // views were read in one statement. There was never a within-view
        // ORDER BY; the old order was a planner accident.
        .orderBy('bvl.vote_key', 'asc')
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
  /**
   * The edge set of ONE division. Served by `bill_vote_links_current_uq`, the
   * unique index on (vote_key, coalesce(bill_key,'')) — its leading column is
   * vote_key, so no new index is needed (verified on prod: Index Scan, 0.12ms).
   *
   * Unbounded on purpose: the observed maximum is two bills per vote, so a LIMIT
   * would be a cap with nothing to cap.
   */
  const getVoteLinks = async (
    voteKey: string
  ): Promise<Result<readonly ParliamentBillVoteLink[], ApiError>> => {
    try {
      const rows = await db
        .selectFrom('parliament.bill_vote_links as bvl')
        .select([
          'bvl.vote_key',
          'bvl.bill_key',
          'bvl.role',
          'bvl.resolution_status',
          'bvl.confidence_label',
        ])
        .where('bvl.vote_key', '=', voteKey)
        // See getBillVoteLinks: withdrawn claims are excluded, other statuses
        // are surfaced with their status intact.
        .where('bvl.resolution_status', '!=', 'retracted')
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
      return err(databaseError('getVoteLinks failed', e));
    }
  };

  const buildVoteConditions = (filter: FilterInput): Result<RawBuilder<unknown>[], ApiError> => {
    const physical: Record<string, unknown> = {};
    for (const key of ['chamber', 'outcome', 'voteDate', 'billKey'] as const) {
      // Read as unknown: FilterInput omits null, but a GraphQL nullable field CAN arrive
      // as null at runtime — skip it (treat null as absent) so the kernel composer never
      // sees a null value (which it would mishandle).
      const v: unknown = filter[key];
      if (v !== undefined && v !== null) physical[key] = v;
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

    // groupVote (virtual, COMPOSITE): the group's PLURALITY stance on the vote.
    const groupVote = buildGroupVoteCondition(fieldFilter(filter, 'groupVote'));
    if (groupVote.isErr()) return err(groupVote.error);
    if (groupVote.value !== null) conds.push(groupVote.value);

    // kind (virtual): the ordered bill_key + title-regex partition.
    const kind = buildVoteKindCondition(fieldFilter(filter, 'kind'));
    if (kind.isErr()) return err(kind.error);
    if (kind.value !== null) conds.push(kind.value);
    return ok(conds);
  };

  const listVotes = async (
    filter: FilterInput,
    sort: string,
    dir: 'asc' | 'desc',
    page: CursorPageRequest
  ): Promise<
    Result<CursorPage<ParliamentVote> & { total: number; totalEstimated: boolean }, ApiError>
  > => {
    const condsRes = buildVoteConditions(filter);
    if (condsRes.isErr()) return err(condsRes.error);
    // baseConds = the FILTERED slice, which drives the capped total; the keyset
    // predicate below is added ON TOP for the page and MUST NOT touch the count
    // (else `total` would shrink page by page). Same split as listSpeeches.
    // §2.6 default-deny: the list was the ONE vote reader without VOTE_PUBLIC —
    // dormant while all 20,745 live votes are public, fail-open the moment one
    // is not. Applied to baseConds so the page AND the total share it.
    const baseConds = [...condsRes.value, VOTE_PUBLIC];
    const conds = [...baseConds];
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
      // Capped count (the listSpeeches/listBills pattern): count(*) over a LIMIT
      // cap+1 subselect, issued CONCURRENTLY with the page query. Measured on prod
      // 2026-07-28: 7.6ms unfiltered, 1.1ms for kind:legislative, 65ms for a title
      // rule — and 330-540ms for the heaviest ALLOWED groupVote filter (a
      // chamber-only bound), where the page query alone already costs 344-515ms
      // because its ORDER BY forces the same correlated aggregate over the same
      // candidate set. The count therefore adds latency only up to the max of the
      // two, never a second full pass.
      const [rows, countRow] = await Promise.all([
        db
          .selectFrom('parliament.votes as v')
          .select(VOTE_SELECT)
          .where(where)
          .orderBy(order)
          .limit(limit + 1)
          .execute(),
        db
          .selectFrom(
            db
              .selectFrom('parliament.votes as v')
              .select(sql<number>`1`.as('one'))
              .where(composeWhere(baseConds))
              .limit(LIST_TOTAL_CAP + 1)
              .as('capped')
          )
          .select(sql<string>`count(*)`.as('cnt'))
          .executeTakeFirst(),
      ]);
      const hasMore = rows.length > limit;
      const sliced = hasMore ? rows.slice(0, limit) : rows;
      const items = sliced.map((r) => mapVote(r));
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
      const rawCount = Number(countRow?.cnt ?? 0);
      const totalEstimated = rawCount > LIST_TOTAL_CAP;
      return ok({
        items,
        next,
        total: totalEstimated ? LIST_TOTAL_CAP : rawCount,
        totalEstimated,
      });
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
        .where('v.privacy_class', '=', 'public')
        .limit(1)
        .executeTakeFirst();
      return ok(row === undefined ? null : mapVote(row));
    } catch (e) {
      return err(databaseError('findVote failed', e));
    }
  };

  /**
   * Chamber-scope per-day division counts + the capture coverage behind them.
   *
   * Reuses `buildVoteConditions` VERBATIM so the heatmap and the list under it
   * share one predicate builder and can never describe different row sets. The
   * grain is the DIVISION (one `votes` row) — at chamber scope a ballot count
   * would answer a different question in the same pixels.
   *
   * Two partitions of `total` come off ONE scan of a 20,745-row table on the
   * (chamber, vote_date desc) index; the second partition is free.
   */
  const voteActivity = async (
    year: number,
    filter: FilterInput
  ): Promise<Result<ParliamentVoteActivity, ApiError>> => {
    const condsRes = buildVoteConditions(filter);
    if (condsRes.isErr()) return err(condsRes.error);
    const baseConds = [...condsRes.value, VOTE_PUBLIC];
    const yearStart = `${String(year)}-01-01`;
    const yearEnd = `${String(year)}-12-31`;
    const daysWhere = composeWhere([
      ...baseConds,
      sql`v.vote_date >= ${yearStart}`,
      sql`v.vote_date <= ${yearEnd}`,
    ]);
    // availableYears is NOT year-bounded: it tells the client which years hold
    // divisions at all. It can only ever mean that — which is why an un-crawled
    // decade is made askable by coverage.sourceAvailableFrom, not by this list.
    //
    // It is also NOT filter-bounded, for the same reason. It drives the year
    // picker, so applying the caller's filter both contradicts the sentence above
    // (a year the reader can still navigate to would vanish the moment they typed
    // a search) and puts an unbounded, correlated scan of the 4.16M-row ballot
    // table behind every keystroke, since `q`/`groupVote` reach vote_records and
    // nothing here bounds the year. Privacy is the only predicate it keeps.
    const yearsWhere = composeWhere([VOTE_PUBLIC, sql`v.vote_date is not null`]);

    // Coverage is scoped to the chambers actually asked for (all of them when
    // the filter names none), because a reader filtered to the Senate must not
    // be told about the Chamber's crawl window.
    const chamberSel = stringValues(fieldFilter(filter, 'chamber'));
    const chambers = [
      ...new Set([
        ...(chamberSel.eq !== undefined ? [chamberSel.eq] : []),
        ...(chamberSel.in ?? []),
      ]),
    ];
    const coverageWhere =
      chambers.length > 0
        ? composeWhere([sql`c.chamber = any(${chambers}::text[])`])
        : composeWhere([]);

    const coverageAvailable = await voteCoverageExists();
    try {
      const [dayRows, yearRows, coverageRows] = await Promise.all([
        db
          .selectFrom('parliament.votes as v')
          .select([
            sql<string>`v.vote_date::text`.as('date'),
            sql<string>`count(*)`.as('total'),
            sql<string>`count(*) filter (where v.outcome = 'adoptat')`.as('adoptat'),
            sql<string>`count(*) filter (where v.outcome = 'respins')`.as('respins'),
            sql<string>`count(*) filter (where v.outcome is null)`.as('fara_rezultat'),
            sql<string>`count(*) filter (where v.chamber = 'camera_deputatilor')`.as('camera'),
            sql<string>`count(*) filter (where v.chamber = 'senat')`.as('senat'),
            sql<string>`count(*) filter (where v.chamber = 'comun')`.as('comun'),
          ])
          .where(daysWhere)
          .groupBy('v.vote_date')
          .orderBy('v.vote_date', 'asc')
          .execute(),
        db
          .selectFrom('parliament.votes as v')
          .select(sql<number>`extract(year from v.vote_date)::int`.as('year'))
          .distinct()
          .where(yearsWhere)
          .orderBy(sql`1`, 'asc')
          .execute(),
        !coverageAvailable
          ? Promise.resolve([])
          : db
              .selectFrom('parliament.vote_capture_coverage as c')
              .select([
                'c.chamber',
                'c.source_system',
                'c.scope',
                'c.source_url',
                sql<string | null>`c.source_available_from::text`.as('source_available_from'),
                sql<string>`c.observed_from::text`.as('observed_from'),
                sql<string>`c.observed_through::text`.as('observed_through'),
                // NULLable: no settled prefix is a real state, and it must not be
                // read as "everything up to observed_from is confirmed".
                sql<string | null>`c.finalized_through::text`.as('finalized_through'),
                sql<string>`c.as_of::text`.as('as_of'),
                // upper(r) - 1: Postgres canonicalises daterange to half-open
                // [from, to+1), so surfacing upper() verbatim would publish one day
                // of coverage we do not have.
                sql<
                  { from: string; to: string }[]
                >`coalesce((select jsonb_agg(jsonb_build_object('from', lower(r)::text, 'to', (upper(r) - 1)::text) order by lower(r)) from unnest(c.ranges) r), '[]'::jsonb)`.as(
                  'ranges'
                ),
                sql<
                  { date: string; status: string; reason: string | null }[]
                >`coalesce((select jsonb_agg(jsonb_build_object('date', g.gap_date::text, 'status', upper(g.status), 'reason', g.reason) order by g.gap_date) from parliament.vote_capture_gaps g where g.chamber = c.chamber and g.source_system = c.source_system), '[]'::jsonb)`.as(
                  'gaps'
                ),
              ])
              .where(coverageWhere)
              .orderBy('c.chamber', 'asc')
              .orderBy('c.source_system', 'asc')
              .execute(),
      ]);

      const days = dayRows.map((r) => ({
        date: r.date,
        total: Number(r.total),
        adoptat: Number(r.adoptat),
        respins: Number(r.respins),
        faraRezultat: Number(r.fara_rezultat),
        camera: Number(r.camera),
        senat: Number(r.senat),
        comun: Number(r.comun),
      }));
      const coverage = coverageRows.map((r) => ({
        chamber: r.chamber,
        sourceSystem: r.source_system,
        scope: r.scope,
        sourceUrl: r.source_url,
        sourceAvailableFrom: r.source_available_from,
        observedFrom: r.observed_from,
        observedThrough: r.observed_through,
        finalizedThrough: r.finalized_through,
        asOf: r.as_of,
        ranges: r.ranges,
        gaps: r.gaps.map((g) => ({
          date: g.date,
          status: g.status as ParliamentVoteGapStatus,
          reason: g.reason,
        })),
      }));
      return ok({ year, days, availableYears: yearRows.map((r) => r.year), coverage });
    } catch (e) {
      return err(databaseError('voteActivity failed', e));
    }
  };

  const billActivity = async (
    year: number,
    filter: FilterInput
  ): Promise<Result<ParliamentBillActivity, ApiError>> => {
    const condsRes = buildBillConditions(filter);
    if (condsRes.isErr()) return err(condsRes.error);
    // The SAME rows parliamentBills pages: caller's filter + canonical-only.
    // The day key is attrs.last_event_date — the key the default updated_desc
    // sort reads — stored as ISO YYYY-MM-DD text, so the year bound is a text
    // range plus a fixed-width shape guard (a malformed value like '2026-1-5'
    // would otherwise sort inside the range and group as its own day; the
    // guard checks SHAPE, not calendar validity — '2026-02-31' passes, exactly
    // as the Date scalar and the client accept it).
    const lastEvent = sql`(b.attrs->>'last_event_date')`;
    const wellFormed = sql`${lastEvent} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'`;
    const yearStart = `${String(year)}-01-01`;
    const yearEnd = `${String(year)}-12-31`;
    const daysWhere = composeWhere([
      ...condsRes.value,
      sql<boolean>`b.is_canonical`,
      wellFormed,
      sql`${lastEvent} >= ${yearStart}`,
      sql`${lastEvent} <= ${yearEnd}`,
    ]);
    // availableYears: NOT requested-year-bounded and NOT filter-bounded — it
    // drives the year picker, so a year the reader can still navigate to must
    // not vanish the moment they type a search (same law as voteActivity).
    // It keeps two predicates only: canonical-only (the default-visibility
    // rule, not a caller choice) and the SERVABLE year range — the picker must
    // never advertise a year the usecase's 1990–2100 guard would then reject.
    const yearsWhere = composeWhere([
      sql<boolean>`b.is_canonical`,
      wellFormed,
      sql`${lastEvent} >= '1990-01-01'`,
      sql`${lastEvent} <= '2100-12-31'`,
    ]);
    try {
      const [dayRows, yearRows] = await Promise.all([
        db
          .selectFrom('parliament.bills as b')
          .select([
            sql<string>`(b.attrs->>'last_event_date')`.as('date'),
            sql<string>`count(*)`.as('total'),
          ])
          .where(daysWhere)
          .groupBy(sql`(b.attrs->>'last_event_date')`)
          .orderBy(sql`1`, 'asc')
          .execute(),
        db
          .selectFrom('parliament.bills as b')
          .select(
            sql<number>`substring((b.attrs->>'last_event_date') from 1 for 4)::int`.as('year')
          )
          .distinct()
          .where(yearsWhere)
          .orderBy(sql`1`, 'asc')
          .execute(),
      ]);
      return ok({
        year,
        days: dayRows.map((r) => ({ date: r.date, total: Number(r.total) })),
        availableYears: yearRows.map((r) => r.year),
      });
    } catch (e) {
      return err(databaseError('billActivity failed', e));
    }
  };

  const listVotesForBill = async (
    billKeys: readonly string[]
  ): Promise<Result<readonly ParliamentVote[], ApiError>> => {
    try {
      // The 500 cap is PER VIEW, not per request — batching the accepted view
      // set into one statement must not silently turn it into a shared budget
      // (measured 2026-08-05: max 425 votes on any one bill, 0 bills over the
      // cap, so this is a guard rather than live truncation — but a shared
      // budget would change WHICH rows survive the day that stops being true).
      const ranked = db
        .selectFrom('parliament.votes as v')
        .select(VOTE_SELECT)
        .select(viewRank(billKeys, 'v.bill_key').as('view_rank'))
        .select(
          // vote_key tiebreaks to a TOTAL order (votes_pkey): vote_date alone
          // ties freely, which would make BOTH the served order and — the day
          // the cap bites — WHICH rows survive it nondeterministic.
          sql<number>`row_number() over (partition by v.bill_key order by v.vote_date asc, v.vote_key asc)`.as(
            'view_row'
          )
        )
        .where(anyOfViews(billKeys, 'v.bill_key'))
        .where('v.privacy_class', '=', 'public');
      const rows = await db
        .selectFrom(ranked.as('t'))
        .selectAll()
        .where('t.view_row', '<=', BILL_CHILD_PER_VIEW_LIMIT)
        .orderBy('t.view_rank')
        // `vote_date` here is VOTE_SELECT's `::text` projection, so this sorts
        // lexically while the window above ranks the raw date. Equivalent under
        // ISO dates (which is how every date on this surface is served), and
        // the vote_key tiebreak makes the tie behaviour identical either way.
        .orderBy('t.vote_date', 'asc')
        .orderBy('t.vote_key', 'asc')
        .execute();
      return ok(rows.map((r) => mapVote(r as VoteRow)));
    } catch (e) {
      return err(databaseError('listVotesForBill failed', e));
    }
  };

  // Parent-bound fhash: a ballots cursor is bound to its vote_key (Codex #2).
  const ballotFhash = (voteKey: string): string => filterHash(`ballots:${voteKey}`);

  const listVoteRecords = async (
    voteKey: string,
    page: CursorPageRequest
  ): Promise<Result<CursorPage<ParliamentBallot>, ApiError>> => {
    const limit = Math.min(Math.max(page.first, 1), PARLIAMENT_BALLOT_PAGE_LIMIT);
    const fhash = ballotFhash(voteKey);
    const conds: RawBuilder<unknown>[] = [
      sql`vp.vote_key = ${voteKey}`,
      votePositionPopulation('vp'),
    ];
    if (page.after !== undefined) {
      const dec = decodeCursor(page.after, { sort: 'rowIndex', dir: 'asc', fhash });
      if (dec.isErr()) return err(dec.error);
      const keys = requireCursorKeys(dec.value.keys, 2, [0]);
      if (keys.isErr()) return err(keys.error);
      const [rowIndex = '0', positionKey = ''] = keys.value;
      conds.push(
        sql`(vo.source_row_index, vp.position_key) > (${Number(rowIndex)}, ${positionKey})`
      );
    }
    try {
      // One current logical position per ballot group; the representative
      // observation supplies only source-audit fields.
      const rows = await db
        .selectFrom('parliament.vote_positions as vp')
        .innerJoin(
          'parliament.vote_observations as vo',
          'vo.observation_key',
          'vp.representative_observation_key'
        )
        .leftJoin('parliament.members as m', 'm.mandate_key', 'vp.mandate_key')
        .select([
          'vp.position_key',
          'vo.source_row_index',
          'vo.member_name',
          'vo.group_name',
          'vp.effective_choice',
          'vp.position_status',
          'vp.observation_count',
          'vp.observed_choices',
          'vp.group_name_variant_count',
          'vp.mandate_key',
          'vo.match_method',
          'm.constituency_name',
        ])
        .where(composeWhere(conds))
        .orderBy('vo.source_row_index', 'asc')
        .orderBy('vp.position_key', 'asc')
        .limit(limit + 1)
        .execute();
      const hasMore = rows.length > limit;
      const sliced = hasMore ? rows.slice(0, limit) : rows;
      const items: ParliamentBallot[] = sliced.map((r) => ({
        positionKey: r.position_key,
        rowIndex: r.source_row_index,
        memberName: r.member_name,
        // Repeated source captures can disagree on the member's group even
        // when their choice agrees. Do not publish an arbitrary representative
        // spelling as an attributed group.
        groupName: r.group_name_variant_count === 1 ? r.group_name : null,
        choice: r.effective_choice,
        positionStatus: r.position_status as ParliamentBallot['positionStatus'],
        observationCount: r.observation_count,
        observedChoices: observedChoicesOf(r.observed_choices),
        mandateKey: r.mandate_key,
        matchMethod: r.match_method,
        constituencyName: r.constituency_name,
      }));
      const last = sliced[sliced.length - 1];
      const next =
        hasMore && last !== undefined
          ? buildNextCursor({
              sort: 'rowIndex',
              dir: 'asc',
              fhash,
              lastKeys: [last.source_row_index, last.position_key],
            })
          : null;
      return ok({ items, next });
    } catch (e) {
      return err(databaseError('listVoteRecords failed', e));
    }
  };

  const voteGroupBreakdown = async (
    voteKey: string
  ): Promise<Result<readonly ParliamentVoteGroupBreakdown[], ApiError>> => {
    try {
      const rows = await db
        .selectFrom('parliament.vote_positions as vp')
        .innerJoin(
          'parliament.vote_observations as vo',
          'vo.observation_key',
          'vp.representative_observation_key'
        )
        .select([
          'vo.group_name',
          sql<string>`count(*) filter (
            where ${votePositionHasEffectiveChoice('vp')}
              and vp.effective_choice = 'pentru'
          )`.as('pentru'),
          sql<string>`count(*) filter (
            where ${votePositionHasEffectiveChoice('vp')}
              and vp.effective_choice = 'impotriva'
          )`.as('impotriva'),
          sql<string>`count(*) filter (
            where ${votePositionHasEffectiveChoice('vp')}
              and vp.effective_choice = 'abtinere'
          )`.as('abtinere'),
          sql<string>`count(*) filter (
            where ${votePositionHasEffectiveChoice('vp')}
              and vp.effective_choice = 'nu_a_votat'
          )`.as('nu_a_votat'),
          sql<string>`count(*) filter (
            where vp.position_status = 'conflicting_choice'
          )`.as('conflicting'),
          sql<string>`count(*) filter (
            where vp.position_status in ('unknown_marker', 'identity_conflict')
          )`.as('unknown'),
        ])
        .where('vp.vote_key', '=', voteKey)
        .where(votePositionPopulation('vp'))
        .where('vp.group_name_variant_count', '=', 1)
        .groupBy('vo.group_name')
        .orderBy(sql`count(*) desc`)
        .execute();
      return ok(
        rows.map((r) => ({
          groupName: r.group_name,
          pentru: Number(r.pentru),
          impotriva: Number(r.impotriva),
          abtinere: Number(r.abtinere),
          nuAVotat: Number(r.nu_a_votat),
          conflicting: Number(r.conflicting),
          unknown: Number(r.unknown),
        }))
      );
    } catch (e) {
      return err(databaseError('voteGroupBreakdown failed', e));
    }
  };

  const ballotResolution = async (voteKey: string): Promise<Result<BallotResolution, ApiError>> => {
    try {
      const row = await db
        .selectFrom('parliament.vote_positions as vp')
        .select([
          sql<string>`count(*)`.as('total'),
          sql<string>`count(vp.mandate_key)`.as('resolved'),
        ])
        .where('vp.vote_key', '=', voteKey)
        .where(votePositionPopulation('vp'))
        .executeTakeFirst();
      return ok({ total: Number(row?.total ?? 0), resolved: Number(row?.resolved ?? 0) });
    } catch (e) {
      return err(databaseError('ballotResolution failed', e));
    }
  };

  // ── member activity (parented by mandate_key) ─────────────────────────────────
  const listMemberVotes = async (
    mandateKey: string,
    page: CursorPageRequest,
    filter: FilterInput = {}
  ): Promise<Result<CursorPage<ParliamentMemberVote> & { total: number }, ApiError>> => {
    const limit = Math.min(Math.max(page.first, 1), 100);
    const fhash = memberVotesFhash(mandateKey, filter);
    // Spec conditions (voteDate/chamber/outcome on `v`, confirmed choice on `vp`) AND the
    // mandate bound — ANDed into the same WHERE. Non-virtual spec, so the filter
    // compiles directly.
    const built = toConditionBuilders(memberVotesFilterSpec, filter);
    if (built.isErr()) return err(built.error);
    const where = composeWhere([
      sql`vp.mandate_key = ${mandateKey}`,
      votePositionPopulation('vp'),
      VOTE_PUBLIC,
      ...built.value,
    ]);
    // Materialize the member's bounded ballot set ⋈ votes; stable in-memory sort
    // (vote_date desc, vote_key desc, row_index) — the mandate index has no date.
    try {
      const rows = await db
        .selectFrom('parliament.vote_positions as vp')
        .innerJoin(
          'parliament.vote_observations as vo',
          'vo.observation_key',
          'vp.representative_observation_key'
        )
        .innerJoin('parliament.votes as v', 'v.vote_key', 'vp.vote_key')
        .select([
          'vp.position_key',
          'vp.vote_key',
          'vo.source_row_index',
          'vp.effective_choice',
          'vp.position_status',
          'vp.observation_count',
          'vp.observed_choices',
          'v.chamber',
          sql<string | null>`v.vote_date::text`.as('vote_date'),
          'v.title',
          'v.outcome',
          'v.bill_key',
        ])
        .where(where)
        .execute();
      const total = rows.length;
      const sorted = rows
        .map((r) => ({
          positionKey: r.position_key,
          voteKey: r.vote_key,
          chamber: r.chamber,
          voteDate: r.vote_date,
          title: r.title,
          outcome: r.outcome,
          choice: r.effective_choice,
          positionStatus: r.position_status as ParliamentMemberVote['positionStatus'],
          observationCount: r.observation_count,
          observedChoices: observedChoicesOf(r.observed_choices),
          rowIndex: r.source_row_index,
          billKey: r.bill_key,
        }))
        .sort((a, b) => {
          const da = a.voteDate ?? '';
          const db2 = b.voteDate ?? '';
          if (da !== db2) return da < db2 ? 1 : -1; // date desc
          if (a.voteKey !== b.voteKey) return a.voteKey < b.voteKey ? 1 : -1; // key desc
          if (a.rowIndex !== b.rowIndex) return a.rowIndex - b.rowIndex;
          return a.positionKey.localeCompare(b.positionKey);
        });

      let startIdx = 0;
      if (page.after !== undefined) {
        const dec = decodeCursor(page.after, { sort: 'memberVote', dir: 'desc', fhash });
        if (dec.isErr()) return err(dec.error);
        const keys = requireCursorKeys(dec.value.keys, 4, [2]);
        if (keys.isErr()) return err(keys.error);
        const [kDate = '', kKey = '', kRow = '0', kPosition = ''] = keys.value;
        startIdx = sorted.findIndex(
          (r) =>
            (r.voteDate ?? '') < kDate ||
            ((r.voteDate ?? '') === kDate && r.voteKey < kKey) ||
            ((r.voteDate ?? '') === kDate &&
              r.voteKey === kKey &&
              (r.rowIndex > Number(kRow) ||
                (r.rowIndex === Number(kRow) && r.positionKey > kPosition)))
        );
        if (startIdx < 0) startIdx = sorted.length;
      }
      const slice = sorted.slice(startIdx, startIdx + limit);
      const last = slice[slice.length - 1];
      const hasMore = startIdx + limit < sorted.length;
      const next =
        hasMore && last !== undefined
          ? buildNextCursor({
              sort: 'memberVote',
              dir: 'desc',
              fhash,
              lastKeys: [last.voteDate ?? '', last.voteKey, last.rowIndex, last.positionKey],
            })
          : null;
      return ok({ items: slice, next, total });
    } catch (e) {
      return err(databaseError('listMemberVotes failed', e));
    }
  };

  const memberVoteActivity = async (
    mandateKey: string,
    year: number,
    filter: FilterInput
  ): Promise<Result<ParliamentMemberVoteActivity, ApiError>> => {
    // Same spec conditions as listMemberVotes; the year bounds the per-day query
    // (the usecase rejects a voteDate filter, so the year is the only date bound).
    const built = toConditionBuilders(memberVotesFilterSpec, filter);
    if (built.isErr()) return err(built.error);
    const specConds = built.value;
    const yearStart = `${String(year)}-01-01`;
    const yearEnd = `${String(year)}-12-31`;
    const daysWhere = composeWhere([
      sql`vp.mandate_key = ${mandateKey}`,
      votePositionPopulation('vp'),
      VOTE_PUBLIC,
      sql`v.vote_date >= ${yearStart}`,
      sql`v.vote_date <= ${yearEnd}`,
      ...specConds,
    ]);
    const yearsWhere = composeWhere([
      sql`vp.mandate_key = ${mandateKey}`,
      votePositionPopulation('vp'),
      VOTE_PUBLIC,
      sql`v.vote_date is not null`,
      ...specConds,
    ]);
    try {
      const [dayRows, yearRows] = await Promise.all([
        db
          .selectFrom('parliament.vote_positions as vp')
          .innerJoin('parliament.votes as v', 'v.vote_key', 'vp.vote_key')
          .select([
            sql<string>`v.vote_date::text`.as('date'),
            sql<string>`count(*)`.as('total'),
            sql<string>`count(*) filter (
              where ${votePositionHasEffectiveChoice('vp')}
                and vp.effective_choice = 'pentru'
            )`.as('pentru'),
            sql<string>`count(*) filter (
              where ${votePositionHasEffectiveChoice('vp')}
                and vp.effective_choice = 'impotriva'
            )`.as('impotriva'),
            sql<string>`count(*) filter (
              where ${votePositionHasEffectiveChoice('vp')}
                and vp.effective_choice = 'abtinere'
            )`.as('abtinere'),
            sql<string>`count(*) filter (
              where ${votePositionHasEffectiveChoice('vp')}
                and vp.effective_choice = 'nu_a_votat'
            )`.as('nu_a_votat'),
            sql<string>`count(*) filter (
              where vp.position_status = 'conflicting_choice'
            )`.as('conflicting'),
            sql<string>`count(*) filter (
              where vp.position_status in ('unknown_marker', 'identity_conflict')
            )`.as('unknown'),
          ])
          .where(daysWhere)
          .groupBy('v.vote_date')
          .orderBy('v.vote_date', 'asc')
          .execute(),
        db
          .selectFrom('parliament.vote_positions as vp')
          .innerJoin('parliament.votes as v', 'v.vote_key', 'vp.vote_key')
          .select(sql<number>`extract(year from v.vote_date)::int`.as('year'))
          .distinct()
          .where(yearsWhere)
          .orderBy(sql`1`, 'asc')
          .execute(),
      ]);
      const days = dayRows.map((r) => ({
        date: r.date,
        total: Number(r.total),
        pentru: Number(r.pentru),
        impotriva: Number(r.impotriva),
        abtinere: Number(r.abtinere),
        nuAVotat: Number(r.nu_a_votat),
        conflicting: Number(r.conflicting),
        unknown: Number(r.unknown),
      }));
      const availableYears = yearRows.map((r) => r.year);
      return ok({ year, days, availableYears });
    } catch (e) {
      return err(databaseError('memberVoteActivity failed', e));
    }
  };

  /**
   * The five per-mandate activity totals in ONE round trip.
   *
   * This replaces five `list…(pageSize: 1)` calls whose only consumed output was
   * `total`. Those calls also fetched a ROW each, and the votes one MATERIALIZED
   * the member's entire ballot set ⋈ votes (≈1.4k rows for a prolific member)
   * purely to read `rows.length`. Collapsing them removes ~6 concurrent
   * connections per member read — the amplifier that let a single flaky ancillary
   * query 404 a valid member (see `getMember`).
   *
   * Every sub-count is a bounded, index-served `count(*)` over a `mandate_key`
   * slice, and each one MIRRORS EXACTLY the predicates of the list it counts —
   * control: CONTROL_NO_MOTION + CONTROL_PUBLIC; speeches: quarantined=false +
   * SPEECH_PUBLIC; votes: the current `vote_positions ⋈ votes` population used by
   * `listMemberVotes`
   * (so `activityCounts.votes` still equals the unfiltered connection `total`).
   * `vote_positions` stays parent-bounded by `mandate_key` (§3.1).
   */
  const memberActivityCounts = async (
    mandateKey: string
  ): Promise<Result<ParliamentActivityCounts, ApiError>> => {
    // The speeches sub-count MUST use the same population rule as the speech lists, or
    // the member profile's "interventions" badge inflates by the legacy over-split
    // factor while the list beneath it shows the canonical turns. This count also feeds
    // `careerTotals.speeches` on the person view.
    const speechConds = composeWhere([
      sql`s.mandate_key = ${mandateKey}`,
      sql`s.quarantined = false`,
      SPEECH_PUBLIC,
      ...populationConds(await speechPopulation()),
    ]);
    try {
      const r = await sql<{
        votes: string;
        control_items: string;
        speeches: string;
        initiatives: string;
        declarations: string;
      }>`
        select
          (select count(*)
             from parliament.vote_positions vp
             join parliament.votes v on v.vote_key = vp.vote_key
            where vp.mandate_key = ${mandateKey}
              and ${votePositionPopulation('vp')}
              and ${VOTE_PUBLIC})                                    as votes,
          (select count(*)
             from parliament.control_items c
            where c.mandate_key = ${mandateKey}
              and ${CONTROL_NO_MOTION}
              and ${CONTROL_PUBLIC})                                  as control_items,
          (select count(*)
             from parliament.speeches s
            where ${speechConds})                                     as speeches,
          (select count(*)
             from parliament.member_initiatives mi
            where mi.mandate_key = ${mandateKey}
              and ${INITIATIVE_PUBLIC})                               as initiatives,
          (select count(*)
             from parliament.member_declarations d
            where d.mandate_key = ${mandateKey}
              and ${DECLARATION_PUBLIC})                              as declarations
      `.execute(db);
      const row = r.rows[0];
      if (row === undefined) return err(databaseError('memberActivityCounts returned no row'));
      return ok({
        votes: Number(row.votes),
        controlItems: Number(row.control_items),
        speeches: Number(row.speeches),
        initiatives: Number(row.initiatives),
        declarations: Number(row.declarations),
      });
    } catch (e) {
      return err(databaseError('memberActivityCounts failed', e));
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
          .leftJoin('parliament.control_filter_projection as cfp', 'cfp.item_key', 'c.item_key')
          .select([
            'c.item_key',
            'c.control_type',
            'c.control_type_provenance',
            'c.title',
            'c.recipient',
            sql<string | null>`c.item_date::text`.as('item_date'),
            'c.response_status',
            'cfp.requested_response_mode',
            'cfp.response_evidence_state',
            'cfp.response_count',
            'cfp.response_document_count',
            sql<string | null>`cfp.first_valid_response_date::text`.as('first_valid_response_date'),
            sql<string | null>`cfp.latest_valid_response_date::text`.as(
              'latest_valid_response_date'
            ),
            'cfp.recipient_count',
            'c.author_name',
            'c.mandate_key',
            'c.source_url',
          ])
          .where('c.mandate_key', '=', mandateKey)
          .where(sql<SqlBool>`${CONTROL_NO_MOTION}`)
          .where(sql<SqlBool>`${CONTROL_PUBLIC}`)
          .orderBy('c.item_date', 'desc')
          // item_key DESC — the table's UNIQUE key as a tiebreak, so `item_date`
          // ties get a TOTAL order and offset pages never skip/duplicate a row
          // (B2-F1; mirrors listMemberInitiatives + the cursor speech path).
          .orderBy('c.item_key', 'desc')
          .limit(p.pageSize)
          .offset(offsetFor(p))
          .execute();
        const cnt = await db
          .selectFrom('parliament.control_items as c')
          .select(sql<string>`count(*)`.as('cnt'))
          .where('c.mandate_key', '=', mandateKey)
          .where(sql<SqlBool>`${CONTROL_NO_MOTION}`)
          .where(sql<SqlBool>`${CONTROL_PUBLIC}`)
          .executeTakeFirst();
        return { rows: rows.map((r) => mapControlItem(r)), total: Number(cnt?.cnt ?? 0) };
      },
      page
    );

  const listMemberSpeeches = (mandateKey: string, page: OffsetParams) =>
    offsetActivity<ParliamentSpeech>(
      'listMemberSpeeches',
      async (p) => {
        const population = await speechPopulation();
        const hasCanonical = population === 'CANONICAL_PREFERRED';
        const hasPerson = await stenogram.speakerIdentityColumnsAvailable();
        // The population predicate goes on BOTH the rows and the count, so the page and
        // its `total` can never describe different populations.
        const conds = [
          sql`s.mandate_key = ${mandateKey}`,
          sql`s.quarantined = false`, // §2.6 — quarantined excluded by default
          SPEECH_PUBLIC,
          ...populationConds(population),
        ];
        const rows = await db
          .selectFrom('parliament.speeches as s')
          .select([
            ...SPEECH_SELECT,
            ...speechCanonicalSelect(hasCanonical),
            ...speechPersonSelect(hasPerson),
          ])
          .where(composeWhere(conds))
          .orderBy('s.spoken_at', 'desc')
          // speech_key DESC — the table's UNIQUE key as a tiebreak, so `spoken_at`
          // ties get a TOTAL order and offset pages never skip/duplicate a turn
          // (B2-F1; mirrors listMemberSpeechesCursor's keyset shape).
          .orderBy('s.speech_key', 'desc')
          .limit(p.pageSize)
          .offset(offsetFor(p))
          .execute();
        const cnt = await db
          .selectFrom('parliament.speeches as s')
          .select(sql<string>`count(*)`.as('cnt'))
          .where(composeWhere(conds))
          .executeTakeFirst();
        return { rows: rows.map(mapSpeech), total: Number(cnt?.cnt ?? 0) };
      },
      page
    );

  // Per-mandate speeches can reach ~35k rows (median 72), so — unlike member votes —
  // we do NOT materialize + sort in memory. This is SQL keyset pagination on
  // (spoken_at desc, speech_key desc), served index-ordered by speeches_mandate_idx.
  const listMemberSpeechesCursor = async (
    mandateKey: string,
    page: CursorPageRequest,
    filter: FilterInput,
    q: string | undefined
  ): Promise<
    Result<
      CursorPage<ParliamentSpeech> & {
        total: number;
        population: ParliamentSpeechPopulation;
      },
      ApiError
    >
  > => {
    const limit = Math.min(Math.max(page.first, 1), 100);
    // Non-virtual spec (spokenAt/chamber on `s`) → compiles straight to SQL.
    const built = toConditionBuilders(memberSpeechesFilterSpec, filter);
    if (built.isErr()) return err(built.error);
    const [hasTexts, population] = await Promise.all([speechTextsExists(), speechPopulation()]);
    const hasCanonical = population === 'CANONICAL_PREFERRED';
    const hasPerson = await stenogram.speakerIdentityColumnsAvailable();
    // The APPLIED population is folded into the cursor fhash: a probe flip mid-pagination
    // changes which rows exist, so an in-flight cursor must be rejected with the clean
    // "restart pagination" error rather than silently skipping or duplicating turns.
    const fhash = memberSpeechesFhash(mandateKey, filter, q, population);
    // baseConds = the FILTERED member slice (drives the exact total); the keyset
    // predicate is added ON TOP for the page but MUST NOT touch the count.
    const baseConds: RawBuilder<unknown>[] = [
      sql`s.mandate_key = ${mandateKey}`,
      sql`s.quarantined = false`, // §2.6 — quarantined excluded by default
      SPEECH_PUBLIC,
      ...populationConds(population),
      ...built.value,
    ];
    if (q !== undefined && q !== '') baseConds.push(speechSearchPredicate(q, hasTexts));

    // Keyset on (spoken_at, speech_key), both DESC. Coalesce NULL date → '' in BOTH
    // the ORDER BY and the predicate so a NULL-date turn sorts LAST (== NULLS LAST)
    // and pagination never skips/duplicates at the null boundary. spoken_at::text is
    // YYYY-MM-DD (lexical == chrono); speech_key is text (plain `<`).
    const dateKey = sql`coalesce(s.spoken_at::text, '')`;
    const pageConds = [...baseConds];
    if (page.after !== undefined) {
      const dec = decodeCursor(page.after, { sort: 'spokenAt', dir: 'desc', fhash });
      if (dec.isErr()) return err(dec.error);
      const keys = requireCursorKeys(dec.value.keys, 2);
      if (keys.isErr()) return err(keys.error);
      const [kDate, kKey] = keys.value;
      pageConds.push(sql`(${dateKey}, s.speech_key) < (${kDate ?? ''}, ${kKey ?? ''})`);
    }
    try {
      const [rows, cnt] = await Promise.all([
        db
          .selectFrom('parliament.speeches as s')
          .select([
            ...SPEECH_SELECT,
            ...speechCanonicalSelect(hasCanonical),
            ...speechPersonSelect(hasPerson),
          ])
          .where(composeWhere(pageConds))
          .orderBy(sql`${dateKey} desc, s.speech_key desc`)
          .limit(limit + 1)
          .execute(),
        db
          .selectFrom('parliament.speeches as s')
          .select(sql<string>`count(*)`.as('cnt'))
          .where(composeWhere(baseConds))
          .executeTakeFirst(),
      ]);
      const hasMore = rows.length > limit;
      const sliced = hasMore ? rows.slice(0, limit) : rows;
      const items = sliced.map(mapSpeech);
      const last = sliced[sliced.length - 1];
      const next =
        hasMore && last !== undefined
          ? buildNextCursor({
              sort: 'spokenAt',
              dir: 'desc',
              fhash,
              lastKeys: [last.spoken_at ?? '', last.speech_key],
            })
          : null;
      return ok({ items, next, total: Number(cnt?.cnt ?? 0), population });
    } catch (e) {
      return err(databaseError('listMemberSpeechesCursor failed', e));
    }
  };

  const memberSpeechActivity = async (
    mandateKey: string,
    year: number,
    filter: FilterInput,
    q: string | undefined
  ): Promise<Result<ParliamentMemberSpeechActivity, ApiError>> => {
    const built = toConditionBuilders(memberSpeechesFilterSpec, filter);
    if (built.isErr()) return err(built.error);
    // The heatmap MUST count the same population the list shows, or the calendar and
    // the connection total disagree by the over-split factor.
    const [hasTexts, population] = await Promise.all([speechTextsExists(), speechPopulation()]);
    const baseConds: RawBuilder<unknown>[] = [
      sql`s.mandate_key = ${mandateKey}`,
      sql`s.quarantined = false`,
      SPEECH_PUBLIC,
      ...populationConds(population),
      ...built.value,
    ];
    if (q !== undefined && q !== '') baseConds.push(speechSearchPredicate(q, hasTexts));
    // The year bounds the per-day window (the usecase rejects a spokenAt filter, so
    // the year is the only date bound). availableYears is NOT year-bounded.
    const yearStart = `${String(year)}-01-01`;
    const yearEnd = `${String(year)}-12-31`;
    const daysWhere = composeWhere([
      ...baseConds,
      sql`s.spoken_at >= ${yearStart}`,
      sql`s.spoken_at <= ${yearEnd}`,
    ]);
    const yearsWhere = composeWhere([...baseConds, sql`s.spoken_at is not null`]);
    try {
      const [dayRows, yearRows] = await Promise.all([
        db
          .selectFrom('parliament.speeches as s')
          .select([
            sql<string>`s.spoken_at::text`.as('date'),
            sql<string>`count(*)`.as('total'),
            sql<string>`count(*) filter (where s.chamber = 'comun')`.as('comun'),
          ])
          .where(daysWhere)
          .groupBy('s.spoken_at')
          .orderBy('s.spoken_at', 'asc')
          .execute(),
        db
          .selectFrom('parliament.speeches as s')
          .select(sql<number>`extract(year from s.spoken_at)::int`.as('year'))
          .distinct()
          .where(yearsWhere)
          .orderBy(sql`1`, 'asc')
          .execute(),
      ]);
      const days = dayRows.map((r) => {
        const total = Number(r.total);
        const comun = Number(r.comun);
        return { date: r.date, total, proprie: total - comun, comun };
      });
      return ok({ year, days, availableYears: yearRows.map((r) => r.year) });
    } catch (e) {
      return err(databaseError('memberSpeechActivity failed', e));
    }
  };

  const getSpeechFullText = async (speechKey: string): Promise<Result<string | null, ApiError>> => {
    // Degrade gracefully: no speech_texts table (parallel slice not landed) → null.
    if (!(await speechTextsExists())) return ok(null);
    try {
      const r = await sql<{ full_text: string }>`
        select t.full_text
        from parliament.speech_texts t
        inner join parliament.speeches s on s.speech_key = t.speech_key
        where t.speech_key = ${speechKey}
          and s.quarantined = false
          and ${SPEECH_PUBLIC}
          and ${SPEECH_TEXT_PUBLIC}
        limit 1
      `.execute(db);
      return ok(r.rows[0]?.full_text ?? null);
    } catch {
      // A transient read error must never break the enclosing speech query.
      return ok(null);
    }
  };

  // ── global speeches (stenograme; NO date index — the usecase bound guard is the
  //    ONLY thing keeping an unparented scan window-bounded) ──────────────────────

  /**
   * Shared WHERE for every GLOBAL speech surface: the physical spec conditions
   * (spokenAt/chamber/mandateKey) + the two privacy predicates. Quarantined rows
   * and non-public privacy classes are NEVER served globally (§2.6);
   * strict equality default-denies any unexpected value. NULL-mandate turns are
   * INCLUDED — they are real data.
   */
  const buildGlobalSpeechConditions = (
    filter: FilterInput,
    population: ParliamentSpeechPopulation
  ): Result<RawBuilder<unknown>[], ApiError> => {
    const physical: Record<string, unknown> = {};
    for (const key of ['spokenAt', 'chamber', 'mandateKey'] as const) {
      // Read as unknown: FilterInput omits null, but a GraphQL nullable field CAN
      // arrive as null at runtime — skip it (treat null as absent).
      const v: unknown = filter[key];
      if (v !== undefined && v !== null) physical[key] = v;
    }
    const built = toConditionBuilders(parliamentSpeechesFilterSpec, physical as FilterInput);
    if (built.isErr()) return err(built.error);
    return ok([
      ...built.value,
      sql`s.quarantined = false`, // §2.6 — quarantined excluded on every global surface
      SPEECH_PUBLIC,
      // The default-serving population rule — see SPEECH_CANONICAL_PREFERRED. Built in
      // HERE so the global list and the global activity heatmap cannot diverge.
      ...populationConds(population),
    ]);
  };

  const listSpeeches = async (
    page: CursorPageRequest,
    filter: FilterInput,
    q: string | undefined,
    wantFullText: boolean
  ): Promise<
    Result<
      CursorPage<ParliamentSpeech> & {
        total: number;
        totalEstimated: boolean;
        searchDepth: ParliamentSpeechSearchDepth | null;
        population: ParliamentSpeechPopulation;
      },
      ApiError
    >
  > => {
    const limit = Math.min(Math.max(page.first, 1), 100);
    // APPLIED depth = the usecase's decision ∩ the live speech_texts probe; the
    // fhash folds it in so a probe flip mid-pagination invalidates cursors cleanly.
    const searchDepth: ParliamentSpeechSearchDepth | null =
      q !== undefined && q !== ''
        ? wantFullText && (await speechTextsExists())
          ? 'FULL_TEXT'
          : 'TITLE_SUMMARY'
        : null;
    const population = await speechPopulation();
    const hasCanonical = population === 'CANONICAL_PREFERRED';
    const hasPerson = await stenogram.speakerIdentityColumnsAvailable();
    // Both probe-derived facts ride in the fhash for the same reason: either flipping
    // mid-pagination changes the row set, and a stale cursor must be refused cleanly.
    const fhash = parliamentSpeechesFhash(filter, q, searchDepth ?? 'none', population);
    const condsRes = buildGlobalSpeechConditions(filter, population);
    if (condsRes.isErr()) return err(condsRes.error);
    // baseConds = the FILTERED global slice (drives the capped total); the keyset
    // predicate is added ON TOP for the page but MUST NOT touch the count.
    const baseConds = condsRes.value;
    if (q !== undefined && q !== '') {
      baseConds.push(speechSearchPredicate(q, searchDepth === 'FULL_TEXT'));
    }

    // Keyset on (spoken_at, speech_key), both DESC — identical in shape to
    // listMemberSpeechesCursor: coalesce NULL date → '' in BOTH the ORDER BY and
    // the tuple predicate so a NULL-date turn sorts LAST and pagination never
    // skips/duplicates at the null boundary.
    const dateKey = sql`coalesce(s.spoken_at::text, '')`;
    const pageConds = [...baseConds];
    if (page.after !== undefined) {
      const dec = decodeCursor(page.after, { sort: 'spokenAt', dir: 'desc', fhash });
      if (dec.isErr()) return err(dec.error);
      const keys = requireCursorKeys(dec.value.keys, 2);
      if (keys.isErr()) return err(keys.error);
      const [kDate, kKey] = keys.value;
      pageConds.push(sql`(${dateKey}, s.speech_key) < (${kDate ?? ''}, ${kKey ?? ''})`);
    }
    try {
      // Capped count (the listBills pattern): count(*) over a LIMIT cap+1 subselect,
      // in the same Promise.all as the page query.
      const [rows, countRow] = await Promise.all([
        db
          .selectFrom('parliament.speeches as s')
          .select([
            ...SPEECH_SELECT,
            ...speechCanonicalSelect(hasCanonical),
            ...speechPersonSelect(hasPerson),
          ])
          .where(composeWhere(pageConds))
          .orderBy(sql`${dateKey} desc, s.speech_key desc`)
          .limit(limit + 1)
          .execute(),
        db
          .selectFrom(
            db
              .selectFrom('parliament.speeches as s')
              .select(sql<number>`1`.as('one'))
              .where(composeWhere(baseConds))
              .limit(LIST_TOTAL_CAP + 1)
              .as('capped')
          )
          .select(sql<string>`count(*)`.as('cnt'))
          .executeTakeFirst(),
      ]);
      const hasMore = rows.length > limit;
      const sliced = hasMore ? rows.slice(0, limit) : rows;
      const items = sliced.map(mapSpeech);
      const last = sliced[sliced.length - 1];
      const next =
        hasMore && last !== undefined
          ? buildNextCursor({
              sort: 'spokenAt',
              dir: 'desc',
              fhash,
              lastKeys: [last.spoken_at ?? '', last.speech_key],
            })
          : null;
      const rawCount = Number(countRow?.cnt ?? 0);
      const totalEstimated = rawCount > LIST_TOTAL_CAP;
      return ok({
        items,
        next,
        total: totalEstimated ? LIST_TOTAL_CAP : rawCount,
        totalEstimated,
        searchDepth,
        population,
      });
    } catch (e) {
      return err(databaseError('listSpeeches failed', e));
    }
  };

  const speechActivity = async (
    year: number,
    filter: FilterInput,
    q: string | undefined,
    wantFullText: boolean
  ): Promise<Result<ParliamentSpeechActivity, ApiError>> => {
    // Mirrors memberSpeechActivity minus the mandate parent: per-day counts within
    // the year window + availableYears (distinct years over the filtered base, NOT
    // year-bounded — a sequential pass, no date index; the usecase's year argument
    // bounds only the per-day query).
    const searchDepth: ParliamentSpeechSearchDepth | null =
      q !== undefined && q !== ''
        ? wantFullText && (await speechTextsExists())
          ? 'FULL_TEXT'
          : 'TITLE_SUMMARY'
        : null;
    // Same population as the global list, so the stenograme heatmap and the connection
    // total can never describe different row sets.
    const condsRes = buildGlobalSpeechConditions(filter, await speechPopulation());
    if (condsRes.isErr()) return err(condsRes.error);
    const baseConds = condsRes.value;
    if (q !== undefined && q !== '') {
      baseConds.push(speechSearchPredicate(q, searchDepth === 'FULL_TEXT'));
    }
    const yearStart = `${String(year)}-01-01`;
    const yearEnd = `${String(year)}-12-31`;
    const daysWhere = composeWhere([
      ...baseConds,
      sql`s.spoken_at >= ${yearStart}`,
      sql`s.spoken_at <= ${yearEnd}`,
    ]);
    const yearsWhere = composeWhere([...baseConds, sql`s.spoken_at is not null`]);
    try {
      const [dayRows, yearRows] = await Promise.all([
        db
          .selectFrom('parliament.speeches as s')
          .select([
            sql<string>`s.spoken_at::text`.as('date'),
            sql<string>`count(*)`.as('total'),
            sql<string>`count(*) filter (where s.chamber = 'comun')`.as('comun'),
          ])
          .where(daysWhere)
          .groupBy('s.spoken_at')
          .orderBy('s.spoken_at', 'asc')
          .execute(),
        db
          .selectFrom('parliament.speeches as s')
          .select(sql<number>`extract(year from s.spoken_at)::int`.as('year'))
          .distinct()
          .where(yearsWhere)
          .orderBy(sql`1`, 'asc')
          .execute(),
      ]);
      const days = dayRows.map((r) => {
        const total = Number(r.total);
        const comun = Number(r.comun);
        return { date: r.date, total, proprie: total - comun, comun };
      });
      return ok({ year, days, availableYears: yearRows.map((r) => r.year), searchDepth });
    } catch (e) {
      return err(databaseError('speechActivity failed', e));
    }
  };

  const findSpeech = async (
    speechKey: string
  ): Promise<Result<ParliamentSpeech | null, ApiError>> => {
    // speeches_pkey point read, with the SAME global privacy predicates as the list
    // — a quarantined/non-public row resolves null, never leaks via deep link.
    const hasCanonical = await stenogram.canonicalSpeechColumnsAvailable();
    const hasPerson = await stenogram.speakerIdentityColumnsAvailable();
    try {
      const row = await db
        .selectFrom('parliament.speeches as s')
        .select([
          ...SPEECH_SELECT,
          ...speechCanonicalSelect(hasCanonical),
          ...speechPersonSelect(hasPerson),
        ])
        .where('s.speech_key', '=', speechKey)
        .where(sql<SqlBool>`s.quarantined = false`)
        .where(sql<SqlBool>`${SPEECH_PUBLIC}`)
        .limit(1)
        .executeTakeFirst();
      return ok(row === undefined ? null : mapSpeech(row));
    } catch (e) {
      return err(databaseError('findSpeech failed', e));
    }
  };

  const listMemberInitiatives = (mandateKey: string, page: OffsetParams) =>
    offsetActivity<ParliamentInitiative>(
      'listMemberInitiatives',
      async (p) => {
        // registration_date_text is TEXT 'DD.MM.YYYY' (~95.7% coverage). Reorder it to
        // a zero-padded ISO 'YYYY-MM-DD' STRING with pure string ops (lpad/split) for
        // BOTH the projected field and the sort key. This is throw-proof: `to_date`
        // ERRORS on an impossible date (e.g. '31.02.2026') and would 500 the whole
        // member's page — the regex format check is NOT sufficient (Codex container
        // test). The reorder produces an identical ISO value to to_date for every
        // live row (0 mismatches verified vs prod) and lexical == chronological order.
        // null/'' → NULL → NULLS LAST. Order DESC (newest first), then initiative_key
        // DESC as a UNIQUE (PK) tiebreak → TOTAL order (stable offset pagination). The
        // OLD `initiative_key ASC` surfaced NULL-date legacy items on page 1 and
        // buried a member's recent initiatives (audit bug).
        const regDateIso = sql<string | null>`(case
          when nullif(mi.registration_date_text, '') is null then null
          else lpad(split_part(mi.registration_date_text, '.', 3), 4, '0') || '-'
            || lpad(split_part(mi.registration_date_text, '.', 2), 2, '0') || '-'
            || lpad(split_part(mi.registration_date_text, '.', 1), 2, '0')
        end)`;
        const rows = await db
          .selectFrom('parliament.member_initiatives as mi')
          .select([
            'mi.initiative_key',
            'mi.mandate_key',
            'mi.bill_key',
            'mi.title',
            'mi.status',
            'mi.promulgated_law_number',
            'mi.promulgated_law_year',
            sql<string | null>`${regDateIso}`.as('registration_date'),
          ])
          .where('mi.mandate_key', '=', mandateKey)
          .where(sql<SqlBool>`${INITIATIVE_PUBLIC}`)
          .orderBy(sql`${regDateIso} desc nulls last`)
          .orderBy('mi.initiative_key', 'desc')
          .limit(p.pageSize)
          .offset(offsetFor(p))
          .execute();
        const cnt = await db
          .selectFrom('parliament.member_initiatives as mi')
          .select(sql<string>`count(*)`.as('cnt'))
          .where('mi.mandate_key', '=', mandateKey)
          .where(sql<SqlBool>`${INITIATIVE_PUBLIC}`)
          .executeTakeFirst();
        return { rows: rows.map(mapInitiative), total: Number(cnt?.cnt ?? 0) };
      },
      page
    );

  const listMemberDeclarations = async (
    mandateKey: string
  ): Promise<Result<readonly ParliamentDeclarationMeta[], ApiError>> => {
    try {
      const rows = await db
        .selectFrom('parliament.member_declarations as d')
        .select([
          'd.declaration_type',
          sql<string | null>`d.declaration_date::text`.as('declaration_date'),
          'd.label',
          'd.file_url',
        ])
        .where('d.mandate_key', '=', mandateKey)
        .where(sql<SqlBool>`${DECLARATION_PUBLIC}`)
        .orderBy('d.declaration_date', 'desc')
        .execute();
      return ok(rows.map(mapDeclaration));
    } catch (e) {
      return err(databaseError('listMemberDeclarations failed', e));
    }
  };

  // ── standalone control-items list (cursor; bounded — §3.2) ─────────────────────
  const buildControlConditions = (
    filter: FilterInput
  ): { conds: RawBuilder<unknown>[]; error?: ApiError } => {
    const physical: Record<string, unknown> = {};
    for (const key of [
      'controlType',
      'responseStatus',
      'responseEvidenceState',
      'responseDate',
      'itemDate',
    ] as const) {
      // Read as unknown: FilterInput omits null, but a GraphQL nullable field CAN arrive
      // as null at runtime — skip it (treat null as absent) so the kernel composer never
      // sees a null value (which it would mishandle).
      const v: unknown = filter[key];
      if (v !== undefined && v !== null) physical[key] = v;
    }
    const built = toConditionBuilders(controlItemsFilterSpec, physical as FilterInput);
    if (built.isErr()) return { conds: [], error: built.error };
    // control-population.v2 (2026-07-22): motions are NOT parliamentary control —
    // exclude the 6 leaked rows from every served control read (see CONTROL_TYPES).
    // CONTROL_PUBLIC is the strict §5 privacy gate (never fail-open coalesce).
    const conds: RawBuilder<unknown>[] = [CONTROL_NO_MOTION, CONTROL_PUBLIC, ...built.value];

    const recipient = fieldFilter(filter, 'recipient');
    if (recipient !== undefined) {
      if (typeof recipient['eq'] === 'string') conds.push(sql`c.recipient = ${recipient['eq']}`);
      const rc = containsValue(recipient);
      if (rc !== undefined) {
        const needle = '%' + escapeLike(foldDiacritics(rc)) + '%';
        conds.push(
          sql`lower(translate(coalesce(c.recipient, ''), ${FOLD_FROM}, ${FOLD_TO})) like ${needle} escape '\\'`
        );
      }
    }
    const author = containsValue(fieldFilter(filter, 'author'));
    if (author !== undefined) {
      const needle = '%' + escapeLike(foldDiacritics(author)) + '%';
      conds.push(
        sql`lower(translate(coalesce(c.author_name, ''), ${FOLD_FROM}, ${FOLD_TO})) like ${needle} escape '\\'`
      );
    }
    const q = containsValue(fieldFilter(filter, 'q'));
    if (q !== undefined && q.trim() !== '') {
      const needle = '%' + escapeLike(foldDiacritics(q)) + '%';
      conds.push(
        sql`lower(translate(coalesce(c.title, ''), ${FOLD_FROM}, ${FOLD_TO})) like ${needle} escape '\\'`
      );
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
        .leftJoin('parliament.control_filter_projection as cfp', 'cfp.item_key', 'c.item_key')
        .select([
          'c.item_key',
          'c.control_type',
          'c.control_type_provenance',
          'c.title',
          'c.recipient',
          sql<string | null>`c.item_date::text`.as('item_date'),
          'c.response_status',
          'cfp.requested_response_mode',
          'cfp.response_evidence_state',
          'cfp.response_count',
          'cfp.response_document_count',
          sql<string | null>`cfp.first_valid_response_date::text`.as('first_valid_response_date'),
          sql<string | null>`cfp.latest_valid_response_date::text`.as('latest_valid_response_date'),
          'cfp.recipient_count',
          'c.author_name',
          'c.mandate_key',
          'c.source_url',
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
          ? buildNextCursor({
              sort: 'itemDate',
              dir: 'desc',
              fhash,
              lastKeys: [last.item_date ?? '', last.item_key],
            })
          : null;
      return ok({ items, next });
    } catch (e) {
      return err(databaseError('listControlItems failed', e));
    }
  };

  // ── lineage (the marquee) ──────────────────────────────────────────────────────
  const votesForActId = async (
    actId: string,
    roles: readonly string[]
  ): Promise<Result<readonly LineageVoteRow[], ApiError>> => {
    try {
      let qb = db
        .selectFrom('parliament.bill_act_links as bal')
        .innerJoin('parliament.bill_vote_links as bvl', 'bvl.bill_key', 'bal.bill_key')
        .innerJoin('parliament.votes as v', 'v.vote_key', 'bvl.vote_key')
        .select([
          ...VOTE_SELECT,
          'bvl.bill_key as bvl_bill_key',
          'bvl.role',
          'bvl.resolution_status as bvl_status',
          'bvl.confidence_label as bvl_conf',
        ])
        .where(sql`bal.target_act_id`, '=', sql`${actId}::bigint`)
        .where('bal.resolution_status', '=', 'linked')
        // The vote edge is held to the SAME standard as the act edge above.
        // This is a factual lineage claim ("these divisions decided this act"),
        // not an evidence listing, so only fully-resolved edges qualify — the
        // asymmetry of demanding `linked` on one join and accepting anything on
        // the other was an oversight, and it is the join that would have served
        // retracted rows once retraction is activated.
        .where('bvl.resolution_status', '=', 'linked')
        .where('v.privacy_class', '=', 'public');
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

  const billsForActId = async (
    actId: string
  ): Promise<Result<readonly ParliamentBill[], ApiError>> => {
    try {
      const rows = await db
        .selectFrom('parliament.bill_act_links as bal')
        .innerJoin('parliament.bills as b', 'b.bill_key', 'bal.bill_key')
        .select(BILL_SELECT)
        .where(sql`bal.target_act_id`, '=', sql`${actId}::bigint`)
        .where('bal.resolution_status', '=', 'linked')
        .execute();
      return ok(rows.map((r) => mapBill(r)));
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
        .where('v.privacy_class', '=', 'public')
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
        .where('v.privacy_class', '=', 'public')
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
      return err(
        invalidInput(`cohesion vote set exceeds cap (${String(COHESION_VOTE_CAP)})`, 'voteKeys')
      );
    }
    try {
      let qb = db
        .selectFrom('parliament.vote_positions as vp')
        .innerJoin(
          'parliament.vote_observations as vo',
          'vo.observation_key',
          'vp.representative_observation_key'
        )
        .select([
          'vo.group_name',
          sql<string>`count(*) filter (
            where ${votePositionHasEffectiveChoice('vp')}
              and vp.effective_choice = 'pentru'
          )`.as('pentru'),
          sql<string>`count(*) filter (
            where ${votePositionHasEffectiveChoice('vp')}
              and vp.effective_choice = 'impotriva'
          )`.as('impotriva'),
          sql<string>`count(*) filter (
            where ${votePositionHasEffectiveChoice('vp')}
              and vp.effective_choice = 'abtinere'
          )`.as('abtinere'),
          sql<string>`count(*) filter (
            where ${votePositionHasEffectiveChoice('vp')}
              and vp.effective_choice = 'nu_a_votat'
          )`.as('nu_a_votat'),
          sql<string>`count(*) filter (
            where vp.position_status = 'conflicting_choice'
          )`.as('conflicting'),
          sql<string>`count(*) filter (
            where vp.position_status in ('unknown_marker', 'identity_conflict')
          )`.as('unknown'),
          sql<string>`count(distinct vp.vote_key)`.as('vote_count'),
        ])
        .where('vp.vote_key', 'in', [...voteKeys])
        .where(votePositionPopulation('vp'))
        .where('vp.group_name_variant_count', '=', 1)
        .where('vo.group_name', 'is not', null);
      if (group !== undefined) qb = qb.where('vo.group_name', '=', group);
      const rows = await qb.groupBy('vo.group_name').execute();
      return ok(
        rows.map((r) => {
          const pentru = Number(r.pentru);
          const impotriva = Number(r.impotriva);
          const abtinere = Number(r.abtinere);
          const absent = Number(r.nu_a_votat);
          const conflicting = Number(r.conflicting);
          const unknown = Number(r.unknown);
          const total = pentru + impotriva + abtinere + absent + conflicting + unknown;
          // M12: largest-remainder (Hamilton) apportionment so the four percentages sum
          // to EXACTLY 100.00 — independent half-up rounding of each could yield 99.99/100.01.
          const [
            forPct = 0,
            againstPct = 0,
            abstainPct = 0,
            absentPct = 0,
            conflictingPct = 0,
            unknownPct = 0,
          ] = largestRemainderPct(
            [pentru, impotriva, abtinere, absent, conflicting, unknown],
            total
          );
          // Rice cohesion: |for - against| / (for + against), 0..1. M13: NULL when there
          // are no DECIDED votes (for+against=0) — Rice is undefined, not 0 (a 0 would
          // read as "maximally divided" for an abstain/absent-only group).
          const decided = pentru + impotriva;
          const cohesionIndex =
            decided > 0 ? Math.round((Math.abs(pentru - impotriva) / decided) * 1000) / 1000 : null;
          return {
            groupName: r.group_name ?? '(none)',
            forPct,
            againstPct,
            abstainPct,
            absentPct,
            conflictingPct,
            unknownPct,
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
        .select([
          'pc.mandate_key',
          sql<string | null>`pc.person_id::text`.as('person_id'),
          'pc.status',
        ]);
      if (status !== undefined) qb = qb.where('pc.status', '=', status);
      const rows = await qb
        .orderBy('pc.mandate_key', 'asc')
        .limit(page.pageSize)
        .offset(offsetFor(page))
        .execute();
      let cntQb = db
        .selectFrom('parliament.person_identity_candidates as pc')
        .select(sql<string>`count(*)`.as('cnt'));
      if (status !== undefined) cntQb = cntQb.where('pc.status', '=', status);
      const cnt = await cntQb.executeTakeFirst();
      return ok({
        rows: rows.map((r) => ({
          mandateKey: r.mandate_key,
          personId: r.person_id,
          status: r.status,
        })),
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
  ): Promise<Result<ParliamentControlSummaryCount | null, ApiError>> => Promise.resolve(ok(null));

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

  // ── data freshness (B4) ─────────────────────────────────────────────────────────
  const dataFreshness = async (): Promise<Result<ParliamentDataFreshness, ApiError>> => {
    try {
      const row = await db
        .selectFrom('parliament.votes')
        .select([
          sql<string | null>`max(vote_date)::text`.as('latest_vote_date'),
          sql<string | null>`max(updated_at)::text`.as('last_loaded_at'),
        ])
        .where('privacy_class', '=', 'public')
        .executeTakeFirst();
      return ok({
        latestVoteDate: row?.latest_vote_date ?? null,
        lastLoadedAt: row?.last_loaded_at ?? null,
      });
    } catch (e) {
      return err(databaseError('dataFreshness failed', e));
    }
  };

  // ── AI enrichment metadata (B1 — inference-only; NON-AUTHORITATIVE) ──────────────
  // Latest deterministic pick per key (loaded_at desc, schema_version desc). Only
  // valid + public rows are served (control has 4,706 restricted rows that MUST be
  // filtered; bill is all-public today but the filter is future-proof). confidence
  // is numeric → ::text (precision-safe).
  const findBillAiMetadata = async (
    billKey: string
  ): Promise<Result<ParliamentAiBillMetadata | null, ApiError>> => {
    try {
      const row = await db
        .selectFrom('parliament.bill_metadata as bm')
        .select([
          'bm.summary',
          'bm.topic',
          'bm.domains',
          'bm.keywords',
          'bm.value_class',
          'bm.config_key',
          'bm.prompt_version',
          'bm.schema_version',
          'bm.model',
          'bm.validation_status',
          sql<string | null>`bm.confidence::text`.as('confidence'),
          sql<string | null>`bm.source_updated_at::text`.as('source_updated_at'),
          sql<string | null>`bm.loaded_at::text`.as('loaded_at'),
          'bm.privacy_class',
        ])
        .where('bm.bill_key', '=', billKey)
        .where('bm.validation_status', '=', 'valid')
        .where('bm.privacy_class', '=', 'public')
        .orderBy('bm.loaded_at', 'desc')
        .orderBy('bm.schema_version', 'desc')
        // Final stable tiebreakers so the served summary is deterministic when two
        // rows share (loaded_at, schema_version) — the versioned PK guarantees these
        // fully disambiguate.
        .orderBy('bm.config_key', 'desc')
        .orderBy('bm.prompt_version', 'desc')
        .limit(1)
        .executeTakeFirst();
      return ok(row === undefined ? null : mapAiBillMetadata(row as AiBillMetadataRow));
    } catch (e) {
      return err(databaseError('findBillAiMetadata failed', e));
    }
  };

  const findControlItemAiMetadata = async (
    itemKey: string
  ): Promise<Result<ParliamentAiControlItemMetadata | null, ApiError>> => {
    try {
      const row = await db
        .selectFrom('parliament.control_item_metadata as cm')
        .select([
          'cm.summary',
          'cm.policy_domains',
          'cm.issue_types',
          'cm.urgency',
          'cm.keywords',
          'cm.config_key',
          'cm.prompt_version',
          'cm.schema_version',
          'cm.model',
          'cm.validation_status',
          sql<string | null>`cm.confidence::text`.as('confidence'),
          sql<string | null>`cm.source_updated_at::text`.as('source_updated_at'),
          sql<string | null>`cm.loaded_at::text`.as('loaded_at'),
          'cm.privacy_class',
        ])
        .where('cm.item_key', '=', itemKey)
        .where('cm.validation_status', '=', 'valid')
        // CRITICAL (B1): 4,706 of 9,345 rows are restricted — serve public only.
        .where('cm.privacy_class', '=', 'public')
        .orderBy('cm.loaded_at', 'desc')
        .orderBy('cm.schema_version', 'desc')
        // Final stable tiebreakers (deterministic summary when loaded_at/schema_version tie).
        .orderBy('cm.config_key', 'desc')
        .orderBy('cm.prompt_version', 'desc')
        .limit(1)
        .executeTakeFirst();
      return ok(
        row === undefined ? null : mapAiControlItemMetadata(row as AiControlItemMetadataRow)
      );
    } catch (e) {
      return err(databaseError('findControlItemAiMetadata failed', e));
    }
  };

  // ── committees (B2) ──────────────────────────────────────────────────────────────
  const COMMITTEE_SELECT = [
    'co.committee_key',
    'co.chamber',
    'co.name',
    'co.legislature',
    'co.committee_type',
    'co.source_url',
  ] as const;

  /** Translate the module-enum chamber to the raw committees.chamber code. */
  const rawCommitteeChamber = (chamber: string): string =>
    chamber === 'camera_deputatilor' ? 'cdep' : chamber === 'senat' ? 'senate' : chamber;

  // The senate roster attr-join: a senate_committee membership carries a
  // senate_parlamentar_id; it links to the CURRENT senator whose attrs carry the
  // matching senate_current_roster_parlamentar_id (376/376 match on live data).
  const SENATE_ROSTER_JOIN = sql<boolean>`(
    cm.membership_source = 'cdep_committee' and m.mandate_key = cm.mandate_key
  ) or (
    cm.membership_source = 'senate_committee' and m.is_current
      and m.attrs->>'senate_current_roster_parlamentar_id' = cm.senate_parlamentar_id::text
  )`;

  const listCommittees = async (
    chamber: string | undefined,
    legislature: string | undefined,
    page: CursorPageRequest
  ): Promise<Result<CursorPage<ParliamentCommittee>, ApiError>> => {
    const limit = Math.min(Math.max(page.first, 1), 100);
    const fhash = filterHash(`committees:${chamber ?? ''}:${legislature ?? ''}`);
    const conds: RawBuilder<unknown>[] = [];
    if (chamber !== undefined) conds.push(sql`co.chamber = ${rawCommitteeChamber(chamber)}`);
    if (legislature !== undefined) conds.push(sql`co.legislature = ${legislature}`);
    if (page.after !== undefined) {
      // Cursors minted under the old `committeeKey` sort fail this check and
      // surface as "restart pagination" — the intended graceful break, not a bug.
      const dec = decodeCursor(page.after, { sort: 'committeeName', dir: 'asc', fhash });
      if (dec.isErr()) return err(dec.error);
      const keys = requireCursorKeys(dec.value.keys, 2);
      if (keys.isErr()) return err(keys.error);
      const [name = '', key = ''] = keys.value;
      conds.push(sql`(co.name, co.committee_key) > (${name}, ${key})`);
    }
    try {
      // Ordered by NAME, not by `committee_key`. The key is an opaque per-chamber
      // id — a cdep path (`cdep:2:2024:11`) or a Senate UUID — so ordering by it
      // scattered a chamber's committees arbitrarily: the two IDENTICALLY named
      // Senate rows for "Comisia pentru comunicații, tehnologia informației și
      // inteligență artificială" landed at #117 and #172 of 191, with a third,
      // near-identically named committee at #54. All three are adjacent at
      // #83-85 now. Any reader holding a bounded prefix saw an arbitrary subset.
      //
      // The keyset below needs a DETERMINISTIC collation applied identically by
      // the ORDER BY and the row comparison — that is the requirement, and any
      // deterministic collation satisfies it. This database's `C` locale is what
      // additionally makes the order BYTE order rather than linguistic, so
      // linguistic ordering stays a presentation concern (the client re-sorts
      // with `localeCompare(…, 'ro')`). `committee_key` is the tiebreak, so
      // duplicate names page deterministically — cdep carries more of that load
      // than the Senate did (59 duplicate names, max repeat 16, vs 38 and 9).
      const rows = await db
        .selectFrom('parliament.committees as co')
        .select(COMMITTEE_SELECT)
        .where(composeWhere(conds))
        .orderBy('co.name', 'asc')
        .orderBy('co.committee_key', 'asc')
        .limit(limit + 1)
        .execute();
      const hasMore = rows.length > limit;
      const sliced = hasMore ? rows.slice(0, limit) : rows;
      const items = sliced.map((r) => mapCommittee(r as CommitteeRow));
      const last = sliced[sliced.length - 1] as CommitteeRow | undefined;
      const next =
        hasMore && last !== undefined
          ? buildNextCursor({
              sort: 'committeeName',
              dir: 'asc',
              fhash,
              lastKeys: [last.name, last.committee_key],
            })
          : null;
      return ok({ items, next });
    } catch (e) {
      return err(databaseError('listCommittees failed', e));
    }
  };

  const findCommittee = async (
    committeeKey: string
  ): Promise<Result<ParliamentCommittee | null, ApiError>> => {
    try {
      const row = await db
        .selectFrom('parliament.committees as co')
        .select(COMMITTEE_SELECT)
        .where('co.committee_key', '=', committeeKey)
        .limit(1)
        .executeTakeFirst();
      return ok(row === undefined ? null : mapCommittee(row as CommitteeRow));
    } catch (e) {
      return err(databaseError('findCommittee failed', e));
    }
  };

  const listCommitteeRoster = async (
    committeeKey: string
  ): Promise<Result<readonly ParliamentCommitteeMembership[], ApiError>> => {
    try {
      // cdep rows link by mandate_key; senate_committee rows via the current-roster
      // attr join (unlinked rows still appear with a null member — no member_name,
      // PDL-003). senate_profile rows are EXCLUDED (no member link + noise).
      const rows = await db
        .selectFrom('parliament.committee_memberships as cm')
        .leftJoin('parliament.members as m', (join) => join.on(SENATE_ROSTER_JOIN))
        .select([
          ...MEMBER_SELECT,
          'cm.membership_key',
          'cm.role as membership_role',
          sql<string | null>`cm.joined_date::text`.as('joined_date'),
          sql<string | null>`cm.left_date::text`.as('left_date'),
          'cm.is_bureau as membership_is_bureau',
          'cm.source_url as membership_source_url',
        ])
        .where('cm.committee_key', '=', committeeKey)
        .where('cm.membership_source', 'in', ['cdep_committee', 'senate_committee'])
        .orderBy(
          sql`(cm.left_date is null) desc, cm.joined_date desc nulls last, m.full_name asc nulls last`
        )
        // Empirically safe: the largest committee roster is ~57 seats (measured live
        // 2026-07-06, max cdep:2:2012:33) — the 500 cap never truncates a real roster.
        .limit(500)
        .execute();
      return ok(
        rows.map((r) => {
          // The LEFT JOIN makes every member column nullable at runtime (Kysely still
          // infers mandate_key as non-null from the table type) — override it so the
          // unlinked-seat branch is a REAL conditional, not a type-lie.
          const row = r as Omit<MemberRow, 'mandate_key'> &
            CommitteeMembershipCoreRow & { mandate_key: string | null };
          // member is null when the seat did not resolve to a member (unlinked row).
          const member = row.mandate_key !== null ? mapMember(row as MemberRow) : null;
          return mapCommitteeMembership(row, null, member);
        })
      );
    } catch (e) {
      return err(databaseError('listCommitteeRoster failed', e));
    }
  };

  const listMemberCommitteeMemberships = async (
    mandateKey: string
  ): Promise<Result<readonly ParliamentCommitteeMembership[], ApiError>> => {
    try {
      // The member's committee seats: cdep by mandate_key; senate_committee via the
      // attr join when this member is a CURRENTLY-SEATED senator. The committee is
      // the soft-link (nullable). No member_name / group / role_raw (PDL-003).
      const rows = await db
        .selectFrom('parliament.committee_memberships as cm')
        .innerJoin('parliament.members as m', (join) =>
          join.on(sql<boolean>`m.mandate_key = ${mandateKey}`)
        )
        .leftJoin('parliament.committees as co', 'co.committee_key', 'cm.committee_key')
        .select([
          ...COMMITTEE_SELECT,
          'cm.membership_key',
          'cm.role as membership_role',
          sql<string | null>`cm.joined_date::text`.as('joined_date'),
          sql<string | null>`cm.left_date::text`.as('left_date'),
          'cm.is_bureau as membership_is_bureau',
          'cm.source_url as membership_source_url',
        ])
        .where('cm.membership_source', 'in', ['cdep_committee', 'senate_committee'])
        .where(SENATE_ROSTER_JOIN)
        .orderBy(
          sql`(cm.left_date is null) desc, cm.joined_date desc nulls last, co.name asc nulls last`
        )
        // Empirically safe: a member holds single-digit committee seats (measured live
        // 2026-07-06; busiest members ≤ a handful) — the 200 cap never truncates.
        .limit(200)
        .execute();
      return ok(
        rows.map((r) => {
          const row = r as CommitteeMembershipCoreRow & {
            committee_key: string | null;
            chamber: string | null;
            name: string | null;
            legislature: string | null;
            committee_type: string | null;
            source_url: string | null;
          };
          // The committee soft-link (null only if the FK was unresolved).
          const committee =
            row.committee_key !== null && row.source_url !== null
              ? mapCommittee({
                  committee_key: row.committee_key,
                  chamber: row.chamber,
                  name: row.name ?? '',
                  legislature: row.legislature,
                  committee_type: row.committee_type,
                  source_url: row.source_url,
                })
              : null;
          return mapCommitteeMembership(row, committee, null);
        })
      );
    } catch (e) {
      return err(databaseError('listMemberCommitteeMemberships failed', e));
    }
  };

  /**
   * The bills a committee has touched, as ONE predicate — built here so the page
   * and its total read the SAME set and the cap can never misreport what it cut.
   *
   * TWO ARMS, because neither alone is the committee's work:
   *  - `bill_step_links` (link_kind='committee') is the referral anchor the bill's
   *    own dossier prints. It is where the Senate's 115,890 relinked referrals
   *    live, and it is 96% of the Senate substrate.
   *  - `committee_bill_links` (via `committee_documents`) is the document-side
   *    resolution. Kept because 307 (committee, bill) pairs appear in NO step link.
   * UNION, not UNION ALL: the arms overlap on 26,661 edges.
   *
   * `coalesce(canonical_bill_key, bill_key)` — NOT an `is_canonical` filter on the
   * edge's own bill. 194,269 edges legitimately point at a non-canonical twin: a
   * referral anchor is printed on the dossier of the twin that was referred, while
   * B1 makes the CDep row canonical. Filtering `src.is_canonical` here returns 10
   * bills for `senate:ef36e8b3-…` where 197 exist (measured on Chronos 2026-08-06).
   * The edges are not wrong and must not be "fixed" — the coalesce is the join.
   *
   * Read-time, deliberately NOT a projection table. Measured on Chronos 2026-08-06
   * over the largest committee (cdep:2:2008:11 — 19,640 edges, 3,352 distinct
   * bills): 62 ms warm, 105-115 ms cold, against a 16 ms median committee. Revisit
   * only if getCommittee p50 crosses ~250 ms.
   */
  const committeeBillKeysSql = (committeeKey: string): RawBuilder<boolean> =>
    sql<boolean>`b.bill_key in (
      select coalesce(src.canonical_bill_key, src.bill_key) as bill_key
      from parliament.bill_step_links l
      join parliament.bills src on src.bill_key = l.bill_key
      where l.link_kind = 'committee'
        and l.resolution_status = 'linked'
        and l.target_key = ${committeeKey}
      union
      select coalesce(src.canonical_bill_key, src.bill_key)
      from parliament.committee_bill_links cbl
      join parliament.committee_documents cd
        on cd.committee_document_key = cbl.committee_document_key
      join parliament.bills src on src.bill_key = cbl.bill_key
      where cd.committee_key = ${committeeKey}
        and cbl.resolution_status = 'linked'
        and cd.privacy_class = 'public'
        and cbl.privacy_class = 'public'
    )`;

  const listCommitteeLinkedBills = async (
    committeeKey: string,
    cap: number
  ): Promise<Result<{ bills: readonly ParliamentBill[]; total: number }, ApiError>> => {
    // ONE expression object, used twice. Sharing the built predicate — rather than
    // writing the union out at both call sites — is what makes "the total counts
    // exactly the rows the cap truncated" a property of the code instead of a
    // convention two edits could drift apart.
    const linked = committeeBillKeysSql(committeeKey);
    try {
      // ORDER BY the shared bill sort, NOT bill_key: keys are text, so `asc` puts
      // all 20,748 numeric CDep keys ahead of every 'senat:' key — under a cap that
      // categorically hides the Senate half of a joint committee's work.
      // ONE statement. The total is a window count over the SAME predicate — a
      // window is computed before LIMIT, so it names the whole matching set, and
      // being in the same statement it is the same snapshot as the rows. Two
      // statements could straddle a loader commit and report a total the page
      // provably contradicts, and cost a second ~23 ms round trip to do it.
      const rows = await db
        .selectFrom('parliament.bills as b')
        .select([...BILL_SELECT, sql<string>`count(*) over ()`.as('total')])
        .where(linked)
        .orderBy(billOrderBy('updated_desc'))
        .limit(cap)
        .execute();
      // No rows means nothing matched the predicate, so the total is 0 — the one
      // case a window count cannot report, because there is no row to carry it.
      return ok({
        bills: rows.map((r) => mapBill(r)),
        total: Number(rows[0]?.total ?? 0),
      });
    } catch (e) {
      return err(databaseError('listCommitteeLinkedBills failed', e));
    }
  };

  /** Parent-bound fhash: a documents cursor is bound to its committee_key. */
  const committeeDocumentFhash = (committeeKey: string): string =>
    filterHash(`committee-documents:${committeeKey}`);

  /**
   * A committee's VISIBLE documents — the privacy gate, as one expression.
   *
   * `privacy_class` is `not null` with `check (privacy_class in ('public',
   * 'restricted'))`, so strict equality is the right predicate and
   * `coalesce(privacy_class,'public')` would be the fail-open no-op §5 of this
   * file already warns about. Every row is `public` on Chronos today (94,200 of
   * 94,200), so this gate moves no row — which is exactly why it has to be
   * written now: the platform stores restricted data deliberately and relies on
   * THIS layer to withhold it, so the day a restricted document lands the gate
   * must already exist. It is shared by the page and by the total so the two can
   * never disagree about what is visible.
   */
  const committeeDocumentsVisible = (alias: string, committeeKey: string): RawBuilder<SqlBool> =>
    sql<SqlBool>`${sql.ref(`${alias}.committee_key`)} = ${committeeKey}
        and ${sql.ref(`${alias}.privacy_class`)} = 'public'`;

  const listCommitteeDocuments = async (
    committeeKey: string,
    page: CursorPageRequest
  ): Promise<Result<CommitteeDocumentPage, ApiError>> => {
    const limit = Math.min(Math.max(page.first, 1), COMMITTEE_DOCUMENT_PAGE_LIMIT);
    const fhash = committeeDocumentFhash(committeeKey);
    // ONE ordinal expression, referenced by the projection, the sort AND the
    // keyset comparison. Written out three times it would be three things that
    // can drift, and any drift between the sort and the comparison silently skips
    // or repeats rows rather than failing. See COMMITTEE_DOCUMENT_ORD_SENTINEL for
    // why the coalesce exists at all (NULL doc_date + three-valued ROW compare).
    const ord = sql<string>`coalesce(to_char(cd.doc_date, 'YYYYMMDD'), ${COMMITTEE_DOCUMENT_ORD_SENTINEL})`;
    const conds: RawBuilder<unknown>[] = [committeeDocumentsVisible('cd', committeeKey)];
    if (page.after !== undefined) {
      // Cross-committee replay is rejected HERE, by the fhash: the cursor is
      // signed over this committee_key, so a cursor minted on another committee
      // fails the envelope check before any key reaches SQL.
      const dec = decodeCursor(page.after, { sort: 'docOrd', dir: 'desc', fhash });
      if (dec.isErr()) return err(dec.error);
      const keys = requireCursorKeys(dec.value.keys, 2);
      if (keys.isErr()) return err(keys.error);
      const [ordKey = '', docKey = ''] = keys.value;
      if (!isCommitteeDocumentOrd(ordKey)) {
        return err(invalidInput('malformed cursor; restart pagination', 'cursor'));
      }
      conds.push(sql`(${ord}, cd.committee_document_key) < (${ordKey}, ${docKey})`);
    }
    try {
      // 49,574 of the 94,200 committee_documents rows (52.6%, all CDep) carry a
      // NULL committee_key and are unreachable from ANY committee — they resolve
      // to no committee at all in the source capture. This field therefore serves
      // a committee's documents, not "the committee's complete document record",
      // and must never be presented as the latter.
      const rows = await db
        .selectFrom('parliament.committee_documents as cd')
        .select([
          'cd.committee_document_key',
          'cd.committee_key',
          'cd.title',
          'cd.doc_type',
          sql<string | null>`cd.doc_date::text`.as('doc_date'),
          'cd.document_url',
          'cd.source_url',
          // ONE bill per document, resolved by SUBQUERY rather than a join.
          // `committee_bill_links` is keyed (committee_document_key, scheme,
          // value, year_key), so a document may legitimately carry SEVERAL link
          // rows; a join would then emit the document twice with an identical
          // (ord, key) cursor — duplicating a node, making billKey arbitrary, and
          // skipping a row at a page boundary while `total` still counted the
          // document once. Zero documents carry two link rows on Chronos today,
          // but that is data, not structure, and the keyset cannot depend on it.
          // `order by` makes the pick deterministic instead of arbitrary.
          //
          // The privacy gate sits INSIDE this subquery on purpose: a public
          // document whose only link is restricted stays visible with billKey
          // null, rather than vanishing from its committee's list.
          //
          // The coalesce is the same one the bills union uses — a referral can be
          // filed against a suppressed twin, and the reader must land on the
          // canonical dossier rather than a page that redirects away.
          sql<string | null>`(
            select coalesce(lb.canonical_bill_key, lb.bill_key)
            from parliament.committee_bill_links cbl
            join parliament.bills lb on lb.bill_key = cbl.bill_key
            where cbl.committee_document_key = cd.committee_document_key
              and cbl.resolution_status = 'linked'
              and cbl.privacy_class = 'public'
            order by coalesce(lb.canonical_bill_key, lb.bill_key)
            limit 1
          )`.as('bill_key'),
          ord.as('ord'),
          // The total rides ALONG WITH the page, in the same statement and so the
          // same snapshot. Run as a second round trip it could straddle a loader
          // commit and report a total the page provably contradicts — and on this
          // platform a round trip (~23 ms) costs more than this bounded count.
          // It cannot be `count(*) over ()`: the WHERE carries the keyset bound,
          // so a windowed count would shrink on every page.
          sql<string>`(
            select count(*) from parliament.committee_documents cdt
            where ${committeeDocumentsVisible('cdt', committeeKey)}
          )`.as('total'),
        ])
        .where(composeWhere(conds))
        .orderBy(sql`${ord} desc, cd.committee_document_key desc`)
        .limit(limit + 1)
        .execute();
      const hasMore = rows.length > limit;
      const sliced = hasMore ? rows.slice(0, limit) : rows;
      // EVERY cursor — the page's `next` and each edge's — is minted from the
      // ordinal the DATABASE returned. The resolver used to re-derive edge
      // cursors in TypeScript from doc_date, which is two definitions of the sort
      // key and turns any drift between them into an InvalidInput on replay.
      const cursorFor = (r: { ord: string; committee_document_key: string }): string =>
        buildNextCursor({
          sort: 'docOrd',
          dir: 'desc',
          fhash,
          lastKeys: [r.ord, r.committee_document_key],
        });
      const last = sliced[sliced.length - 1];
      // The total is a SCALAR ON THE ROWS, so an empty page has nothing to carry
      // it — and an empty page is reachable: replaying the final EDGE cursor asks
      // for everything after the last row. Defaulting to 0 there told the reader
      // a committee with documents had published nothing, contradicting the page
      // they had just seen. Falling back to a count-only statement is safe
      // precisely because the page is empty: there are no rows for the total to
      // be snapshot-inconsistent WITH. The common path stays one statement.
      const total =
        rows[0] !== undefined
          ? Number(rows[0].total)
          : Number(
              (
                await db
                  .selectFrom('parliament.committee_documents as cd')
                  .select(sql<string>`count(*)`.as('cnt'))
                  .where(committeeDocumentsVisible('cd', committeeKey))
                  .executeTakeFirst()
              )?.cnt ?? 0
            );
      return ok({
        items: sliced.map((r) => mapCommitteeDocument(r)),
        cursors: sliced.map(cursorFor),
        next: hasMore && last !== undefined ? cursorFor(last) : null,
        total,
      });
    } catch (e) {
      return err(databaseError('listCommitteeDocuments failed', e));
    }
  };

  const committeeMeetingsCount = async (
    committeeKey: string
  ): Promise<Result<number, ApiError>> => {
    try {
      const row = await db
        .selectFrom('parliament.committee_meetings as cmm')
        .select(sql<string>`count(*)`.as('cnt'))
        .where('cmm.committee_key', '=', committeeKey)
        .executeTakeFirst();
      return ok(Number(row?.cnt ?? 0));
    } catch (e) {
      return err(databaseError('committeeMeetingsCount failed', e));
    }
  };

  return {
    // The canonical-stenogram slice: one port, one object (see ParliamentRepo).
    ...stenogram,
    latestLegislature,
    listMembers,
    findMember,
    listGroupCounts,
    listGroupMembers,
    findGroup,
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
    getBillDossierViewKeys,
    getBillEvents,
    listAgendas,
    getAgenda,
    getBillScheduling,
    getBillDocuments,
    getBillInitiators,
    getBillActLinks,
    getBillVoteLinks,
    listVotes,
    getVoteLinks,
    findVote,
    listVotesForBill,
    listVoteRecords,
    voteGroupBreakdown,
    ballotResolution,
    listMemberVotes,
    memberVoteActivity,
    voteActivity,
    billActivity,
    memberActivityCounts,
    listMemberControlItems,
    listMemberSpeeches,
    listMemberSpeechesCursor,
    memberSpeechActivity,
    getSpeechFullText,
    listSpeeches,
    speechActivity,
    findSpeech,
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
    dataFreshness,
    findBillAiMetadata,
    findControlItemAiMetadata,
    listCommittees,
    findCommittee,
    listCommitteeRoster,
    listCommitteeLinkedBills,
    listCommitteeDocuments,
    committeeMeetingsCount,
    listMemberCommitteeMemberships,
  };
};

export { fhashFor };
