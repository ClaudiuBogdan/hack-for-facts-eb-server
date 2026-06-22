/**
 * Parliament module — `ProdDatabase` augmentation (foundation §3, §14.1;
 * plan 04 §2). 04 OWNS the `parliament.*` tables. Only the columns the repo reads
 * are typed; PII/provenance columns the surfaces never project
 * (`birth_date_text`, `birth_date_parse_method`, `persons.cluster_key`,
 * `member_declarations.file_hash`) are deliberately OMITTED so a stray
 * `select('birth_date_text')` is a compile error — the privacy invariant is
 * enforced by the type, not just by code review (plan §2.6, §12).
 *
 * Scalars (§14.1):
 *  - `bigint` → `string` (person_id, declaration_id, bill_act_link_id,
 *    bill_vote_link_id, candidate_id) — pg int8 parser yields a string.
 *  - `date` → `'YYYY-MM-DD'` string (cast `::text` at the SQL boundary; pg returns
 *    `Date` objects otherwise — the unified `vote_date::text` precedent).
 *  - `timestamptz` → ISO string; `jsonb` → object.
 *
 * vote_records (4.13M) is typed but the repo NEVER scans it unparented — every
 * read is bounded by `vote_key` (PK prefix) or `mandate_key` (the secondary idx).
 */

import type { ColumnType } from 'kysely';

/** read-only timestamptz returned as an ISO string. */
type Tstz = ColumnType<string, never, never>;
/** read-only date column; cast `::text` in the query, but typed as the raw value here. */
type DateCol = ColumnType<string, never, never>;
/** jsonb column: object on read; the server is read-only so write types are unused. */
type Jsonb = ColumnType<Record<string, unknown>, never, never>;

// ── members / groups / persons ───────────────────────────────────────────────

export interface ParliamentMembersTable {
  mandate_key: string; // PK — the attribution key on votes/initiatives/control/speeches
  chamber: string | null;
  legislature: string | null;
  full_name: string | null;
  normalized_name: string | null;
  group_name: string | null;
  group_id: string | null;
  constituency_name: string | null;
  birth_date: DateCol | null; // the parsed DOB IS surfaced (public CDEP profile data)
  // birth_date_text / birth_date_parse_method — provenance; OMITTED (§2.6 privacy)
  // SC-1 seat lifecycle. is_current is for COMPOSITION/ROSTER ONLY — it must NEVER
  // gate vote attribution (a superseded/deceased member keeps every vote_records /
  // initiative / control row). mandate_end_text is the raw provenance string —
  // OMITTED here (the parsed date + reason are surfaced; text stays internal).
  is_current: boolean;
  mandate_end_date: DateCol | null;
  mandate_end_reason: string | null; // 'demisie' | 'deces' | … (open list)
  attrs: Jsonb;
  source_updated_at: Tstz | null;
  updated_at: Tstz | null;
  person_id: string | null; // bigint → string
}

export interface ParliamentaryGroupsTable {
  group_id: string;
  chamber: string;
  name: string;
  attrs: Jsonb;
  updated_at: Tstz | null;
}

export interface GroupMembershipIntervalsTable {
  mandate_key: string;
  group_id: string;
  valid_from: DateCol;
  valid_to: DateCol | null;
  source: string;
  vote_count: number | null;
  issues: Jsonb;
}

export interface ParliamentPersonsTable {
  person_id: string; // bigint → string
  canonical_name: string;
  normalized_name: string;
  birth_date: DateCol | null;
  // birth_date_text — provenance; OMITTED (§2.6)
  confidence: string; // 'high' | 'medium' | 'low'
  issues: Jsonb;
  attrs: Jsonb;
  updated_at: Tstz | null;
  // cluster_key — internal clustering anchor; NEVER surfaced; OMITTED (§2.6)
}

export interface PersonIdentityCandidatesTable {
  candidate_id: string; // bigint → string
  mandate_key: string;
  person_id: string | null; // bigint → string
  status: string; // 'needs_review' | 'ambiguous' | 'rejected'
  // method / evidence — internal matcher state; OMITTED from the data-quality
  // projection (§2.6); not typed so a stray select is a compile error.
  created_at: Tstz | null;
  updated_at: Tstz | null;
}

// ── bills / timeline ─────────────────────────────────────────────────────────

export interface ParliamentBillsTable {
  bill_key: string;
  plx_number: string | null;
  plx_year: number | null;
  senate_number: string | null;
  senate_year: number | null;
  title: string | null;
  final_law_number: string | null;
  final_law_year: number | null;
  attrs: Jsonb;
  source_updated_at: Tstz | null;
  updated_at: Tstz | null;
}

export interface BillEventsTable {
  bill_key: string;
  position: number;
  event_date: DateCol | null;
  event_date_text: string | null;
  description: string | null;
  chamber_code: string | null;
  committee: string[] | null;
  vote_idv: string | null;
  docs: Jsonb;
}

export interface BillDocumentsTable {
  bill_key: string;
  url: string;
  label: string | null;
  kind: string | null;
  position: number | null;
  attrs: Jsonb;
}

