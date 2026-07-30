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
  // identity-v2 source-traceability (prod migration 20260701T176000): the canonical
  // CDep mandate page for the cluster. Nullable (added `if not exists`, per-row fill).
  source_url: string | null;
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
  // B1 canonicality (migration 20260701T173000): is_canonical is the default-visible
  // flag (§3); canonical_bill_key points a suppressed Senate navetă twin at its
  // canonical CDep key (null on canonical rows). dup_group_id / canonical_match_* /
  // dup_review / decision_chamber are internal dedup provenance — deliberately UNBOUND.
  is_canonical: boolean;
  canonical_bill_key: string | null;
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

/** parliament.bill_procedure_steps — 1:1 with bill_events (the derived interpretation). */
export interface BillProcedureStepsTable {
  bill_key: string;
  position: number;
  row_kind: string;
  parent_position: number | null;
  step_kind: string | null;
  kind_method: string;
  resolver_version: string;
  actor_kind: string;
  chamber_code: string | null;
  extras: Jsonb;
}

/** parliament.bill_step_links — stage-level edges resolved from source anchors. */
export interface BillStepLinksTable {
  bill_step_link_id: number;
  bill_key: string;
  position: number;
  step_position: number;
  link_kind: string;
  target_key: string | null;
  source_href: string;
  source_text: string | null;
  resolution_status: string;
  match_method: string;
  confidence: number | null;
  confidence_label: string | null;
  evidence: Jsonb;
  resolver_version: string;
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

/**
 * What the vote crawl covers (scrapper migration 20260727T142000). Read with
 * `lower(r)` / `upper(r) - 1`: Postgres canonicalises every daterange to the
 * half-open `[from, to+1)`, so a reader that surfaces `upper()` verbatim
 * publishes one day of coverage the crawl does not have.
 */
export interface ParliamentVoteCaptureCoverageTable {
  chamber: string;
  source_system: string;
  scope: string;
  source_url: string;
  source_available_from: DateCol | null;
  observed_from: DateCol;
  observed_through: DateCol;
  /** NULL when no contiguous prefix of the observed days has been re-polled. */
  finalized_through: DateCol | null;
  ranges: unknown; // daterange[]
  as_of: Tstz;
}

export interface ParliamentVoteCaptureGapsTable {
  chamber: string;
  source_system: string;
  gap_date: DateCol;
  // 'failed' | 'skipped' | 'parser_empty' | 'provisional' | 'source_limited'
  status: string;
  reason: string | null;
}

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
  // E2 source-traceability (prod migration 20260701T172000). EXACT cdep.ro /
  // senat.ro division URL; nullable because the backfill is per-row.
  source_url: string | null;
  privacy_class: string; // 'public' | 'restricted' (migration 20260701T171000)
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
  privacy_class: string; // 'public' | 'restricted' (migration 20260701T171000)
}

/** Lossless parser-versioned ballot evidence; served only through vote_positions. */
export interface VoteObservationsTable {
  observation_key: string;
  vote_key: string;
  source_row_index: number;
  native_member_id: string | null;
  member_name: string | null;
  group_name: string | null;
  choice: string | null;
  mandate_key: string | null;
  match_method: string | null;
  source_url: string;
  privacy_class: string;
}

/** Current logical ballot positions derived from all immutable observations. */
export interface VotePositionsTable {
  position_key: string;
  vote_key: string;
  ballot_group_key: string;
  grouping_method: string;
  derivation_version: string;
  native_member_id: string | null;
  mandate_key: string | null;
  representative_observation_key: string;
  position_status: string;
  effective_choice: string | null;
  observed_choices: Jsonb;
  observation_count: number;
  source_position_count: number;
  unknown_marker_count: number;
  identity_count: number;
  member_name_variant_count: number;
  group_name_variant_count: number;
  is_current: boolean;
  source_url: string;
  privacy_class: string;
  derived_at: Tstz;
}

