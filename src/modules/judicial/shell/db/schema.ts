/**
 * Judicial module — `ProdDatabase` augmentation (foundation §3, module-augmentation
 * pattern §14; plan 08 §2). **08 OWNS the `justice.*` tables.** The server is
 * READ-ONLY over them.
 *
 * Scalars (§14.1):
 *  - `bigint` → `string` (case_id, name_key_id, candidate_id, latest_snapshot_id, …).
 *  - `date` → `'YYYY-MM-DD'`; `timestamptz` → ISO string; `jsonb` → object.
 *
 * ── STRUCTURAL PRIVACY (plan §0, §2.1, §3 — THE CENTERPIECE) ──────────────────
 * Two columns are forbidden on every public surface:
 *   1. `justice.case_hearings.solution_summary` — forbidden PERMANENTLY.
 *      `justice.case_hearings.solution` — withheld in v1 (no audit passed yet).
 *      **Neither is declared on `JusticeCaseHearingsTable`.** A `select('solution')`
 *      or `select('solution_summary')` is therefore a COMPILE ERROR everywhere in
 *      the module — the type system has no slot for them. This is the structural
 *      guarantee, not a runtime omit.
 *   2. `justice.party_name_keys.display_name` — the gated name column. It IS
 *      declared (the repo must SELECT it inside the ONE gated method), but the
 *      static leak-audit asserts it is named in exactly one SQL string in the
 *      module. `party_name_keys.name_key`/`alias_keys`/`normalizer_version` are
 *      raw normalization internals → also omitted (never projected).
 *
 * `justice.case_parties` has NO name column by design; its provenance columns
 * (`row_hash`, `latest_response_id`, `parser_version`, `sync_run_id`, the
 * `*_seen_at` stamps) are internal and not declared here (only the columns the
 * server projects + the privacy-predicate columns `party_kind`/`classifier_rule`/
 * `classifier_version` are typed).
 */

import type { ColumnType } from 'kysely';

/** read-only timestamptz returned as an ISO string. */
type Tstz = ColumnType<string, never, never>;

// ── courts (246-row reference) ────────────────────────────────────────────────

export interface JusticeCourtsTable {
  institution_code: string; // PK
  ordinal: number; // integer
  court_level: string; // CHECK: judecatorie|tribunal|tribunal_militar|curte_de_apel|curte_militara_apel
  specialization: string | null;
  locality: string | null;
  county_code: string | null; // soft link → core.territories.county_code
  parent_institution_code: string | null;
  mapping_confidence: string; // CHECK: high|medium|low
  // mapping_notes, evidence (jsonb), updated_at: internal — not declared.
}

// ── cases (current projection) ────────────────────────────────────────────────

export interface JusticeCasesTable {
  case_id: string; // bigint → string (PK = reused raw bigint)
  source_slug: string;
  institution_code: string;
  case_number: string;
  case_number_old: string | null;
  department: string | null;
  category: string | null;
  category_name: string | null;
  stage: string | null;
  stage_name: string | null;
  object: string | null; // raw object text — SAFE (procedural subject, not parties)
  source_opened_at: Tstz | null;
  latest_source_modified_at: Tstz | null;
  // latest_snapshot_id, sync_run_id, *_seen_at: internal — not declared.
}

// ── case_hearings — solution_summary AND solution STRUCTURALLY ABSENT (§2.1) ───

export interface JusticeCaseHearingsTable {
  case_id: string; // bigint → string
  hearing_index: number; // integer
  hearing_at: Tstz | null;
  panel: string | null;
  // NO `solution` field (withheld in v1). NO `solution_summary` field (forbidden
  // permanently). A select() on either is a TYPE ERROR — the structural guarantee.
  pronouncement_date: string | null; // date
  document_number: string | null;
  document_date: string | null; // date
  // row_hash, latest_snapshot_id, updated_at: internal — not declared.
}

// ── case_appeals ───────────────────────────────────────────────────────────────

export interface JusticeCaseAppealsTable {
  case_id: string; // bigint → string
  appeal_index: number; // integer
  appeal_declared_at: string | null; // date
  appeal_type: string | null;
  // row_hash, latest_snapshot_id, updated_at: internal — not declared.
}

// ── case_parties — NO NAME COLUMN; only projected + privacy-predicate columns ──

export interface JusticeCasePartiesTable {
  case_id: string; // bigint → string
  party_index: number; // integer
  name_key_id: string | null; // bigint → string; NULL for ~67% (person/unknown/low-conf)
  role_normalized: string | null; // controlled vocab; role_raw is NOT in prod at all
  party_kind: string; // CHECK: company|public_entity|person|unknown
  classifier_version: string | null; // the version the PUBLISHABLE_RULES set is valid for
  classifier_rule: string | null; // the privacy gate predicate column (§3.1)
  // row_hash, latest_response_id, parser_version, sync_run_id, *_seen_at: internal.
}

