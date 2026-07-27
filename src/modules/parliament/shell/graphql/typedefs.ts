/**
 * Parliament module — GraphQL SDL slice (plan 04 §6). All types `Parliament*`-
 * prefixed (§14.8); extends root `Query` + `type Entity`. Filter inputs are
 * GENERATED from the §7 specs via the kernel `toGraphQLInput(spec)` so
 * REST/GraphQL/MCP never drift. Kernel scalars (`Date`, `BigInt`, `JSON`,
 * `PageInfo`, `Entity`) are referenced, never redefined.
 *
 * vote_records (4.13M) is reachable ONLY through a vote or a member connection —
 * there is no root ballots field (§3.1.2). Heavy paths are cursor connections;
 * member/bill lists are offset pages with a bounded total.
 *
 * AI METADATA (B1): the `aiMetadata` fields on ParliamentBill / ParliamentControlItem
 * are AI-GENERATED, NON-AUTHORITATIVE (trust_class inference_only_label; enrichment
 * gate publishable=false). Exposed by explicit user decision for client display only.
 * These fields must never become search facets, filters, or index body.
 *
 * ENUM strategy: vote choices, control types, statuses, roles carry DB-native
 * string values. To avoid a brittle UPPER_SNAKE round-trip for the long open
 * lists (roles, statuses, relationship_kind), those are typed `String` in the SDL
 * (documented), while the small CLOSED, surface-defining sets (chamber, outcome,
 * vote choice, control type, resolve dim, person confidence) are GraphQL enums.
 *
 * CLIENT GAP AUDIT (2026-06-17, vs live prod). Six client-flagged gaps:
 *   IMPLEMENTED (data exists in prod, now exposed):
 *     1. ParliamentBallot.constituencyName — JOIN members.constituency_name (261/277
 *        resolved on cdep:29892); client vote-detail "județ" column.
 *     2. ParliamentBill.statusText + .billType — bills.attrs status_text /
 *        procedure.tip_initiativa (real source classification, was attrs-only).
 *     4a. ParliamentMember.profileUrl — attrs.profile_url (public CDEP/Senate page).
 *   DOCUMENTED source-data gaps (NO prod data — a scrapper/data-platform task, not API):
 *     3. Member electionResult / officialPortraitUrl — absent in parliament.*.
 *     4b. Member contact email/phone/photoUrl + OFFICIAL mandate start/end — absent.
 *        (group_membership_intervals.valid_from/to exist but are derived_from_votes,
 *        NOT official mandate dates — already surfaced as ParliamentGroupInterval.)
 *     5. Group colour / shortName — parliamentary_groups.attrs is empty {}; the
 *        client palette stays a UI concern.
 *     6. Vote type deschis/secret — no column/flag; all stored votes are electronic
 *        roll-call (open by nature); the client "deschis" default is correct.
 */

import { toGraphQLInput } from '@/modules/shared/index.js';

import {
  billsFilterSpec,
  controlItemsFilterSpec,
  memberSpeechesFilterSpec,
  memberVotesFilterSpec,
  membersFilterSpec,
  parliamentSpeechesFilterSpec,
  stenogramSessionsFilterSpec,
  votesFilterSpec,
} from '../filters/specs.js';

const votesFilter = toGraphQLInput(votesFilterSpec);
const memberVotesFilter = toGraphQLInput(memberVotesFilterSpec);
const memberSpeechesFilter = toGraphQLInput(memberSpeechesFilterSpec);
const speechesFilter = toGraphQLInput(parliamentSpeechesFilterSpec);
const stenogramSessionsFilter = toGraphQLInput(stenogramSessionsFilterSpec);
const membersFilter = toGraphQLInput(membersFilterSpec);
const billsFilter = toGraphQLInput(billsFilterSpec);
const controlFilter = toGraphQLInput(controlItemsFilterSpec);

