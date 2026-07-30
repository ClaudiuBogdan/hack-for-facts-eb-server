/**
 * Parliament module — collection filter specs (plan 04 §7). One
 * `CollectionFilterSpec` per collection; the kernel derives the GraphQL input +
 * SQL conditions + the stable `fhash` from each. The module only DECLARES specs.
 *
 * Aliases MUST match each repo FROM clause:
 *   `v`  parliament.votes
 *   `m`  parliament.members
 *   `b`  parliament.bills
 *   `c`  parliament.control_items
 *
 * VIRTUAL fields (repo-intercepted; the kernel composer SKIPS them, §15.6 / #60b):
 *   - votes.q / bills.q          → Meili-primary; ILIKE fallback needs a bound
 *   - votes.groupVote            → per-vote group PLURALITY, or bare PARTICIPATION
 *                                  when `choice` is omitted (vote_records EXISTS;
 *                                  COMPOSITE input — `group` required, `choice` not)
 *   - votes.kind                 → bill_key column + ORDERED title regexes
 *                                  (VOTE_KIND_TITLE_RULES; partition incl. a
 *                                  real `unclassified` bucket)
 *   - members.group / members.judet → slug→exact match (resolved in TS)
 *   - members.q                  → unaccent-free ILIKE on full_name (bounded by legislature)
 *   - bills.hasLaw / bills.actId → join to bill_act_links (cross-table EXISTS)
 *   - control_items.recipient    → slug/contains, resolved value
 *
 * Index discipline (§3 contract): the driving index is named per field where one
 * exists. Small dimension tables (members 5,289; bills 9,935; groups 73) have no
 * btree on most filter columns — those predicates are post-scan filters over a
 * few-thousand-row table (cheap by row count, not by index), stated plainly here
 * rather than naming a non-existent index (the "no speculative index" rule).
 * vote_records (4,164,568 rows, verified 2026-07-28) carries ONLY
 * vote_records_pkey (vote_key, row_index) and vote_records_mandate_idx
 * (mandate_key) — there is NO index on group_name or choice, which is why
 * votes.groupVote requires a bounding vote predicate rather than naming one.
 */

import {
  canonicalizeFilters,
  filterHash,
  type CollectionFilterSpec,
  type FilterInput,
} from '@/modules/shared/index.js';

import {
  STENOGRAM_AVAILABILITIES,
  STENOGRAM_SOURCE_SYSTEMS,
  VOTE_CHAMBERS_OK,
} from '../../core/types.js';

/** Live enum domains (verified against transparenta_prod 2026-06-17). */
export const VOTE_CHAMBERS = VOTE_CHAMBERS_OK;
export const VOTE_OUTCOMES = ['adoptat', 'respins'] as const;
/** A ballot's per-member choice (parliament.vote_records.choice live domain). */
export const VOTE_CHOICES = ['pentru', 'impotriva', 'abtinere', 'nu_a_votat'] as const;
/**
 * control_type live values. CDEP: `question_or_interpellation` is the combined
 * bucket (control_type_provenance='combined_pass'); split rows are `question` /
 * `interpellation`. SENATE (provenance='senate_direct', H12): `question` /
 * `interpellation` / `interpellation_pm` (interpelare adresată Primului
 * Ministru) / `political_declaration` (declaraţie politică). NOT `unknown`.
 *
 * `motion` is EXCLUDED from the served control population
 * (parliament.control-population.v2, user decision 2026-07-22): motions are a
 * different public act that leaked into control_items via a shared attachment
 * lane — 6 rows as of the cut (118,680 → 118,674 served). Every control read
 * (list, member activity, recipient facets/presence) filters
 * `control_type <> 'motion'`; the prod rows are retained untouched pending the
 * dedicated motions domain (PARLIAMENT_READINESS_TODO.md T4).
 */
export const CONTROL_TYPES = [
  'question',
  'interpellation',
  'question_or_interpellation',
  'interpellation_pm',
  'political_declaration',
] as const;

/**
 * Bill INITIATIVE-KIND buckets (the client's badge), source-aware union
 * (re-verified vs transparenta_prod 2026-07-22 on the 22,896 canonical views):
 *   - CDep evidence: `attrs.procedure.tip_initiativa` by PREFIX —
 *       government    → ILIKE 'Proiect de Lege%'       (12,652)
 *       parliamentary → ILIKE 'Propunere legislativa%'  (8,085)
 *   - Senate evidence: `attrs.initiator_classification.value` (H-series Senate
 *     register projection; method initiators:guvern/members, confidence high) —
 *       government 1,064 / parliamentary 484. Senate bills carry NO procedure
 *     block, so before 2026-07-22 the CDep-only prefix silently omitted these
 *     1,548 classifiable bills (readiness-review fix, user decision).
 * The two evidence paths are non-overlapping on live data. Bills with neither
 * signal (2,159 canonical) match NEITHER value (explicit unknown; documented).
 */
export const BILL_TYPES = ['government', 'parliamentary'] as const;

