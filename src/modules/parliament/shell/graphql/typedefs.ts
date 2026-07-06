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
  membersFilterSpec,
  votesFilterSpec,
} from '../filters/specs.js';

const votesFilter = toGraphQLInput(votesFilterSpec);
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
    motion
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
    activityCounts: ParliamentActivityCounts!
    votes(first: Int, after: String): ParliamentMemberVoteConnection!
    controlItems(page: Int, pageSize: Int): ParliamentControlItemPage!
    speeches(page: Int, pageSize: Int): ParliamentSpeechPage!
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

  type ParliamentBillEvent {
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
    "RAW source status string (CDEP/Senate status_text, e.g. 'Lege 423/2023 …', 'respins'). May contain glued tokens/typos on the cdep side — use the 'status' FILTER (promulgated/rejected/in_progress) for the normalized lifecycle signal (M11)."
    statusText: String
    "RAW source initiative type (procedure.tip_initiativa, e.g. 'Proiect de Lege …' / 'Propunere legislativa …'). The billType FILTER buckets this by prefix into government/parliamentary; senat bills carry no procedure block, so the field is null and they match NEITHER bucket (M4). null when the source has no procedure block."
    billType: String
    "Date of the most recent timeline event (attrs.last_event_date). This is the key the default 'updated_desc' sort uses — exposed so the client can show/verify recency."
    lastEventDate: Date
    "B1 canonicality (§3): true = this bill is in the default-visible set. A bicameral bill is stored under both chambers' keys; the suppressed Senate navetă twin is NON-canonical and EXCLUDED from the default bill list. A deep link to a non-canonical key still resolves via parliamentBill — read canonicalBillKey to notice/redirect to the canonical view."
    isCanonical: Boolean!
    "On a non-canonical (suppressed) twin, the canonical CDep bill_key to redirect to; null on a canonical bill."
    canonicalBillKey: String
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
    "Votes (cursor; default voteDate desc). vote_records are NEVER listed flat here."
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

export const parliamentTypeDefs = `${objectsAndQuery}\n\n${votesFilter}\n\n${membersFilter}\n\n${billsFilter}\n\n${controlFilter}`;
