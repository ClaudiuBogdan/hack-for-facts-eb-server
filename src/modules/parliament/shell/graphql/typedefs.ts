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
  enum ParliamentChamber { camera_deputatilor senat comun }
  enum ParliamentVoteOutcome { adoptat respins }
  enum ParliamentVoteChoice { pentru impotriva abtinere nu_a_votat }
  enum ParliamentControlType { question interpellation question_or_interpellation motion }
  enum ParliamentPersonConfidence { high medium low }
  enum ParliamentFilterDim { group person constituency recipient control_type outcome chamber }
  enum ParliamentBillSort { updated_desc updated_asc title_asc title_desc }
  "Vote sort. voteDate (default) is chronological. voteKey is a STABLE id order, NOT chronological — senat vote keys are UUIDs that sort lexically; use voteDate for time order."
  enum ParliamentVoteSort { voteDate voteKey }

  type ParliamentGroup {
    groupId: ID!
    "Chamber of this group row. An empty string means a party-level / cross-chamber aggregate (the whole-parliament parliamentGroups list sums a party across both chambers); a non-empty value is a per-chamber group."
    chamber: String!
    name: String!
    memberCount: Int
  }
  type ParliamentGroupInterval {
    groupId: ID!  group: ParliamentGroup  validFrom: Date!  validTo: Date  source: String!  voteCount: Int
  }

  type ParliamentCareerTotals { mandates: Int!  votes: Int!  initiatives: Int!  speeches: Int! }

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
  }

  type ParliamentActivityCounts { votes: Int!  controlItems: Int!  speeches: Int!  initiatives: Int!  declarations: Int! }

  type ParliamentTally { pentru: Int  impotriva: Int  abtinere: Int  nuAVotat: Int  present: Int }

  type ParliamentVoteGroupBreakdown { groupName: String  pentru: Int!  impotriva: Int!  abtinere: Int!  nuAVotat: Int! }

  type ParliamentBallot {
    rowIndex: Int!  memberName: String  groupName: String
    choice: ParliamentVoteChoice  mandateKey: ID  member: ParliamentMember  matchMethod: String
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
    ballots(first: Int, after: String): ParliamentBallotConnection!
  }

  "A member's ballot joined to its vote (the member voting profile row)."
  type ParliamentMemberVote {
    voteKey: ID!  chamber: String!  voteDate: Date  title: String
    outcome: ParliamentVoteOutcome  choice: ParliamentVoteChoice  rowIndex: Int!  billKey: ID
    vote: ParliamentVote
  }

  type ParliamentBillEvent {
    position: Int!  eventDate: Date  eventDateText: String  description: String
    chamberCode: String  committee: String  voteIdv: String  docs: JSON
  }
  type ParliamentBillDocument { url: String!  label: String  kind: String  position: Int }

  "bill↔legal.acts edge. legalAct is resolved by the KERNEL LegalActByIdLoader (§6.7); a dangling target_act_id resolves to null (never an error)."
  type ParliamentBillActLink {
    relationshipKind: String!
    targetActId: ID  targetActType: String  targetActNumber: String  targetActYear: Int
    resolutionStatus: String!  confidenceLabel: String!  primaryMethod: String!
    legalAct: ParliamentLegalActRef
  }
  "The minimal legal-act ref the kernel loader returns (parliament never reads legal.* itself)."
  type ParliamentLegalActRef { actId: ID!  title: String  actType: String }

  type ParliamentBillVoteLink {
    voteKey: ID!  vote: ParliamentVote  billKey: ID
    role: String!  resolutionStatus: String!  confidenceLabel: String!
  }

  type ParliamentBill {
    billKey: ID!
    plxNumber: String  plxYear: Int  senateNumber: String  senateYear: Int
    title: String  finalLawNumber: String  finalLawYear: Int
    "Source-stored current-status string (CDEP/Senate status_text, e.g. 'Lege 423/2023 …', 'respins'). The real status the client derived from title+events."
    statusText: String
    "Source initiative type (procedure.tip_initiativa, e.g. 'Proiect de Lege …' / 'Propunere legislativa …'). null when the source carries no procedure block."
    billType: String
    "Date of the most recent timeline event (attrs.last_event_date). This is the key the default 'updated_desc' sort uses — exposed so the client can show/verify recency."
    lastEventDate: Date
    events: [ParliamentBillEvent!]!
    documents: [ParliamentBillDocument!]!
    initiators: [ParliamentMember!]!
    relatedVotes: [ParliamentVote!]!
    actLinks: [ParliamentBillActLink!]!
    voteLinks: [ParliamentBillVoteLink!]!
  }

  type ParliamentControlItem {
    itemKey: ID!  controlType: ParliamentControlType  controlTypeProvenance: String
    title: String  recipient: String  itemDate: Date  responseStatus: String
    authorName: String  member: ParliamentMember
  }
  type ParliamentSpeech { speechKey: ID!  spokenAt: Date  title: String  summary: String  chamber: String }
  type ParliamentInitiative {
    initiativeKey: ID!  billKey: ID  title: String  status: String
    promulgatedLawNumber: String  promulgatedLawYear: Int  bill: ParliamentBill
    "Registration date (parsed from registration_date_text). null for ~4.3% date-less legacy rows. The member-initiatives list is ordered by this DESC (newest first)."
    registrationDate: Date
  }
  "Declaration metadata ONLY — no file_hash, no content (§2.6)."
  type ParliamentDeclarationMeta { declarationType: String!  declarationDate: Date  label: String  fileUrl: String! }

  "Marquee: act → bills → final votes → ballots. caveats flag era/coverage limits — never a silent empty."
  type ParliamentActLineage {
    actId: ID!
    bills: [ParliamentBill!]!
    votes: [ParliamentLineageVote!]!
    caveats: [String!]!
  }
  type ParliamentLineageVote {
    voteKey: ID!  billKey: ID  chamber: String!  voteDate: Date  role: String!  outcome: ParliamentVoteOutcome
    resolutionStatus: String!  confidenceLabel: String!  tally: ParliamentTally!
    ballotsTotal: Int  ballotsResolved: Int
  }

  type ParliamentGroupCohesion {
    groupName: String!  forPct: Float!  againstPct: Float!  abstainPct: Float!  absentPct: Float!
    cohesionIndex: Float!  voteCount: Int!
  }

  type ParliamentResolveHit { dim: ParliamentFilterDim!  value: String!  label: String!  kind: String!  score: Float }

  "Person-identity review queue — lean projection (NO evidence/method internals, §2.6). API-key gated surface."
  type ParliamentPersonCandidate { mandateKey: ID!  personId: ID  status: String! }
  type ParliamentPersonCandidatePage { candidates: [ParliamentPersonCandidate!]!  total: Int!  totalEstimated: Boolean! }

  "Institutional Entity-360 slice — gated until recipient→CUI canonicalization; resolves null today (§4, §6.3)."
  type ParliamentControlSummary { controlItemCount: Int!  lastItemDate: Date  topRecipient: String }

  # ── pages / connections ──────────────────────────────────────────────────────
  type ParliamentMemberPage { members: [ParliamentMember!]!  total: Int!  totalEstimated: Boolean! }
  type ParliamentBillPage { bills: [ParliamentBill!]!  total: Int!  totalEstimated: Boolean! }
  type ParliamentControlItemPage { items: [ParliamentControlItem!]!  total: Int!  totalEstimated: Boolean! }
  type ParliamentSpeechPage { speeches: [ParliamentSpeech!]!  total: Int!  totalEstimated: Boolean! }
  type ParliamentInitiativePage { initiatives: [ParliamentInitiative!]!  total: Int!  totalEstimated: Boolean! }

  type ParliamentVoteEdge { node: ParliamentVote!  cursor: String! }
  type ParliamentVoteConnection { edges: [ParliamentVoteEdge!]!  pageInfo: PageInfo! }
  type ParliamentBallotEdge { node: ParliamentBallot!  cursor: String! }
  "Ballots for ONE vote (parented by vote_key; low hundreds). The 4.13M table is never scanned flat."
  type ParliamentBallotConnection { edges: [ParliamentBallotEdge!]!  pageInfo: PageInfo! }
  type ParliamentMemberVoteEdge { node: ParliamentMemberVote!  cursor: String! }
  "A member's voting record (parented by mandate_key; bounded set). total is an EXACT count over the member slice."
  type ParliamentMemberVoteConnection { edges: [ParliamentMemberVoteEdge!]!  pageInfo: PageInfo!  total: Int! }
  type ParliamentControlItemEdge { node: ParliamentControlItem!  cursor: String! }
  type ParliamentControlItemConnection { edges: [ParliamentControlItemEdge!]!  pageInfo: PageInfo! }

  extend type Query {
    "Members of a legislature (default = latest). Offset page bounded by legislature."
    parliamentMembers(filter: ParliamentMembersFilter, page: Int, pageSize: Int): ParliamentMemberPage!
    parliamentMember(mandateKey: ID!): ParliamentMember
    "Cross-mandate person career (all mandates, group history, career totals)."
    parliamentPerson(personId: ID!): ParliamentPerson
    "Group composition counts. current:true (SC-1) = currently-seated only (e.g. camera 330 / senat 134); omit/false = all-mandate counts (335 / 137)."
    parliamentGroups(legislature: String, chamber: String, current: Boolean): [ParliamentGroup!]!
    "Roster for a group. groupId accepts EITHER a per-chamber group_id slug (from the chamber-scoped parliamentGroups list) OR a party-level group_name (from the whole-parliament list, whose groupId is the chamber-agnostic party name) — both resolve. Each member carries its own chamber, so the client buckets a party-level roster by chamber. current:true (SC-1) = currently-seated roster only."
    parliamentGroupMembers(groupId: ID!, legislature: String, current: Boolean): [ParliamentMember!]!
    parliamentBills(filter: ParliamentBillsFilter, sort: ParliamentBillSort, page: Int, pageSize: Int): ParliamentBillPage!
    parliamentBill(billKey: ID!): ParliamentBill
    "Votes (cursor; default voteDate desc). vote_records are NEVER listed flat here."
    parliamentVotes(filter: ParliamentVotesFilter, sort: ParliamentVoteSort, first: Int, after: String): ParliamentVoteConnection!
    parliamentVote(voteKey: ID!): ParliamentVote
    "Standalone control-items list (cursor; REQUIRES a date window or recipient/author bound)."
    parliamentControlItems(filter: ParliamentControlItemsFilter, first: Int, after: String): ParliamentControlItemConnection!
    "Marquee: act → bills → final votes → ballots. roles default final_adoption,final_rejection."
    parliamentActLineage(actId: ID!, roles: [String!], includeBallots: Boolean): ParliamentActLineage
    "Party cohesion over a bounded vote set (billKey OR chamber+from+to; hard-cap 500 votes)."
    parliamentVoteCohesion(billKey: ID, chamber: ParliamentChamber, from: Date, to: Date, group: String): [ParliamentGroupCohesion!]!
    "Resolve a free-text query to a filter value (group/person/constituency/recipient/control_type/outcome/chamber)."
    parliamentResolveFilter(dim: ParliamentFilterDim!, q: String!, legislature: String): [ParliamentResolveHit!]!
    "Person-identity review queue (API-key gated; lean projection — no evidence/method)."
    parliamentPersonCandidates(status: String, page: Int, pageSize: Int): ParliamentPersonCandidatePage!
  }

  extend type Entity {
    "Control items addressed to this entity (gated until recipient→CUI; resolves null today)."
    parliamentControls: ParliamentControlSummary
  }
`;

export const parliamentTypeDefs = `${objectsAndQuery}\n\n${votesFilter}\n\n${membersFilter}\n\n${billsFilter}\n\n${controlFilter}`;