/**
 * Bill STATUS buckets, derived from `attrs.status_text` (re-verified vs prod
 * 2026-07-22 — partitions all 22,896 canonical views, 0 unclassified, 0
 * cross-bucket overlap):
 *   - promulgated → became law, TWO equivalent phrasings             (11,557):
 *       · status_text ILIKE 'lege %' or = 'lege' (also carry final_law_number;
 *         cross-checks 1:1, 0 mismatches), AND
 *       · status_text ILIKE 'a devenit lege%' (final_law_number NOT backfilled,
 *         so status_text is the ONLY became-law signal). Missing this union
 *         silently drops those laws into in_progress (Codex/GLM critique).
 *   - rejected    → status_text ILIKE 'respins%'            (6,424) — case-folded,
 *     so 'Respins de ambele Camere' is covered too; incl. respinsa /
 *     respins(a)definitiv.
 *   - withdrawn   → 'retras%' (withdrawn by initiator) or 'restituit%'
 *     (returned to initiator)                                 (558).
 *   - lapsed      → 'clasat%' (filed/closed, incl. art.63(5) end-of-legislature
 *     lapse) or 'procedura legislativa încetat%' (procedure terminated; all 191
 *     live rows carry the î diacritic — verified)           (1,162).
 *   - in_progress → everything else                          (3,195) — la
 *     comisii, trimis la cameră, pe ordinea de zi, raport, etc.
 *
 * HISTORY: v1 (2026-06-17, 9,958 pre-B1 bills) deliberately deferred the
 * withdrawn/lapsed buckets when the tail was 61 rows (0.6%). After the Senate
 * register expansion the same tail grew to 1,720 canonical bills = 34.9% of the
 * old in_progress bucket — the 2026-07-18 research measured it and the split
 * shipped 2026-07-22 (parliament.bill-lifecycle.v2, user decision, fix-in-place:
 * `in_progress` NARROWED from 4,915 to 3,195). The five buckets stay an
 * exhaustive, disjoint partition: in_progress = NOT(any other bucket).
 * Verified vs prod: NO 'Promulgat…' / 'Legea …' (no-space) phrasings exist, so
 * the promulgated union above is exhaustive for became-law.
 */
export const BILL_STATUSES = [
  'promulgated',
  'rejected',
  'withdrawn',
  'lapsed',
  'in_progress',
] as const;

/**
 * Vote KIND buckets — "votes on actual laws" vs amendment-by-amendment vs
 * housekeeping. The buckets are NOT equally solid, and the API must not pretend
 * they are:
 *
 *   - `legislative` is a COLUMN: `votes.bill_key is not null` (rides
 *     votes_bill_idx). It is the one bucket that does not guess.
 *   - the other four are TITLE HEURISTICS over `votes.title`, a messy free-text
 *     field with no index and no controlled vocabulary.
 *   - `unclassified` is the residual, and it is LARGE (14.4% of the corpus) —
 *     it exists so a third of the votes are not silently dropped out of every
 *     bucket.
 *
 * The buckets are an ORDERED, DISJOINT, EXHAUSTIVE partition: `legislative`
 * first (the column), then the title rules in the declared order, first match
 * wins, and `unclassified` is "matched nothing". Ordering barely bites — only
 * 44 of 9,178 non-bill votes match more than one title rule (measured) — but it
 * is declared rather than emergent so `unclassified` has a meaning.
 *
 * `VOTE_KIND_TITLE_RULES` is the SINGLE source of the shape: the repo compiles
 * its `pattern`s into SQL and `voteKindDescription()` renders the SAME strings
 * into the GraphQL description, so the documented regex cannot drift from the
 * executed one.
 */
export const VOTE_KINDS = [
  'legislative',
  'amendment',
  'procedural',
  'chamber_decision',
  'attendance',
  'unclassified',
] as const;

export type VoteKind = (typeof VOTE_KINDS)[number];

export interface VoteKindTitleRule {
  readonly kind: VoteKind;
  /**
   * POSIX regex matched against the FOLDED title —
   * `lower(translate(coalesce(v.title,''), <diacritics>))` — so `Prezenţa` and
   * `prezenta` are the same needle. Case/diacritic folding is the ONLY
   * normalization; the pattern is otherwise matched as written.
   */
  readonly pattern: string;
  /** Rows landing in this bucket under THIS precedence (prod, 2026-07-28). */
  readonly measured: number;
  /** What the rule is actually recognizing, in the words of the titles. */
  readonly gloss: string;
}

/** Ordered: first match wins (see the partition note above). */
export const VOTE_KIND_TITLE_RULES: readonly VoteKindTitleRule[] = [
  {
    kind: 'attendance',
    pattern: 'prezent',
    measured: 172,
    gloss: 'roll-call / quorum checks ("Verificare prezenta", "Prezenta la vot")',
  },
  {
    kind: 'chamber_decision',
    pattern: '(^ph ?-? ?cd|^ph *-|proiect\\w* de hotarare)',
    measured: 1103,
    gloss:
      'chamber decisions (hotărâri): the "PH CD 23/2025" / "PHCD 75/2022" reference form, the Senate\'s "PH - …" form ("PH - COM (2026) 16 final", "PH - Regulament Senat", "PH - validarea unui mandat de senator"), AND the spelled-out "Proiect(ul) de Hotărâre …" form',
  },
  {
    kind: 'amendment',
    pattern: '(^art\\.? ?[0-9]|amr|amendament|^anexa |nr\\.? ?crt)',
    measured: 3774,
    gloss:
      'amendment- and article-grain votes ("Art.54 - Amr.274-3", "Anexa 3/15 - amendament respins 318", "nr. crt. 3 - amendamente respinse")',
  },
  {
    kind: 'procedural',
    pattern:
      '(ordin\\w* de zi|prelungir|timp\\w* dezbatere|retrimitere la comisie|program\\w* de lucru|sistar)',
    measured: 1424,
    gloss:
      'housekeeping: agenda changes, sitting-time extensions, debate-time allocation, referral back to committee, suspension of debate',
  },
];

