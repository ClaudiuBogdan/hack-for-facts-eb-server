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

import { GRAPHQL_ERROR_CODE, HTTP_STATUS, type ApiError } from '@/modules/shared/index.js';

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
  /** Canonical CDep mandate page for the cluster (§6 traceability). Null until backfilled. */
  readonly sourceUrl: string | null;
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

/**
 * A stage-level edge resolved from a SOURCE ANCHOR printed on the bill's
 * procedure table — never from a name. `targetKey` is populated only when
 * `resolutionStatus` is 'linked'; otherwise the status says WHY, and
 * `sourceHref` remains the navigable terminator.
 */
export interface ParliamentBillStepLink {
  readonly linkKind: string;
  readonly targetKey: string | null;
  readonly sourceHref: string;
  readonly sourceText: string | null;
  readonly resolutionStatus: string;
  readonly matchMethod: string;
}

export interface ParliamentBillEvent {
  /** Bill view that contributed this event to a merged dossier. */
  readonly sourceBillKey: string;
  readonly position: number;
  readonly eventDate: string | null;
  readonly eventDateText: string | null;
  readonly description: string | null;
  readonly chamberCode: string | null;
  readonly committee: readonly string[] | null;
  readonly voteIdv: string | null; // explicit timeline→vote evidence
  readonly docs: readonly unknown[];
  /**
   * Procedure model (parliament.bill_procedure_steps, 1:1 with the captured
   * event). All null until the derive has run for this bill — a caller must
   * render the row regardless, never drop it.
   */
  readonly rowKind: string | null;
  readonly parentPosition: number | null;
  readonly stepKind: string | null;
  readonly actorKind: string | null;
  /** Edges presented under THIS step (includes those anchored on its attachments). */
  readonly links: readonly ParliamentBillStepLink[];
}