export interface ControlFilterProjectionTable {
  item_key: string;
  requested_response_mode: string | null;
  response_evidence_state: string;
  response_count: number;
  response_document_count: number;
  first_valid_response_date: DateCol | null;
  latest_valid_response_date: DateCol | null;
  recipient_count: number;
  source_page_observation_key: string | null;
  source_parse_run_key: string | null;
  parser_status: string | null;
  issue_flags: Jsonb;
  build_version: string;
  source_url: string;
  privacy_class: string;
  built_at: Tstz;
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
  // E2 source-traceability (prod migration 20260701T172000). EXACT interpelări /
  // întrebări detail URL; nullable because the backfill is per-row.
  source_url: string | null;
  privacy_class: string; // 'public' | 'restricted' (migration 20260701T171000)
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
  privacy_class: string; // 'public' | 'restricted' (migration 20260701T171000)
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
  privacy_class: string; // 'public' | 'restricted' (migration 20260701T171000)
  // Source-traceability path (§ source-traceability): source_url + its precision.
  // source_url_kind: 'exact' (per-turn deep link) | 'lossy_root' (sitting/section root,
  // e.g. Senate stenograms that carry no per-turn anchor).
  source_url: string | null;
  source_url_kind: string | null;
  source_ref: Jsonb | null;
  // ── canonical-stenogram pointers (scrapper migration 20260726T140000, ADDITIVE) ──
  // Every PRE-EXISTING row takes the defaults (false / NULL), so a legacy row is by
  // construction NON-canonical. The DB pins the key-space equivalence
  // (`parliament_speeches_canonical_key_space_check`):
  //   is_canonical  ⇔  speech_key LIKE 'canon:%'  ⇔  stenogram_segment_key IS NOT NULL
  // which is what makes the legacy (`cdep:%` / `senat:%`) and canonical populations
  // provably disjoint. NOT YET APPLIED to the live serving DB — every read of these
  // three columns goes through the repo's memoized canonical probe, exactly like
  // `parliament.speech_texts` (a missing column fails at PARSE time).
  is_canonical: boolean;
  stenogram_session_key: string | null; // FK → stenogram_sessions.session_key
  stenogram_segment_key: string | null; // segment identity; position is encoded in the key
}

// ── canonical stenogram (scrapper migration 20260726T140000) ─────────────────
// The re-derived READING of a sitting: one session per stored capture, ordered
// reading blocks under it, and a redirect per legacy speech row. `evidence` on
// `speech_redirects` is internal matcher/reviewer state and is deliberately
// UNBOUND (the `person_identity_candidates.evidence` precedent) so a stray select
// is a compile error.

export interface StenogramSessionsTable {
  session_key: string; // PK — `cdep:<ids>` | `senat:<raw session_key>`
  chamber: string; // 'camera_deputatilor' | 'senat' | 'comun' (CHECK)
  session_date: DateCol | null;
  // Provenance of session_date: CDep parses the sitting TITLE (the raw
  // sitting_date column is condemned); Senate carries a real date.
  session_date_source: string; // 'stenogram_title' | 'session_date' | 'none' (CHECK)
  title: string | null;
  source_system: string; // 'cdep_stenogram' | 'senat_stenogram' (CHECK)
  availability: string; // 'COMPLETE' | 'PARTIAL' | 'SOURCE_ONLY' (CHECK)
  source_url: string; // NOT NULL — the E2 traceability terminator
  source_url_kind: string; // 'exact' | 'lossy_root' | 'raw_response' (CHECK)
  source_ref: Jsonb;
  // Optional link to the agenda-owned sitting spine. Unlinked is NORMAL (the
  // agenda lane only knows the sittings its own source published).
  sitting_key: string | null;
  presiding_text: string | null;
  start_time_text: string | null;
  end_time_text: string | null;
  // Denormalised shape of the parse (a cache the loader gate re-derives from
  // stenogram_segments and BLOCKS on drift), so a consumer can size a session
  // without scanning its blocks. Availability is FULLY determined by these in BOTH
  // directions (`parliament_stenogram_sessions_availability_semantics_check`):
  //   SOURCE_ONLY ⇔ segment_count = 0
  //   PARTIAL     ⇔ segment_count > 0 and speech_count = 0
  //   COMPLETE    ⇔ speech_count > 0
  segment_count: number;
  speech_count: number;
  speaker_count: number;
  // Integrity anchors. `capture_digest` fixes the SOURCE BYTES the reading was
  // derived from (NULL for a SOURCE_ONLY sitting — there is no usable capture);
  // `canonical_digest` fixes the ORDERED READING itself and is NOT NULL. The loader
  // gate recomputes the canonical digest from `stenogram_segments` and BLOCKS on a
  // mismatch, so "this row describes exactly these blocks, in this order" is
  // provable by query. Read-only here: the server verifies nothing, it just carries
  // them so a client can detect a re-parse.
  capture_digest: string | null;
  canonical_digest: string;
  attrs: Jsonb;
  privacy_class: string; // 'public' | 'restricted' (CHECK, default 'public')
  source_updated_at: Tstz | null;
  loaded_at: Tstz | null;
  updated_at: Tstz | null;
}

