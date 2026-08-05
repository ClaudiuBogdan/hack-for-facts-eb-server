/**
 * Client↔server contract guard for the parliament BILL, VOTE and STENOGRAM
 * documents (no DB).
 *
 * The transparenta.eu client ships hand-written GraphQL documents — there is no
 * codegen in that repo — and they are the real consumers of this module's SDL.
 * They live in another repository, so a renamed field or a tightened
 * nullability here would surface only at runtime, in a browser.
 *
 * And it would not surface gently: a document naming a field the schema does
 * not define fails VALIDATION, which 400s the WHOLE query. The bill page does
 * not lose a line, it goes blank. That asymmetry is why this guard exists as a
 * unit test rather than as something we notice in review.
 *
 * The documents below are VERBATIM copies of
 * `src/features/parliament/api/graphql/parliament-queries.ts` (the AI-metadata
 * fragment interpolated), kept in sync deliberately. A failure here means the
 * deployed client would break against this server — ship the SDL change first,
 * or ship both together.
 */

import { buildSchema, parse, validate } from 'graphql';
import { describe, expect, it } from 'vitest';

import { parliamentTypeDefs } from '@/modules/parliament/shell/graphql/typedefs.js';

const KERNEL_STUBS = `
  scalar Date
  scalar DateTime
  scalar BigInt
  scalar JSON
  type PageInfo { hasNextPage: Boolean!  endCursor: String }
  type Entity { cui: String! }
  type Query { _root: Boolean }
`;

const schema = buildSchema(`${KERNEL_STUBS}\n${parliamentTypeDefs}`);

const errorsFor = (document: string): readonly string[] =>
  validate(schema, parse(document)).map((e) => e.message);

/** Verbatim from the client's parliament-queries.ts (PARLIAMENT_BILLS_QUERY). */
const CLIENT_BILLS_QUERY = `

  query ParliamentBills(
    $filter: ParliamentBillsFilter
    $sort: ParliamentBillSort
    $page: Int
    $pageSize: Int
  ) {
    parliamentBills(
      filter: $filter
      sort: $sort
      page: $page
      pageSize: $pageSize
    ) {
      total
      totalEstimated
      bills {
        billKey
        plxNumber
        plxYear
        senateNumber
        senateYear
        title
        finalLawNumber
        finalLawYear
        statusText
        billType
        lastEventDate
        # The two prose fields the list can afford. lastEventDescription says
        # WHAT the last move was (the list already sorts by WHEN); the object of
        # regulation is the bill's own statement of what it does. Both are rare
        # enough that the row must read correctly without either.
        lastEventDescription
        objectOfRegulation
        # DERIVED classification — preferred over the client's title-prefix
        # heuristic wherever present. See classifyBillType.
        initiatorType
      }
    }
  }
`;

/** Verbatim from the client's parliament-queries.ts (PARLIAMENT_BILL_QUERY). */
const CLIENT_BILL_QUERY = `

  query ParliamentBill($billKey: ID!) {
    parliamentBill(billKey: $billKey) {
      billKey
      plxNumber
      plxYear
      senateNumber
      senateYear
      title
      finalLawNumber
      finalLawYear
      statusText
      billType
      lastEventDate
      lastEventDescription
      objectOfRegulation
      initiatorType
      # ── How the bill is being handled (attrs.procedure) ──────────────────
      # decisionChamber says which chamber casts the final, unappealable vote
      # (art. 75) — the single fact that says where the bill's fate is decided.
      # OPEN STRING: 11 rows carry parser-welded prose, so the client matches a
      # known vocabulary before it renders one.
      decisionChamber
      lawCharacter
      # TRI-STATE: true (4,697) / false (16,051) / null (21,242 with no
      # procedure block at all). Null must never be shown as "not urgent".
      procedureUrgency
      procedureRegime
      # ── Timeline bounds + provenance ────────────────────────────────────
      firstEventDate
      lastEventSource
      sourceUpdatedAt
      # ── The four human-openable source pages ────────────────────────────
      cdepProjectUrl
      senateDetailUrl
      senateFileUrl
      senateOpinionsUrl
      # ── Cross-source identifiers ────────────────────────────────────────
      senateCod
      governmentENumber
      governmentEYear
      # DERIVED BY US, never printed by the chamber — rendered as our
      # classification with the rule that produced it, never as a source fact.
      initiatorTypeConfidence
      initiatorTypeMethod
      dossierBillKeys
      events {
        sourceBillKey position eventDate eventDateText description chamberCode committee voteIdv docs
        rowKind parentPosition stepKind actorKind
        links { linkKind targetKey sourceHref sourceText resolutionStatus }
      }
      documents { sourceBillKey url label kind position }
      initiators { mandateKey fullName groupName }
      relatedVotes {
        voteKey
        chamber
        voteDate
        # What the chamber voted ON. The title field here is the BILL's title on
        # every one of these rows, so without this the cards cannot be told apart.
        voteSubject
        title
        outcome
        divisionNumber
        sourceUrl
        tally { pentru impotriva abtinere nuAVotat present }
      }
      # The ROLE-BEARING edge (bill_vote_links.role). Only an explicit
      # 'final_adoption' / 'final_rejection' role proves a vote was the final one
      # — chronological order does not.
      voteLinks {
        voteKey
        role
        resolutionStatus
      }
      actLinks {
        relationshipKind
        resolutionStatus
        confidenceLabel
        legalAct { actId title actType }
      }
      aiMetadata { 
  summary topic domains keywords valueClass
  configKey promptVersion schemaVersion model
  validationStatus confidence sourceUpdatedAt loadedAt
  privacyClass trustClass disclaimer
 }
    }
  }
`;

