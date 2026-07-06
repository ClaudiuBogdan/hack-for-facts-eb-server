/**
 * Parliament module — domain view models (plan 04 §2). camelCase; scalars per
 * §14.1 (dates `'YYYY-MM-DD'`; bigint identity columns are STRINGS end to end).
 * Row types live in `shell/repo`; mappers convert row → view model.
 *
 * PRIVACY (§2.6): these view models deliberately do NOT carry `birthDateText`,
 * `birthDateParseMethod`, `clusterKey`, `fileHash`, declaration content,
 * candidate `evidence`/`method`. The DB-augmentation omits those columns too, so
 * the exclusion is enforced at two layers.
 */

// ── members / groups / persons ───────────────────────────────────────────────

/**
 * `attrs` whitelist (Codex BLOCKER #4): the raw `attrs` jsonb is NEVER passed
 * through to a view model — the mapper projects ONLY these known-safe keys, so an
 * unreviewed future key (or a provenance value that leaked into attrs) can never
 * reach a public GraphQL/MCP surface. Any view-model `attrs` field is a
 * `SafeAttrs` (a whitelisted subset), not the raw column.
 */
export const MEMBER_ATTR_KEYS = [
  'last_event_date',
  'source_title',
  'procedure',
  'profile_url',
  'cv_pdf_url',
] as const;
export const BILL_ATTR_KEYS = [
  'status_text',
  'last_event_date',
  'first_event_date',
  'procedure',
  'source_title',
  'event_count',
] as const;
export const VOTE_ATTR_KEYS = ['source_title', 'tally_mismatch', 'vote_action'] as const;

/** A whitelisted attrs projection (string-keyed; values are primitives only). */
export type SafeAttrs = Record<string, string | number | boolean | null>;

export interface ParliamentMember {
  readonly mandateKey: string; // PK; THE attribution key
  readonly chamber: string | null; // 'camera_deputatilor' | 'senat' | 'comun'
  readonly legislature: string | null; // election year, e.g. '2024'
  readonly fullName: string | null;
  readonly normalizedName: string | null;
  readonly groupName: string | null; // display label at mandate scope
  readonly groupId: string | null; // FK parliamentary_groups.group_id
  readonly constituencyName: string | null;
  readonly birthDate: string | null; // parsed DOB (public); birth_date::text
  readonly personId: string | null; // FK persons.person_id (bigint→string)
  // The public CDEP/Senate profile-page URL (attrs.profile_url), surfaced flat for
  // the member contact tab. ~5.3k of 5.3k members carry it. NOT a contact email/
  // phone/photo — those have no source (documented gap 4).
  readonly profileUrl: string | null;
  // B3: the official CDep/Senate CV PDF (attrs.cv_pdf_url), surfaced flat for the
  // member contact tab. Present for a minority of members; null otherwise.
  readonly cvPdfUrl: string | null;
  // SC-1 seat lifecycle. isCurrent = this mandate row is a CURRENTLY-SEATED member
  // (for chamber composition / current rosters ONLY — it does NOT affect this
  // member's vote/initiative/control attribution, which always reads ALL rows).
  // mandateEndDate / mandateEndReason are set when a seat ended early (demisie,
  // deces, …); null for a member still seated or whose mandate ran full term.
  readonly isCurrent: boolean;
  readonly mandateEndDate: string | null; // date::text
  readonly mandateEndReason: string | null;
  readonly attrs: SafeAttrs; // whitelisted to MEMBER_ATTR_KEYS by the mapper
}

export interface ParliamentGroup {
  readonly groupId: string; // slug(name)-<chamber>
  readonly chamber: string;
  readonly name: string;
  readonly memberCount: number | null; // computed per legislature (not stored)
}

export interface ParliamentGroupInterval {
  readonly mandateKey: string;
  readonly groupId: string;
  readonly validFrom: string; // date::text — vote-date granularity
  readonly validTo: string | null; // null = current
  readonly source: string; // 'derived_from_votes'
  readonly voteCount: number | null;
}

/** persons.confidence enum (live: high | medium | low). */
export type ParliamentPersonConfidence = 'high' | 'medium' | 'low';

export interface ParliamentPerson {
  readonly personId: string;
  readonly canonicalName: string;
  readonly normalizedName: string;
  readonly birthDate: string | null;
  readonly confidence: ParliamentPersonConfidence;
}