export interface StenogramSegmentsTable {
  segment_key: string; // PK — `<session_key>#<position padded to 5>`
  session_key: string; // FK → stenogram_sessions (on delete cascade)
  position: number; // 0-based position in the OFFICIAL printed order
  segment_kind: string; // 'SPEECH' | 'AGENDA_HEADING' | 'VOTE_RESULT' | 'CONTEXT' (CHECK)
  text: string; // the reading block (NOT a snippet — speeches.summary is the snippet)
  text_chars: number; // DB-enforced = length(text)
  speaker_name: string | null; // name AS PRINTED, honorific stripped; never an identity
  speaker_ref: string | null; // the source's OWN locator (CDep idm); SPEECH only
  mandate_key: string | null; // roster-validated identity ONLY; NULL is expected
  speech_key: string | null; // the canonical serving speech row; SPEECH only
  agenda_ref: string | null; // source-printed agenda reference (CDep `S<n>` / Senate GUID)
  // Speaker identity (migration 20260727T140000). person_id is the career-stable id
  // behind the per-legislature mandate_key; speaker_resolution is the typed reason a
  // turn does or does not carry one; method/confidence are its provenance.
  person_id: string | null; // bigint → string
  speaker_resolution: string; // 'resolved'|'non_member_capacity'|'ambiguous'|'unresolved'|'not_applicable'
  speaker_method: string | null;
  speaker_confidence: string | null; // 'exact'|'high'|'medium'|'low'
  speaker_source_mandate: string | null; // the mandate the SOURCE printed
  speaker_candidates: Jsonb | null;
  source_url: string; // NOT NULL — traceability terminator
  source_url_kind: string; // 'exact' | 'lossy_root' | 'raw_response' (CHECK)
  source_ref: Jsonb;
  attrs: Jsonb;
  privacy_class: string; // 'public' | 'restricted' (CHECK, default 'public')
  loaded_at: Tstz | null;
  updated_at: Tstz | null;
}

export interface SpeechRedirectsTable {
  legacy_speech_key: string; // PK + FK → speeches (on delete cascade)
  session_key: string; // FK → stenogram_sessions — ALWAYS present
  // Present ONLY for mapping_kind='exact_segment'; the DB CHECK pins
  // (mapping_kind='exact_segment') = (all three pointers NOT NULL), so a
  // 'session_only' row is an honest coarse redirect, never a guessed one.
  canonical_speech_key: string | null;
  canonical_segment_key: string | null;
  canonical_position: number | null;
  mapping_kind: string; // 'session_only' | 'exact_segment' (CHECK)
  match_method: string; // e.g. 'cdep_sitting_ids' | 'senate_raw_speech_key'
  // evidence — internal matcher/reviewer state; NEVER surfaced; OMITTED
  privacy_class: string; // 'public' | 'restricted' (CHECK, default 'public')
  updated_at: Tstz | null;
}

export interface MemberDeclarationsTable {
  declaration_id: string; // bigint → string
  mandate_key: string;
  declaration_type: string;
  declaration_date: DateCol | null;
  label: string | null;
  file_url: string;
  privacy_class: string; // 'public' | 'restricted' (migration 20260701T171000)
  // file_hash — internal dedup; NEVER surfaced; OMITTED (§2.6)
  content_status: string | null; // 'link_only' in v1 — content never read
  attrs: Jsonb;
  created_at: Tstz | null;
}

