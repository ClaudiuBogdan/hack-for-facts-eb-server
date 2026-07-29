/**
 * `ParliamentVote.voteAction` — the field that says what a division was ON.
 *
 * Until it existed, every client had only `title` to describe a division, and
 * for a bill-linked vote `title` is the BILL's title. Two divisions on one bill
 * were therefore indistinguishable, and a tally could not be reconciled with a
 * fate: the Senate's 101-to-1 on L385/2018 reads as overwhelming support until
 * you know the question was 'raport de respingere (a legii)'.
 *
 * The value is derived upstream and merely whitelisted through
 * `VOTE_ATTR_KEYS`; this pins the two properties the resolver itself owns —
 * it reads the SAFE attrs projection, and it never publishes an empty motion as
 * if it were one.
 */
import { describe, expect, it } from 'vitest';

import { VOTE_ATTR_KEYS } from '../../../src/modules/parliament/core/types.js';
import { makeParliamentResolvers } from '../../../src/modules/parliament/shell/graphql/resolvers.js';

type VoteActionResolver = (parent: { attrs?: Record<string, unknown> | null }) => string | null;

function voteActionResolver(): VoteActionResolver {
  const resolvers = makeParliamentResolvers({} as Parameters<typeof makeParliamentResolvers>[0]);
  const vote = resolvers['ParliamentVote'] as Record<string, unknown>;
  return vote['voteAction'] as VoteActionResolver;
}

describe('ParliamentVote.voteAction', () => {
  it('serves the motion the chamber printed', () => {
    const resolve = voteActionResolver();
    expect(resolve({ attrs: { vote_action: 'Raport de respingere (a legii)' } })).toBe(
      'Raport de respingere (a legii)'
    );
    expect(
      resolve({ attrs: { vote_action: 'Retragerea de pe ordinea de zi a votului final' } })
    ).toBe('Retragerea de pe ordinea de zi a votului final');
  });

  it('returns null rather than an empty or missing motion', () => {
    // 9,223 of 20,745 divisions carry no readable motion (measured 2026-07-29).
    // Null is the honest answer; '' would render as a blank line that looks like
    // a motion the chamber never printed.
    const resolve = voteActionResolver();
    expect(resolve({ attrs: {} })).toBeNull();
    expect(resolve({ attrs: null })).toBeNull();
    expect(resolve({})).toBeNull();
    expect(resolve({ attrs: { vote_action: '' } })).toBeNull();
    expect(resolve({ attrs: { vote_action: '   ' } })).toBeNull();
  });

  it('ignores a non-string value instead of coercing one', () => {
    const resolve = voteActionResolver();
    expect(resolve({ attrs: { vote_action: 42 } })).toBeNull();
    expect(resolve({ attrs: { vote_action: { nested: 'object' } } })).toBeNull();
  });

  it('is reachable at all — vote_action must stay on the attrs whitelist', () => {
    // The resolver reads the SAFE projection, so dropping the key from
    // VOTE_ATTR_KEYS would silently null the field for every vote rather than
    // fail anything. This is the guard against that.
    expect(VOTE_ATTR_KEYS).toContain('vote_action');
  });
});