export interface ParliamentCareerTotals {
  readonly mandates: number;
  readonly votes: number; // ballot count across the person's mandates (bounded sum)
  readonly initiatives: number;
  readonly speeches: number;
}

/** A full cross-mandate career: identity + every mandate + intervals + totals. */
export interface ParliamentPersonCareer {
  readonly person: ParliamentPerson;
  readonly mandates: readonly ParliamentMember[];
  readonly groupIntervals: readonly ParliamentGroupInterval[];
  readonly careerTotals: ParliamentCareerTotals;
}

// ── bills / timeline ─────────────────────────────────────────────────────────

export interface ParliamentBill {
  readonly billKey: string;
  readonly plxNumber: string | null;
  readonly plxYear: number | null;
  readonly senateNumber: string | null;
  readonly senateYear: number | null;
  readonly title: string | null;
  readonly finalLawNumber: string | null;
  readonly finalLawYear: number | null;
  // Source-stored classification (extracted from attrs in SQL, surfaced flat):
  //  - statusText: the CDEP/Senate `status_text` ("Lege 423/2023 …", "respins" …)
  //    — the real current-status string the client derived from title+events.
  //  - billType: the `procedure.tip_initiativa` value ("Proiect de Lege …" |
  //    "Propunere legislativa …") — the source initiative type. null when the
  //    procedure object is absent (~1.6k of ~10k bills carry no procedure).
  readonly statusText: string | null;
  readonly billType: string | null;
  // Date of the most recent timeline event (attrs.last_event_date, already ISO).
  // This is the key the default 'updated_desc' sort uses — surfaced flat so the
  // client can show/verify recency.
  readonly lastEventDate: string | null;
  // B1 canonicality (§3). isCanonical = this row is in the default-visible set; a
  // non-canonical row is a suppressed bicameral (Senate navetă) twin whose
  // canonicalBillKey points to the canonical CDep bill to redirect to. The default
  // bill LIST returns canonical rows only; findBill still resolves either (deep links).
  readonly isCanonical: boolean;
  readonly canonicalBillKey: string | null;
  readonly attrs: SafeAttrs; // whitelisted to BILL_ATTR_KEYS by the mapper
  readonly sourceUpdatedAt: string | null; // timestamptz ISO
  readonly updatedAt: string | null;
}

export interface ParliamentBillEvent {
  readonly position: number;
  readonly eventDate: string | null;
  readonly eventDateText: string | null;
  readonly description: string | null;
  readonly chamberCode: string | null;
  readonly committee: readonly string[] | null;
  readonly voteIdv: string | null; // explicit timeline→vote evidence
  readonly docs: readonly unknown[];
}

export interface ParliamentBillDocument {
  readonly url: string;
  readonly label: string | null;
  readonly kind: string | null;
  readonly position: number | null;
}

export interface ParliamentBillActLink {
  readonly relationshipKind: string; // becomes_law (only value in data) etc.
  readonly targetActId: string | null;
  readonly targetActType: string | null;
  readonly targetActNumber: string | null;
  readonly targetActYear: number | null;
  readonly targetMoActKey: string | null; // H4: Monitorul Oficial publication key when resolutionStatus='linked_mo' (published in MO, no consolidated act → targetActId NULL)
  readonly resolutionStatus: string; // linked | linked_mo | unresolved | ambiguous | not_applicable
  readonly confidenceLabel: string; // exact | high | medium | low | none
  readonly primaryMethod: string;
  // legalAct resolved by the kernel LegalActByIdLoader on the GraphQL resolver (§6.7)
}

export interface ParliamentBillVoteLink {
  readonly voteKey: string;
  readonly billKey: string | null;
  readonly role: string; // final_adoption | final_rejection | report_adoption | amendment | procedural | unknown
  readonly resolutionStatus: string;
  readonly confidenceLabel: string;
}

/** The bill dossier: detail + events + docs + initiators + votes + lineage links. */
export interface ParliamentBillDossier {
  readonly bill: ParliamentBill;
  readonly events: readonly ParliamentBillEvent[];
  readonly documents: readonly ParliamentBillDocument[];
  // Initiators are FULL members (H10) — surfaced as ParliamentMember in the SDL, so
  // every member field + nested resolver is reachable. A superseded/deceased initiator
  // is still kept (attribution is never gated by is_current).
  readonly initiators: readonly ParliamentMember[];
  readonly relatedVotes: readonly ParliamentVote[];
  readonly actLinks: readonly ParliamentBillActLink[];
  readonly voteLinks: readonly ParliamentBillVoteLink[];
}