/**
 * Bucket sizes that are NOT title rules (prod, total 20,745).
 *
 * `unclassified` re-measured 2026-07-29 when the `PH - …` Senate hotărâre form
 * joined `chamber_decision` (2,983 → 2,705; 278 rows moved, 233 of them the
 * "PH - COM (…) final" EU-document opinions). The remaining figures are the
 * 2026-07-28 measurements — the PH rule cannot touch them (bare refs start with
 * PL/L; the misfiling count is scoped to rows that HAVE a bill_key).
 */
export const VOTE_KIND_MEASURED = {
  corpus: 20_745,
  legislative: 11_567,
  unclassified: 2_705,
  /** Unclassified votes whose title is a SYNTHESIZED date (attrs.title_kind='date'). */
  unclassifiedDateTitles: 1_488,
  /** Unclassified votes whose title is a bare bill reference ("PL 434/2025"). */
  unclassifiedBareRefs: 266,
  /** legislative rows whose OWN attrs.vote_action says "amendament"/"amr". */
  legislativeWithAmendmentAction: 889,
} as const;

/**
 * The `kind` field description, RENDERED from the rules above so the documented
 * regexes are the executed regexes.
 */
const voteKindDescription = (): string => {
  /** Thousands separators — the counts are read by humans in a schema explorer. */
  const n = (x: number): string => String(x).replace(/\B(?=(\d{3})+(?!\d))/gu, ',');
  const m = VOTE_KIND_MEASURED;
  const rules = VOTE_KIND_TITLE_RULES.map(
    (r) => `\`${r.kind}\` = /${r.pattern}/ — ${r.gloss} (${n(r.measured)})`
  ).join('; ');
  return (
    'Vote KIND: what the chamber was voting ON. The buckets are an ordered, disjoint, exhaustive partition of the corpus ' +
    `(${n(m.corpus)} votes, prod 2026-07-28) — but they are NOT equally solid, and that asymmetry is the point. ` +
    `ONE bucket is a COLUMN: \`legislative\` = \`votes.bill_key is not null\` (${n(m.legislative)}), the vote is linked to a bill — a real, indexable signal (votes_bill_idx), NOT a title regex. ` +
    'THE OTHER FOUR ARE TITLE HEURISTICS over a messy free-text field with no controlled vocabulary and no index; they are matched, first-rule-wins in this order, against the lower-cased diacritic-folded title, and ONLY on votes with no bill_key: ' +
    `${rules}. ` +
    `Everything that matches nothing is \`unclassified\` (${n(m.unclassified)}, 14.4%) — a real bucket, not a hole: ${n(m.unclassifiedDateTitles)} of those carry a SYNTHESIZED date title ("Vot din 13 mai 2020", attrs.title_kind='date') that says nothing about the subject, and ${n(m.unclassifiedBareRefs)} are a bare bill reference ("PL 434/2025", "Pl-x nr.246/2017") that a human would file as legislative but the bill link does not exist for. ` +
    `KNOWN MISFILING, measured not guessed: \`legislative\` is "linked to a bill", NOT "a vote on the law as a whole" — ${n(m.legislativeWithAmendmentAction)} of its rows carry an amendment-flavoured attrs.vote_action ("Amendament respins 1", "Amr.2"), because for a bill-linked vote the title is the BILL's title and the stage lives in attrs. So kind:amendment UNDERCOUNTS amendment votes and kind:legislative is the wider "this vote belongs to a bill's file". ` +
    'COST: the title rules are a sequential scan of the 20,745-row votes table (~65ms measured for the whole regex set, count included) — small by row count, not by index; there is no title index and none is claimed. `legislative` alone rides votes_bill_idx. No bound is required. Repo-intercepted.'
  );
};

/** Repo-intercepted virtual filter fields per collection (kernel composer skips). */
export const VOTES_VIRTUAL_FIELDS = ['q', 'groupVote', 'kind'] as const;
export const MEMBERS_VIRTUAL_FIELDS = ['group', 'judet', 'q'] as const;
// `year` is virtual: it must match plx_year OR senate_year (Codex BLOCKER #3 —
// a non-virtual plx_year-only field silently drops Senate-only bills).
// `billType`/`status` are virtual: they classify jsonb attrs (prefix on
// procedure.tip_initiativa / bucket on status_text), not a plain column op.
export const BILLS_VIRTUAL_FIELDS = [
  'q',
  'hasLaw',
  'publishedInMo',
  'actId',
  'year',
  'billType',
  'status',
] as const;
export const CONTROL_VIRTUAL_FIELDS = ['recipient', 'author', 'q'] as const;

// ── votes (cursor; driving votes_chamber_date_idx) ───────────────────────────

