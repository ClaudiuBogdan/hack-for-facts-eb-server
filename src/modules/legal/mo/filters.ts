/**
 * Monitorul-Oficial (`mo/` area, plan 06) — collection filter specs (§7.1). MO
 * REUSES the shared legal filter families (`act_type`, `issuer`, `year`) as field
 * SHAPES on its own collections and adds MO-only fields. It only DECLARES the
 * `CollectionFilterSpec`s; the kernel derivers compile GraphQL input / SQL / fhash.
 *
 * ENUM `enumValues` carry the **DB values** (incl. the hyphenated `mo-only`) so
 * `toConditionBuilders` matches rows directly. The kernel `toGraphQLInput` emits
 * enum filter fields as `String` (not a GraphQL enum), so there is no input-side
 * enum to translate — only the OUTPUT object enum fields are aliased (§6.1,
 * `graphql.ts`). Clients pass the DB value (`"mo-only"`) in `in:[…]` filters.
 *
 * Aliases: `i` = mo_issues, `p` = mo_act_publications, `e` = mo_lifecycle_edges.
 * NO joins are composed by the kernel — each collection is a single-table scan
 * (the repo owns the FROM), bounded by a mandatory predicate per §7 (year /
 * act_year-or-issuer-or-act_id / relation-or-target).
 */

import { MO_EDGE_RESOLUTIONS, MO_PART_CODES, MO_RELATIONS, MO_RESOLUTIONS } from './types.js';

import type { CollectionFilterSpec } from '@/modules/shared/index.js';

const PART_CODE_VALUES = [...MO_PART_CODES];
const RESOLUTION_VALUES = [...MO_RESOLUTIONS];
const EDGE_RESOLUTION_VALUES = [...MO_EDGE_RESOLUTIONS]; // includes 'mo-only'
const RELATION_VALUES = [...MO_RELATIONS];

// ─────────────────────────────────────────────────────────────────────────────
// mo_issues
// ─────────────────────────────────────────────────────────────────────────────

export const moIssuesSpec: CollectionFilterSpec = {
  collection: 'mo_issues',
  fields: [
    {
      name: 'year',
      type: 'int',
      ops: ['eq'],
      column: { alias: 'i', column: 'issue_year' },
      description: 'Gazette issue year (bounds the scan; required by the browse usecase).',
    },
    {
      name: 'partCode',
      type: 'enum',
      ops: ['in'],
      column: { alias: 'i', column: 'part_code' },
      array: true,
      exclude: true,
      enumValues: PART_CODE_VALUES,
      description: 'Gazette part: PI (laws/decrees), PII, PIM (ministerial), …',
    },
    {
      name: 'issueDate',
      type: 'date',
      ops: ['between'],
      column: { alias: 'i', column: 'issue_date' },
      description: 'Publication-date range { from, to }.',
    },
    {
      name: 'hasPdf',
      type: 'bool',
      ops: ['eq'],
      column: { alias: 'i', column: 'has_emonitor_link' },
      description: 'Whether an e-monitor PDF link is available.',
    },
    {
      name: 'q',
      type: 'string',
      ops: ['contains'],
      column: { alias: 'i', column: 'issue_label' },
      description: 'ILIKE on the issue label (small table; Postgres fallback).',
    },
  ],
  sort: { default: 'issue_date_desc', allowed: ['issue_date_desc', 'issue_date_asc', 'issue_year_desc'] },
};

// ─────────────────────────────────────────────────────────────────────────────
// mo_act_publications  (≥1 bounding predicate enforced by the usecase)
// ─────────────────────────────────────────────────────────────────────────────