// ── votes / records ──────────────────────────────────────────────────────────

export interface ParliamentTally {
  readonly pentru: number | null;
  readonly impotriva: number | null;
  readonly abtinere: number | null;
  readonly nuAVotat: number | null;
  readonly present: number | null;
}

export interface ParliamentVote {
  readonly voteKey: string; // 'cdep:<votid>' | 'senat:<app_id>'
  readonly chamber: string;
  readonly voteDate: string | null;
  readonly title: string | null;
  readonly tally: ParliamentTally;
  readonly outcome: string | null; // 'adoptat' | 'respins' | null (vote-level, NOT bill outcome)
  readonly divisionNumber: number | null;
  readonly billKey: string | null;
  readonly lawReference: string | null; // Senate L-ref, title-extracted
  readonly tallyMismatch: boolean; // from attrs — surfaced as a warning flag
  readonly attrs: SafeAttrs; // whitelisted to VOTE_ATTR_KEYS by the mapper
}

export interface ParliamentVoteGroupBreakdown {
  readonly groupName: string | null;
  readonly pentru: number;
  readonly impotriva: number;
  readonly abtinere: number;
  readonly nuAVotat: number;
}

/** A ballot row (parented by a vote or a member — never an unparented scan). */
export interface ParliamentBallot {
  readonly rowIndex: number;
  readonly memberName: string | null; // raw source name (audit)
  readonly groupName: string | null; // raw group AT vote
  readonly choice: string | null; // 'pentru'|'impotriva'|'abtinere'|'nu_a_votat'
  readonly mandateKey: string | null; // nullable BY DESIGN
  readonly matchMethod: string | null;
  // constituencyName is JOINed from the resolved member (mandate_key → members):
  // null when the ballot is unresolved (mandateKey null) OR the member has no
  // recorded constituency. Surfaced flat so the client's vote-detail "județ" column
  // needs no per-ballot member fetch (the N+1 the `ballot.member` resolver would be).
  readonly constituencyName: string | null;
}

/** A member's ballot joined to its vote (the `listMemberVotes` row). */
export interface ParliamentMemberVote {
  readonly voteKey: string;
  readonly chamber: string;
  readonly voteDate: string | null;
  readonly title: string | null;
  readonly outcome: string | null;
  readonly choice: string | null; // this member's ballot
  readonly rowIndex: number;
  readonly billKey: string | null;
}

/** The vote detail view: vote + group breakdown + first page of ballots. */
export interface ParliamentVoteDetail {
  readonly vote: ParliamentVote;
  readonly groupBreakdown: readonly ParliamentVoteGroupBreakdown[];
}

// ── member activity ──────────────────────────────────────────────────────────

export interface ParliamentControlItem {
  readonly itemKey: string;
  readonly controlType: string | null; // cdep: question|interpellation|question_or_interpellation|motion; senate: +interpellation_pm|political_declaration
  readonly controlTypeProvenance: string | null; // split_pass | combined_pass | senate_direct
  readonly title: string | null;
  readonly recipient: string | null;
  readonly itemDate: string | null;
  readonly responseStatus: string | null;
  readonly chamber: string | null; // senat | camera_deputatilor, derived from mandate_key prefix (1:/2:)
  readonly authorName: string | null;
  readonly mandateKey: string | null;
}

export interface ParliamentInitiative {
  readonly initiativeKey: string;
  readonly mandateKey: string;
  readonly billKey: string | null;
  readonly title: string | null;
  readonly status: string | null;
  readonly promulgatedLawNumber: string | null;
  readonly promulgatedLawYear: number | null;
  // Registration date (parsed from registration_date_text 'DD.MM.YYYY' → ISO).
  // null for the ~4.3% date-less legacy rows. This is the list sort key (DESC).
  readonly registrationDate: string | null;
}

export interface ParliamentSpeech {
  readonly speechKey: string;
  readonly mandateKey: string | null;
  readonly speakerName: string | null;
  readonly chamber: string | null;
  readonly spokenAt: string | null;
  readonly title: string | null;
  readonly summary: string | null; // quarantined rows EXCLUDED by default (§2.6)
}