const objectsAndQuery = /* GraphQL */ `
  enum ParliamentChamber {
    camera_deputatilor
    senat
    comun
  }
  enum ParliamentVoteOutcome {
    adoptat
    respins
  }
  enum ParliamentVoteChoice {
    pentru
    impotriva
    abtinere
    nu_a_votat
  }
  enum ParliamentControlType {
    question
    interpellation
    question_or_interpellation
    interpellation_pm
    political_declaration
  }
  enum ParliamentPersonConfidence {
    high
    medium
    low
  }
  enum ParliamentFilterDim {
    group
    person
    constituency
    recipient
    control_type
    outcome
    chamber
  }
  enum ParliamentBillSort {
    updated_desc
    updated_asc
    title_asc
    title_desc
  }
  "Vote sort. voteDate (default) is chronological. voteKey is a STABLE id order, NOT chronological — senat vote keys are UUIDs that sort lexically; use voteDate for time order."
  enum ParliamentVoteSort {
    voteDate
    voteKey
  }

  type ParliamentGroup {
    groupId: ID!
    "Chamber of this group row. An empty string means a party-level / cross-chamber aggregate (the whole-parliament parliamentGroups list sums a party across both chambers); a non-empty value is a per-chamber group."
    chamber: String!
    name: String!
    memberCount: Int
  }
  type ParliamentGroupInterval {
    groupId: ID!
    group: ParliamentGroup
    validFrom: Date!
    validTo: Date
    source: String!
    voteCount: Int
  }

  type ParliamentCareerTotals {
    mandates: Int!
    votes: Int!
    initiatives: Int!
    speeches: Int!
  }

  type ParliamentPerson {
    personId: ID!
    canonicalName: String!
    normalizedName: String!
    birthDate: Date
    confidence: ParliamentPersonConfidence!
    "Canonical CDep mandate page for this person cluster (source-traceability §6). Null on rows the backfill has not reached."
    sourceUrl: String
    mandates: [ParliamentMember!]!
    groupIntervals: [ParliamentGroupInterval!]!
    careerTotals: ParliamentCareerTotals!
  }

  type ParliamentMember {
    mandateKey: ID!
    chamber: String
    legislature: String
    fullName: String
    normalizedName: String
    groupName: String
    group: ParliamentGroup
    constituencyName: String
    birthDate: Date
    "Public CDEP/Senate profile-page URL (attrs.profile_url). NOT a contact email/phone/photo — those have no source."
    profileUrl: String
    "Official CDep/Senate CV PDF (present for a minority of members)."
    cvPdfUrl: String
    "SC-1 seat lifecycle: true = currently-seated. For chamber composition / current rosters ONLY — does NOT affect this member's vote/initiative/control attribution (a superseded or deceased member keeps every attributed row)."
    isCurrent: Boolean!
    "Date the seat ended early (resignation/death/…); null if still seated or ran full term."
    mandateEndDate: Date
    "Why the seat ended early (e.g. demisie, deces); null if still seated."
    mandateEndReason: String
    person: ParliamentPerson
    groupIntervals: [ParliamentGroupInterval!]!
    "Activity totals. NULLABLE ON PURPOSE: these are ancillary to the member's identity, so a read failure returns null (= counts temporarily unavailable) rather than fabricating zeros or 404-ing a member who exists. null NEVER means no-activity — a member with no activity returns an object of zeros."
    activityCounts: ParliamentActivityCounts
    "This member's ballots (cursor; default voteDate desc). The optional filter (voteDate/chamber/outcome/choice) narrows the set; connection.total is then the EXACT filtered count."
    votes(
      first: Int
      after: String
      filter: ParliamentMemberVotesFilter
    ): ParliamentMemberVoteConnection!
    "Per-day voting activity for one calendar year (drives the activity heatmap). Reflects the SAME filter as the votes connection; a voteDate inside filter is rejected — the year argument bounds the range."
    voteActivity(year: Int!, filter: ParliamentMemberVotesFilter): ParliamentMemberVoteActivity!
    controlItems(page: Int, pageSize: Int): ParliamentControlItemPage!
    "This member's speeches, LEGACY offset page (kept for existing callers). For a filterable/searchable, keyset-paginated view use speechesConnection."
    speeches(page: Int, pageSize: Int): ParliamentSpeechPage!
    "This member's speeches (cursor; keyset spokenAt desc, speechKey desc). The optional filter (spokenAt/chamber) and free-text q (title + summary + verbatim transcript) narrow the set; connection.total is then the EXACT filtered count. A turn is one intervention; per-mandate volume can be very large, so this is SQL keyset — always page via the cursor."
    speechesConnection(
      first: Int
      after: String
      filter: ParliamentMemberSpeechesFilter
      "Free-text substring (case-insensitive, diacritic-sensitive) over title + summary + the verbatim transcript. Part of the cursor identity: a cursor minted under one q cannot replay under another."
      q: String
    ): ParliamentMemberSpeechConnection!
    "Per-day speech activity for one calendar year (drives the interventii heatmap). Reflects the SAME filter + q as speechesConnection; a spokenAt inside filter is rejected — the year argument bounds the range."
    speechActivity(
      year: Int!
      filter: ParliamentMemberSpeechesFilter
      q: String
    ): ParliamentMemberSpeechActivity!
    initiatives(page: Int, pageSize: Int): ParliamentInitiativePage!
    declarations: [ParliamentDeclarationMeta!]!
    "Committee seats for this member (B2). cdep seats link by mandate; senate seats via the current-roster join (a current senator's committee memberships). Senate committee coverage is the CURRENT roster ONLY — a historical (non-current) senator returns an empty list by data availability, not by error. Ordered current-first. No group / raw name (PDL-003)."
    committeeMemberships: [ParliamentCommitteeMembership!]!
  }

  type ParliamentActivityCounts {
    votes: Int!
    controlItems: Int!
    speeches: Int!
    initiatives: Int!
    declarations: Int!
  }

  type ParliamentTally {
    pentru: Int
    impotriva: Int
    abtinere: Int
    nuAVotat: Int
    present: Int
  }

  type ParliamentVoteGroupBreakdown {
    groupName: String
    pentru: Int!
    impotriva: Int!
    abtinere: Int!
    nuAVotat: Int!
  }

  type ParliamentBallot {
    rowIndex: Int!
    memberName: String
    groupName: String
    choice: ParliamentVoteChoice
    mandateKey: ID
    member: ParliamentMember
    matchMethod: String
    "Constituency (județ) of the resolved member, JOINed from members. null when the ballot is unresolved or the member has no recorded constituency. Flat field — avoids a per-ballot member fetch for the vote-detail județ column."
    constituencyName: String
  }

  type ParliamentVote {
    voteKey: ID!
    chamber: String!
    voteDate: Date
    title: String
    tally: ParliamentTally!
    outcome: ParliamentVoteOutcome
    divisionNumber: Int
    billKey: ID
    bill: ParliamentBill
    lawReference: String
    "Official cdep.ro / senat.ro page for this division (source-traceability §6). Null on rows the backfill has not reached."
    sourceUrl: String
    tallyMismatch: Boolean!
    groupBreakdown: [ParliamentVoteGroupBreakdown!]!
    "Ballots for this vote (cursor). 'first' is capped at 200 — deliberately higher than the 100 root-collection cap because a single vote's ballot set is parent-bound and bounded by chamber size."
    ballots(first: Int, after: String): ParliamentBallotConnection!
  }

  "A member's ballot joined to its vote (the member voting profile row)."
  type ParliamentMemberVote {
    voteKey: ID!
    chamber: String!
    voteDate: Date
    title: String
    outcome: ParliamentVoteOutcome
    choice: ParliamentVoteChoice
    rowIndex: Int!
    billKey: ID
    vote: ParliamentVote
  }

  "One calendar day of a member's ballots (the activity-heatmap cell); the four choice counts sum to total."
  type ParliamentMemberVoteActivityDay {
    date: Date!
    total: Int!
    pentru: Int!
    impotriva: Int!
    abtinere: Int!
    nuAVotat: Int!
  }
  "A member's per-day voting activity for one year. availableYears is every year the member has any (filtered) ballot, NOT bounded by the requested year."
  type ParliamentMemberVoteActivity {
    year: Int!
    days: [ParliamentMemberVoteActivityDay!]!
    availableYears: [Int!]!
  }

  type ParliamentMemberSpeechEdge {
    node: ParliamentSpeech!
    cursor: String!
  }
  "A member's speeches (parented by mandate_key; keyset spokenAt desc). total is the EXACT count over the filtered/searched slice."
  type ParliamentMemberSpeechConnection {
    edges: [ParliamentMemberSpeechEdge!]!
    pageInfo: PageInfo!
    total: Int!
  }
  "One calendar day of a member's speeches (the interventii-heatmap cell); proprie + comun = total."
  type ParliamentMemberSpeechActivityDay {
    date: Date!
    total: Int!
    "Turns in this member's own chamber (total - comun)."
    proprie: Int!
    "Turns in a joint sitting (chamber = comun)."
    comun: Int!
  }
  "A member's per-day speech activity for one year. availableYears is every year the member has any (filtered) turn, NOT bounded by the requested year."
  type ParliamentMemberSpeechActivity {
    year: Int!
    days: [ParliamentMemberSpeechActivityDay!]!
    availableYears: [Int!]!
  }

  "The APPLIED depth of a global-speeches q search: TITLE_SUMMARY = title + summary only; FULL_TEXT = additionally the verbatim transcript (speech_texts.full_text). The connection/activity REPORTS what actually ran (the transcript table may be absent or the window too wide); null when no q was given."
  enum ParliamentSpeechSearchDepth {
    TITLE_SUMMARY
    FULL_TEXT
  }

  type ParliamentSpeechEdge {
    node: ParliamentSpeech!
    cursor: String!
  }
  "Global speeches (stenograme; keyset spokenAt desc, speechKey desc). total is the count over the filtered/searched slice, CAPPED at 10,000 — totalEstimated:true means the real total exceeds the cap. searchDepth reports the APPLIED q depth (null when no q)."
  type ParliamentSpeechConnection {
    edges: [ParliamentSpeechEdge!]!
    pageInfo: PageInfo!
    total: Int!
    totalEstimated: Boolean!
    searchDepth: ParliamentSpeechSearchDepth
  }
  "Global per-day speech activity for one year (day shape shared with the member heatmap: proprie + comun = total). availableYears is every year with any (filtered) turn, NOT bounded by the requested year. searchDepth reports the APPLIED q depth (null when no q)."
  type ParliamentSpeechActivity {
    year: Int!
    days: [ParliamentMemberSpeechActivityDay!]!
    availableYears: [Int!]!
    searchDepth: ParliamentSpeechSearchDepth
  }

  type ParliamentBillEvent {
    "Bill view that contributed this event to the merged dossier."
    sourceBillKey: ID!
    position: Int!
    "Event date; null for ~56% of cdep procedural/committee rows whose source row carries no date (absent at source, NOT a parse gap — M6). Position ordering is always intact, so use position for chronology when eventDate is null."
    eventDate: Date
    eventDateText: String
    description: String
    chamberCode: String
    "Referral committee(s) for this event, extracted from the description (M5). An event commonly references more than one (e.g. report + opinion); null when the event references none (votes, readings). The full text remains in 'description'."
    committee: [String!]
    voteIdv: String
    docs: JSON
  }
  type ParliamentBillDocument {
    "Bill view that contributed this document to the merged dossier."
    sourceBillKey: ID!
    url: String!
    label: String
    kind: String
    position: Int
  }

  "bill↔legal.acts edge. legalAct is resolved by the KERNEL LegalActByIdLoader (§6.7); a dangling target_act_id resolves to null (never an error)."
  type ParliamentBillActLink {
    relationshipKind: String!
    targetActId: ID
    targetActType: String
    targetActNumber: String
    targetActYear: Int
    "Monitorul Oficial publication key when resolutionStatus='linked_mo': the law is published in MO but absent from the consolidated act registry, so targetActId/legalAct are null. Distinct from hasLaw (registry-resolved 'linked')."
    targetMoActKey: String
    resolutionStatus: String!
    confidenceLabel: String!
    primaryMethod: String!
    legalAct: ParliamentLegalActRef
  }
  "The minimal legal-act ref the kernel loader returns (parliament never reads legal.* itself)."
  type ParliamentLegalActRef {
    actId: ID!
    title: String
    actType: String
  }

  type ParliamentBillVoteLink {
    voteKey: ID!
    vote: ParliamentVote
    billKey: ID
    role: String!
    resolutionStatus: String!
    confidenceLabel: String!
  }

  type ParliamentBill {
    billKey: ID!
    plxNumber: String
    plxYear: Int
    senateNumber: String
    senateYear: Int
    title: String
    finalLawNumber: String
    finalLawYear: Int
    "RAW source status string (CDEP/Senate status_text, e.g. 'Lege 423/2023 …', 'respins'). May contain glued tokens/typos on the cdep side — use the 'status' FILTER (promulgated/rejected/withdrawn/lapsed/in_progress, v2 2026-07-22) for the normalized lifecycle signal (M11)."
    statusText: String
    "RAW source initiative type (procedure.tip_initiativa, e.g. 'Proiect de Lege …' / 'Propunere legislativa …'). The billType FILTER buckets this into government/parliamentary using the CDep prefix OR the Senate initiator_classification evidence (source-aware since 2026-07-22); bills with neither signal match NEITHER bucket. null when the source has no procedure block."
    billType: String
    "Date of the most recent timeline event (attrs.last_event_date). This is the key the default 'updated_desc' sort uses — exposed so the client can show/verify recency."
    lastEventDate: Date
    "B1 canonicality (§3): true = this bill is in the default-visible set. A bicameral bill is stored under both chambers' keys; the suppressed Senate navetă twin is NON-canonical and EXCLUDED from the default bill list. A deep link to a non-canonical key still resolves via parliamentBill — read canonicalBillKey to notice/redirect to the canonical view."
    isCanonical: Boolean!
    "On a non-canonical (suppressed) twin, the canonical CDep bill_key to redirect to; null on a canonical bill."
    canonicalBillKey: String
    "Dossier completeness (2026-07-22): on the parliamentBill dossier read, every bill_key whose children are merged into events/documents/initiators/relatedVotes/actLinks/voteLinks — the requested view plus its resolved-pair navetă twin. [billKey] alone when the bill has no accepted twin (incl. ambiguous dup-review groups, which are never blended). null when the bill was reached outside the dossier read (e.g. list rows), where children are per-view."
    dossierBillKeys: [String!]
    events: [ParliamentBillEvent!]!
    documents: [ParliamentBillDocument!]!
    initiators: [ParliamentMember!]!
    "DEPRECATED — use voteLinks. relatedVotes is 'votes WHERE bill_key = this bill' only: it drops the cross-chamber vote twin (stored under the other chamber's bill key) and carries no role/resolutionStatus."
    relatedVotes: [ParliamentVote!]!
      @deprecated(
        reason: "Use voteLinks (role-bearing, cross-chamber). relatedVotes omits the cross-chamber vote twin and has no role/resolutionStatus."
      )
    actLinks: [ParliamentBillActLink!]!
    voteLinks: [ParliamentBillVoteLink!]!
    "AI-GENERATED, NON-AUTHORITATIVE (trust_class inference_only_label; enrichment gate publishable=false). Exposed by explicit user decision for client display only. These fields must never become search facets, filters, or index body."
    aiMetadata: ParliamentAiBillMetadata
  }

  type ParliamentControlItem {
    itemKey: ID!
    controlType: ParliamentControlType
    controlTypeProvenance: String
    title: String
    recipient: String
    itemDate: Date
    responseStatus: String
    chamber: String
    authorName: String
    "Official interpelări/întrebări detail page (source-traceability §6). Null on rows the backfill has not reached."
    sourceUrl: String
    member: ParliamentMember
    "AI-GENERATED, NON-AUTHORITATIVE (trust_class inference_only_label; enrichment gate publishable=false). Exposed by explicit user decision for client display only. These fields must never become search facets, filters, or index body. Restricted rows are never served (public only)."
    aiMetadata: ParliamentAiControlItemMetadata
  }
  type ParliamentSpeech {
    speechKey: ID!
    spokenAt: Date
    title: String
    summary: String
    chamber: String
    "Raw source speaker name (as printed in the stenogram). Present even when the speaker could not be matched to a mandate (PM, guests, unmatched names)."
    speakerName: String
    "Speaker mandate key; null for speakers without a parliamentary mandate match (PM, guests, unmatched speakers) — those turns are real data and ARE served."
    mandateKey: ID
    "The resolved member (lazy — one lookup, only when selected). null when mandateKey is null."
    member: ParliamentMember
    "The PERSON behind the mandate — stable across a career spanning several legislatures, unlike the per-legislature mandateKey. Pass it to parliamentPerson. null when mandateKey is null. The typed resolution state and its provenance (speakerResolution / speakerMethod / speakerConfidence) live on the canonical READING BLOCK, not here — reach them via context.segment, so there is exactly one place a resolution is recorded."
    personId: ID
    "Link back to the source stenogram. See sourceUrlKind for how precisely it locates this turn."
    sourceUrl: String
    "'exact' → deep-links this turn (safe to present as an authoritative link). 'lossy_root' → resolves only to the sitting/section root (Senate stenograms carry no per-turn anchor); do NOT present as an exact deep-link to this speech."
    sourceUrlKind: String
    "Verbatim transcript text (parliament.speech_texts). Resolved lazily — only fetched when selected — and null when the transcript is not yet loaded for this turn. Transcript coverage is PARTIAL (a parallel backfill): a null fullText means 'not loaded', not 'no speech'."
    fullText: String
    "True for a CANONICAL contribution (a re-derived reading block, speechKey prefix 'canon:'). PREFER these: a canonical row carries the whole turn and a provable position in the sitting, while a legacy row is an over-split snippet of the same words. false on every legacy row AND on any row read from a database where the canonical stenogram migration is not applied."
    isCanonical: Boolean!
    "The canonical stenogram session (sitting) this turn belongs to — pass it to parliamentStenogramSession for the full ordered transcript. null on a legacy row; use parliamentSpeechContext(speechKey) to resolve a legacy key to its sitting through speech_redirects."
    sessionKey: ID
    "0-based position of this turn in the OFFICIAL printed order of the sitting. null on a legacy row (position is only defined for a canonical reading block). null NEVER means position 0."
    position: Int
    "Canonical context: the reading block, its sitting, and the neighbouring contributions. Resolved lazily; accepts legacy keys through speech_redirects; null when this turn has no canonical mapping yet."
    context: ParliamentSpeechContext
  }

  "How much of the official transcript a capture yields. SOURCE_ONLY = a blank/navigation-only capture: the sitting and its official URL are held and NO reading is served (the DB pins SOURCE_ONLY ⇒ 0 blocks, so it can never claim 'no content' while carrying content)."
  enum ParliamentStenogramAvailability {
    COMPLETE
    PARTIAL
    SOURCE_ONLY
  }
  "Kind of a canonical reading block: someone speaking, the agenda heading the following blocks sit under, an official vote result, or transcript narration/context."
  enum ParliamentStenogramSegmentKind {
    SPEECH
    AGENDA_HEADING
    VOTE_RESULT
    CONTEXT
  }

  "One canonical stenogram session — a captured sitting and the parent of its ordered reading. Counters are a stored shape of the parse (the loader gate re-derives and blocks on drift), so a client can size a sitting without fetching its blocks."
  type ParliamentStenogramSession {
    sessionKey: ID!
    chamber: String!
    "Sitting date. NULL when the source carries no trustworthy date — read sessionDateSource; the date is never inferred."
    sessionDate: Date
    "Provenance of sessionDate: 'stenogram_title' (CDep — parsed from the printed sitting title, because the raw sitting_date column is unusable), 'session_date' (Senate — a real source date), or 'none' (no trustworthy date; sessionDate is null)."
    sessionDateSource: String!
    title: String
    "Official system the capture came from: cdep_stenogram | senat_stenogram."
    sourceSystem: String!
    availability: ParliamentStenogramAvailability!
    "Official transcript URL — always present (a session with no navigable path back to the source is a defect, not a row)."
    sourceUrl: String!
    "SOURCE PRECISION of sourceUrl: 'exact' → deep-links this sitting (safe to present as authoritative); 'lossy_root' → resolves only to the sitting/section root (Senate captures carry no per-turn anchor); 'raw_response' → points at the stored capture, not a live page."
    sourceUrlKind: String!
    "Link to the agenda-owned sitting spine. null is NORMAL — the agenda lane only knows the sittings its own source published; it is not a defect."
    sittingKey: ID
    presidingText: String
    startTimeText: String
    endTimeText: String
    segmentCount: Int!
    speechCount: Int!
    speakerCount: Int!
    "Integrity anchor of the ORDERED reading, recomputed and gate-blocked by the loader. Changes when a re-parse changes the reading — use it to tell a real change from a no-op refresh without diffing blocks."
    canonicalDigest: String!
    "Integrity anchor of the SOURCE BYTES the reading was derived from. null for a SOURCE_ONLY sitting (there is no usable capture)."
    captureDigest: String
    sourceUpdatedAt: String
  }

  "A sitting as a NAVIGATION TARGET: enough to label it and to open its official source, without pretending to be a fetched sitting."
  type ParliamentStenogramSessionRef {
    sessionKey: ID!
    chamber: String!
    sessionDate: Date
    title: String
    availability: ParliamentStenogramAvailability!
    sourceUrl: String!
    "SOURCE PRECISION — do not present a 'lossy_root' URL as an exact deep link."
    sourceUrlKind: String!
  }

  "Previous/next sitting around this one, CHAMBER-SCOPED so the control never jumps between assemblies (a joint 'comun' sitting is a different assembly). Ordering is the same deterministic keyset the sittings list pages by, so stepping and paging always agree. null at the ends of a chamber's history; a non-public neighbour is simply absent."
  type ParliamentSittingNavigation {
    previous: ParliamentStenogramSessionRef
    next: ParliamentStenogramSessionRef
  }

  """
  WHY a turn does or does not carry a speaker identity. Four states, never one
  overloaded null (scrapper migration 20260727T140000):
   - RESOLVED             the speaker is known, and spoke AS a member.
   - NON_MEMBER_CAPACITY  this turn is NOT a member intervention — a minister,
                          secretary of state, official or guest. Deliberately not
                          "not a member": ministers frequently hold a mandate at the
                          same time, and the source is saying they are not speaking
                          under it here. Show a role/guest badge, never a link.
   - AMBIGUOUS            two or more roster candidates survived; we refuse to guess.
   - UNRESOLVED           we could not resolve it and do not claim to know why
                          beyond speakerMethod.
  """
  enum ParliamentSpeakerResolution {
    RESOLVED
    NON_MEMBER_CAPACITY
    AMBIGUOUS
    UNRESOLVED
  }

  "Strength of a speaker-identity claim. Only ever set on RESOLVED / NON_MEMBER_CAPACITY — the two states that make a claim."
  enum ParliamentSpeakerConfidence {
    "Read from the source's OWN printed member id — cdep.ro prints the full mandate key next to the speaker."
    EXACT
    HIGH
    "A labelled name match (Senate only — senat.ro prints no member id anywhere), unique within the legislature's roster."
    MEDIUM
    LOW
  }

  "One canonical reading block, in the OFFICIAL printed order. (sessionKey, position) IS the identity — segmentKey encodes the pair and the database enforces it unique, so the two can never disagree."
  type ParliamentStenogramSegment {
    segmentKey: ID!
    sessionKey: ID!
    "0-based position in the official printed order of the transcript."
    position: Int!
    kind: ParliamentStenogramSegmentKind!
    "The reading block: this turn's paragraphs coalesced in exact source order. NOT a snippet — ParliamentSpeech.summary is the snippet, this is the text."
    text: String!
    textChars: Int!
    "Speaker name AS PRINTED by the official transcript (honorific stripped). NEVER an identity, and null for narration."
    speakerName: String
    "The source's OWN speaker locator (CDep idm) — a raw locator, not an identity."
    speakerRef: String
    "Roster-validated speaker identity. null is the honest, EXPECTED value for guests, ministers, and any speaker the source did not print an id for — a name is never turned into a member."
    mandateKey: ID
    "The resolved member (lazy). null when mandateKey is null."
    member: ParliamentMember
    "The PERSON behind the mandate — stable across a career that spans several legislatures (mandateKey is per-legislature). Pass it to parliamentPerson. null unless speakerResolution is RESOLVED."
    personId: ID
    "WHY this turn does or does not carry an identity. Non-null on every SPEECH block — an unlinked name is never silent about its reason."
    speakerResolution: ParliamentSpeakerResolution
    "Which rule produced speakerResolution, e.g. 'source_member_anchor' (the source printed the mandate) or 'roster_name_unique' (a labelled name match). Recorded even when nothing resolved, so an unresolved turn says which rule gave up."
    speakerMethod: String
    "How strong the claim is. null on AMBIGUOUS/UNRESOLVED, which claim nothing."
    speakerConfidence: ParliamentSpeakerConfidence
    "The canonical serving speech row for this block (SPEECH blocks only)."
    speechKey: ID
    "Source-printed agenda reference in scope (CDep section anchor / Senate agenda GUID)."
    agendaRef: String
    sourceUrl: String!
    "SOURCE PRECISION — same taxonomy as the session's sourceUrlKind."
    sourceUrlKind: String!
  }

  "A sitting plus its ordered reading and its sitting navigation. On THIS root segments is a bounded slice (offset/limit) — totalSegments is always the full public block count, so a client knows whether to page. The REST endpoint GET /api/v1/parliament/stenograms/:sessionKey/transcript returns the COMPLETE reading in one response instead."
  type ParliamentStenogramTranscript {
    session: ParliamentStenogramSession!
    segments: [ParliamentStenogramSegment!]!
    totalSegments: Int!
    navigation: ParliamentSittingNavigation!
  }

  "How a LEGACY speech key was mapped onto the canonical reading. 'exact_segment' carries all three canonical pointers; 'session_only' resolves the sitting alone — the honest coarse answer used when a single block could not be PROVEN, never a guessed turn."
  type ParliamentSpeechRedirect {
    legacySpeechKey: ID!
    sessionKey: ID!
    canonicalSpeechKey: ID
    canonicalSegmentKey: ID
    canonicalPosition: Int
    mappingKind: String!
    "How the mapping was established (e.g. 'cdep_sitting_ids', 'senate_raw_speech_key') — auditable without re-deriving it."
    matchMethod: String!
  }

  "The canonical context of one contribution: its reading block, its sitting (with sittingKey + counters for sitting navigation), and the neighbouring CONTRIBUTIONS — the previous/next SPEECH blocks, not the adjacent printed block, which is usually narration."
  type ParliamentSpeechContext {
    "The key that was REQUESTED (canonical or legacy) — echoed so a client can tell a redirect happened."
    speechKey: ID!
    session: ParliamentStenogramSession!
    "The reading block. null when the requested legacy key resolved only to the sitting (redirect.mappingKind = 'session_only')."
    segment: ParliamentStenogramSegment
    previousContribution: ParliamentStenogramSegment
    nextContribution: ParliamentStenogramSegment
    "Set ONLY when the requested key was legacy and was resolved through parliament.speech_redirects. null for a canonical key."
    redirect: ParliamentSpeechRedirect
  }

  type ParliamentStenogramSessionEdge {
    node: ParliamentStenogramSession!
    cursor: String!
  }
  "Canonical stenogram sessions (cursor; keyset sessionDate desc, sessionKey desc — a dateless capture sorts LAST). total is capped at 10,000; totalEstimated:true means the real total exceeds the cap OR a full-history q resolved more sittings than it could return."
  type ParliamentStenogramSessionConnection {
    edges: [ParliamentStenogramSessionEdge!]!
    pageInfo: PageInfo!
    total: Int!
    totalEstimated: Boolean!
  }
  type ParliamentInitiative {
    initiativeKey: ID!
    billKey: ID
    title: String
    status: String
    promulgatedLawNumber: String
    promulgatedLawYear: Int
    bill: ParliamentBill
    "Registration date (parsed from registration_date_text). null for ~4.3% date-less legacy rows. The member-initiatives list is ordered by this DESC (newest first)."
    registrationDate: Date
  }
  "Declaration metadata ONLY — no file_hash, no content (§2.6). declarationDate is null (the CDEP index carries no per-declaration date); declarationYear is recovered from the file_url path and label is synthesized as '<type> <year>' when the source has none (M10)."
  type ParliamentDeclarationMeta {
    declarationType: String!
    declarationDate: Date
    declarationYear: Int
    label: String
    fileUrl: String!
  }

  "Marquee: act → bills → final votes → ballots. caveats flag era/coverage limits — never a silent empty."
  type ParliamentActLineage {
    actId: ID!
    bills: [ParliamentBill!]!
    votes: [ParliamentLineageVote!]!
    caveats: [String!]!
  }
  type ParliamentLineageVote {
    voteKey: ID!
    billKey: ID
    chamber: String!
    voteDate: Date
    role: String!
    outcome: ParliamentVoteOutcome
    resolutionStatus: String!
    confidenceLabel: String!
    tally: ParliamentTally!
    ballotsTotal: Int
    ballotsResolved: Int
  }

  type ParliamentGroupCohesion {
    groupName: String!
    forPct: Float!
    againstPct: Float!
    abstainPct: Float!
    absentPct: Float!
    "Rice cohesion |for-against|/(for+against), 0..1. NULL when the group cast no DECIDED (for/against) votes in the set — Rice is undefined there, NOT 0 (a 0 would read as 'maximally divided'; M13). Gauge significance with voteCount."
    cohesionIndex: Float
    voteCount: Int!
  }

  type ParliamentResolveHit {
    dim: ParliamentFilterDim!
    value: String!
    label: String!
    kind: String!
    score: Float
  }

  "Person-identity review queue — lean projection (NO evidence/method internals, §2.6). API-key gated surface."
  type ParliamentPersonCandidate {
    mandateKey: ID!
    personId: ID
    status: String!
  }
  type ParliamentPersonCandidatePage {
    candidates: [ParliamentPersonCandidate!]!
    total: Int!
    totalEstimated: Boolean!
  }

  "Institutional Entity-360 slice — gated until recipient→CUI canonicalization; resolves null today (§4, §6.3)."
  type ParliamentControlSummary {
    controlItemCount: Int!
    lastItemDate: Date
    topRecipient: String
  }

  "Loader/data freshness signals (B4): the newest vote date and the last load timestamp."
  type ParliamentDataFreshness {
    latestVoteDate: Date
    lastLoadedAt: DateTime
  }

  # ── AI enrichment metadata (B1) ────────────────────────────────────────────────
  # AI-GENERATED, NON-AUTHORITATIVE (trust_class inference_only_label; enrichment
  # gate publishable=false). Exposed by explicit user decision for client display
  # only. These fields must never become search facets, filters, or index body.
  "AI-generated bill metadata. NON-AUTHORITATIVE (inference_only_label; publishable=false). Client display only — never a search facet/filter/index body."
  type ParliamentAiBillMetadata {
    summary: String
    topic: String
    domains: [String!]!
    keywords: [String!]!
    "'standard' | 'low_value' (the client hides low_value)."
    valueClass: String!
    configKey: String!
    promptVersion: String!
    schemaVersion: Int!
    model: String!
    validationStatus: String!
    confidence: String
    sourceUpdatedAt: DateTime
    loadedAt: DateTime
    privacyClass: String!
    "Always 'inference_only_label' — the fields are non-authoritative."
    trustClass: String!
    "A user-facing Romanian disclaimer to render alongside the AI summary."
    disclaimer: String!
  }
  "AI-generated control-item metadata. NON-AUTHORITATIVE (inference_only_label; publishable=false). Client display only; restricted rows are never served (public only)."
  type ParliamentAiControlItemMetadata {
    summary: String
    policyDomains: [String!]!
    issueTypes: [String!]!
    urgency: String
    keywords: [String!]!
    configKey: String!
    promptVersion: String!
    schemaVersion: Int!
    model: String!
    validationStatus: String!
    confidence: String
    sourceUpdatedAt: DateTime
    loadedAt: DateTime
    privacyClass: String!
    trustClass: String!
    disclaimer: String!
  }

  # ── committees (B2) ────────────────────────────────────────────────────────────
  "A parliamentary committee (CDep + Senate). sourceUrl is the traceability terminator (cdep.ro/senat.ro page)."
  type ParliamentCommittee {
    committeeKey: ID!
    "camera_deputatilor | senat (translated from the raw cdep/senate code)."
    chamber: String!
    name: String!
    legislature: String
    committeeType: String
    sourceUrl: String!
  }
  "A committee seat. NO group / raw name is served (PDL-003). committee is the soft-link in the member direction; member is the resolved (nullable) member in the roster direction."
  type ParliamentCommitteeMembership {
    membershipKey: ID!
    committee: ParliamentCommittee
    member: ParliamentMember
    role: String
    joinedDate: Date
    leftDate: Date
    isBureau: Boolean
    sourceUrl: String!
  }
  "Committee detail: the committee + its roster + linked bills (bounded, exact total) + a meetings count."
  type ParliamentCommitteeDetail {
    committeeKey: ID!
    chamber: String!
    name: String!
    legislature: String
    committeeType: String
    sourceUrl: String!
    "Roster memberships (cdep by mandate, senate via the current-roster join; senate_profile noise excluded). Unlinked seats appear with a null member."
    members: [ParliamentCommitteeMembership!]!
    "Bills resolved from this committee's documents (resolution_status='linked', canonical). Bounded at 200; linkedBillsTotal is the exact distinct count."
    linkedBills: [ParliamentBill!]!
    linkedBillsTotal: Int!
    meetingsCount: Int!
  }
  type ParliamentCommitteeEdge {
    node: ParliamentCommittee!
    cursor: String!
  }
  type ParliamentCommitteeConnection {
    edges: [ParliamentCommitteeEdge!]!
    pageInfo: PageInfo!
  }

  # ── pages / connections ──────────────────────────────────────────────────────
  type ParliamentMemberPage {
    members: [ParliamentMember!]!
    total: Int!
    totalEstimated: Boolean!
  }
  type ParliamentBillPage {
    bills: [ParliamentBill!]!
    total: Int!
    totalEstimated: Boolean!
  }
  type ParliamentControlItemPage {
    items: [ParliamentControlItem!]!
    total: Int!
    totalEstimated: Boolean!
  }
  type ParliamentSpeechPage {
    speeches: [ParliamentSpeech!]!
    total: Int!
    totalEstimated: Boolean!
  }
  type ParliamentInitiativePage {
    initiatives: [ParliamentInitiative!]!
    total: Int!
    totalEstimated: Boolean!
  }

  type ParliamentVoteEdge {
    node: ParliamentVote!
    cursor: String!
  }
  type ParliamentVoteConnection {
    edges: [ParliamentVoteEdge!]!
    pageInfo: PageInfo!
  }
  type ParliamentBallotEdge {
    node: ParliamentBallot!
    cursor: String!
  }
  "Ballots for ONE vote (parented by vote_key; low hundreds). The 4.13M table is never scanned flat. 'total' is the EXACT ballot count for the vote (so a client need not paginate to size the set — M16)."
  type ParliamentBallotConnection {
    edges: [ParliamentBallotEdge!]!
    pageInfo: PageInfo!
    total: Int!
  }
  type ParliamentMemberVoteEdge {
    node: ParliamentMemberVote!
    cursor: String!
  }
  "A member's voting record (parented by mandate_key; bounded set). total is an EXACT count over the member slice."
  type ParliamentMemberVoteConnection {
    edges: [ParliamentMemberVoteEdge!]!
    pageInfo: PageInfo!
    total: Int!
  }
  type ParliamentControlItemEdge {
    node: ParliamentControlItem!
    cursor: String!
  }
  type ParliamentControlItemConnection {
    edges: [ParliamentControlItemEdge!]!
    pageInfo: PageInfo!
  }

  # H2: the list/cohesion/resolve root fields are NULLABLE (no trailing !). A guard
  # error (bad cursor, unbounded window, over-cap cohesion, missing API key) is then
  # isolated to its own field (resolves null + an entry in errors[]) instead of
  # propagating a non-null violation to the root Query and wiping every sibling field.
  # This matches the already-nullable parliamentActLineage and the in-band MCP {ok:false}
  # behaviour. The INNER types stay non-null ([T!] / connection edges).
  extend type Query {
    "Members of a legislature (default = latest). Offset page bounded by legislature."
    parliamentMembers(
      filter: ParliamentMembersFilter
      page: Int
      pageSize: Int
    ): ParliamentMemberPage
    parliamentMember(mandateKey: ID!): ParliamentMember
    "Cross-mandate person career (all mandates, group history, career totals)."
    parliamentPerson(personId: ID!): ParliamentPerson
    "Group composition counts. current:true (SC-1) = currently-seated only (e.g. camera 330 / senat 134); omit/false = all-mandate counts (335 / 137)."
    parliamentGroups(legislature: String, chamber: String, current: Boolean): [ParliamentGroup!]
    "Roster for a group. groupId accepts EITHER a per-chamber group_id slug (from the chamber-scoped parliamentGroups list) OR a party-level group_name (from the whole-parliament list, whose groupId is the chamber-agnostic party name) — both resolve, case-insensitively. Each member carries its own chamber, so the client buckets a party-level roster by chamber. current:true (SC-1) = currently-seated roster only. No row cap — the full cross-chamber roster is returned."
    parliamentGroupMembers(groupId: ID!, legislature: String, current: Boolean): [ParliamentMember!]
    parliamentBills(
      filter: ParliamentBillsFilter
      sort: ParliamentBillSort
      page: Int
      pageSize: Int
    ): ParliamentBillPage
    parliamentBill(billKey: ID!): ParliamentBill
    "Votes (cursor; default voteDate desc). vote_records are NEVER listed flat here. filter.groupVote drills into a group's ballot split — votes where the group's PLURALITY stance was a given choice — and REQUIRES a chamber, voteDate or billKey bound (else INVALID_INPUT in errors[], this field null); its count does NOT equal a parliamentVoteCohesion percentage of the same window, because cohesion measures ballot slots and this measures votes."
    parliamentVotes(
      filter: ParliamentVotesFilter
      sort: ParliamentVoteSort
      first: Int
      after: String
    ): ParliamentVoteConnection
    parliamentVote(voteKey: ID!): ParliamentVote
    "Standalone control-items list (cursor; REQUIRES a date window or recipient/author bound)."
    parliamentControlItems(
      filter: ParliamentControlItemsFilter
      first: Int
      after: String
    ): ParliamentControlItemConnection
    "Global speeches — stenograme (cursor; keyset spokenAt desc). BOUNDEDNESS: requires a mandateKey bound (1 to 20 values) OR a fully-bounded spokenAt window (from AND to, at most 366 days) — there is no date index on speeches, so an unbounded list returns an INVALID_INPUT error in errors[] (this field null), never a silent default. q searches title + summary and — when EXACTLY ONE mandateKey is bound OR the window is at most 92 days, AND transcripts are loaded — the verbatim transcript; connection.searchDepth reports the depth that ACTUALLY ran. total is capped at 10,000 (totalEstimated). Quarantined/non-public rows are never served; NULL-mandate turns (PM, guests, unmatched speakers) ARE included. Transcript (fullText) coverage is partial."
    parliamentSpeeches(
      filter: ParliamentSpeechesFilter
      "Free-text substring (case-insensitive, diacritic-sensitive) over title + summary + (depth permitting) the verbatim transcript. Part of the cursor identity: a cursor minted under one q cannot replay under another."
      q: String
      first: Int
      after: String
    ): ParliamentSpeechConnection
    "Global per-day speech activity for one calendar year (drives the stenograme heatmap). Same filter + q semantics as parliamentSpeeches, EXCEPT: a spokenAt inside filter is rejected (the year argument bounds the range), and q runs at FULL_TEXT depth only under EXACTLY ONE mandateKey (the year window is wider than the 92-day full-text cap). availableYears is not bounded by the year argument."
    parliamentSpeechActivity(
      year: Int!
      filter: ParliamentSpeechesFilter
      q: String
    ): ParliamentSpeechActivity
    "One speech by key (deep link). Returns null for an unknown key AND for a quarantined/non-public row (never leaks via deep link). fullText resolves lazily; null fullText means the transcript is not loaded yet (partial coverage), not that the speech is empty."
    parliamentSpeech(speechKey: ID!): ParliamentSpeech
    "Canonical stenogram sittings (cursor; keyset sessionDate desc). UNLIKE parliamentSpeeches this needs NO boundedness argument — the table is one row per captured sitting and sessionDate is indexed. filter: chamber / sessionDate range / year / availability / sourceSystem / mandateKey (sittings where that speaker holds a public contribution). q is a FULL-HISTORY search over the canonical transcript search projection: when that projection is unavailable the field returns a SEARCH_UNAVAILABLE error in errors[] (this field null) — it NEVER silently degrades to a title-only or window-bounded match, because that would answer a narrower question while looking like a full answer. Only privacy_class='public' sittings are ever served."
    parliamentStenogramSessions(
      filter: ParliamentStenogramSessionsFilter
      "Free-text search over the whole canonical transcript history. Part of the cursor identity: a cursor minted under one q cannot replay under another."
      q: String
      first: Int
      after: String
    ): ParliamentStenogramSessionConnection
    "One sitting plus its ordered PUBLIC reading and its previous/next sitting. Typed errors in errors[] (this field null): NOT_FOUND (no such sitting, or non-public) and TRANSCRIPT_UNAVAILABLE (the sitting is real but yields no reading — a SOURCE_ONLY capture, no public blocks, or the canonical projection is not deployed here). A TRANSCRIPT_UNAVAILABLE error carries extensions.session (sessionKey/title/chamber/sessionDate/sourceUrl/sourceUrlKind) whenever the sitting is held, so a client can still offer the official-transcript action without a second request. segments is a bounded slice ordered by position; page it with offset/limit and read totalSegments for the full count. GET /api/v1/parliament/stenograms/:sessionKey/transcript returns the COMPLETE reading in one response."
    parliamentStenogramSession(
      sessionKey: ID!
      "0-based block offset in the printed order (default 0)."
      offset: Int
      "Blocks per read (default 500, max 2000)."
      limit: Int
    ): ParliamentStenogramTranscript
    "Canonical context for a contribution: the reading block, its sitting, and the previous/next CONTRIBUTION. Accepts a canonical 'canon:' key OR a LEGACY 'cdep:'/'senat:' key, which is resolved through parliament.speech_redirects — so an old deep link reaches the canonical reading. Returns null (never an error) when the key is unknown or the canonical lane has not mapped it yet."
    parliamentSpeechContext(speechKey: ID!): ParliamentSpeechContext
    "Marquee: act → bills → final votes → ballots. roles default to final_adoption,final_rejection; pass specific roles (e.g. [amendment, procedural]) or roles:[all] to widen to every linked vote. bill.voteLinks is UNFILTERED, so by default the two views differ — lineage.caveats reports how many non-default linked votes were omitted so they reconcile."
    parliamentActLineage(
      actId: ID!
      roles: [String!]
      includeBallots: Boolean
    ): ParliamentActLineage
    "Party cohesion over a bounded vote set (billKey OR chamber+from+to; hard-cap 500 votes — a wider window returns an INVALID_INPUT error in errors[], the field itself null)."
    parliamentVoteCohesion(
      billKey: ID
      chamber: ParliamentChamber
      from: Date
      to: Date
      group: String
    ): [ParliamentGroupCohesion!]
    "Resolve a free-text query to a filter value (group/person/constituency/recipient/control_type/outcome/chamber)."
    parliamentResolveFilter(
      dim: ParliamentFilterDim!
      q: String!
      legislature: String
    ): [ParliamentResolveHit!]
    "Person-identity review queue (API-key gated; lean projection — no evidence/method)."
    parliamentPersonCandidates(
      status: String
      page: Int
      pageSize: Int
    ): ParliamentPersonCandidatePage
    "Loader/data freshness: the newest vote date + the last load timestamp (B4)."
    parliamentDataFreshness: ParliamentDataFreshness
    "Committees (cursor; optional chamber = camera_deputatilor|senat, legislature). Ordered by committee key."
    parliamentCommittees(
      chamber: String
      legislature: String
      first: Int
      after: String
    ): ParliamentCommitteeConnection
    "One committee's detail: roster + linked bills + meetings count (B2)."
    parliamentCommittee(committeeKey: ID!): ParliamentCommitteeDetail
  }

  extend type Entity {
    "Control items addressed to this entity (gated until recipient→CUI; resolves null today)."
    parliamentControls: ParliamentControlSummary
  }
`;

export const parliamentTypeDefs = `${objectsAndQuery}\n\n${votesFilter}\n\n${memberVotesFilter}\n\n${memberSpeechesFilter}\n\n${speechesFilter}\n\n${stenogramSessionsFilter}\n\n${membersFilter}\n\n${billsFilter}\n\n${controlFilter}`;