export const moPublicationsSpec: CollectionFilterSpec = {
  collection: 'mo_publications',
  fields: [
    {
      name: 'actType',
      type: 'enum',
      ops: ['in', 'isNull'],
      column: { alias: 'p', column: 'act_type' },
      array: true,
      exclude: true,
      // act_type is an OPEN vocabulary (loader-rederived ~14 values) — no closed
      // enumValues so a new type surfaces without a code change; validated as text.
      description: 'Rederived act type (lege/oug/hotarare/ordin/decret/…). isNull selects unresolved.',
    },
    {
      name: 'issuerSlug',
      type: 'string',
      ops: ['in', 'isNull'],
      column: { alias: 'p', column: 'issuer_slug' },
      array: true,
      exclude: true,
      description: 'Diacritics-folded issuer slug (366 distinct). isNull selects national types.',
    },
    {
      name: 'actYear',
      type: 'int',
      ops: ['eq', 'between'],
      column: { alias: 'p', column: 'act_year' },
      description: 'Act year (a bounding predicate).',
    },
    {
      name: 'issueYear',
      type: 'int',
      ops: ['eq'],
      column: { alias: 'p', column: 'issue_year' },
    },
    {
      name: 'resolution',
      type: 'enum',
      ops: ['in'],
      column: { alias: 'p', column: 'resolution' },
      array: true,
      exclude: true,
      enumValues: RESOLUTION_VALUES,
      description: 'Act-link resolution: unique / ambiguous / unmatched.',
    },
    {
      // bigint id — typed `string` (NOT `int`): the kernel maps `int` → GraphQL
      // `Int` (JS number, precision loss > 2^53). A string `eq`/`isNull` compiles
      // to `act_id = $1` which Postgres casts text→bigint safely (Codex #3).
      name: 'actId',
      type: 'string',
      ops: ['eq', 'isNull'],
      column: { alias: 'p', column: 'act_id' },
      description: 'Resolved legal.acts id (bigint as string; a bounding predicate; partial index).',
    },
    {
      name: 'moIssueId',
      type: 'string', // bigint as string (Codex #3)
      ops: ['eq'],
      column: { alias: 'p', column: 'mo_issue_id' },
      description: 'Containing gazette issue (bigint as string; a bounding predicate; index).',
    },
    {
      name: 'q',
      type: 'string',
      ops: ['contains'],
      column: { alias: 'p', column: 'title' },
      description: 'ILIKE on the act title (Postgres fallback; mo_act search index not yet populated).',
    },
  ],
  sort: { default: 'act_year_desc', allowed: ['act_year_desc', 'act_year_asc'] },
};

// ─────────────────────────────────────────────────────────────────────────────
// mo_lifecycle_edges
// ─────────────────────────────────────────────────────────────────────────────

export const moEdgesSpec: CollectionFilterSpec = {
  collection: 'mo_edges',
  fields: [
    {
      name: 'relation',
      type: 'enum',
      ops: ['in'],
      column: { alias: 'e', column: 'relation' },
      array: true,
      exclude: true,
      enumValues: RELATION_VALUES,
      description: 'Lifecycle relation: promulga / aproba / respinge / rectifica / republica.',
    },
    {
      name: 'resolution',
      type: 'enum',
      ops: ['in'],
      column: { alias: 'e', column: 'resolution' },
      array: true,
      exclude: true,
      enumValues: EDGE_RESOLUTION_VALUES, // includes the hyphenated 'mo-only'
      description: 'Edge resolution: unique / mo-only / ambiguous / unresolved.',
    },
    {
      name: 'sourceMoActKey',
      type: 'string',
      ops: ['eq'],
      column: { alias: 'e', column: 'source_mo_act_key' },
      description: 'Out-edges of one publication (uq-prefix; a bounding predicate).',
    },
    {
      name: 'targetActId',
      type: 'string', // bigint as string (Codex #3)
      ops: ['eq'],
      column: { alias: 'e', column: 'target_act_id' },
      description: 'In-edges targeting one act (bigint as string; partial index; a bounding predicate).',
    },
  ],
  sort: { default: 'edge_id', allowed: ['edge_id'] },
};

export const MO_FILTER_SPECS = {
  issues: moIssuesSpec,
  publications: moPublicationsSpec,
  edges: moEdgesSpec,
} as const;
