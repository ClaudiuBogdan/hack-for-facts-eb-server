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
  mapBillDocument,
  mapBillEvent,
  mapCommittee,
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
  type BillRow,
  type CommitteeMembershipCoreRow,
  type CommitteeRow,
  type ControlItemRow,
  type MemberRow,
  type PersonRow,
  type VoteRow,
} from './mappers.js';
import { makeParliamentStenogramRepo } from './stenogram-repo.js';
import {
  COHESION_VOTE_CAP,
  type ParliamentActivityCounts,
  type ParliamentAiBillMetadata,
  type ParliamentAiControlItemMetadata,
  type ParliamentBallot,
  type ParliamentBill,
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
  type ParliamentSpeechPopulation,
  type ParliamentSpeechSearchDepth,
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
  'm.is_current',
  sql<string | null>`m.mandate_end_date::text`.as('mandate_end_date'),
  'm.mandate_end_reason',
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
  // E2 source-traceability (§6): the EXACT cdep.ro/senat.ro division page.
  'v.source_url',
  'v.attrs',
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
const VOTE_RECORD_PUBLIC = sql`vr.privacy_class = 'public'`;
const INITIATIVE_PUBLIC = sql`mi.privacy_class = 'public'`;
const DECLARATION_PUBLIC = sql`d.privacy_class = 'public'`;

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
  // last_event_date (already ISO YYYY-MM-DD in attrs) — the key the default
  // 'updated_desc' sort uses; surfaced flat so the client can show/verify recency.
  sql<string | null>`b.attrs->>'last_event_date'`.as('last_event_date'),
  'b.attrs',
  // B1 canonicality (§3): is_canonical drives default list visibility; canonical_bill_key
  // points a suppressed Senate twin at its canonical CDep key (null on a canonical row).
  'b.is_canonical',
  'b.canonical_bill_key',
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

/** A member of a composite field, treating a runtime `null` as absent. */
const compositeMember = (f: Record<string, unknown>, name: string): unknown => {
  const v: unknown = f[name];
  return v === null ? undefined : v;
};

/**
 * `votes.groupVote` (virtual, COMPOSITE) → votes seen through ONE group's ballots.
 * It compiles TWO different predicates, and `choice` picks which:
 *
 *  (A) NO `choice` — PARTICIPATION: `exists (… vr.group_name = $g)`, every vote the
 *      group cast at least one ballot on. `nu_a_votat` rows count: they are recorded
 *      ballots, so "the group was there and mostly abstained from voting" is still
 *      participation. This is the reading a filter panel needs when a reader picks a
 *      party and no stance, and it is deliberately NOT the union of the four
 *      stance-filtered sets — a vote the group TIED on belongs to no stance yet
 *      unmistakably belongs here.
 *
 *  (B) WITH `choice` — the group's PLURALITY stance on the vote, i.e. (A) plus an
 *      argmax. A group has no stance in the data — its members each cast a ballot —
 *      so the stance is DERIVED as the choice with the MOST vote_records rows for
 *      that group on that vote. Three rules, all deliberate and all visible in the
 *      SQL below:
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
 * vote_records and the parliamentGroups nomenclator disagree on vocabulary, and
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
        'groupVote.group is required — the group name exactly as vote_records spells it',
        'groupVote.group'
      )
    );
  }
  // Correlated on vote_key so the aggregate rides vote_records_pkey (vote_key,
  // row_index) — the only usable index; group_name/choice are post-scan filters.
  const scoped = sql`select 1 from parliament.vote_records vr
                     where vr.vote_key = v.vote_key and vr.group_name = ${group}`;
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
    sql`count(*) filter (where vr.choice = ${choice})`;
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
 */
const foldedVoteTitle: RawBuilder<string> = sql<string>`lower(translate(coalesce(v.title, ''), ${FOLD_FROM}, ${FOLD_TO}))`;

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
      return ok({ rows: rows.map((r) => mapMember(r as MemberRow)), total, estimated: false });
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
      return ok(row === undefined ? null : mapMember(row as MemberRow));
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
      return ok(rows.map((r) => mapMember(r as MemberRow)));
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
      const pred = (v: string): RawBuilder<unknown> =>
        v === 'government'
          ? sql`(b.attrs#>>'{procedure,tip_initiativa}' ilike 'Proiect de Lege%'
                 or b.attrs#>>'{initiator_classification,value}' = 'government')`
          : sql`(b.attrs#>>'{procedure,tip_initiativa}' ilike 'Propunere legislativa%'
                 or b.attrs#>>'{initiator_classification,value}' = 'parliamentary')`;
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
      const st = sql`lower(coalesce(b.attrs->>'status_text', ''))`;
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
        rows: rows.map((r) => mapBill(r as BillRow)),
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
      return ok(row === undefined ? null : mapBill(row as BillRow));
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
        .where(
          sql<SqlBool>`b.dup_group_id is not null and b.dup_group_id = (select b2.dup_group_id from parliament.bills b2 where b2.bill_key = ${billKey})`
        )
        .execute();
      const canonicalCount = rows.filter((r) => r.is_canonical).length;
      if (rows.length === 2 && canonicalCount === 1) {
        // Requested view first so downstream merges keep a stable anchor.
        const keys = rows.map((r) => r.bill_key);
        return ok([billKey, ...keys.filter((k) => k !== billKey)]);
      }
      return ok([billKey]);
    } catch (e) {
      return err(databaseError('getBillDossierViewKeys failed', e));
    }
  };

  const getBillEvents = async (billKey: string) => {
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
        .select(['d.bill_key', 'd.url', 'd.label', 'd.kind', 'd.position'])
        .where('d.bill_key', '=', billKey)
        .orderBy('d.position', 'asc')
        .execute();
      return ok(rows.map(mapBillDocument));
    } catch (e) {
      return err(databaseError('getBillDocuments failed', e));
    }
  };

  const getBillInitiators = async (
    billKey: string
  ): Promise<Result<readonly ParliamentMember[], ApiError>> => {
    try {
      // H10: select the FULL member columns and map via mapMember, so an initiator
      // reached through a bill has the SAME shape as parliamentMember(s) —
      // legislature/normalizedName/constituencyName/birthDate/profileUrl plus the nested
      // group/person/interval resolvers. The set is NOT filtered by is_current
      // (attribution is never gated; a superseded/deceased initiator is kept).
      const rows = await db
        .selectFrom('parliament.member_initiatives as mi')
        .innerJoin('parliament.members as m', 'm.mandate_key', 'mi.mandate_key')
        .select(MEMBER_SELECT)
        .where('mi.bill_key', '=', billKey)
        .orderBy('m.full_name', 'asc')
        .limit(500)
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
    billKey: string
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
        .where('bal.bill_key', '=', billKey)
        .execute();
      return ok(rows.map(mapActLink));
    } catch (e) {
      return err(databaseError('getBillActLinks failed', e));
    }
  };

  const getBillVoteLinks = async (
    billKey: string
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
    const baseConds = condsRes.value;
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
        .limit(1)
        .executeTakeFirst();
      return ok(row === undefined ? null : mapVote(row as VoteRow));
    } catch (e) {
      return err(databaseError('findVote failed', e));
    }
  };

  const listVotesForBill = async (
    billKey: string
  ): Promise<Result<readonly ParliamentVote[], ApiError>> => {
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

  const voteGroupBreakdown = async (
    voteKey: string
  ): Promise<Result<readonly ParliamentVoteGroupBreakdown[], ApiError>> => {
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
        .select([
          sql<string>`count(*)`.as('total'),
          sql<string>`count(vr.mandate_key)`.as('resolved'),
        ])
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
    page: CursorPageRequest,
    filter: FilterInput = {}
  ): Promise<Result<CursorPage<ParliamentMemberVote> & { total: number }, ApiError>> => {
    const limit = Math.min(Math.max(page.first, 1), 100);
    const fhash = memberVotesFhash(mandateKey, filter);
    // Spec conditions (voteDate/chamber/outcome on `v`, choice on `vr`) AND the
    // mandate bound — ANDed into the same WHERE. Non-virtual spec, so the filter
    // compiles directly.
    const built = toConditionBuilders(memberVotesFilterSpec, filter);
    if (built.isErr()) return err(built.error);
    const where = composeWhere([
      sql`vr.mandate_key = ${mandateKey}`,
      VOTE_RECORD_PUBLIC,
      VOTE_PUBLIC,
      ...built.value,
    ]);
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
        .where(where)
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
          ? buildNextCursor({
              sort: 'memberVote',
              dir: 'desc',
              fhash,
              lastKeys: [last.voteDate ?? '', last.voteKey, last.rowIndex],
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
      sql`vr.mandate_key = ${mandateKey}`,
      VOTE_RECORD_PUBLIC,
      VOTE_PUBLIC,
      sql`v.vote_date >= ${yearStart}`,
      sql`v.vote_date <= ${yearEnd}`,
      ...specConds,
    ]);
    const yearsWhere = composeWhere([
      sql`vr.mandate_key = ${mandateKey}`,
      VOTE_RECORD_PUBLIC,
      VOTE_PUBLIC,
      sql`v.vote_date is not null`,
      ...specConds,
    ]);
    try {
      const [dayRows, yearRows] = await Promise.all([
        db
          .selectFrom('parliament.vote_records as vr')
          .innerJoin('parliament.votes as v', 'v.vote_key', 'vr.vote_key')
          .select([
            sql<string>`v.vote_date::text`.as('date'),
            sql<string>`count(*)`.as('total'),
            sql<string>`count(*) filter (where vr.choice = 'pentru')`.as('pentru'),
            sql<string>`count(*) filter (where vr.choice = 'impotriva')`.as('impotriva'),
            sql<string>`count(*) filter (where vr.choice = 'abtinere')`.as('abtinere'),
            sql<string>`count(*) filter (where vr.choice = 'nu_a_votat')`.as('nu_a_votat'),
          ])
          .where(daysWhere)
          .groupBy('v.vote_date')
          .orderBy('v.vote_date', 'asc')
          .execute(),
        db
          .selectFrom('parliament.vote_records as vr')
          .innerJoin('parliament.votes as v', 'v.vote_key', 'vr.vote_key')
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
   * SPEECH_PUBLIC; votes: the `vote_records ⋈ votes` shape of `listMemberVotes`
   * (so `activityCounts.votes` still equals the unfiltered connection `total`).
   * `vote_records` stays parent-bounded by `mandate_key` (§3.1).
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
             from parliament.vote_records vr
             join parliament.votes v on v.vote_key = vr.vote_key
            where vr.mandate_key = ${mandateKey}
              and ${VOTE_RECORD_PUBLIC}
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
          .select([
            'c.item_key',
            'c.control_type',
            'c.control_type_provenance',
            'c.title',
            'c.recipient',
            sql<string | null>`c.item_date::text`.as('item_date'),
            'c.response_status',
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
    for (const key of ['controlType', 'responseStatus', 'itemDate'] as const) {
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
        .select([
          'c.item_key',
          'c.control_type',
          'c.control_type_provenance',
          'c.title',
          'c.recipient',
          sql<string | null>`c.item_date::text`.as('item_date'),
          'c.response_status',
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
      return err(
        invalidInput(`cohesion vote set exceeds cap (${String(COHESION_VOTE_CAP)})`, 'voteKeys')
      );
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
          // M12: largest-remainder (Hamilton) apportionment so the four percentages sum
          // to EXACTLY 100.00 — independent half-up rounding of each could yield 99.99/100.01.
          const [forPct = 0, againstPct = 0, abstainPct = 0, absentPct = 0] = largestRemainderPct(
            [pentru, impotriva, abtinere, absent],
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
      const dec = decodeCursor(page.after, { sort: 'committeeKey', dir: 'asc', fhash });
      if (dec.isErr()) return err(dec.error);
      const keys = requireCursorKeys(dec.value.keys, 1);
      if (keys.isErr()) return err(keys.error);
      conds.push(sql`co.committee_key > ${keys.value[0] ?? ''}`);
    }
    try {
      const rows = await db
        .selectFrom('parliament.committees as co')
        .select(COMMITTEE_SELECT)
        .where(composeWhere(conds))
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
              sort: 'committeeKey',
              dir: 'asc',
              fhash,
              lastKeys: [last.committee_key],
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

  const listCommitteeLinkedBills = async (
    committeeKey: string,
    cap: number
  ): Promise<Result<{ bills: readonly ParliamentBill[]; total: number }, ApiError>> => {
    try {
      // committee → documents → resolved (linked) bill; canonical bills only. A bill
      // can link via several documents, so DISTINCT dedupes; the total is the exact
      // distinct count (bounded — 29,983 links resolve across 114 committees).
      const rows = await db
        .selectFrom('parliament.committee_bill_links as cbl')
        .innerJoin(
          'parliament.committee_documents as cd',
          'cd.committee_document_key',
          'cbl.committee_document_key'
        )
        .innerJoin('parliament.bills as b', 'b.bill_key', 'cbl.bill_key')
        .select(BILL_SELECT)
        .distinct()
        .where('cd.committee_key', '=', committeeKey)
        .where('cbl.resolution_status', '=', 'linked')
        .where(sql<boolean>`b.is_canonical`)
        .orderBy('b.bill_key', 'asc')
        .limit(cap)
        .execute();
      const cntRow = await db
        .selectFrom('parliament.committee_bill_links as cbl')
        .innerJoin(
          'parliament.committee_documents as cd',
          'cd.committee_document_key',
          'cbl.committee_document_key'
        )
        .innerJoin('parliament.bills as b', 'b.bill_key', 'cbl.bill_key')
        .select(sql<string>`count(distinct b.bill_key)`.as('cnt'))
        .where('cd.committee_key', '=', committeeKey)
        .where('cbl.resolution_status', '=', 'linked')
        .where(sql<boolean>`b.is_canonical`)
        .executeTakeFirst();
      return ok({ bills: rows.map((r) => mapBill(r as BillRow)), total: Number(cntRow?.cnt ?? 0) });
    } catch (e) {
      return err(databaseError('listCommitteeLinkedBills failed', e));
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
    memberVoteActivity,
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
    committeeMeetingsCount,
    listMemberCommitteeMemberships,
  };
};

export { fhashFor };