/** Declaration metadata ONLY — never content; `fileHash` excluded (§2.6). */
export interface ParliamentDeclarationMeta {
  readonly declarationType: string;
  readonly declarationDate: string | null;
  readonly declarationYear: number | null; // recovered from the file_url path (M10)
  readonly label: string | null;
  readonly fileUrl: string;
}

// ── member / person detail (assembled views) ─────────────────────────────────

export interface ParliamentActivityCounts {
  readonly votes: number;
  readonly controlItems: number;
  readonly speeches: number;
  readonly initiatives: number;
  readonly declarations: number;
}

export interface ParliamentMemberDetail {
  readonly member: ParliamentMember;
  readonly person: ParliamentPerson | null;
  readonly groupIntervals: readonly ParliamentGroupInterval[];
  readonly activityCounts: ParliamentActivityCounts;
}

// ── lineage (the marquee) ────────────────────────────────────────────────────

/** A vote in the act lineage chain, carrying its role + resolution + tally. */
export interface ParliamentLineageVote {
  readonly voteKey: string;
  readonly billKey: string | null;
  readonly chamber: string;
  readonly voteDate: string | null;
  readonly role: string; // final_adoption | final_rejection …
  readonly outcome: string | null;
  readonly resolutionStatus: string;
  readonly confidenceLabel: string;
  readonly tally: ParliamentTally;
  readonly ballotsTotal: number | null; // when includeBallots
  readonly ballotsResolved: number | null;
}

export interface ParliamentActLineage {
  readonly actId: string;
  readonly bills: readonly ParliamentBill[];
  readonly votes: readonly ParliamentLineageVote[];
  readonly caveats: readonly string[]; // e.g. "lineage covers initiative era ~2010+"
}

// ── cohesion ─────────────────────────────────────────────────────────────────

export interface ParliamentGroupCohesion {
  readonly groupName: string;
  readonly forPct: number;
  readonly againstPct: number;
  readonly abstainPct: number;
  readonly absentPct: number;
  readonly cohesionIndex: number | null; // Rice-style 0..1; null when no decided votes (M13)
  readonly voteCount: number;
}

// ── data quality (api-key gated; lean projection only — §2.6) ─────────────────

export interface ParliamentPersonCandidate {
  readonly mandateKey: string;
  readonly personId: string | null;
  readonly status: string; // needs_review | ambiguous | rejected — NO evidence/method
}

// ── institutional Entity slice (gated until recipient→CUI canonicalization) ───

export interface ParliamentControlSummary {
  readonly controlItemCount: number;
  readonly lastItemDate: string | null;
  readonly topRecipient: string | null;
}

// ── resolve / discovery ──────────────────────────────────────────────────────

export const PARLIAMENT_RESOLVE_DIMS = [
  'group',
  'person',
  'constituency',
  'recipient',
  'control_type',
  'outcome',
  'chamber',
] as const;
export type ParliamentResolveDim = (typeof PARLIAMENT_RESOLVE_DIMS)[number];

/** A name→value resolution hit (the §7.4 discovery surface). */
export interface ParliamentResolveHit {
  readonly dim: ParliamentResolveDim;
  readonly value: string;
  readonly label: string;
  readonly kind: string; // 'group' | 'person' | 'enum' | 'constituency' | 'recipient'
  readonly score: number | null;
}

// ── data freshness (B4) ──────────────────────────────────────────────────────

/** Loader/data freshness signals: the newest vote date and the last load stamp. */
export interface ParliamentDataFreshness {
  readonly latestVoteDate: string | null; // max(vote_date)::text
  readonly lastLoadedAt: string | null; // max(updated_at)::text (timestamptz ISO)
}

// ── AI metadata (B1 — inference-only, NON-AUTHORITATIVE) ──────────────────────

/**
 * AI-enrichment trust class + disclaimer stamped on EVERY AI-metadata row (B1).
 * These fields are inference-only (enrichment gate `publishable=false`) and are
 * exposed by explicit user decision for client display ONLY — they must NEVER
 * become search facets, filters, or index body.
 */
export const AI_TRUST_CLASS = 'inference_only_label';
export const AI_DISCLAIMER =
  'Rezumat generat automat de un model AI. Nu este un document oficial și poate conține erori — verificați sursa oficială.';

/**
 * AI-generated bill metadata (parliament.bill_metadata). NON-AUTHORITATIVE.
 * PII/provenance/hash/discovery columns are NEVER carried (compile-guarded in the
 * shell DB augmentation — the birth_date_text pattern).
 */