export const votesFilterSpec: CollectionFilterSpec = {
  collection: 'parliamentVotes',
  fields: [
    {
      name: 'chamber',
      type: 'enum',
      ops: ['eq', 'in'],
      column: { alias: 'v', column: 'chamber' },
      enumValues: [...VOTE_CHAMBERS],
      array: true,
      description: 'Assembly: camera_deputatilor | senat | comun. Drives votes_chamber_date_idx.',
    },
    {
      name: 'outcome',
      type: 'enum',
      ops: ['eq', 'isNull'],
      column: { alias: 'v', column: 'outcome' },
      enumValues: [...VOTE_OUTCOMES],
      description: 'Vote-level result (adoptat | respins | null). NOT the bill outcome (§2.4).',
    },
    {
      name: 'voteDate',
      type: 'date',
      ops: ['gte', 'lte', 'between'],
      column: { alias: 'v', column: 'vote_date' },
      description: 'Vote date range (bounds the votes_chamber_date_idx range).',
    },
    {
      name: 'billKey',
      type: 'string',
      ops: ['eq'],
      column: { alias: 'v', column: 'bill_key' },
      description: 'Votes for one bill (votes_bill_idx).',
    },
    {
      name: 'q',
      type: 'string',
      ops: ['contains'],
      column: { alias: 'v', column: 'title' },
      virtual: true,
      description:
        'Title search. Meili-backed when up; ILIKE fallback REQUIRES chamber and/or a vote-date bound (no FTS index; repo-intercepted).',
    },
    // VIRTUAL: `legislative` is a column test and the other buckets are title
    // regexes with an ordering — neither is an `{op: value}` on one column, so the
    // kernel composer cannot express it and the repo compiles it from the SAME
    // VOTE_KIND_TITLE_RULES the description above is rendered from.
    {
      name: 'kind',
      type: 'enum',
      ops: ['eq', 'in'],
      // Declared column = the bucket that is REAL (bill_key / votes_bill_idx). The
      // composer never reads it (virtual); it names the driving signal.
      column: { alias: 'v', column: 'bill_key' },
      enumValues: [...VOTE_KINDS],
      virtual: true,
      description: voteKindDescription(),
    },
    // COMPOSITE (not `{eq:…}`): the two members are ONE predicate whose meaning
    // changes with the group, so they cannot be two independent op fields — `choice`
    // alone ("votes with any pentru ballot") is every vote, not a subset, which is
    // why `group` is `!` in the SDL and `choice` is not. `choice` is OPTIONAL because
    // its absence is a real, narrower question — "every vote this group balloted in"
    // — not half a predicate; a caller who omits `group` still gets an error at
    // GraphQL validation. It is `virtual` because both readings are correlated
    // subqueries over vote_records, not a column op the composer could compile.
    {
      name: 'groupVote',
      type: 'string',
      ops: [],
      // Correlation column, like bills.hasLaw declares bill_key: the EXISTS joins
      // vote_records on v.vote_key. The composer never reads it (virtual).
      column: { alias: 'v', column: 'vote_key' },
      virtual: true,
      composite: [
        {
          name: 'group',
          type: 'string',
          required: true,
          description:
            'Group name EXACTLY as vote_records spells it — the ballot vocabulary, NOT the parliamentGroups directory vocabulary (the two disagree: ballots carry e.g. "neafiliat", "Senatori neafiliați", "PIR", "POT"). Case-sensitive, no fuzzy/slug matching: take the value from parliamentVote.groupBreakdown[].groupName or parliamentVoteCohesion[].groupName. An unknown spelling matches nothing rather than guessing.',
        },
        {
          name: 'choice',
          type: 'enum',
          enumValues: [...VOTE_CHOICES],
          graphqlType: 'ParliamentVoteChoice',
          // OPTIONAL: omitting it is the PARTICIPATION reading, not a half-sent
          // predicate — see the field description for the two readings.
          description:
            'The PLURALITY stance to match: pentru | impotriva | abtinere | nu_a_votat (nu_a_votat = the group mostly did not cast a ballot). OMIT IT to match every vote the group took part in, whatever it decided — that is a wider set than the four stances summed, because a TIED vote belongs to no stance.',
        },
      ],
      description:
        "Votes seen through ONE group's ballots. It has TWO readings, and which one runs depends on `choice`. (A) WITHOUT `choice` — PARTICIPATION: every vote on which the group cast at least one ballot, whatever that ballot was, `nu_a_votat` rows included (they are recorded ballots, not missing rows). This is the wider set: it is what a reader who picked a party but no stance means, and it does NOT equal the four stance-filtered sets added up, because a vote where the group TIED belongs to no stance yet the group was plainly there. (B) WITH `choice` — the group's PLURALITY stance. A group has no single stance in the data — a 91-member group splits — so the stance is DERIVED: the choice with the MOST vote_records rows for that group on that vote. Three rules, all deliberate: (1) the plurality is computed over ALL FOUR choices INCLUDING nu_a_votat, so \"the group mostly did not show up\" is expressible and a vote CAN be attributed to nu_a_votat; (2) a TIE for the plurality matches NEITHER tied choice — the group did not take that position, and picking one by sort order would invent a stance; (3) a group with no ballots on a vote never matches — which is exactly reading (A)'s test, so (B) is always a subset of (A). `group` is REQUIRED under both readings: a `choice` on its own would be \"votes with any pentru ballot anywhere\", which is nearly every vote, not a subset. DIFFERENT DENOMINATOR from the cohesion bar: parliamentVoteCohesion.forPct is a share of the group's BALLOT SLOTS across the window, this counts VOTES — do NOT present the filtered count as the bar's percentage. BOUNDEDNESS (both readings): there is NO index on vote_records.group_name or .choice — the predicate rides vote_records_pkey (vote_key, row_index) once per candidate vote, so it REQUIRES a chamber, voteDate or billKey bound (else INVALID_INPUT, never a silent 4.1M-ballot scan). Repo-intercepted.",
    },
  ],
  sort: { default: 'voteDate', allowed: ['voteDate', 'voteKey'] },
};

