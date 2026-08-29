/**
 * Parliament unit tests — filter specs (kernel derivation + virtual-field skip)
 * and the cursor envelope (fhash mismatch → InvalidInput). These guard the
 * tri-surface contract: one spec → GraphQL input + SQL conditions + a stable hash.
 */

import { describe, expect, it } from 'vitest';

import {
  billsFilterSpec,
  controlItemsFilterSpec,
  memberSpeechesFhash,
  memberSpeechesFilterSpec,
  memberVotesFhash,
  memberVotesFilterSpec,
  membersFilterSpec,
  parliamentSpeechesFhash,
  parliamentSpeechesFilterSpec,
  votesFilterSpec,
} from '@/modules/parliament/index.js';
import {
  BILLS_VIRTUAL_FIELDS,
  CONTROL_VIRTUAL_FIELDS,
  MEMBERS_VIRTUAL_FIELDS,
  VOTES_VIRTUAL_FIELDS,
} from '@/modules/parliament/shell/filters/specs.js';
import { enumSelection } from '@/modules/parliament/shell/repo/parliament-repo.js';
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
    // Virtual bill fields STILL surface in the GraphQL input: the repo owns
    // their JSON/OR predicates, while every transport inherits the same shape.
    const billSdl = toGraphQLInput(billsFilterSpec);
    expect(billSdl).toContain('year:');
    expect(billSdl).toContain('lastEventDate:');
    expect(billSdl).toContain('input ParliamentBillsLastEventDateFilter');
  });
});