// ── party_name_keys — the GATED dictionary (company/public ONLY by CHECK) ──────

export interface JusticePartyNameKeysTable {
  name_key_id: string; // bigint → string (PK)
  // `display_name` is the GATED column — read ONLY inside PartyDictionaryRepo's
  // single gated SQL string (§3.1). Declared so that method can select it; the
  // static leak-audit asserts it is named exactly once in the module source.
  display_name: string;
  party_kind: string; // CHECK: company|public_entity (the dictionary holds ZERO persons)
  legal_form: string | null;
  mention_count: string; // bigint → string
  classifier_version: string | null;
  // name_key, alias_keys, normalizer_version, *_seen_at: normalization internals — not declared.
}

// ── party_company_candidates — GATED (published-only); jsonb/PII NEVER projected ─

export interface JusticePartyCompanyCandidatesTable {
  candidate_id: string; // bigint → string
  name_key_id: string; // bigint → string
  candidate_cui: string | null; // text, no FK — "a candidate, not an identity"
  validation_status: string; // CHECK: candidate|auto_accepted|needs_review|rejected|published
  // `candidate_company_name` is DELIBERATELY NOT declared (codex P0): it is a
  // SECOND name source that would bypass the gated PartyDictionaryRepo. The
  // company name on a published link comes ONLY from the dictionary gate (joined
  // by name_key_id). Selecting it is a compile error — the single-name-path
  // guarantee, structural.
  // candidate_source_table, method, confidence_score/tier, resolver_version: not
  // projected. evidence (jsonb), candidates (jsonb), reviewed_by (text PII),
  // rejection_reason, *_at: RESTRICTED-SURFACE — never declared (plan §2.1, leak audit #6).
}

// ── case_legal_references — SAFE projection (citation token only; no PII) ──────

export interface JusticeCaseLegalReferencesTable {
  case_legal_reference_id: string; // bigint → string
  case_id: string; // bigint → string
  source_field: string; // CHECK: object|solution|solution_summary — rows with 'solution_summary' EXCLUDED from served projection (S2)
  act_type: string | null;
  act_number: string | null;
  act_year: number | null; // smallint
  issuer_slug: string | null;
  article_fragment: string | null;
  target_act_id: string | null; // bigint → string; soft link → legal.acts (no FK)
  resolution_status: string | null; // CHECK: unique|ambiguous|unresolved|not_a_legal_citation
  confidence_score: string | null; // numeric → string
  // raw_text, span_start/end: the SOURCE SPAN — NEVER projected (S2). The served
  // citation token is rebuilt from act_type/number/year only. candidates (jsonb),
  // resolver_version, created_at: internal — not declared.
}

// ── case_lineage_candidates — candidate-only (empty in v1) ────────────────────

export interface JusticeCaseLineageCandidatesTable {
  lineage_candidate_id: string; // bigint → string
  from_case_id: string; // bigint → string
  to_case_id: string; // bigint → string
  lineage_type: string; // CHECK: appeal|old_number|same_dossier_cross_institution|manual
  method: string | null;
  confidence_score: string | null; // numeric → string
  validation_status: string; // CHECK: candidate|accepted|needs_review|rejected
  // evidence (jsonb): RESTRICTED-SURFACE — never declared, never projected (leak audit #6).
  // resolver_version, *_at: internal — not declared.
}

/**
 * Declaration-merge the `justice.*` tables onto the kernel `ProdDatabase`. The
 * `case_hearings` table interface intentionally omits `solution`/`solution_summary`
 * so a stray select on either is a compile error (the structural privacy guarantee).
 */
declare module '@/modules/shared/shell/db/types.js' {
  interface ProdDatabase {
    /* eslint-disable @typescript-eslint/naming-convention -- Kysely table keys are the schema-qualified live names (foundation §3) */
    'justice.courts': JusticeCourtsTable;
    'justice.cases': JusticeCasesTable;
    'justice.case_hearings': JusticeCaseHearingsTable;
    'justice.case_appeals': JusticeCaseAppealsTable;
    'justice.case_parties': JusticeCasePartiesTable;
    'justice.party_name_keys': JusticePartyNameKeysTable;
    'justice.party_company_candidates': JusticePartyCompanyCandidatesTable;
    'justice.case_legal_references': JusticeCaseLegalReferencesTable;
    'justice.case_lineage_candidates': JusticeCaseLineageCandidatesTable;
    /* eslint-enable @typescript-eslint/naming-convention -- restore the rule after the schema-qualified table keys */
  }
}