// ── member votes (a member's ballots ⋈ votes; parented by mandate_key) ────────

export const memberVotesFilterSpec: CollectionFilterSpec = {
  collection: 'parliamentMemberVotes',
  fields: [
    {
      name: 'voteDate',
      type: 'date',
      ops: ['gte', 'lte', 'between'],
      column: { alias: 'v', column: 'vote_date' },
      description:
        'Vote date range (post-scan filter over the member slice; the mandate index has no date).',
    },
    {
      name: 'chamber',
      type: 'enum',
      ops: ['eq', 'in'],
      column: { alias: 'v', column: 'chamber' },
      enumValues: [...VOTE_CHAMBERS],
      array: true,
      description:
        'Assembly of the vote. A member ballots ONLY in their own chamber or in `comun` — filtering by the OTHER chamber matches nothing.',
    },
    {
      name: 'outcome',
      type: 'enum',
      ops: ['eq', 'isNull'],
      column: { alias: 'v', column: 'outcome' },
      enumValues: [...VOTE_OUTCOMES],
      description: 'Vote-level result (adoptat | respins | null). NOT the bill outcome (§2.4).',
    },
    {
      name: 'choice',
      type: 'enum',
      ops: ['eq', 'in'],
      column: { alias: 'vr', column: 'choice' },
      enumValues: [...VOTE_CHOICES],
      array: true,
      description: "This member's ballot: pentru | impotriva | abtinere | nu_a_votat.",
    },
  ],
  sort: { default: 'voteDate', allowed: ['voteDate'] },
};

/**
 * Parent-bound fhash for a member-votes cursor: the mandate AND the filter derive
 * it (Codex #2), so a cursor cannot be replayed against a different member OR a
 * different filter. Mirrors `fhashFor` but keys the mandate into the seed.
 */
export const memberVotesFhash = (mandateKey: string, filter: FilterInput): string =>
  filterHash(`memberVotes:${mandateKey}:${canonicalizeFilters(memberVotesFilterSpec, filter)}`);

// ── member speeches (a member's turns; parented by mandate_key) ───────────────
//
// The full-text search token `q` is NOT a spec field: it spans title + summary AND
// the sibling `parliament.speech_texts.full_text` (a multi-column + cross-table OR
// the kernel `contains` op cannot express), so it enters as a separate GraphQL/repo
// argument and is repo-intercepted (like `membersFilterSpec.q`). It is folded into
// the cursor fhash by `memberSpeechesFhash` so a cursor minted under one `q` cannot
// replay under another — the same binding the filter fields get.

export const memberSpeechesFilterSpec: CollectionFilterSpec = {
  collection: 'parliamentMemberSpeeches',
  fields: [
    {
      name: 'spokenAt',
      type: 'date',
      ops: ['gte', 'lte', 'between'],
      column: { alias: 's', column: 'spoken_at' },
      description:
        'Speech-date range over the member slice (the mandate index carries spoken_at, so a bound is index-ordered).',
    },
    {
      name: 'chamber',
      type: 'enum',
      ops: ['eq', 'in'],
      column: { alias: 's', column: 'chamber' },
      enumValues: [...VOTE_CHAMBERS],
      array: true,
      description:
        'Assembly the turn was delivered in: camera_deputatilor | senat | comun (a joint sitting).',
    },
  ],
  sort: { default: 'spokenAt', allowed: ['spokenAt'] },
};

/**
 * Parent-bound fhash for a member-speeches cursor: the mandate, the filter, the
 * normalized text token `q` AND the APPLIED served population derive it (Codex #2), so
 * a cursor cannot be replayed against a different member, filter, search term — or a
 * different POPULATION.
 *
 * The population token matters because the canonical-preference rule is probe-driven: if
 * the canonical migration lands between two pages, the row set changes underneath an
 * in-flight cursor. Folding it in turns that into the clean "restart pagination" error
 * instead of a page that silently skips or duplicates turns. Callers MUST pass the SAME
 * normalized `q` and the SAME population the repo used; the hash does not derive either.
 */
export const memberSpeechesFhash = (
  mandateKey: string,
  filter: FilterInput,
  q: string | undefined,
  population: string
): string =>
  filterHash(
    `memberSpeeches:${mandateKey}:${canonicalizeFilters(memberSpeechesFilterSpec, filter)}:${q ?? ''}:${population}`
  );