describe('bill virtual enum selection mirrors physical eq/in semantics', () => {
  const VALUES = ['government', 'parliamentary'] as const;

  it('intersects eq with in', () => {
    const overlap = enumSelection(
      { eq: 'government', in: ['government', 'parliamentary'] },
      VALUES
    );
    expect(overlap.isOk() && overlap.value).toEqual({
      values: ['government'],
      matchNothing: false,
    });

    const disjoint = enumSelection({ eq: 'government', in: ['parliamentary'] }, VALUES);
    expect(disjoint.isOk() && disjoint.value).toEqual({ values: [], matchNothing: true });
  });

  it('treats empty in as match-nothing even when eq is also present', () => {
    const result = enumSelection({ eq: 'government', in: [] }, VALUES);
    expect(result.isOk() && result.value).toEqual({ values: [], matchNothing: true });
  });

  it('still validates every eq/in operand before intersecting', () => {
    expect(enumSelection({ eq: 'government', in: ['unknown'] }, VALUES).isErr()).toBe(true);
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

describe('memberSpeeches filter spec — derivation + conditions', () => {
  it('derives a GraphQL input block with spokenAt (a date range) + chamber, and NO q field', () => {
    const sdl = toGraphQLInput(memberSpeechesFilterSpec);
    expect(sdl).toContain('input ParliamentMemberSpeechesFilter');
    expect(sdl).toContain('spokenAt:');
    expect(sdl).toContain('chamber:');
    expect(sdl).toContain('SpokenAtRange');
    // q is a repo-intercepted GraphQL argument, NOT a spec field → the input carries
    // ONLY spokenAt + chamber (q never appears as a spec field).
    expect(memberSpeechesFilterSpec.fields.map((f) => f.name)).toEqual(['spokenAt', 'chamber']);
  });

  it('has NO virtual fields (every field compiles to SQL)', () => {
    expect(memberSpeechesFilterSpec.fields.some((f) => f.virtual === true)).toBe(false);
  });

  it('compiles {chamber:{in:["comun","senat"]}} → 1 condition', () => {
    const r = toConditionBuilders(memberSpeechesFilterSpec, {
      chamber: { in: ['comun', 'senat'] },
    });
    expect(r.isOk()).toBe(true);
    if (r.isOk()) expect(r.value).toHaveLength(1);
  });

  it('compiles a spokenAt between-range → 1 condition', () => {
    const r = toConditionBuilders(memberSpeechesFilterSpec, {
      spokenAt: { between: { from: '2025-01-01', to: '2025-12-31' } },
    });
    expect(r.isOk()).toBe(true);
    if (r.isOk()) expect(r.value).toHaveLength(1);
  });

  it('rejects an out-of-enum chamber value (InvalidInput)', () => {
    const r = toConditionBuilders(memberSpeechesFilterSpec, { chamber: { eq: 'plen' } });
    expect(r.isErr()).toBe(true);
    if (r.isErr()) expect(r.error.type).toBe('InvalidInput');
  });

  it('an explicit empty {chamber:{in:[]}} still emits exactly 1 (match-none) condition (H6/H7)', () => {
    const r = toConditionBuilders(memberSpeechesFilterSpec, { chamber: { in: [] } });
    expect(r.isOk()).toBe(true);
    if (r.isOk()) expect(r.value).toHaveLength(1);
  });
});

describe('parliamentSpeeches filter spec — derivation + conditions (global stenograme)', () => {
  it('derives a GraphQL input block with spokenAt/chamber/mandateKey and NO q field', () => {
    const sdl = toGraphQLInput(parliamentSpeechesFilterSpec);
    expect(sdl).toContain('input ParliamentSpeechesFilter');
    expect(sdl).toContain('spokenAt:');
    expect(sdl).toContain('chamber:');
    expect(sdl).toContain('mandateKey:');
    expect(sdl).toContain('ParliamentSpeechesSpokenAtRange');
    // q is a repo-intercepted GraphQL argument, NOT a spec field (a spec-level q
    // would generate an input field the physical extraction silently ignores).
    expect(parliamentSpeechesFilterSpec.fields.map((f) => f.name)).toEqual([
      'spokenAt',
      'chamber',
      'mandateKey',
    ]);
  });

  it('has NO virtual fields (every field compiles to SQL)', () => {
    expect(parliamentSpeechesFilterSpec.fields.some((f) => f.virtual === true)).toBe(false);
  });

  it('compiles the physical fields (an unknown q key is ignored by the composer)', () => {
    const rq = toConditionBuilders(parliamentSpeechesFilterSpec, { q: { contains: 'lege' } });
    expect(rq.isOk()).toBe(true);
    if (rq.isOk()) expect(rq.value).toHaveLength(0);
    const rp = toConditionBuilders(parliamentSpeechesFilterSpec, {
      mandateKey: { eq: '2:2020:12' },
      chamber: { in: ['comun', 'senat'] },
      spokenAt: { between: { from: '2025-01-01', to: '2025-12-31' } },
    });
    expect(rp.isOk()).toBe(true);
    if (rp.isOk()) expect(rp.value).toHaveLength(3);
  });

  it('rejects an out-of-enum chamber value (InvalidInput)', () => {
    const r = toConditionBuilders(parliamentSpeechesFilterSpec, { chamber: { eq: 'plen' } });
    expect(r.isErr()).toBe(true);
  });

  it('an explicit empty {mandateKey:{in:[]}} still emits exactly 1 (match-none) condition (#60h)', () => {
    const r = toConditionBuilders(parliamentSpeechesFilterSpec, { mandateKey: { in: [] } });
    expect(r.isOk()).toBe(true);
    if (r.isOk()) expect(r.value).toHaveLength(1);
  });
});

describe('parliamentSpeechesFhash — filter + q + APPLIED-depth + APPLIED-population binding', () => {
  const LEGACY = 'LEGACY';
  it('varies by filter, q, and depth', () => {
    const filter = { spokenAt: { between: { from: '2025-01-01', to: '2025-03-31' } } };
    expect(parliamentSpeechesFhash(filter, 'lege', 'TITLE_SUMMARY', LEGACY)).not.toEqual(
      parliamentSpeechesFhash({ chamber: { eq: 'senat' } }, 'lege', 'TITLE_SUMMARY', LEGACY)
    );
    expect(parliamentSpeechesFhash(filter, 'lege', 'TITLE_SUMMARY', LEGACY)).not.toEqual(
      parliamentSpeechesFhash(filter, 'buget', 'TITLE_SUMMARY', LEGACY)
    );
    // A probe flip mid-pagination (TITLE_SUMMARY ↔ FULL_TEXT) forks the fhash, so
    // in-flight cursors are invalidated with the clean "restart pagination" error.
    expect(parliamentSpeechesFhash(filter, 'lege', 'TITLE_SUMMARY', LEGACY)).not.toEqual(
      parliamentSpeechesFhash(filter, 'lege', 'FULL_TEXT', LEGACY)
    );
    // no-q uses the 'none' depth token and differs from any q-bearing hash.
    expect(parliamentSpeechesFhash(filter, undefined, 'none', LEGACY)).not.toEqual(
      parliamentSpeechesFhash(filter, 'lege', 'TITLE_SUMMARY', LEGACY)
    );
  });

  it('varies by the APPLIED served population (the canonical-migration probe flip)', () => {
    const filter = { spokenAt: { between: { from: '2025-01-01', to: '2025-03-31' } } };
    // When the canonical migration lands, legacy rows with a redirect stop being served.
    // That changes the row set, so an in-flight cursor MUST be refused rather than
    // silently skipping or duplicating turns.
    expect(parliamentSpeechesFhash(filter, undefined, 'none', 'LEGACY')).not.toEqual(
      parliamentSpeechesFhash(filter, undefined, 'none', 'CANONICAL_PREFERRED')
    );
  });

  it('is stable under filter key reordering (canonicalization)', () => {
    const a = parliamentSpeechesFhash(
      { chamber: { eq: 'senat' }, spokenAt: { gte: '2025-01-01', lte: '2025-03-31' } },
      'lege',
      'FULL_TEXT',
      LEGACY
    );
    const b = parliamentSpeechesFhash(
      { spokenAt: { lte: '2025-03-31', gte: '2025-01-01' }, chamber: { eq: 'senat' } },
      'lege',
      'FULL_TEXT',
      LEGACY
    );
    expect(a).toEqual(b);
  });

  it('rejects a cursor encoded under depth A, decoded under depth B (probe flip)', () => {
    const filter = { spokenAt: { between: { from: '2025-01-01', to: '2025-03-31' } } };
    const fhashA = parliamentSpeechesFhash(filter, 'lege', 'FULL_TEXT', LEGACY);
    const fhashB = parliamentSpeechesFhash(filter, 'lege', 'TITLE_SUMMARY', LEGACY);
    const cursor = buildNextCursor({
      sort: 'spokenAt',
      dir: 'desc',
      fhash: fhashA,
      lastKeys: ['2025-02-01', 'senat:123'],
    });
    const dec = decodeCursor(cursor, { sort: 'spokenAt', dir: 'desc', fhash: fhashB });
    expect(dec.isErr()).toBe(true);
    if (dec.isErr()) expect(dec.error.type).toBe('InvalidInput');
  });
});

describe('memberSpeechesFhash — parent + filter + q + population binding (Codex #2)', () => {
  const LEGACY = 'LEGACY';
  it('differs across mandates for the same filter + q', () => {
    const filter = { chamber: { eq: 'senat' } };
    expect(memberSpeechesFhash('1:2024:79', filter, 'lege', LEGACY)).not.toEqual(
      memberSpeechesFhash('2:2000:92', filter, 'lege', LEGACY)
    );
  });

  it('differs across filters for the same mandate + q', () => {
    const mk = '1:2024:79';
    expect(memberSpeechesFhash(mk, { chamber: { eq: 'senat' } }, 'lege', LEGACY)).not.toEqual(
      memberSpeechesFhash(mk, { chamber: { eq: 'comun' } }, 'lege', LEGACY)
    );
  });

  it('differs across the q token for the same mandate + filter', () => {
    const mk = '1:2024:79';
    expect(memberSpeechesFhash(mk, {}, 'lege', LEGACY)).not.toEqual(
      memberSpeechesFhash(mk, {}, 'buget', LEGACY)
    );
    // absent q vs a present q also differ.
    expect(memberSpeechesFhash(mk, {}, undefined, LEGACY)).not.toEqual(
      memberSpeechesFhash(mk, {}, 'lege', LEGACY)
    );
  });

  it('differs across the APPLIED served population (the canonical-migration probe flip)', () => {
    const mk = '1:2024:79';
    expect(memberSpeechesFhash(mk, {}, undefined, 'LEGACY')).not.toEqual(
      memberSpeechesFhash(mk, {}, undefined, 'CANONICAL_PREFERRED')
    );
  });

  it('rejects a cursor encoded under q=A, decoded under q=B (same mandate + filter)', () => {
    const mk = '1:2024:79';
    const fhashA = memberSpeechesFhash(mk, {}, 'lege', LEGACY);
    const fhashB = memberSpeechesFhash(mk, {}, 'buget', LEGACY);
    const cursor = buildNextCursor({
      sort: 'spokenAt',
      dir: 'desc',
      fhash: fhashA,
      lastKeys: ['2025-06-01', 'senat:123'],
    });
    const dec = decodeCursor(cursor, { sort: 'spokenAt', dir: 'desc', fhash: fhashB });
    expect(dec.isErr()).toBe(true);
    if (dec.isErr()) expect(dec.error.type).toBe('InvalidInput');
  });

  it('round-trips a speeches cursor under the SAME mandate + filter + q (2-tuple keyset)', () => {
    const mk = '1:2024:79';
    const fhash = memberSpeechesFhash(mk, { chamber: { eq: 'senat' } }, undefined, LEGACY);
    const cursor = buildNextCursor({
      sort: 'spokenAt',
      dir: 'desc',
      fhash,
      lastKeys: ['2025-06-01', 'senat:123'],
    });
    const dec = decodeCursor(cursor, { sort: 'spokenAt', dir: 'desc', fhash });
    expect(dec.isOk()).toBe(true);
    if (dec.isOk()) expect(dec.value.keys).toEqual(['2025-06-01', 'senat:123']);
  });
});