export interface ParliamentAiBillMetadata {
  readonly summary: string | null;
  readonly topic: string | null;
  readonly domains: readonly string[];
  readonly keywords: readonly string[];
  readonly valueClass: string; // 'standard' | 'low_value'
  readonly configKey: string;
  readonly promptVersion: string;
  readonly schemaVersion: number;
  readonly model: string;
  readonly validationStatus: string;
  readonly confidence: string | null; // numeric → string (precision-safe)
  readonly sourceUpdatedAt: string | null; // timestamptz ISO
  readonly loadedAt: string | null; // timestamptz ISO
  readonly privacyClass: string; // 'public' | 'restricted'
  readonly trustClass: string; // AI_TRUST_CLASS
  readonly disclaimer: string; // AI_DISCLAIMER
}

/**
 * AI-generated control-item metadata (parliament.control_item_metadata).
 * NON-AUTHORITATIVE. Restricted rows are filtered out at the repo (privacy_class
 * = 'public' only); geographic/institution/PII columns are never carried.
 */
export interface ParliamentAiControlItemMetadata {
  readonly summary: string | null;
  readonly policyDomains: readonly string[];
  readonly issueTypes: readonly string[];
  readonly urgency: string | null;
  readonly keywords: readonly string[];
  readonly configKey: string;
  readonly promptVersion: string;
  readonly schemaVersion: number;
  readonly model: string;
  readonly validationStatus: string;
  readonly confidence: string | null;
  readonly sourceUpdatedAt: string | null;
  readonly loadedAt: string | null;
  readonly privacyClass: string;
  readonly trustClass: string; // AI_TRUST_CLASS
  readonly disclaimer: string; // AI_DISCLAIMER
}

// ── committees (B2) ──────────────────────────────────────────────────────────

/** A parliamentary committee (CDep + Senate). source_url is the traceability terminator. */
export interface ParliamentCommittee {
  readonly committeeKey: string;
  readonly chamber: string; // translated: 'camera_deputatilor' | 'senat'
  readonly name: string;
  readonly legislature: string | null;
  readonly committeeType: string | null;
  readonly sourceUrl: string;
}

/**
 * A committee seat. NO parliamentary_group / role_raw / member_name (PDL-003 — raw
 * event labels/names are never served). `committee` is the soft-link in the member
 * direction; `member` is the resolved (nullable) member in the committee-roster
 * direction — unlinked rows still appear with role/dates and a null member.
 */
export interface ParliamentCommitteeMembership {
  readonly membershipKey: string; // opaque ID (may contain '|'); never parsed
  readonly role: string | null;
  readonly joinedDate: string | null;
  readonly leftDate: string | null;
  readonly isBureau: boolean | null;
  readonly sourceUrl: string;
  readonly committee: ParliamentCommittee | null;
  readonly member: ParliamentMember | null;
}

/** The committee detail view: committee + roster + linked bills + a meetings count. */
export interface ParliamentCommitteeDetail {
  readonly committee: ParliamentCommittee;
  readonly members: readonly ParliamentCommitteeMembership[];
  readonly linkedBills: readonly ParliamentBill[];
  readonly linkedBillsTotal: number;
  readonly meetingsCount: number;
}

// ── sort keys ────────────────────────────────────────────────────────────────

export const VOTE_SORTS = ['voteDate', 'voteKey'] as const;
export type VoteSort = (typeof VOTE_SORTS)[number];

export const BILL_SORTS = ['updated_desc', 'updated_asc', 'title_asc', 'title_desc'] as const;
export type BillSort = (typeof BILL_SORTS)[number];

export const MEMBER_ACTIVITY_KINDS = ['votes', 'control', 'speeches', 'initiatives'] as const;
export type MemberActivityKind = (typeof MEMBER_ACTIVITY_KINDS)[number];

/**
 * The cohesion vote-set hard cap (§7.7, §3.1.4). A bounded date×chamber window
 * resolving to more than this many votes is rejected with InvalidInput BEFORE any
 * vote_records fan-in (≈235k ballots worst case under the 15s timeout).
 */
export const COHESION_VOTE_CAP = 500;

/** The closed chamber enum (core copy; the filter spec re-declares it for the kernel). */
export const VOTE_CHAMBERS_OK = ['camera_deputatilor', 'senat', 'comun'] as const;
export type VoteChamber = (typeof VOTE_CHAMBERS_OK)[number];