/** Verbatim from the client's parliament-queries.ts (PARLIAMENT_VOTE_QUERY). */
const CLIENT_VOTE_QUERY = `

  query ParliamentVote($voteKey: ID!, $ballotsFirst: Int, $after: String) {
    parliamentVote(voteKey: $voteKey) {
      voteKey
      chamber
      voteDate
      # The clock time the chamber PRINTED against this division ("20.12.2023
      # 16:16"), on all 14,158 CDep + joint divisions and none of the 6,702
      # Senate ones. voteDate is a DATE column parsed OUT of this string, so it
      # carries no time at all — this is the only place the hour exists.
      voteDateTimeText
      voteSubject
      kind
      title
      outcome
      divisionNumber
      billKey
      sourceUrl
      # The ROLE-BEARING edges of THIS division. billKey holds at most one bill
      # and no role at all; role is the only field that says what the division
      # was procedurally for. It names the MOTION, not the result — the verdict
      # is role composed with outcome.
      voteLinks {
        billKey
        role
        resolutionStatus
        bill {
          billKey
          title
          plxNumber
          plxYear
          senateNumber
          senateYear
        }
      }
      tally {
        pentru
        impotriva
        abtinere
        nuAVotat
        present
      }
      groupBreakdown {
        groupName
        pentru
        impotriva
        abtinere
        nuAVotat
        conflicting
        unknown
      }
      ballots(first: $ballotsFirst, after: $after) {
        edges {
          node {
            positionKey
            rowIndex
            memberName
            groupName
            choice
            positionStatus
            observationCount
            observedChoices
            mandateKey
            matchMethod
            constituencyName
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
`;

describe('the client bill/vote documents validate against this SDL', () => {
  it('accepts the bills LIST document', () => {
    expect(errorsFor(CLIENT_BILLS_QUERY)).toEqual([]);
  });

  it('accepts the bill DETAIL document', () => {
    expect(errorsFor(CLIENT_BILL_QUERY)).toEqual([]);
  });

  it('accepts the vote DETAIL document', () => {
    expect(errorsFor(CLIENT_VOTE_QUERY)).toEqual([]);
  });

  it('the guard actually fires on a field this schema does not define', () => {
    // Positive control. Without this, a validate() that silently stopped
    // reporting — or a schema stub that accidentally allowed anything — would
    // leave the three assertions above passing while protecting nothing.
    const errors = errorsFor(`
      query Bad {
        parliamentBill(billKey: "1") { billKey fieldThatDoesNotExist }
      }
    `);
    expect(errors).not.toEqual([]);
    expect(errors.join(' ')).toContain('fieldThatDoesNotExist');
  });
});