export interface ParliamentBillDocument {
  /** Bill view that contributed this document to a merged dossier. */
  readonly sourceBillKey: string;
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

/**
 * The bill dossier: detail + events + docs + initiators + votes + lineage links.
 * Since 2026-07-22 the child families are read across the FULL accepted view set
 * (`viewBillKeys`): the requested view plus its resolved-pair navetă twin, so a
 * canonical read no longer silently drops the suppressed view's children.
 * Ambiguous dup-review groups stay single-view (viewBillKeys = [billKey]).
 */
export interface ParliamentBillDossier {
  /** Every bill_key whose children are included (requested view first). */
  readonly viewBillKeys: readonly string[];
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
  /** EXACT cdep.ro/senat.ro division page (§6 traceability). Null until backfilled. */
  readonly sourceUrl: string | null;
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

/** One calendar day of a member's ballots (the activity-heatmap cell). */
export interface ParliamentMemberVoteActivityDay {
  readonly date: string; // YYYY-MM-DD
  readonly total: number;
  readonly pentru: number;
  readonly impotriva: number;
  readonly abtinere: number;
  readonly nuAVotat: number;
}

/** A member's per-day voting activity for one year + the years with any activity. */
export interface ParliamentMemberVoteActivity {
  readonly year: number;
  readonly days: readonly ParliamentMemberVoteActivityDay[];
  readonly availableYears: readonly number[];
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
  /** EXACT interpelări/întrebări detail page (§6 traceability). Null until backfilled. */
  readonly sourceUrl: string | null;
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
  // Source-traceability path (§ source-traceability). `sourceUrlKind`:
  //  - 'exact'      → deep-links the turn; safe to present as an authoritative link.
  //  - 'lossy_root' → resolves only to the sitting/section root (Senate stenograms
  //    carry no per-turn anchor); do NOT present as an exact deep-link.
  readonly sourceUrl: string | null;
  readonly sourceUrlKind: string | null;
  // Verbatim transcript text (parliament.speech_texts.full_text). Resolved LAZILY at
  // the GraphQL layer ONLY when selected — never materialized in list/count queries —
  // and null when the speech_texts table/row is absent. Not part of the mapped row.
  readonly fullText?: string | null;
  // ── canonical-stenogram pointers (ADDITIVE; the legacy contract is unchanged) ──
  // `isCanonical` marks a `canon:` reading-block row: PREFER these contributions —
  // they carry the full block text and a provable position in the sitting, whereas a
  // legacy row is an over-split snippet. `sessionKey`/`position` locate the turn in
  // its sitting; `position` is decoded from the segment key (`<session>#<00042>`),
  // whose (session, position) identity the DB enforces via a unique index.
  //
  // All three are `false`/`null` on a legacy row AND on ANY row read from a database
  // where the canonical migration is not applied — a null here means "not canonical
  // / not available", never "position 0".
  readonly isCanonical: boolean;
  readonly sessionKey: string | null;
  readonly position: number | null;
  /**
   * The PERSON behind the mandate — stable across a career spanning several
   * legislatures, unlike the per-legislature mandateKey. null when mandateKey is
   * null, and on a database without migration 20260727T140000. The typed resolution
   * state and its provenance live on the canonical READING BLOCK, not here.
   */
  readonly personId: string | null;
}

/**
 * The APPLIED depth of a global-speeches `q` search (the connection REPORTS what
 * actually ran, so a client can tell a title-only hit set from a transcript-deep
 * one): TITLE_SUMMARY = ILIKE over title + summary only; FULL_TEXT = additionally
 * the EXISTS over `parliament.speech_texts.full_text`. null when no `q` was given.
 * The applied depth is folded into the cursor fhash — a probe flip mid-pagination
 * invalidates the cursor with the clean "restart pagination" error.
 */
export const SPEECH_SEARCH_DEPTHS = ['TITLE_SUMMARY', 'FULL_TEXT'] as const;
export type ParliamentSpeechSearchDepth = (typeof SPEECH_SEARCH_DEPTHS)[number];

/**
 * WHICH POPULATION a speech collection served — the single most important thing to
 * understand about the legacy speech surfaces after the canonical stenogram model
 * lands.
 *
 * `parliament.speeches` holds TWO generations of rows for the same words:
 *  - LEGACY rows, derived from an extraction parser that walked `$('p,li,td')`, so one
 *    spoken turn is scattered across a container row AND each of its paragraph rows;
 *  - CANONICAL rows (`canon:` key-space), one per whole reading block.
 * `parliament.speech_redirects` is the loader's PROVEN, source-keyed mapping from a
 * legacy row to where its content lives canonically.
 *
 * Serving both at once would double-surface the same sitting — a member's intervention
 * count and heatmap would inflate by the legacy over-split factor, which for CDep is
 * several rows per real turn. So:
 *
 *  - `LEGACY` — the canonical migration is not available on this database. Every
 *    surface behaves EXACTLY as it did before the model existed. This is the fail-safe
 *    default: we never suppress on the strength of tables we cannot read.
 *  - `CANONICAL_PREFERRED` — canonical rows are served, and a legacy row is suppressed
 *    ONLY when a PUBLIC redirect maps it into a PUBLIC canonical sitting. A legacy row
 *    with no redirect (coverage lag between loader runs) is RETAINED, so nothing
 *    disappears while the canonical lane catches up.
 *
 * The applied population is reported on every cursor page and folded into the cursor
 * `fhash`, because a probe flip mid-pagination changes the population: the cursor is
 * then rejected with the clean "restart pagination" error instead of silently skipping
 * or duplicating rows.
 */
export const SPEECH_POPULATIONS = ['LEGACY', 'CANONICAL_PREFERRED'] as const;
export type ParliamentSpeechPopulation = (typeof SPEECH_POPULATIONS)[number];

/** One calendar day of a member's speeches (the activity-heatmap cell). */
export interface ParliamentMemberSpeechActivityDay {
  readonly date: string; // YYYY-MM-DD
  readonly total: number;
  // `comun` = turns in a joint sitting (chamber='comun'); `proprie` = own-chamber
  // turns (total - comun). The two partition `total`.
  readonly proprie: number;
  readonly comun: number;
}

/** A member's per-day speech activity for one year + the years with any activity. */
export interface ParliamentMemberSpeechActivity {
  readonly year: number;
  readonly days: readonly ParliamentMemberSpeechActivityDay[];
  readonly availableYears: readonly number[];
}

/**
 * Global (unparented) per-day speech activity for one year. Reuses the member
 * activity day shape (date/proprie/comun/total). `availableYears` is every year
 * with any (filtered) turn — NOT bounded by the requested year. `searchDepth`
 * reports the APPLIED `q` depth (null when no q), like the speeches connection.
 */
export interface ParliamentSpeechActivity {
  readonly year: number;
  readonly days: readonly ParliamentMemberSpeechActivityDay[];
  readonly availableYears: readonly number[];
  readonly searchDepth: ParliamentSpeechSearchDepth | null;
}

/**
 * One calendar day of CHAMBER voting activity — the votes-hub heatmap cell.
 *
 * The unit is the DIVISION, not the ballot: one row of `parliament.votes`, the
 * same row `parliamentVotes` lists, so the chart and the list beneath it can
 * never describe different sets. A busy day therefore reads in the hundreds, not
 * in the tens of thousands its ballots would.
 *
 * Two independent partitions of `total` ride on the same row because they answer
 * different questions and cost one scan together:
 *   adoptat + respins + faraRezultat = total   (how contested was the day)
 *   camera  + senat   + comun        = total   (who was sitting)
 */
export interface ParliamentVoteActivityDay {
  readonly date: string; // YYYY-MM-DD
  readonly total: number;
  readonly adoptat: number;
  readonly respins: number;
  /**
   * The source published a tally but no result — 202 rows corpus-wide. NOT
   * "amânat": the source simply says nothing, and naming it for a procedural
   * outcome it never asserted would invent a fact.
   */
  readonly faraRezultat: number;
  readonly camera: number;
  readonly senat: number;
  readonly comun: number;
}

/** A contiguous window the crawl actually covers. Inclusive at both ends. */
export interface ParliamentVoteCoverageRange {
  readonly from: string;
  readonly to: string;
}

export type ParliamentVoteGapStatus =
  | 'FAILED'
  | 'SKIPPED'
  | 'PARSER_EMPTY'
  | 'PROVISIONAL'
  | 'SOURCE_LIMITED';

export interface ParliamentVoteCoverageGap {
  readonly date: string;
  readonly status: ParliamentVoteGapStatus;
  readonly reason: string | null;
}

/**
 * What the capture actually covers, so a day we never fetched — or fetched
 * before the sitting finished — is never drawn as a quiet day.
 *
 * Keyed by (chamber, sourceSystem) rather than chamber alone because `scope` is
 * the honest name for what the numbers measure: the Senate rows are "Senate
 * electronic plenary divisions", which for 46 days of 2020 covers nothing at all
 * because the Senate voted by telephone roll call, minuted but never published.
 */
export interface ParliamentVoteCoverage {
  readonly chamber: string;
  readonly sourceSystem: string;
  readonly scope: string;
  readonly sourceUrl: string;
  /**
   * Earliest day the SOURCE publishes, independent of what we hold. This is what
   * makes an uncaptured year askable-but-empty rather than invisible:
   * `availableYears` can only ever mean "years containing held divisions".
   */
  readonly sourceAvailableFrom: string | null;
  readonly observedFrom: string;
  readonly observedThrough: string;
  /** Latest day whose record is SETTLED. Days after it are provisional. */
  readonly finalizedThrough: string;
  readonly asOf: string;
  readonly ranges: readonly ParliamentVoteCoverageRange[];
  readonly gaps: readonly ParliamentVoteCoverageGap[];
}

/**
 * Per-day chamber voting activity for one calendar year.
 *
 * `coverage` is deliberately NOT bounded by `year`: outside a coverage window
 * there is no data to have, and a client that zero-fills there is making a false
 * claim about the record. The client needs the whole window to decide which
 * years are even askable.
 */
export interface ParliamentVoteActivity {
  readonly year: number;
  readonly days: readonly ParliamentVoteActivityDay[];
  readonly availableYears: readonly number[];
  readonly coverage: readonly ParliamentVoteCoverage[];
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

/**
 * DEPRECATED shape — the eagerly-assembled member view. `getMember` no longer
 * builds it: person / group intervals / activity counts are resolved lazily by
 * their own field resolvers so an ancillary failure cannot 404 a valid member.
 * Kept only as documentation of the old composite; nothing constructs it.
 */
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

// ── canonical stenogram (scrapper migration 20260726T140000) ─────────────────
//
// The canonical model is the re-derived READING of a sitting: `stenogram_sessions`
// (one per stored capture) → ordered `stenogram_segments` (reading blocks) → a
// canonical `parliament.speeches` row per SPEECH block (`canon:` key-space), plus
// `speech_redirects` mapping every LEGACY speech row onto the canonical reading.
// The closed enums below are the DB CHECK domains verbatim — they are the contract,
// not a display convenience, so an unexpected value is a data defect and never
// coerced to a default.

/**
 * How much of the official transcript a capture actually yields (DB CHECK on
 * `stenogram_sessions.availability`):
 *  - COMPLETE    — parsed into at least one SPEECH reading block.
 *  - PARTIAL     — readable blocks exist, but no official printed speaker heading
 *                  was found (a narration-only capture).
 *  - SOURCE_ONLY — no usable capture at all: a sitting we know about whose
 *                  transcript we do not hold (or hold blank / CSS-only /
 *                  navigation-only). The session and its official URL are served,
 *                  and NO reading is.
 *
 * The mapping to the counters is a BICONDITIONAL named CHECK
 * (`parliament_stenogram_sessions_availability_semantics_check`):
 *   SOURCE_ONLY ⇔ segment_count = 0 · PARTIAL ⇔ blocks but no speech ·
 *   COMPLETE ⇔ ≥1 speech.
 * So a row can neither claim a reading it does not carry nor hide one it does — and
 * the server never has to infer availability from a count.
 */
export const STENOGRAM_AVAILABILITIES = ['COMPLETE', 'PARTIAL', 'SOURCE_ONLY'] as const;
export type ParliamentStenogramAvailability = (typeof STENOGRAM_AVAILABILITIES)[number];

/** Kind of a canonical reading block (DB CHECK on `stenogram_segments.segment_kind`). */
export const STENOGRAM_SEGMENT_KINDS = [
  'SPEECH',
  'AGENDA_HEADING',
  'VOTE_RESULT',
  'CONTEXT',
] as const;
export type ParliamentStenogramSegmentKind = (typeof STENOGRAM_SEGMENT_KINDS)[number];

/** Which official system the capture came from (DB CHECK on `source_system`). */
export const STENOGRAM_SOURCE_SYSTEMS = ['cdep_stenogram', 'senat_stenogram'] as const;
export type ParliamentStenogramSourceSystem = (typeof STENOGRAM_SOURCE_SYSTEMS)[number];

/**
 * Provenance of `session_date` (DB CHECK on `session_date_source`). CDep dates are
 * parsed from the sitting TITLE — the raw `sitting_date` column is condemned (81%
 * null, wrong where present) — so `stenogram_title` is the normal CDep value and
 * `session_date` the normal Senate one. `none` means the source carries no
 * trustworthy date; the date is then null and MUST NOT be inferred.
 */
export const STENOGRAM_DATE_SOURCES = ['stenogram_title', 'session_date', 'none'] as const;
export type ParliamentStenogramDateSource = (typeof STENOGRAM_DATE_SOURCES)[number];

/**
 * How precisely a source URL locates its target (DB CHECK on `source_url_kind`),
 * i.e. SOURCE PRECISION. Same taxonomy as `speeches.source_url_kind` plus
 * `raw_response` (the locator is a stored raw response, not a live route):
 *  - 'exact'        → deep-links the target; safe to present as authoritative.
 *  - 'lossy_root'   → resolves only to the sitting/section root (Senate captures
 *                     carry no per-turn anchor); NEVER present as an exact link.
 *  - 'raw_response' → points at the stored capture, not a live page.
 */
export const STENOGRAM_SOURCE_URL_KINDS = ['exact', 'lossy_root', 'raw_response'] as const;
export type ParliamentStenogramSourceUrlKind = (typeof STENOGRAM_SOURCE_URL_KINDS)[number];

/**
 * How a legacy speech row was mapped onto the canonical reading (DB CHECK on
 * `speech_redirects.mapping_kind`). `exact_segment` carries all three canonical
 * pointers; `session_only` is the honest coarse redirect used when a single block
 * could not be PROVEN — it resolves the sitting, never a guessed turn.
 */
export const STENOGRAM_MAPPING_KINDS = ['session_only', 'exact_segment'] as const;
export type ParliamentStenogramMappingKind = (typeof STENOGRAM_MAPPING_KINDS)[number];

/**
 * The `search.documents.doc_type` of the canonical full-history transcript
 * projection — the ONE place this constant lives, so binding it to the data
 * layer's exact value is a single edit (foundation §9: the projection is a
 * REBUILDABLE search projection derived exclusively from PUBLIC canonical reading
 * blocks, never a second source of truth).
 *
 * PENDING BINDING (2026-07-26): the scrapper reserved
 * `20260726T14xxxx` for "canonical stenogram sessions, ordered transcript
 * segments, legacy speech redirects, and search projection" and the projection
 * itself has NOT landed — only the migration + the pure parser/types have. This
 * value is the doc_type the data layer already reserves for speech-grade search
 * (`PARLIAMENT_CONTRACT.md` §7 lists `parliament_speech_segment` as the deferred
 * speech doc type, gated by `PARLIAMENT_SPEECH_SEARCH_MODE`; the scrapper's
 * `speech-search.test.ts` pins the same string). RE-CONFIRM it against the data
 * agent's projection before validation — a mismatch must be a one-line change
 * here, never a second constant somewhere else.
 */
export const PARLIAMENT_TRANSCRIPT_SEARCH_DOC_TYPE = 'parliament_speech_segment';

/**
 * A canonical stenogram session — one stored capture of one sitting, and the
 * parent of the ordered reading. `sittingKey` is the OPTIONAL link to the
 * agenda-owned sitting spine (`parliament.sittings`): an unlinked session is
 * normal, because the agenda lane only knows the sittings its own source
 * published. Together with the counters and the segment positions it is the
 * SITTING NAVIGATION surface — a client can size the sitting, jump to any printed
 * position, and reach the agenda spine without a second query.
 */
export interface ParliamentStenogramSession {
  readonly sessionKey: string;
  readonly chamber: string;
  readonly sessionDate: string | null; // session_date::text (YYYY-MM-DD)
  readonly sessionDateSource: string;
  readonly title: string | null;
  readonly sourceSystem: string;
  readonly availability: string;
  readonly sourceUrl: string;
  readonly sourceUrlKind: string; // SOURCE PRECISION — see STENOGRAM_SOURCE_URL_KINDS
  /** Agenda-owned sitting spine link; null = this source never published a sitting row. */
  readonly sittingKey: string | null;
  readonly presidingText: string | null;
  readonly startTimeText: string | null;
  readonly endTimeText: string | null;
  readonly segmentCount: number;
  readonly speechCount: number;
  readonly speakerCount: number;
  // Integrity anchors carried straight through from the loader (§DIGESTS).
  // `canonicalDigest` fixes the ORDERED reading, so a client can tell a re-parse
  // from a no-op refresh without diffing the blocks; `captureDigest` fixes the
  // source bytes and is null for a SOURCE_ONLY sitting (there is no capture).
  readonly captureDigest: string | null;
  readonly canonicalDigest: string;
  readonly sourceUpdatedAt: string | null;
}

/**
 * The minimum a client needs to render a sitting as a NAVIGATION TARGET (a
 * previous/next link, or the "open the official transcript" action on a sitting that
 * carries no reading) without a second round-trip. Deliberately not the full session:
 * a nav target is a label plus a destination, and widening it would invite callers to
 * treat a neighbour as a fetched sitting.
 */
export interface ParliamentStenogramSessionRef {
  readonly sessionKey: string;
  readonly chamber: string;
  readonly sessionDate: string | null;
  readonly title: string | null;
  readonly availability: string;
  readonly sourceUrl: string;
  readonly sourceUrlKind: string;
}

/** Project a full session down to its navigation-target shape. */
export const toStenogramSessionRef = (
  session: ParliamentStenogramSession
): ParliamentStenogramSessionRef => ({
  sessionKey: session.sessionKey,
  chamber: session.chamber,
  sessionDate: session.sessionDate,
  title: session.title,
  availability: session.availability,
  sourceUrl: session.sourceUrl,
  sourceUrlKind: session.sourceUrlKind,
});

/**
 * The previous/next SITTING around one session — the chamber-scoped chronological
 * neighbours, so "previous sitting" never jumps between assemblies (a joint `comun`
 * sitting is a different assembly from a `camera_deputatilor` one; mixing them makes
 * the control unusable). Ordering is the SAME deterministic keyset the session list
 * uses — `(coalesce(session_date::text,''), session_key)` — so paging a list and
 * stepping with these two controls agree, and a dateless capture has a defined place
 * instead of an arbitrary one. Both are null at the ends of a chamber's history, and
 * a non-public neighbour is simply absent (never a hole a caller can probe).
 */
export interface ParliamentSittingNavigation {
  readonly previous: ParliamentStenogramSessionRef | null;
  readonly next: ParliamentStenogramSessionRef | null;
}

/**
 * One canonical reading block, in the OFFICIAL printed order. `position` (0-based)
 * plus `sessionKey` IS the identity — `segmentKey` encodes the pair and the DB
 * enforces the unique `(session_key, position)` index, so the two can never
 * disagree.
 *
 * `speakerName` is the name AS PRINTED (honorific stripped) and is NEVER an
 * identity; `speakerRef` is the source's own locator (CDep `idm`); `mandateKey` is
 * the roster-validated identity and is null for guests, ministers, and every
 * unmatched speaker — the honest, expected value. Only a SPEECH block may carry
 * `speakerRef` / `mandateKey` / `speechKey` (DB CHECK).
 */
export interface ParliamentStenogramSegment {
  readonly segmentKey: string;
  readonly sessionKey: string;
  readonly position: number;
  readonly kind: string;
  readonly text: string;
  readonly textChars: number;
  readonly speakerName: string | null;
  readonly speakerRef: string | null;
  readonly mandateKey: string | null;
  /** The canonical serving speech row minted for this block (SPEECH blocks only). */
  readonly speechKey: string | null;
  /** Source-printed agenda reference in scope (CDep `S<n>` anchor / Senate GUID). */
  readonly agendaRef: string | null;
  readonly sourceUrl: string;
  readonly sourceUrlKind: string;
  /**
   * Speaker identity, as resolved by the data layer (scrapper migration
   * 20260727T140000). All four are null on a database where that migration has not
   * been applied — the repo probes for the columns and emits literals rather than
   * failing the whole read.
   *
   * `speakerResolution` is the field the UI should branch on: an unlinked name is
   * NOT the same event as a guest speaker, and both differ from "we could not tell".
   */
  readonly personId: string | null;
  readonly speakerResolution: string | null;
  readonly speakerMethod: string | null;
  readonly speakerConfidence: string | null;
}

/**
 * A session plus its ordered reading and its sitting navigation.
 *
 * `segments` is the COMPLETE public reading when served by REST (one response = one
 * whole transcript) and a bounded slice when served by GraphQL/MCP, which is what
 * `totalSegments` is for: it is always the full public block count, so a caller can
 * tell a slice from the whole thing.
 */
export interface ParliamentStenogramTranscript {
  readonly session: ParliamentStenogramSession;
  readonly segments: readonly ParliamentStenogramSegment[];
  /** Total PUBLIC blocks in the session (`segments` may be a bounded slice of it). */
  readonly totalSegments: number;
  /** Chamber-scoped chronological neighbours of this sitting. */
  readonly navigation: ParliamentSittingNavigation;
}

/** A legacy speech row's mapping onto the canonical reading. */
export interface ParliamentSpeechRedirect {
  readonly legacySpeechKey: string;
  readonly sessionKey: string;
  readonly canonicalSpeechKey: string | null;
  readonly canonicalSegmentKey: string | null;
  readonly canonicalPosition: number | null;
  readonly mappingKind: string;
  readonly matchMethod: string;
}

/**
 * The canonical context of one contribution: the reading block, its sitting, and
 * the neighbouring CONTRIBUTIONS (the previous/next SPEECH blocks — not the next
 * printed block, which is usually narration). Accepts a canonical `canon:` key OR
 * a LEGACY `cdep:` / `senat:` key, which is resolved through
 * `parliament.speech_redirects`:
 *  - `mappingKind='exact_segment'` → `segment` is the proven block.
 *  - `mappingKind='session_only'`  → `segment` is null and only the sitting is
 *    resolved. This is the honest coarse answer, never a guessed turn.
 */
export interface ParliamentSpeechContext {
  readonly speechKey: string;
  readonly session: ParliamentStenogramSession;
  readonly segment: ParliamentStenogramSegment | null;
  readonly previousContribution: ParliamentStenogramSegment | null;
  readonly nextContribution: ParliamentStenogramSegment | null;
  /** Set only when the requested key was LEGACY and resolved through a redirect. */
  readonly redirect: ParliamentSpeechRedirect | null;
}

// ── module error taxonomy (widens the kernel ApiError, never replaces it) ─────

/**
 * The session exists (or would), but no READING can be served. Kept DISTINCT from
 * `NotFound` because the difference is user-visible: "there is no such sitting" is
 * a different fact from "we hold this sitting and its official URL but the capture
 * yields no transcript". `reason`:
 *  - 'source_only'            — the capture is blank/CSS-only/navigation-only
 *                               (availability='SOURCE_ONLY'); retrying never helps.
 *  - 'no_public_segments'     — blocks exist but none are `privacy_class='public'`.
 *  - 'projection_unavailable' — the canonical stenogram relations are not present
 *                               on this database (the scrapper migration is not
 *                               applied); retrying MAY help.
 */
export interface ParliamentTranscriptUnavailableError {
  readonly type: 'TranscriptUnavailable';
  readonly message: string;
  readonly sessionKey: string | null;
  readonly reason: 'source_only' | 'no_public_segments' | 'projection_unavailable';
  /**
   * The sitting itself, whenever we hold it — the WHOLE POINT of keeping this
   * distinct from `NotFound`. A SOURCE_ONLY sitting is a real, known sitting whose
   * transcript we do not hold; the client must be able to render "open the official
   * transcript" (sourceUrl + sourceUrlKind, so a Senate `lossy_root` link is not
   * presented as an exact deep link) and label it (title/chamber/sessionDate)
   * WITHOUT a second request that would only 409 again.
   *
   * Null only when there is no session to describe: `projection_unavailable` (we
   * cannot read sittings at all).
   */
  readonly session: ParliamentStenogramSessionRef | null;
}

/**
 * The canonical FULL-HISTORY transcript search projection is not available, so a
 * `q` over the whole transcript history cannot be answered. This is an EXPLICIT
 * refusal by design (foundation privacy/honesty rule): the surface must NEVER
 * silently degrade to a title-only match or a bounded legacy ILIKE, because both
 * answer a narrower question than the caller asked while looking like a full
 * answer. `docType` names the projection so an operator can see what is missing.
 */
export interface ParliamentSearchUnavailableError {
  readonly type: 'SearchUnavailable';
  readonly message: string;
  readonly docType: string;
}

/** Every stenogram surface returns this union; it WIDENS the kernel `ApiError`. */
export type ParliamentStenogramError =
  | ApiError
  | ParliamentTranscriptUnavailableError
  | ParliamentSearchUnavailableError;

export const transcriptUnavailable = (
  message: string,
  sessionKey: string | null,
  reason: ParliamentTranscriptUnavailableError['reason'],
  session: ParliamentStenogramSessionRef | null = null
): ParliamentTranscriptUnavailableError => ({
  type: 'TranscriptUnavailable',
  message,
  sessionKey,
  reason,
  session,
});

export const searchUnavailable = (
  message: string,
  docType: string = PARLIAMENT_TRANSCRIPT_SEARCH_DOC_TYPE
): ParliamentSearchUnavailableError => ({ type: 'SearchUnavailable', message, docType });

/**
 * Stable wire code per error type, IDENTICAL on REST (`error`), GraphQL
 * (`extensions.code`) and MCP (`error`) — the tri-surface equivalence rule applied
 * to failures, so a client can branch on one vocabulary.
 */
export const parliamentStenogramErrorCode = (error: ParliamentStenogramError): string => {
  if (error.type === 'TranscriptUnavailable') return 'TRANSCRIPT_UNAVAILABLE';
  if (error.type === 'SearchUnavailable') return 'SEARCH_UNAVAILABLE';
  return GRAPHQL_ERROR_CODE[error.type];
};

/**
 * HTTP status per error type. `TranscriptUnavailable` splits on `reason`: a
 * SOURCE_ONLY capture is a permanent property of the resource (409 — the session
 * is real but cannot yield this representation), while a missing projection is an
 * operational gap (503, retryable). `SearchUnavailable` is always 503.
 */
export const parliamentStenogramHttpStatus = (error: ParliamentStenogramError): number => {
  if (error.type === 'TranscriptUnavailable') {
    return error.reason === 'projection_unavailable' ? 503 : 409;
  }
  if (error.type === 'SearchUnavailable') return 503;
  return HTTP_STATUS[error.type];
};

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

// ── plenary agenda (ordinea de zi) ───────────────────────────────────────────

/**
 * A sitting as the agenda lane knows it.
 *
 * `date` is present on every row today, but the field stays nullable and
 * carries its own provenance: a caller must be able to tell a genuinely
 * dateless capture from one this lane simply has not dated, and must never
 * order the undated as if they were dated.
 */
export interface ParliamentAgendaSitting {
  readonly sittingKey: string;
  readonly chamber: string;
  readonly date: string | null;
  /**
   * 'stenogram_session' — the sitting's own printed transcript title (the
   * authority). 'ordinezi_title' — parsed from the order-of-business title.
   * 'weekly_agenda' — the PLANNED week; it loses to a transcript date.
   * 'none' — no trustworthy date.
   */
  readonly dateSource: string;
  readonly title: string | null;
  /** The stenogram session key, when this sitting has a captured transcript. */
  readonly stenogramSessionKey: string | null;
  /** How firmly the agenda maps onto this sitting: 'exact' | 'candidate'. */
  readonly resolutionStatus: string | null;
}

/** A document printed against one point of an order of business. */
export interface ParliamentAgendaItemDocument {
  readonly url: string;
  readonly label: string | null;
  readonly date: string | null;
  readonly manifestSide: string;
}

/** One numbered point of an order of business. */
export interface ParliamentAgendaItem {
  readonly agendaItemKey: string;
  readonly rowIndex: number;
  readonly numberText: string | null;
  /** 'administrative' | 'debate' | 'unknown'. */
  readonly itemKind: string;
  readonly billKey: string | null;
  readonly billLabel: string | null;
  readonly billFamily: string | null;
  readonly titleText: string | null;
  readonly descriptionText: string | null;
  readonly lawCategory: string | null;
  readonly senateDisposition: string | null;
  readonly senateDispositionDate: string | null;
  /**
   * Verbatim source strings naming the reporting committee and its
   * recommendation, e.g. `Comisia juridică (Respingere) - distribuit -
   * 26.04.2016`. Deliberately unparsed: resolving a short committee name needs
   * the legislature, and 47 of them are prefix-ambiguous across 109,250
   * mentions. Present them as source text, not as a resolved committee.
   */
  readonly committeeRapporteurs: readonly string[];
  readonly procedureUrgency: boolean;
  readonly decisionalChamber: boolean;
  readonly debateReservation: boolean;
  /** 'linked' | 'unresolved' | 'not_applicable' for the bill reference. */
  readonly resolutionStatus: string;
  readonly documents: readonly ParliamentAgendaItemDocument[];
}

/**
 * One published order of business.
 *
 * An agenda is a PLAN. Nothing here is evidence that a point was reached,
 * debated or voted — that comes from the transcript and the division lists.
 */
export interface ParliamentAgenda {
  readonly agendaKey: string;
  readonly chamber: string;
  readonly title: string | null;
  readonly approvedDate: string | null;
  readonly approvedDateText: string | null;
  /** The official PDF of the order of business, when the source published one. */
  readonly pdfUrl: string | null;
  readonly sourceUrl: string;
  readonly sittings: readonly ParliamentAgendaSitting[];
  readonly itemCount: number;
  /** Bills on the agenda we hold a dossier for, and can therefore link. */
  readonly billCount: number;
  /**
   * Bills the agenda NAMES. Equal to `billCount` except where a bill is too new
   * to have been ingested — 151 items over 112 agendas, but concentrated in the
   * freshest agenda, so a list that features the newest must use this one.
   */
  readonly namedBillCount: number;
}

/** An order of business plus its ordered points. */
export interface ParliamentAgendaDetail extends ParliamentAgenda {
  readonly items: readonly ParliamentAgendaItem[];
}

/**
 * A bill's appearance on an order of business.
 *
 * This proves SCHEDULING and nothing more. `relationshipKind` is
 * `scheduled_on_agenda` on every row that exists today.
 */
export interface ParliamentBillScheduling {
  readonly agendaKey: string;
  readonly agendaItemKey: string;
  readonly agendaTitle: string | null;
  readonly sittingKey: string;
  readonly sittingDate: string | null;
  readonly sittingDateSource: string;
  readonly chamber: string;
  readonly relationshipKind: string;
  /** 'exact' | 'candidate' — a candidate mapping must not be shown as certain. */
  readonly resolutionStatus: string;
  readonly itemNumberText: string | null;
  readonly stenogramSessionKey: string | null;
}

export interface ParliamentAgendaFilter {
  readonly chamber?: string | null;
  /**
   * Bounds on `approved_date` — the date the Chamber ADOPTED the plan.
   *
   * 391 of 1,297 agendas carry no approval date, and they are not an old-data
   * artefact: the gap runs 8%-54% in every year from 2001 to 2026, and past half
   * in 2011-2012. Any of these bounds therefore drops up to half a year's
   * agendas. Prefer the sitting bounds below unless the approval act itself is
   * what is being asked about.
   */
  readonly dateFrom?: string | null;
  readonly dateTo?: string | null;
  readonly year?: number | null;
  /**
   * Bounds on the SITTING dates the agenda covers — the days it plans for.
   *
   * This is the axis a reader actually means by "agendas from 2019", and unlike
   * the approval date every one of the 1,297 agendas has at least one sitting
   * date. An agenda spanning a week matches if ANY of its days falls in range.
   */
  readonly sittingFrom?: string | null;
  readonly sittingTo?: string | null;
  readonly sittingYear?: number | null;
  /** Free-text over the agenda title. */
  readonly q?: string | null;
}

export interface ParliamentAgendaConnection {
  readonly nodes: readonly ParliamentAgenda[];
  readonly total: number;
}
