/**
 * Parliament unit tests — filter specs (kernel derivation + virtual-field skip)
 * and the cursor envelope (fhash mismatch → InvalidInput). These guard the
 * tri-surface contract: one spec → GraphQL input + SQL conditions + a stable hash.
 */

import { describe, expect, it } from 'vitest';

import {
  billsFilterSpec,
  controlItemsFilterSpec,
  memberVotesFhash,
  memberVotesFilterSpec,
  membersFilterSpec,
  votesFilterSpec,
} from '@/modules/parliament/index.js';
import {
  BILLS_VIRTUAL_FIELDS,
  CONTROL_VIRTUAL_FIELDS,
  MEMBERS_VIRTUAL_FIELDS,
  VOTES_VIRTUAL_FIELDS,
} from '@/modules/parliament/shell/filters/specs.js';
import {
  buildNextCursor,
  decodeCursor,
  fhashFor,
  filterHash,
  toConditionBuilders,
  toGraphQLInput,
} from '@/modules/shared/index.js';

describe('filter specs — virtual fields are declared and skipped by the SQL composer', () => {
  it('every spec marks its repo-intercepted fields virtual:true', () => {
    const virtualNames = (spec: typeof votesFilterSpec): string[] =>
      spec.fields
        .filter((f) => f.virtual === true)
        .map((f) => f.name)
        .sort();
    expect(virtualNames(votesFilterSpec)).toEqual([...VOTES_VIRTUAL_FIELDS].sort());
    expect(virtualNames(membersFilterSpec)).toEqual([...MEMBERS_VIRTUAL_FIELDS].sort());
    expect(virtualNames(billsFilterSpec)).toEqual([...BILLS_VIRTUAL_FIELDS].sort());
    expect(virtualNames(controlItemsFilterSpec)).toEqual([...CONTROL_VIRTUAL_FIELDS].sort());
  });

  it('toConditionBuilders SKIPS a virtual field (no SQL emitted for `q`)', () => {
    const r = toConditionBuilders(votesFilterSpec, { q: { contains: 'lege' } });
    expect(r.isOk()).toBe(true);
    if (r.isOk()) expect(r.value).toHaveLength(0); // virtual → no condition
  });

  it('toConditionBuilders compiles a NON-virtual field (chamber → one condition)', () => {
    const r = toConditionBuilders(votesFilterSpec, { chamber: { eq: 'senat' } });
    expect(r.isOk()).toBe(true);
    if (r.isOk()) expect(r.value).toHaveLength(1);
  });

  it('rejects an out-of-enum chamber value', () => {
    const r = toConditionBuilders(votesFilterSpec, { chamber: { eq: 'bundestag' } });
    expect(r.isErr()).toBe(true);
  });

  it('derives a GraphQL input block per collection (mirrors the spec)', () => {
    const sdl = toGraphQLInput(votesFilterSpec);
    expect(sdl).toContain('input ParliamentVotesFilter');
    expect(sdl).toContain('chamber:');
    expect(sdl).toContain('outcome:');
    // bills year is virtual but STILL surfaces in the GraphQL input (documentation).
    expect(toGraphQLInput(billsFilterSpec)).toContain('year:');
  });
});

describe('cursor envelope — parent/filter binding (Codex BLOCKER #2)', () => {
  it('round-trips a votes cursor under the SAME filter', () => {
    const filter = { chamber: { eq: 'senat' } };
    const fhash = fhashFor(votesFilterSpec, filter);
    const cursor = buildNextCursor({
      sort: 'voteDate',
      dir: 'desc',
      fhash,
      lastKeys: ['2022-05-04', 'cdep:29892'],
    });
    const dec = decodeCursor(cursor, { sort: 'voteDate', dir: 'desc', fhash });
    expect(dec.isOk()).toBe(true);
    if (dec.isOk()) expect(dec.value.keys).toEqual(['2022-05-04', 'cdep:29892']);
  });

  it('rejects a cursor decoded under a DIFFERENT filter (fhash mismatch)', () => {
    const fhashA = fhashFor(votesFilterSpec, { chamber: { eq: 'senat' } });
    const fhashB = fhashFor(votesFilterSpec, { chamber: { eq: 'camera_deputatilor' } });
    expect(fhashA).not.toEqual(fhashB);
    const cursor = buildNextCursor({
      sort: 'voteDate',
      dir: 'desc',
      fhash: fhashA,
      lastKeys: ['x', 'y'],
    });
    const dec = decodeCursor(cursor, { sort: 'voteDate', dir: 'desc', fhash: fhashB });
    expect(dec.isErr()).toBe(true);
    if (dec.isErr()) expect(dec.error.type).toBe('InvalidInput');
  });

  it('rejects a malformed cursor', () => {
    const dec = decodeCursor('not-a-cursor', { sort: 'voteDate', dir: 'desc', fhash: 'x' });
    expect(dec.isErr()).toBe(true);
  });
});

