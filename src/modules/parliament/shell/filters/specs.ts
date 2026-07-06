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
 */

import {
  canonicalizeFilters,
  filterHash,
  type CollectionFilterSpec,
  type FilterInput,
} from '@/modules/shared/index.js';

import { VOTE_CHAMBERS_OK } from '../../core/types.js';

/** Live enum domains (verified against transparenta_prod 2026-06-17). */
export const VOTE_CHAMBERS = VOTE_CHAMBERS_OK;
export const VOTE_OUTCOMES = ['adoptat', 'respins'] as const;
/** A ballot's per-member choice (parliament.vote_records.choice live domain). */
export const VOTE_CHOICES = ['pentru', 'impotriva', 'abtinere', 'nu_a_votat'] as const;
/**
 * control_type live values. CDEP: `question_or_interpellation` is the combined
 * bucket (control_type_provenance='combined_pass'); split rows are `question` /
 * `interpellation`; `motion` is rare (6 rows). SENATE (provenance='senate_direct',
 * H12): `question` / `interpellation` / `interpellation_pm` (interpelare adresată
 * Primului Ministru) / `political_declaration` (declaraţie politică). NOT `unknown`.
 */
export const CONTROL_TYPES = [
  'question',
  'interpellation',
  'question_or_interpellation',
  'motion',
  'interpellation_pm',
  'political_declaration',
] as const;

/**
 * Bill INITIATIVE-KIND buckets (the client's badge), derived from
 * `attrs.procedure.tip_initiativa` by PREFIX (verified vs transparenta_prod
 * 2026-06-17 — the prefix is exhaustive, no third value):
 *   - government     → tip_initiativa ILIKE 'Proiect de Lege%'      (5,271)
 *   - parliamentary  → tip_initiativa ILIKE 'Propunere legislativa%' (3,005)
 * Bills with NO procedure block (1,682) match NEITHER value (documented).
 */
export const BILL_TYPES = ['government', 'parliamentary'] as const;

/**
 * Bill STATUS buckets, derived from `attrs.status_text` (verified vs prod
 * 2026-06-17 — partitions all 9,958 bills, 0 unclassified):
 *   - promulgated → became law, TWO equivalent phrasings              (4,470):
 *       · status_text ILIKE 'lege %' or = 'lege'   (3,606 — also carry
 *         final_law_number; cross-checks 1:1 with it, 0 mismatches), AND
 *       · status_text ILIKE 'a devenit lege%'      (864 — final_law_number NOT
 *         backfilled, so status_text is the ONLY became-law signal). Missing this
 *         union silently drops 864 laws into in_progress (Codex/GLM critique).
 *   - rejected    → status_text ILIKE 'respins%'            (1,939) — case-folded,
 *     so 'Respins de ambele Camere' (220) is covered too; incl. respinsa /
 *     respins(a)definitiv.
 *   - in_progress → everything else                          (3,549) — la comisii,
 *     trimis la cameră, pe ordinea de zi, raport, etc.
 *
 * `in_progress` means "neither promulgated nor rejected". A SMALL terminal tail —
 * `clasat%` (filed, 46) + `retras%` (withdrawn, 15) = 61 bills — also lands here:
 * they are terminal but neither a law nor a rejection, so v1 keeps the 3-bucket
 * model rather than a 4th "withdrawn/lapsed" bucket (0.6% of bills; GLM Q4 flagged,
 * deliberately deferred). Verified vs prod: NO 'Promulgat…' / 'Legea …' (no-space)
 * phrasings exist, so the promulgated union above is exhaustive for became-law.
 */
export const BILL_STATUSES = ['promulgated', 'rejected', 'in_progress'] as const;

/** Repo-intercepted virtual filter fields per collection (kernel composer skips). */
export const VOTES_VIRTUAL_FIELDS = ['q'] as const;
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
 * Parent-bound fhash for a member-speeches cursor: the mandate, the filter AND the
 * normalized text token `q` derive it (Codex #2), so a cursor cannot be replayed
 * against a different member, filter OR search term. Callers MUST pass the SAME
 * normalized `q` the repo used (see `normalizeSpeechQ`); the hash does not normalize.
 */
export const memberSpeechesFhash = (
  mandateKey: string,
  filter: FilterInput,
  q: string | undefined
): string =>
  filterHash(
    `memberSpeeches:${mandateKey}:${canonicalizeFilters(memberSpeechesFilterSpec, filter)}:${q ?? ''}`
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
        'Initiative kind (the client badge): government = procedure.tip_initiativa starts with "Proiect de Lege"; parliamentary = starts with "Propunere legislativa". Bills with no procedure match neither. Repo-intercepted. Residual (no index).',
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
        'Lifecycle bucket from status_text: promulgated = "Lege …" (became law; matches final_law_number); rejected = "respins…"; in_progress = everything else. Repo-intercepted. Residual (no index).',
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
        'question | interpellation | question_or_interpellation | motion. Residual (no index).',
    },
    {
      name: 'responseStatus',
      type: 'string',
      ops: ['eq', 'isNull'],
      column: { alias: 'c', column: 'response_status' },
      description: 'PR-5 timeliness; isNull surfaces unanswered items.',
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

export const PARLIAMENT_FILTER_SPECS = {
  parliamentVotes: votesFilterSpec,
  parliamentMemberVotes: memberVotesFilterSpec,
  parliamentMemberSpeeches: memberSpeechesFilterSpec,
  parliamentMembers: membersFilterSpec,
  parliamentBills: billsFilterSpec,
  parliamentControlItems: controlItemsFilterSpec,
} as const;