/** Verbatim from the client's parliament-stenograms-queries.ts (PARLIAMENT_STENOGRAM_SESSIONS_QUERY). */
const CLIENT_STENOGRAM_SESSIONS_QUERY = `

  query ParliamentStenogramSessions(
    $first: Int
    $after: String
    $filter: ParliamentStenogramSessionsFilter
    $q: String
  ) {
    parliamentStenogramSessions(
      first: $first
      after: $after
      filter: $filter
      q: $q
    ) {
      total
      totalEstimated
      edges {
        cursor
        node { 
  sessionKey
  chamber
  sessionDate
  sessionDateSource
  title
  sourceSystem
  availability
  sourceUrl
  sourceUrlKind
  sittingKey
  presidingText
  startTimeText
  endTimeText
  segmentCount
  speechCount
  speakerCount
  sourceUpdatedAt
  canonicalDigest
  captureDigest
 }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

/** Verbatim from the client's parliament-stenograms-queries.ts (PARLIAMENT_STENOGRAM_SESSION_QUERY). */
const CLIENT_STENOGRAM_SESSION_QUERY = `

  query ParliamentStenogramSession(
    $sessionKey: ID!
    $offset: Int
    $limit: Int
  ) {
    parliamentStenogramSession(
      sessionKey: $sessionKey
      offset: $offset
      limit: $limit
    ) {
      totalSegments
      session { 
  sessionKey
  chamber
  sessionDate
  sessionDateSource
  title
  sourceSystem
  availability
  sourceUrl
  sourceUrlKind
  sittingKey
  presidingText
  startTimeText
  endTimeText
  segmentCount
  speechCount
  speakerCount
  sourceUpdatedAt
  canonicalDigest
  captureDigest
 }
      segments { 
  segmentKey
  sessionKey
  position
  kind
  text
  textChars
  speakerName
  speakerRef
  mandateKey
  speechKey
  agendaRef
  sourceUrl
  sourceUrlKind
  personId
  speakerResolution
  speakerMethod
  speakerConfidence
 }
      navigation {
        previous { 
  sessionKey
  chamber
  sessionDate
  title
  availability
  sourceUrl
  sourceUrlKind
 }
        next { 
  sessionKey
  chamber
  sessionDate
  title
  availability
  sourceUrl
  sourceUrlKind
 }
      }
    }
  }
`;

/** Verbatim from the client's parliament-stenograms-queries.ts (PARLIAMENT_SPEECH_CONTEXT_QUERY). */
const CLIENT_SPEECH_CONTEXT_QUERY = `

  query ParliamentSpeechContext($speechKey: ID!) {
    parliamentSpeechContext(speechKey: $speechKey) {
      speechKey
      session { 
  sessionKey
  chamber
  sessionDate
  sessionDateSource
  title
  sourceSystem
  availability
  sourceUrl
  sourceUrlKind
  sittingKey
  presidingText
  startTimeText
  endTimeText
  segmentCount
  speechCount
  speakerCount
  sourceUpdatedAt
  canonicalDigest
  captureDigest
 }
      segment { 
  segmentKey
  sessionKey
  position
  kind
  text
  textChars
  speakerName
  speakerRef
  mandateKey
  speechKey
  agendaRef
  sourceUrl
  sourceUrlKind
  personId
  speakerResolution
  speakerMethod
  speakerConfidence
 }
      previousContribution { 
  segmentKey
  sessionKey
  position
  kind
  text
  textChars
  speakerName
  speakerRef
  mandateKey
  speechKey
  agendaRef
  sourceUrl
  sourceUrlKind
  personId
  speakerResolution
  speakerMethod
  speakerConfidence
 }
      nextContribution { 
  segmentKey
  sessionKey
  position
  kind
  text
  textChars
  speakerName
  speakerRef
  mandateKey
  speechKey
  agendaRef
  sourceUrl
  sourceUrlKind
  personId
  speakerResolution
  speakerMethod
  speakerConfidence
 }
      redirect {
        legacySpeechKey
        sessionKey
        canonicalSpeechKey
        canonicalSegmentKey
        canonicalPosition
        mappingKind
        matchMethod
      }
    }
  }
`;

describe('the client stenogram documents validate against this SDL', () => {
  /*
   * These exist because of a real regression, not a hypothetical one.
   *
   * The commit that added `sourceUpdatedAt` to `ParliamentBill` DELETED the
   * field of the same name from `ParliamentStenogramSession` — collateral from
   * a whole-file regex used while mutation-testing the guard above, where only
   * the bill occurrence was put back. The bill and vote documents still
   * validated, typecheck passed, and all 487 unit tests passed, because nothing
   * covered the stenogram document. The stenogram reader would have gone blank
   * on deploy, in exactly the way this file exists to prevent.
   *
   * A guard over three of a client's documents proves nothing about the fourth.
   */
  it('accepts the sessions LIST document', () => {
    expect(errorsFor(CLIENT_STENOGRAM_SESSIONS_QUERY)).toEqual([]);
  });

  it('accepts the single SESSION document', () => {
    expect(errorsFor(CLIENT_STENOGRAM_SESSION_QUERY)).toEqual([]);
  });

  it('accepts the speech-CONTEXT document', () => {
    expect(errorsFor(CLIENT_SPEECH_CONTEXT_QUERY)).toEqual([]);
  });

  it('covers the field whose loss started this', () => {
    // Pins the specific selection, so a future edit cannot quietly drop the
    // stenogram field again and still pass the three checks above.
    expect(CLIENT_STENOGRAM_SESSION_QUERY).toContain('sourceUpdatedAt');
  });
});
