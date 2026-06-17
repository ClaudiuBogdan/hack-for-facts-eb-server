/**
 * Parliament unit tests — filter specs (kernel derivation + virtual-field skip)
 * and the cursor envelope (fhash mismatch → InvalidInput). These guard the
 * tri-surface contract: one spec → GraphQL input + SQL conditions + a stable hash.
 */

import { describe, expect, it } from 'vitest';

import {
  billsFilterSpec,
  controlItemsFilterSpec,
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
  toConditionBuilders,
  toGraphQLInput,
} from '@/modules/shared/index.js';

describe('filter specs — virtual fields are declared and skipped by the SQL composer', () => {
  it('every spec marks its repo-intercepted fields virtual:true', () => {
    const virtualNames = (spec: typeof votesFilterSpec): string[] =>
      spec.fields.filter((f) => f.virtual === true).map((f) => f.name).sort();
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
    const cursor = buildNextCursor({ sort: 'voteDate', dir: 'desc', fhash, lastKeys: ['2022-05-04', 'cdep:29892'] });
    const dec = decodeCursor(cursor, { sort: 'voteDate', dir: 'desc', fhash });
    expect(dec.isOk()).toBe(true);
    if (dec.isOk()) expect(dec.value.keys).toEqual(['2022-05-04', 'cdep:29892']);
  });

  it('rejects a cursor decoded under a DIFFERENT filter (fhash mismatch)', () => {
    const fhashA = fhashFor(votesFilterSpec, { chamber: { eq: 'senat' } });
    const fhashB = fhashFor(votesFilterSpec, { chamber: { eq: 'camera_deputatilor' } });
    expect(fhashA).not.toEqual(fhashB);
    const cursor = buildNextCursor({ sort: 'voteDate', dir: 'desc', fhash: fhashA, lastKeys: ['x', 'y'] });
    const dec = decodeCursor(cursor, { sort: 'voteDate', dir: 'desc', fhash: fhashB });
    expect(dec.isErr()).toBe(true);
    if (dec.isErr()) expect(dec.error.type).toBe('InvalidInput');
  });

  it('rejects a malformed cursor', () => {
    const dec = decodeCursor('not-a-cursor', { sort: 'voteDate', dir: 'desc', fhash: 'x' });
    expect(dec.isErr()).toBe(true);
  });
});