describe('memberVotes filter spec — derivation + conditions', () => {
  it('derives a GraphQL input block with choice/voteDate/chamber/outcome + a date-range type', () => {
    const sdl = toGraphQLInput(memberVotesFilterSpec);
    expect(sdl).toContain('input ParliamentMemberVotesFilter');
    expect(sdl).toContain('choice:');
    expect(sdl).toContain('voteDate:');
    expect(sdl).toContain('chamber:');
    expect(sdl).toContain('outcome:');
    expect(sdl).toContain('ParliamentMemberVotesVoteDateRange');
  });

  it('has NO virtual fields (every field compiles to SQL)', () => {
    expect(memberVotesFilterSpec.fields.some((f) => f.virtual === true)).toBe(false);
  });

  it('compiles {choice:{eq:"pentru"}} → 1 condition', () => {
    const r = toConditionBuilders(memberVotesFilterSpec, { choice: { eq: 'pentru' } });
    expect(r.isOk()).toBe(true);
    if (r.isOk()) expect(r.value).toHaveLength(1);
  });

  it('compiles {chamber:{in:["comun","senat"]}} → 1 condition', () => {
    const r = toConditionBuilders(memberVotesFilterSpec, { chamber: { in: ['comun', 'senat'] } });
    expect(r.isOk()).toBe(true);
    if (r.isOk()) expect(r.value).toHaveLength(1);
  });

  it('rejects an out-of-enum choice value (InvalidInput)', () => {
    const r = toConditionBuilders(memberVotesFilterSpec, { choice: { eq: 'da' } });
    expect(r.isErr()).toBe(true);
    if (r.isErr()) expect(r.error.type).toBe('InvalidInput');
  });

  it('an explicit empty {choice:{in:[]}} still emits exactly 1 (match-none) condition (H6/H7)', () => {
    const r = toConditionBuilders(memberVotesFilterSpec, { choice: { in: [] } });
    expect(r.isOk()).toBe(true);
    if (r.isOk()) expect(r.value).toHaveLength(1);
  });
});

describe('memberVotesFhash — parent + filter binding (Codex #2)', () => {
  it('differs across mandates for the same filter', () => {
    const filter = { choice: { eq: 'pentru' } };
    expect(memberVotesFhash('1:2024:1', filter)).not.toEqual(memberVotesFhash('2:2024:1', filter));
  });

  it('differs across filters for the same mandate', () => {
    const mk = '1:2024:1';
    expect(memberVotesFhash(mk, { choice: { eq: 'pentru' } })).not.toEqual(
      memberVotesFhash(mk, { choice: { eq: 'impotriva' } })
    );
  });

  it('the empty-filter hash differs from the OLD memberVotes:<mandate> hash (pins the one-time break)', () => {
    const mk = '1:2024:1';
    expect(memberVotesFhash(mk, {})).not.toEqual(filterHash(`memberVotes:${mk}`));
  });

  it('rejects a cursor encoded under filter A, decoded under filter B (same mandate)', () => {
    const mk = '1:2024:1';
    const fhashA = memberVotesFhash(mk, { choice: { eq: 'pentru' } });
    const fhashB = memberVotesFhash(mk, { choice: { eq: 'impotriva' } });
    const cursor = buildNextCursor({
      sort: 'memberVote',
      dir: 'desc',
      fhash: fhashA,
      lastKeys: ['2026-03-20', 'cdep:1', 0],
    });
    const dec = decodeCursor(cursor, { sort: 'memberVote', dir: 'desc', fhash: fhashB });
    expect(dec.isErr()).toBe(true);
    if (dec.isErr()) expect(dec.error.type).toBe('InvalidInput');
  });
});
