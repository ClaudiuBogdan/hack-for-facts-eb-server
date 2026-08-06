/**
 * Parliament SDL wiring guard (no DB). The typedefs slice is a plain string merged
 * by the kernel; a syntax error or a dangling type reference only surfaces at app
 * boot / the live golden suite. This builds the parliament SDL against minimal
 * kernel stubs so the new B1–B4 types + roots are caught in CI-without-DB.
 */

import { buildSchema, parse } from 'graphql';
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

describe('parliament SDL — builds with the new B1–B4 surface', () => {
  it('is syntactically valid', () => {
    expect(() => parse(parliamentTypeDefs)).not.toThrow();
  });

  const schema = buildSchema(`${KERNEL_STUBS}\n${parliamentTypeDefs}`);

  it('declares the new object types (B1 AI, B2 committees, B4 freshness)', () => {
    for (const name of [
      'ParliamentAiBillMetadata',
      'ParliamentAiControlItemMetadata',
      'ParliamentCommittee',
      'ParliamentCommitteeMembership',
      'ParliamentCommitteeDetail',
      'ParliamentCommitteeConnection',
      'ParliamentDataFreshness',
    ]) {
      expect(schema.getType(name), name).toBeDefined();
    }
  });

  it('exposes the new query roots', () => {
    const q = schema.getQueryType()?.getFields() ?? {};
    expect(q['parliamentCommittees']).toBeDefined();
    expect(q['parliamentCommittee']).toBeDefined();
    expect(q['parliamentDataFreshness']).toBeDefined();
  });

  it('adds the new member fields (B3 cvPdfUrl, B2 committeeMemberships) and aiMetadata edges', () => {
    const member = schema.getType('ParliamentMember');
    const memberFields =
      member !== undefined && member !== null && 'getFields' in member ? member.getFields() : {};
    expect(memberFields['cvPdfUrl']).toBeDefined();
    expect(memberFields['committeeMemberships']).toBeDefined();
    const bill = schema.getType('ParliamentBill');
    const billFields =
      bill !== undefined && bill !== null && 'getFields' in bill ? bill.getFields() : {};
    expect(billFields['aiMetadata']).toBeDefined();
    const control = schema.getType('ParliamentControlItem');
    const controlFields =
      control !== undefined && control !== null && 'getFields' in control
        ? control.getFields()
        : {};
    expect(controlFields['aiMetadata']).toBeDefined();
  });

  it('declares the member-vote activity types + a member voteActivity field, and the filtered votes arg', () => {
    expect(schema.getType('ParliamentMemberVoteActivity')).toBeDefined();
    expect(schema.getType('ParliamentMemberVoteActivityDay')).toBeDefined();
    expect(schema.getType('ParliamentMemberVotesFilter')).toBeDefined();
    const member = schema.getType('ParliamentMember');
    const memberFields =
      member !== undefined && member !== null && 'getFields' in member ? member.getFields() : {};
    expect(memberFields['voteActivity']).toBeDefined();
    // the votes connection gained a filter arg (additive).
    const votesField = memberFields['votes'];
    const votesArgs =
      votesField !== undefined && 'args' in votesField ? votesField.args.map((a) => a.name) : [];
    expect(votesArgs).toContain('filter');
  });

  it('declares the member-speech connection + activity types, the speechesConnection/speechActivity fields, and ParliamentSpeech.fullText', () => {
    expect(schema.getType('ParliamentMemberSpeechConnection')).toBeDefined();
    expect(schema.getType('ParliamentMemberSpeechEdge')).toBeDefined();
    expect(schema.getType('ParliamentMemberSpeechActivity')).toBeDefined();
    expect(schema.getType('ParliamentMemberSpeechActivityDay')).toBeDefined();
    expect(schema.getType('ParliamentMemberSpeechesFilter')).toBeDefined();
    const member = schema.getType('ParliamentMember');
    const memberFields =
      member !== undefined && member !== null && 'getFields' in member ? member.getFields() : {};
    // the legacy offset field stays; the new cursor + activity fields are additive.
    expect(memberFields['speeches']).toBeDefined();
    expect(memberFields['speechesConnection']).toBeDefined();
    expect(memberFields['speechActivity']).toBeDefined();
    const connField = memberFields['speechesConnection'];
    const connArgs =
      connField !== undefined && 'args' in connField ? connField.args.map((a) => a.name) : [];
    for (const arg of ['first', 'after', 'filter', 'q']) expect(connArgs).toContain(arg);
    // ParliamentSpeech gained the source-trace + verbatim-text fields.
    const speech = schema.getType('ParliamentSpeech');
    const speechFields =
      speech !== undefined && speech !== null && 'getFields' in speech ? speech.getFields() : {};
    for (const name of ['sourceUrl', 'sourceUrlKind', 'fullText'])
      expect(speechFields[name]).toBeDefined();
  });

  it('declares the canonical stenogram types + roots, and keeps the legacy speech surface intact', () => {
    for (const name of [
      'ParliamentStenogramSession',
      'ParliamentStenogramSegment',
      'ParliamentStenogramTranscript',
      'ParliamentStenogramSessionConnection',
      'ParliamentStenogramSessionEdge',
      'ParliamentSpeechContext',
      'ParliamentSpeechRedirect',
      'ParliamentStenogramAvailability',
      'ParliamentStenogramSegmentKind',
      'ParliamentStenogramSessionsFilter',
      'ParliamentStenogramSessionRef',
      'ParliamentSittingNavigation',
    ]) {
      expect(schema.getType(name), name).toBeDefined();
    }

    const q = schema.getQueryType()?.getFields() ?? {};
    for (const root of [
      'parliamentStenogramSessions',
      'parliamentStenogramSession',
      'parliamentSpeechContext',
    ]) {
      expect(q[root], root).toBeDefined();
    }
    // The pre-existing speech roots are UNTOUCHED (the old contract is preserved).
    for (const root of ['parliamentSpeeches', 'parliamentSpeech', 'parliamentSpeechActivity']) {
      expect(q[root], root).toBeDefined();
    }

    // The sessions search takes a full-history `q` alongside the filter + cursor args.
    const sessions = q['parliamentStenogramSessions'];
    const sessionArgs =
      sessions !== undefined && 'args' in sessions ? sessions.args.map((a) => a.name) : [];
    for (const arg of ['filter', 'q', 'first', 'after']) expect(sessionArgs).toContain(arg);

    // The transcript read is sliceable, so a large sitting can be paged.
    const transcript = q['parliamentStenogramSession'];
    const transcriptArgs =
      transcript !== undefined && 'args' in transcript ? transcript.args.map((a) => a.name) : [];
    for (const arg of ['sessionKey', 'offset', 'limit']) expect(transcriptArgs).toContain(arg);
  });

  it('the transcript carries non-null sitting navigation, and the session carries its digests', () => {
    const transcript = schema.getType('ParliamentStenogramTranscript');
    const fields =
      transcript !== undefined && transcript !== null && 'getFields' in transcript
        ? transcript.getFields()
        : {};
    // Non-null: a sitting always HAS a navigation answer, even when both ends are null.
    expect(String(fields['navigation']?.type)).toBe('ParliamentSittingNavigation!');

    const session = schema.getType('ParliamentStenogramSession');
    const sessionFields =
      session !== undefined && session !== null && 'getFields' in session
        ? session.getFields()
        : {};
    // canonicalDigest is NOT NULL in the migration; captureDigest is null for SOURCE_ONLY.
    expect(String(sessionFields['canonicalDigest']?.type)).toBe('String!');
    expect(String(sessionFields['captureDigest']?.type)).toBe('String');

    // A nav target is a label plus a destination — and its source URL/precision are
    // non-null, because the migration makes a session without a terminator impossible.
    const ref = schema.getType('ParliamentStenogramSessionRef');
    const refFields =
      ref !== undefined && ref !== null && 'getFields' in ref ? ref.getFields() : {};
    expect(String(refFields['sourceUrl']?.type)).toBe('String!');
    expect(String(refFields['sourceUrlKind']?.type)).toBe('String!');
    // Neighbours themselves ARE nullable (the ends of a chamber's history).
    const nav = schema.getType('ParliamentSittingNavigation');
    const navFields =
      nav !== undefined && nav !== null && 'getFields' in nav ? nav.getFields() : {};
    expect(String(navFields['previous']?.type)).toBe('ParliamentStenogramSessionRef');
    expect(String(navFields['next']?.type)).toBe('ParliamentStenogramSessionRef');
  });

  it('ParliamentSpeech exposes sessionKey + position + isCanonical + context (additive)', () => {
    const speech = schema.getType('ParliamentSpeech');
    const speechFields =
      speech !== undefined && speech !== null && 'getFields' in speech ? speech.getFields() : {};
    for (const name of ['isCanonical', 'sessionKey', 'position', 'context']) {
      expect(speechFields[name], name).toBeDefined();
    }
    // `position` must stay NULLABLE: null means "not a canonical block", and a
    // non-null Int would have to invent 0 for every legacy row.
    expect(String(speechFields['position']?.type)).toBe('Int');
    expect(String(speechFields['sessionKey']?.type)).toBe('ID');
  });

  it('the stenogram session filter surfaces chamber, date, year, availability and speaker', () => {
    const filter = schema.getType('ParliamentStenogramSessionsFilter');
    const fields =
      filter !== undefined && filter !== null && 'getFields' in filter ? filter.getFields() : {};
    for (const name of ['chamber', 'sessionDate', 'year', 'availability', 'mandateKey']) {
      expect(fields[name], name).toBeDefined();
    }
    // `q` is NOT a filter field: it is answered by the canonical search projection,
    // not by a column, so it enters as its own root argument on every surface.
    expect(fields['q']).toBeUndefined();
  });

  it('the committee detail carries roster + linked bills + meetings count', () => {
    const detail = schema.getType('ParliamentCommitteeDetail');
    const fields =
      detail !== undefined && detail !== null && 'getFields' in detail ? detail.getFields() : {};
    for (const name of [
      'members',
      'linkedBills',
      'linkedBillsTotal',
      'meetingsCount',
      'sourceUrl',
    ]) {
      expect(fields[name], name).toBeDefined();
    }
  });

  /**
   * WHERE `documents` IS DECLARED IS THE WHOLE N+1 ARGUMENT.
   *
   * On the DETAIL type it is reachable through exactly one path — Query
   * .parliamentCommittee, one committee per request — so a document read is
   * bounded by construction. On the LIST type `ParliamentCommittee` the same
   * field would fan a 191-row committee page out into 191 keyset reads, and
   * nothing in the resolver could refuse it. The placement IS the bound, so it
   * is asserted rather than left to reviewer memory.
   */
  it('declares documents on the committee DETAIL only, never on the list type', () => {
    for (const name of [
      'ParliamentCommitteeDocument',
      'ParliamentCommitteeDocumentEdge',
      'ParliamentCommitteeDocumentConnection',
    ]) {
      expect(schema.getType(name), name).toBeDefined();
    }

    const detail = schema.getType('ParliamentCommitteeDetail');
    const detailFields =
      detail !== undefined && detail !== null && 'getFields' in detail ? detail.getFields() : {};
    const documents = detailFields['documents'];
    expect(documents).toBeDefined();
    expect(String(documents?.type)).toBe('ParliamentCommitteeDocumentConnection!');
    const args = documents !== undefined && 'args' in documents ? documents.args : [];
    expect(args.map((a) => a.name).sort()).toEqual(['after', 'first']);

    const list = schema.getType('ParliamentCommittee');
    const listFields =
      list !== undefined && list !== null && 'getFields' in list ? list.getFields() : {};
    expect(listFields['documents']).toBeUndefined();
  });

  it('never publishes docTypeRaw in any shape', () => {
    // 2-character CDep codes and ~950-character Senate navigation blobs. The
    // served `docType` is a policy decision built from it; the raw value is not
    // a fact a reader can act on, in any type.
    expect(parliamentTypeDefs).not.toContain('docTypeRaw');
    expect(parliamentTypeDefs).not.toContain('doc_type_raw');
  });
});