export interface BillActLinksTable {
  bill_act_link_id: string; // bigint → string
  bill_key: string;
  relationship_kind: string;
  target_act_id: string | null; // bigint → string — NO DB FK to legal.acts (§6.7)
  target_act_type: string | null;
  target_act_number: string | null;
  target_act_year: number | null; // smallint
  target_issuer_slug: string | null;
  target_mo_act_key: string | null; // H4: Monitorul Oficial publication key when resolution_status='linked_mo' (act published in MO but absent from the consolidated registry → target_act_id NULL)
  resolution_status: string;
  confidence: string | null; // numeric(4,3) → string (precision-safe)
  confidence_label: string | null;
  primary_method: string | null;
  resolver_version: string | null;
  // evidence / candidates / issues — internal resolver state; OMITTED (not surfaced)
  created_at: Tstz | null;
  updated_at: Tstz | null;
}

export interface BillVoteLinksTable {
  bill_vote_link_id: string; // bigint → string
  vote_key: string;
  bill_key: string | null;
  source_ref: string | null;
  matched_scheme: string | null;
  match_method: string | null;
  role: string;
  resolution_status: string;
  confidence: string | null; // numeric(4,3) → string
  confidence_label: string | null;
  source_event_position: number | null;
  resolver_version: string | null;
  // evidence / candidates / issues — OMITTED
  created_at: Tstz | null;
  updated_at: Tstz | null;
}

// ── votes / records ──────────────────────────────────────────────────────────

export interface ParliamentVotesTable {
  vote_key: string;
  chamber: string;
  vote_date: DateCol | null;
  title: string | null;
  pentru: number | null;
  impotriva: number | null;
  abtinere: number | null;
  nu_a_votat: number | null;
  present: number | null;
  outcome: string | null; // 'adoptat' | 'respins' | null
  division_number: number | null;
  bill_key: string | null;
  law_reference: string | null;
  attrs: Jsonb;
  source_updated_at: Tstz | null;
  updated_at: Tstz | null;
}

export interface VoteRecordsTable {
  vote_key: string;
  row_index: number;
  member_name: string | null;
  group_name: string | null;
  choice: string | null;
  raw_marker: string | null;
  mandate_key: string | null; // nullable BY DESIGN (collisions never auto-resolved)
  match_method: string | null;
}

// ── member activity ──────────────────────────────────────────────────────────

export interface ControlItemsTable {
  item_key: string;
  control_type: string | null;
  control_type_provenance: string | null;
  title: string | null;
  recipient: string | null;
  item_date: DateCol | null;
  response_status: string | null;
  author_name: string | null;
  mandate_key: string | null;
  match_method: string | null;
  attrs: Jsonb;
  source_updated_at: Tstz | null;
}

export interface MemberInitiativesTable {
  initiative_key: string;
  mandate_key: string;
  bill_key: string | null;
  title: string | null;
  status: string | null;
  registration_number: string | null;
  registration_date_text: string | null;
  promulgated_law_number: string | null;
  promulgated_law_year: number | null;
  bill_url: string | null;
  attrs: Jsonb;
}

export interface SpeechesTable {
  speech_key: string;
  mandate_key: string | null;
  speaker_name: string | null;
  chamber: string | null;
  spoken_at: DateCol | null;
  date_source: string | null;
  quarantined: boolean | null; // WHERE quarantined=false on every default projection
  title: string | null;
  summary: string | null;
  attrs: Jsonb;
  source_updated_at: Tstz | null;
}

export interface MemberDeclarationsTable {
  declaration_id: string; // bigint → string
  mandate_key: string;
  declaration_type: string;
  declaration_date: DateCol | null;
  label: string | null;
  file_url: string;
  // file_hash — internal dedup; NEVER surfaced; OMITTED (§2.6)
  content_status: string | null; // 'link_only' in v1 — content never read
  attrs: Jsonb;
  created_at: Tstz | null;
}

/**
 * Declaration-merge the `parliament.*` tables onto the kernel `ProdDatabase`.
 * Importing the module barrel (`parliament/index.ts`) pulls this in.
 */
declare module '@/modules/shared/shell/db/types.js' {
  interface ProdDatabase {
    /* eslint-disable @typescript-eslint/naming-convention -- Kysely table keys are the schema-qualified live names (foundation §3) */
    'parliament.members': ParliamentMembersTable;
    'parliament.parliamentary_groups': ParliamentaryGroupsTable;
    'parliament.group_membership_intervals': GroupMembershipIntervalsTable;
    'parliament.persons': ParliamentPersonsTable;
    'parliament.person_identity_candidates': PersonIdentityCandidatesTable;
    'parliament.bills': ParliamentBillsTable;
    'parliament.bill_events': BillEventsTable;
    'parliament.bill_documents': BillDocumentsTable;
    'parliament.bill_act_links': BillActLinksTable;
    'parliament.bill_vote_links': BillVoteLinksTable;
    'parliament.votes': ParliamentVotesTable;
    'parliament.vote_records': VoteRecordsTable;
    'parliament.control_items': ControlItemsTable;
    'parliament.member_initiatives': MemberInitiativesTable;
    'parliament.speeches': SpeechesTable;
    'parliament.member_declarations': MemberDeclarationsTable;
    /* eslint-enable @typescript-eslint/naming-convention -- restore the rule after the schema-qualified table keys */
  }
}