// ── AI enrichment metadata (B1 — NON-AUTHORITATIVE, inference-only) ───────────

/**
 * `parliament.bill_metadata` (C3 prod projection). Only the display-safe columns
 * are typed. The generation-provenance + PII/discovery columns
 * (`input_text_sha256`, `raw_metadata_id`, `source_hash`, `model_input_sha256`,
 * `input_truncated`, `validation_issues`, `semantic_text`, `agent_discovery_title`,
 * `agent_discovery_description`) are deliberately OMITTED — a stray select is a
 * compile error (the birth_date_text privacy pattern). Values are inference-only
 * (enrichment gate publishable=false) — NEVER a search facet/filter/index body.
 */
export interface ParliamentBillMetadataTable {
  bill_key: string;
  config_key: string;
  prompt_version: string;
  schema_version: number;
  model: string;
  validation_status: string; // 'valid' | 'invalid'
  value_class: string; // 'standard' | 'low_value'
  confidence: string | null; // numeric → string (precision-safe)
  summary: string | null;
  topic: string | null;
  domains: string[];
  keywords: string[];
  source_updated_at: Tstz | null;
  privacy_class: string; // 'public' | 'restricted'
  loaded_at: Tstz | null;
}

/**
 * `parliament.control_item_metadata` (C3 prod projection). Display-safe columns
 * only. The provenance/PII/geographic/institution columns
 * (`input_text_sha256`, `raw_metadata_id`, `source_hash`, `model_input_sha256`,
 * `input_truncated`, `validation_issues`, `semantic_text`, `agent_discovery_*`,
 * `geographic_scope`, `target_institutions`, `mentioned_institutions`,
 * `organizations`, `localities`, `counties`, `law_references`, `years`,
 * `personal_data_present`, `redaction_applied`, `omitted_personal_data_types`)
 * are OMITTED. 4,706 of 9,345 rows are privacy_class='restricted' — the repo query
 * MUST filter privacy_class='public'. NO value_class column on this table.
 */
export interface ParliamentControlItemMetadataTable {
  item_key: string;
  config_key: string;
  prompt_version: string;
  schema_version: number;
  model: string;
  validation_status: string; // 'valid' | 'invalid'
  confidence: string | null;
  summary: string | null;
  policy_domains: string[];
  issue_types: string[];
  urgency: string | null;
  keywords: string[];
  source_updated_at: Tstz | null;
  privacy_class: string; // 'public' | 'restricted'
  loaded_at: Tstz | null;
}

// ── committees (B2) ──────────────────────────────────────────────────────────
// privacy_class='public' verified via migration 20260701T175000; source_url NOT
// NULL = the traceability terminator on every committee table. The raw
// `parliamentary_group` / `role_raw` / `member_name` columns are DELIBERATELY
// UNBOUND (PDL-003 — raw event labels/names must never be served; omitting them
// from the Kysely interface makes a stray select a compile error).

/**
 * `parliament.sittings` — the agenda lane's sitting spine.
 *
 * NOT a registry of every plenary sitting: `stenogram_sessions` is that (11,103
 * captures vs 2,110 rows here). This table holds the sittings an order of
 * business actually maps onto, which is why it is date-navigable — every row
 * carries a date as of 2026-07-28.
 */
export interface ParliamentSittingsTable {
  sitting_key: string; // PK — `cdep_stenogram:<ids>` | `cdep_agenda:<oid>:<date>`
  chamber: string;
  sitting_date: DateCol | null;
  // 'stenogram_session' = copied from the stenogram lane's session row (the
  // sitting's own printed title) and the authority; 'weekly_agenda' = the
  // PLANNED week, which loses to a transcript date; 'ordinezi_title' = parsed
  // from the order-of-business title; 'none' = no trustworthy date.
  sitting_date_source: string;
  title: string | null;
  source_system: string;
  stenogram_ids: string | null;
  attrs: Jsonb;
  privacy_class: string;
  source_updated_at: Tstz | null;
  updated_at: Tstz | null;
}

