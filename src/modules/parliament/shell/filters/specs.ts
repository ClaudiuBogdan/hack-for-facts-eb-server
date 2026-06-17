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

import { VOTE_CHAMBERS_OK } from '../../core/types.js';

import type { CollectionFilterSpec } from '@/modules/shared/index.js';

/** Live enum domains (verified against transparenta_prod 2026-06-17). */
export const VOTE_CHAMBERS = VOTE_CHAMBERS_OK;
export const VOTE_OUTCOMES = ['adoptat', 'respins'] as const;
/**
 * control_type live values: `question_or_interpellation` is the combined bucket
 * (control_type_provenance='combined_pass'); split rows are `question` /
 * `interpellation`. `motion` is rare (6 rows). NOT `unknown` (plan was stale).
 */
export const CONTROL_TYPES = [
  'question',
  'interpellation',
  'question_or_interpellation',
  'motion',
] as const;

/** Repo-intercepted virtual filter fields per collection (kernel composer skips). */
export const VOTES_VIRTUAL_FIELDS = ['q'] as const;
export const MEMBERS_VIRTUAL_FIELDS = ['group', 'judet', 'q'] as const;
// `year` is virtual: it must match plx_year OR senate_year (Codex BLOCKER #3 —
// a non-virtual plx_year-only field silently drops Senate-only bills).
export const BILLS_VIRTUAL_FIELDS = ['q', 'hasLaw', 'actId', 'year'] as const;
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
      description: 'County/diaspora slug → constituency_name (diacritic-folded). Repo-intercepted; NOT SIRUTA.',
    },
    {
      name: 'q',
      type: 'string',
      ops: ['contains'],
      column: { alias: 'm', column: 'full_name' },
      virtual: true,
      description: 'Member-name search (unaccent-free ILIKE, bounded by legislature). Repo-intercepted.',
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
      description: 'Bill year — matches plx_year OR senate_year (repo-intercepted; covers Senate-only stubs). Residual.',
    },
    {
      name: 'finalized',
      type: 'bool',
      ops: ['isNull'],
      column: { alias: 'b', column: 'final_law_number' },
      description: 'isNull:false = became law (final_law_number IS NOT NULL). Residual.',
    },
    {
      name: 'hasLaw',
      type: 'bool',
      ops: ['eq'],
      column: { alias: 'b', column: 'bill_key' },
      virtual: true,
      description: 'true = has a linked bill_act_links row (resolution_status=linked). Repo EXISTS join.',
    },
    {
      name: 'actId',
      type: 'string',
      ops: ['eq'],
      column: { alias: 'b', column: 'bill_key' },
      virtual: true,
      description: 'Reverse lineage: bills that became act X (bill_act_links_target_idx). Repo-intercepted.',
    },
    {
      name: 'q',
      type: 'string',
      ops: ['contains'],
      column: { alias: 'b', column: 'title' },
      virtual: true,
      description: 'Title / plx-number / senate-number search. Meili-backed; ILIKE fallback. Repo-intercepted.',
    },
  ],
  sort: { default: 'updated_desc', allowed: [...['title_asc', 'title_desc', 'updated_asc', 'updated_desc']] },
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
      description: 'question | interpellation | question_or_interpellation | motion. Residual (no index).',
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
      description: 'Item date range. AT LEAST ONE bound required (no date index) — enforced at the handler.',
    },
    {
      name: 'recipient',
      type: 'string',
      ops: ['eq', 'contains'],
      column: { alias: 'c', column: 'recipient' },
      virtual: true,
      description: 'Ministry/institution addressed (resolved via dim=recipient). Bounds the scan. Repo-intercepted.',
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
      description: 'Title search (ILIKE). Does NOT by itself bound the scan — pair with itemDate/recipient/author. Repo-intercepted.',
    },
  ],
  sort: { default: 'itemDate', allowed: ['itemDate', 'itemKey'] },
};

export const PARLIAMENT_FILTER_SPECS = {
  parliamentVotes: votesFilterSpec,
  parliamentMembers: membersFilterSpec,
  parliamentBills: billsFilterSpec,
  parliamentControlItems: controlItemsFilterSpec,
} as const;