// ── global speeches (stenograme; cursor; bounded by mandateKey OR a spokenAt
//    window — enforced in the usecase, NOT here) ────────────────────────────────
//
// Like memberSpeeches, the text token `q` is NOT a spec field: it spans title +
// summary AND (mandate/window permitting) the sibling
// `parliament.speech_texts.full_text` — a multi-column + cross-table OR the
// kernel `contains` op cannot express — so it enters as a separate GraphQL/MCP
// argument and is repo-intercepted. A spec-level `q` would generate a filter
// input field the physical extraction silently ignores (codex round-3 MAJOR);
// keeping it out means an unknown `filter:{q:…}` fails GraphQL input validation
// instead. The applied search depth (TITLE_SUMMARY | FULL_TEXT) is folded into
// the cursor fhash by `parliamentSpeechesFhash`, so a speech_texts probe flip
// mid-pagination invalidates in-flight cursors cleanly.

export const parliamentSpeechesFilterSpec: CollectionFilterSpec = {
  collection: 'parliamentSpeeches',
  fields: [
    {
      name: 'spokenAt',
      type: 'date',
      ops: ['gte', 'lte', 'between'],
      column: { alias: 's', column: 'spoken_at' },
      description:
        'Speech-date range (valid YYYY-MM-DD only). Without a mandateKey bound the list REQUIRES both ends (from AND to, at most 366 days) — there is NO date index on speeches, so an unbounded window is refused with InvalidInput. A window of at most 92 days additionally enables FULL_TEXT q depth.',
    },
    {
      name: 'chamber',
      type: 'enum',
      ops: ['eq', 'in'],
      column: { alias: 's', column: 'chamber' },
      enumValues: [...VOTE_CHAMBERS],
      array: true,
      description:
        'Assembly the turn was delivered in: camera_deputatilor | senat | comun (a joint sitting; there is NO separate session kind). Does NOT bound the scan by itself.',
    },
    {
      name: 'mandateKey',
      type: 'string',
      ops: ['eq', 'in'],
      column: { alias: 's', column: 'mandate_key' },
      array: true,
      description:
        'Speaker mandate key(s). Bounds the scan via the (mandate_key, spoken_at desc) index — at most 20 values; EXACTLY ONE also enables FULL_TEXT q depth. NULL-mandate turns (PM, guests, unmatched speakers) never match a mandateKey filter.',
    },
  ],
  sort: { default: 'spokenAt', allowed: ['spokenAt'] },
};

/**
 * Cursor fhash for the global speeches connection: the filter, the normalized text token
 * `q`, the APPLIED search depth (token 'none' when no q) AND the APPLIED served
 * population derive it — so a cursor cannot be replayed against a different filter,
 * search term, a probe-flipped depth, or a probe-flipped population. Both probe flips
 * surface as the clean "restart pagination" error instead of a silently inconsistent
 * page. Callers MUST pass the SAME normalized `q`, depth and population the repo used;
 * the hash derives none of them.
 */
export const parliamentSpeechesFhash = (
  filter: FilterInput,
  q: string | undefined,
  depth: string,
  population: string
): string =>
  filterHash(
    `parliamentSpeeches:${canonicalizeFilters(parliamentSpeechesFilterSpec, filter)}:${q ?? ''}:${depth}:${population}`
  );

// ── members (offset+total; bounded by legislature) ───────────────────────────

export const membersFilterSpec: CollectionFilterSpec = {
  collection: 'parliamentMembers',
  fields: [
    {
      name: 'legislature',
      type: 'string',
      ops: ['eq'],
      column: { alias: 'm', column: 'legislature' },
      description: 'Election year (e.g. 2024). Default = latest; ALWAYS present (bounds the scan).',
    },
    {
      name: 'current',
      type: 'bool',
      ops: ['eq'],
      column: { alias: 'm', column: 'is_current' },
      description:
        'SC-1: current:true = currently-seated members only (chamber composition / current roster). Omit for ALL mandate rows. Does NOT affect vote/initiative attribution.',
    },
    {
      name: 'chamber',
      type: 'enum',
      ops: ['eq'],
      column: { alias: 'm', column: 'chamber' },
      enumValues: [...VOTE_CHAMBERS],
      description: 'camera_deputatilor | senat (members are never comun). Residual filter.',
    },
    {
      name: 'group',
      type: 'string',
      ops: ['eq', 'in'],
      column: { alias: 'm', column: 'group_name' },
      array: true,
      virtual: true,
      description: 'Group slug → group_name (resolved via resolve dim=group). Repo-intercepted.',
    },
    {
      name: 'judet',
      type: 'string',
      ops: ['eq', 'in'],
      column: { alias: 'm', column: 'constituency_name' },
      array: true,
      virtual: true,
      description:
        'County/diaspora slug → constituency_name (diacritic-folded). Repo-intercepted; NOT SIRUTA.',
    },
    {
      name: 'q',
      type: 'string',
      ops: ['contains'],
      column: { alias: 'm', column: 'full_name' },
      virtual: true,
      description:
        'Member-name search (unaccent-free ILIKE, bounded by legislature). Repo-intercepted.',
    },
  ],
  sort: { default: 'name', allowed: ['name', 'mandateKey'] },
};

// ── bills (offset+total) ─────────────────────────────────────────────────────