/** `parliament.sitting_agendas` — one published order of business. */
export interface ParliamentSittingAgendasTable {
  agenda_key: string; // PK
  oid: string; // the source's own id, unique
  chamber: string;
  title: string | null;
  approved_date: DateCol | null;
  approved_date_text: string | null;
  pdf_url: string | null;
  attrs: Jsonb;
  privacy_class: string;
  source_updated_at: Tstz | null;
  updated_at: Tstz | null;
}

/** `parliament.sitting_agenda_sittings` — which sittings an agenda covers. */
export interface ParliamentSittingAgendaSittingsTable {
  agenda_key: string;
  sitting_key: string;
  sitting_date: DateCol | null;
  resolution_status: string; // 'exact' | 'candidate' (CHECK)
  match_method: string;
  evidence: Jsonb;
  privacy_class: string;
  updated_at: Tstz | null;
}

/**
 * `parliament.sitting_agenda_items` — the ordered points of one agenda.
 *
 * `is_current` is load-bearing: the lane retains superseded revisions
 * (107,404 tombstones against 97,348 current rows), so an unfiltered read
 * serves withdrawn versions of the order of business as if they were live.
 */
export interface ParliamentSittingAgendaItemsTable {
  agenda_item_key: string; // PK
  agenda_key: string;
  row_index: number;
  anchor: string | null;
  item_number_text: string | null;
  item_kind: string; // 'administrative' | 'debate' | 'unknown' (CHECK)
  bill_key: string | null;
  source_bill_idp: string | null;
  bill_label: string | null;
  bill_family: string | null;
  title_text: string | null;
  description_text: string | null;
  ozitm: string | null;
  law_category: string | null;
  senate_disposition: string | null;
  senate_disposition_date: DateCol | null;
  // Verbatim source strings naming the reporting committee and its
  // recommendation. NOT yet resolved to committee keys — see
  // PARLIAMENT_AGENDA_MODEL.md §5; and note that rows loaded before
  // 2026-07-28 carry a distribution date truncated to its day.
  committee_rapporteurs: string[];
  procedure_urgency: boolean;
  decisional_chamber: boolean;
  debate_reservation: boolean;
  resolution_status: string; // 'linked' | 'unresolved' | 'not_applicable' (CHECK)
  is_current: boolean;
  attrs: Jsonb;
  privacy_class: string;
  source_updated_at: Tstz | null;
  updated_at: Tstz | null;
}

/** `parliament.sitting_agenda_item_documents` — documents attached to a point. */
export interface ParliamentSittingAgendaItemDocumentsTable {
  agenda_item_document_key: string; // PK
  agenda_item_key: string | null;
  bill_key: string | null;
  ozitm: string;
  document_url: string;
  label: string | null;
  document_date: DateCol | null;
  manifest_side: string; // 'project_file' | 'caseta_scan' | 'unknown' (CHECK)
  is_current: boolean;
  attrs: Jsonb;
  privacy_class: string;
  updated_at: Tstz | null;
}

/**
 * `parliament.bill_sitting_links` — a bill was PLACED ON an order of business.
 *
 * `relationship_kind` is `scheduled_on_agenda` on every row. It is NOT evidence
 * of debate or of a vote; `debated_in_session`/`voted_in_session` are reserved
 * for edges anchored to a transcript or a division and are deliberately empty
 * (the loader gate BLOCKS if either appears).
 */
export interface ParliamentBillSittingLinksTable {
  bill_sitting_link_id: string; // bigint → string
  bill_key: string;
  sitting_key: string;
  agenda_item_key: string;
  agenda_key: string;
  relationship_kind: string;
  resolution_status: string; // 'exact' | 'candidate' (CHECK)
  match_method: string;
  evidence: Jsonb;
  privacy_class: string;
  created_at: Tstz | null;
  updated_at: Tstz | null;
}

export interface ParliamentCommitteesTable {
  committee_key: string;
  chamber: string; // 'cdep' | 'senate'
  native_id: string | null;
  legislature: string | null;
  committee_type: string | null;
  name: string;
  meeting_tip: string | null;
  source_url: string; // NOT NULL — traceability terminator
  source_scope: string | null;
  privacy_class: string; // 'public'
  attrs: Jsonb;
}

