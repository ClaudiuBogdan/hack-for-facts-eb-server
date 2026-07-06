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
});