export const billsFilterSpec: CollectionFilterSpec = {
  collection: 'parliamentBills',
  fields: [
    {
      name: 'year',
      type: 'int',
      ops: ['eq', 'gte', 'lte'],
      column: { alias: 'b', column: 'plx_year' },
      virtual: true,
      description:
        'Bill year — matches plx_year OR senate_year (repo-intercepted; covers Senate-only stubs). Residual.',
    },
    {
      name: 'finalized',
      type: 'bool',
      ops: ['isNull'],
      column: { alias: 'b', column: 'final_law_number' },
      description:
        'isNull:false = has a LAW NUMBER (final_law_number IS NOT NULL). NOT the same as hasLaw (act-registry linked): some bills have a law number but no resolved consolidated act, so finalized > hasLaw (the H4 gap, narrowed by publishedInMo). Residual.',
    },
    {
      name: 'hasLaw',
      type: 'bool',
      ops: ['eq'],
      column: { alias: 'b', column: 'bill_key' },
      virtual: true,
      description:
        'true = act-registry RESOLVED — a linked bill_act_links row (resolution_status=linked, consolidated act). Distinct from finalized (has a law number) and from publishedInMo (resolution_status=linked_mo: published in Monitorul Oficial but not yet consolidated, targetActId NULL). Repo EXISTS join.',
    },
    {
      name: 'publishedInMo',
      type: 'bool',
      ops: ['eq'],
      column: { alias: 'b', column: 'bill_key' },
      virtual: true,
      description:
        'true = MO-evidence resolved (H4) — a bill_act_links row with resolution_status=linked_mo: the law is published in Monitorul Oficial but absent from the consolidated act registry (targetActId NULL, targetMoActKey set). The third resolution state between hasLaw (consolidated) and unresolved (no evidence). Repo EXISTS join.',
    },
    {
      name: 'actId',
      type: 'string',
      ops: ['eq'],
      column: { alias: 'b', column: 'bill_key' },
      virtual: true,
      description:
        'Reverse lineage: bills that became act X (bill_act_links_target_idx). Repo-intercepted.',
    },
    {
      name: 'billType',
      type: 'enum',
      ops: ['eq', 'in'],
      column: { alias: 'b', column: 'attrs' },
      enumValues: [...BILL_TYPES],
      array: true,
      virtual: true,
      description:
        'Initiative kind (the client badge), source-aware: government = CDep procedure.tip_initiativa starts with "Proiect de Lege" OR Senate initiator_classification.value = government; parliamentary = "Propunere legislativa" prefix OR Senate value parliamentary. Bills with neither signal match neither (explicit unknown). Repo-intercepted. Residual (no index).',
    },
    {
      name: 'status',
      type: 'enum',
      ops: ['eq', 'in'],
      column: { alias: 'b', column: 'attrs' },
      enumValues: [...BILL_STATUSES],
      array: true,
      virtual: true,
      description:
        'Lifecycle bucket from status_text (v2, 5 disjoint buckets): promulgated = "Lege …"/"A devenit lege…" (became law); rejected = "respins…"; withdrawn = "retras…"/"restituit…"; lapsed = "clasat…"/"procedura legislativa încetată"; in_progress = none of the above. Repo-intercepted. Residual (no index).',
    },
    {
      name: 'q',
      type: 'string',
      ops: ['contains'],
      column: { alias: 'b', column: 'title' },
      virtual: true,
      description:
        'Title / plx-number / senate-number search. Meili-backed; ILIKE fallback. Repo-intercepted.',
    },
  ],
  sort: {
    default: 'updated_desc',
    allowed: [...['title_asc', 'title_desc', 'updated_asc', 'updated_desc']],
  },
};

// ── control_items (cursor; bounded by date window or recipient/author) ────────

export const controlItemsFilterSpec: CollectionFilterSpec = {
  collection: 'parliamentControlItems',
  fields: [
    {
      name: 'controlType',
      type: 'enum',
      ops: ['eq', 'in'],
      column: { alias: 'c', column: 'control_type' },
      enumValues: [...CONTROL_TYPES],
      array: true,
      description:
        'question | interpellation | question_or_interpellation | interpellation_pm | political_declaration. Motions are excluded from the served control population (control-population.v2). Residual (no index).',
    },
    {
      name: 'responseStatus',
      type: 'string',
      ops: ['eq', 'isNull'],
      column: { alias: 'c', column: 'response_status' },
      description:
        'RAW source response status string — NOT an answered/unanswered fact. null means "no structured response status was extracted" (ALL Senate rows + most legacy CDep rows are null because response evidence extraction does not exist for them yet), and non-null values mix requested mode, answer mode, and legacy page-text fragments. Do NOT present isNull as "unanswered"; honest response-evidence fields land with the control evidence topology (PARLIAMENT_READINESS_TODO.md T1).',
    },
    {
      name: 'itemDate',
      type: 'date',
      ops: ['gte', 'lte', 'between'],
      column: { alias: 'c', column: 'item_date' },
      description:
        'Item date range. AT LEAST ONE bound required (no date index) — enforced at the handler.',
    },
    {
      name: 'recipient',
      type: 'string',
      ops: ['eq', 'contains'],
      column: { alias: 'c', column: 'recipient' },
      virtual: true,
      description:
        'Ministry/institution addressed (resolved via dim=recipient). Bounds the scan. Repo-intercepted.',
    },
    {
      name: 'author',
      type: 'string',
      ops: ['contains'],
      column: { alias: 'c', column: 'author_name' },
      virtual: true,
      description: 'Author MP name (ILIKE). Bounds the scan. Repo-intercepted.',
    },
    {
      name: 'q',
      type: 'string',
      ops: ['contains'],
      column: { alias: 'c', column: 'title' },
      virtual: true,
      description:
        'Title search (ILIKE). Does NOT by itself bound the scan — pair with itemDate/recipient/author. Repo-intercepted.',
    },
  ],
  sort: { default: 'itemDate', allowed: ['itemDate', 'itemKey'] },
};