export interface ParliamentCommitteeMembershipsTable {
  membership_key: string;
  membership_source: string; // 'cdep_committee' | 'senate_committee' | 'senate_profile'
  committee_key: string | null;
  chamber: string; // 'cdep' | 'senate'
  mandate_key: string | null; // FK-safe (cdep set; senate null)
  senate_parlamentar_id: string | null; // the senate attr-join key
  role: string | null;
  joined_date: DateCol | null;
  left_date: DateCol | null;
  is_bureau: boolean | null;
  match_status: string;
  source_url: string; // NOT NULL — traceability terminator
  privacy_class: string; // 'public'
  // parliamentary_group / role_raw / member_name — PDL-003; NEVER served; OMITTED
}

export interface ParliamentCommitteeDocumentsTable {
  committee_document_key: string;
  committee_key: string | null;
  doc_type: string | null;
  doc_date: DateCol | null;
  title: string | null;
  document_url: string | null;
  source_url: string; // NOT NULL — traceability terminator
  privacy_class: string; // 'public'
}

export interface ParliamentCommitteeBillLinksTable {
  committee_document_key: string;
  bill_key: string | null;
  resolution_status: string; // 'linked' | 'unresolved'
  source_url: string;
  privacy_class: string; // 'public'
}

export interface ParliamentCommitteeMeetingsTable {
  meeting_key: string;
  committee_key: string | null;
  meeting_date: DateCol | null;
  meeting_kind: string | null;
  location_text: string | null;
  source_url: string; // NOT NULL — traceability terminator
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
    'parliament.bill_procedure_steps': BillProcedureStepsTable;
    'parliament.bill_step_links': BillStepLinksTable;
    'parliament.bill_documents': BillDocumentsTable;
    'parliament.bill_act_links': BillActLinksTable;
    'parliament.bill_vote_links': BillVoteLinksTable;
    'parliament.votes': ParliamentVotesTable;
    'parliament.vote_records': VoteRecordsTable;
    'parliament.vote_observations': VoteObservationsTable;
    'parliament.vote_positions': VotePositionsTable;
    'parliament.vote_capture_coverage': ParliamentVoteCaptureCoverageTable;
    'parliament.vote_capture_gaps': ParliamentVoteCaptureGapsTable;
    'parliament.control_items': ControlItemsTable;
    'parliament.control_filter_projection': ControlFilterProjectionTable;
    'parliament.member_initiatives': MemberInitiativesTable;
    'parliament.speeches': SpeechesTable;
    'parliament.stenogram_sessions': StenogramSessionsTable;
    'parliament.stenogram_segments': StenogramSegmentsTable;
    'parliament.speech_redirects': SpeechRedirectsTable;
    'parliament.member_declarations': MemberDeclarationsTable;
    'parliament.bill_metadata': ParliamentBillMetadataTable;
    'parliament.control_item_metadata': ParliamentControlItemMetadataTable;
    'parliament.committees': ParliamentCommitteesTable;
    'parliament.committee_memberships': ParliamentCommitteeMembershipsTable;
    'parliament.committee_documents': ParliamentCommitteeDocumentsTable;
    'parliament.committee_bill_links': ParliamentCommitteeBillLinksTable;
    'parliament.committee_meetings': ParliamentCommitteeMeetingsTable;
    'parliament.sittings': ParliamentSittingsTable;
    'parliament.sitting_agendas': ParliamentSittingAgendasTable;
    'parliament.sitting_agenda_sittings': ParliamentSittingAgendaSittingsTable;
    'parliament.sitting_agenda_items': ParliamentSittingAgendaItemsTable;
    'parliament.sitting_agenda_item_documents': ParliamentSittingAgendaItemDocumentsTable;
    'parliament.bill_sitting_links': ParliamentBillSittingLinksTable;
    /* eslint-enable @typescript-eslint/naming-convention -- restore the rule after the schema-qualified table keys */
  }
}