// ── canonical stenogram sessions (cursor; UNBOUNDED IS SAFE HERE) ─────────────
//
// Unlike `parliamentSpeeches`, this list needs NO boundedness guard: the driving
// index `parliament_stenogram_sessions_date_idx (session_date desc)` exists, and the
// table is one row per captured sitting (thousands), not 1.4M turns. Stated here so
// the asymmetry with the speeches guard is deliberate and visible.
//
// VIRTUAL fields (repo-intercepted; the kernel composer SKIPS them):
//   - `year`       → a session_date range (there is no year column, and wrapping the
//                    indexed column in extract() would forfeit the index)
//   - `mandateKey` → an EXISTS over stenogram_segments (cross-table; a speaker is a
//                    property of the READING, not of the session row)
// Alias `ss` = parliament.stenogram_sessions (matches the repo FROM clause).
export const stenogramSessionsFilterSpec: CollectionFilterSpec = {
  collection: 'parliamentStenogramSessions',
  fields: [
    {
      name: 'chamber',
      type: 'enum',
      ops: ['eq', 'in'],
      column: { alias: 'ss', column: 'chamber' },
      enumValues: [...VOTE_CHAMBERS],
      array: true,
      description: 'Assembly of the sitting: camera_deputatilor | senat | comun (a joint sitting).',
    },
    {
      name: 'sessionDate',
      type: 'date',
      ops: ['gte', 'lte', 'between'],
      column: { alias: 'ss', column: 'session_date' },
      description:
        'Sitting-date range (valid YYYY-MM-DD only). Rides parliament_stenogram_sessions_date_idx. A capture whose source carries no trustworthy date has a NULL date and matches NO date filter (it is never dated by inference).',
    },
    {
      name: 'year',
      type: 'int',
      ops: ['eq', 'in'],
      column: { alias: 'ss', column: 'session_date' },
      array: true,
      virtual: true,
      description:
        'Calendar year(s) of the sitting. Repo-intercepted into a session_date range per year so the date index still drives the scan (extract(year …) would not). Dateless captures never match.',
    },
    {
      name: 'availability',
      type: 'enum',
      ops: ['eq', 'in'],
      column: { alias: 'ss', column: 'availability' },
      enumValues: [...STENOGRAM_AVAILABILITIES],
      array: true,
      description:
        'How much reading the capture yields: COMPLETE (has speech blocks) | PARTIAL (readable, no printed speaker heading) | SOURCE_ONLY (blank/navigation-only capture — held with its official URL, no reading served).',
    },
    {
      name: 'sourceSystem',
      type: 'enum',
      ops: ['eq', 'in'],
      column: { alias: 'ss', column: 'source_system' },
      enumValues: [...STENOGRAM_SOURCE_SYSTEMS],
      array: true,
      description: 'Official system the capture came from: cdep_stenogram | senat_stenogram.',
    },
    {
      name: 'mandateKey',
      type: 'string',
      ops: ['eq', 'in'],
      column: { alias: 'ss', column: 'session_key' },
      array: true,
      virtual: true,
      description:
        'Sittings in which the given speaker mandate key(s) hold at least one PUBLIC contribution. Repo-intercepted into an EXISTS over stenogram_segments (segment_kind=SPEECH). Blocks whose speaker could not be roster-resolved carry a null mandate_key and never match.',
    },
  ],
  sort: { default: 'sessionDate', allowed: ['sessionDate'] },
};

/**
 * Cursor fhash for the stenogram-sessions connection: the filter AND the normalized
 * full-history `q` derive it, so a cursor cannot be replayed under a different
 * filter or search term (it would otherwise page through a different ordered set).
 * `q` is NOT a spec field — it is answered by the canonical search projection, not
 * by a column, so it enters as a separate argument on every surface and the repo
 * receives the resolved session keys.
 */
export const stenogramSessionsFhash = (filter: FilterInput, q: string | undefined): string =>
  filterHash(
    `parliamentStenogramSessions:${canonicalizeFilters(stenogramSessionsFilterSpec, filter)}:${q ?? ''}`
  );

export const PARLIAMENT_FILTER_SPECS = {
  parliamentVotes: votesFilterSpec,
  parliamentMemberVotes: memberVotesFilterSpec,
  parliamentMemberSpeeches: memberSpeechesFilterSpec,
  parliamentSpeeches: parliamentSpeechesFilterSpec,
  parliamentStenogramSessions: stenogramSessionsFilterSpec,
  parliamentMembers: membersFilterSpec,
  parliamentBills: billsFilterSpec,
  parliamentControlItems: controlItemsFilterSpec,
} as const;
