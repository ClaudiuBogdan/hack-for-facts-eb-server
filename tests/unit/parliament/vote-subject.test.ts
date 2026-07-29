/**
 * `ParliamentVote.voteSubject` — the field that says what a division was ON.
 *
 * Until it existed, every client had only `title` to describe a division, and
 * for a bill-linked vote `title` is the BILL's title — identical across every
 * division on that bill, so two of them could not be told apart.
 *
 * It is the chamber's OWN LABEL ("Subiect vot"), which is why it is not called
 * an action: it is often a motion, but just as legitimately a document version
 * ('Text initial'), an amendment, an article, or a debate-time allocation, and
 * it settles nothing about whether anything carried.
 *
 * The value is derived upstream and merely whitelisted through
 * `VOTE_ATTR_KEYS`; this pins the two properties the resolver itself owns —
 * it reads the SAFE attrs projection, and it never publishes an empty label as
 * if it were one.
 */
import { describe, expect, it } from 'vitest';

import { VOTE_ATTR_KEYS } from '../../../src/modules/parliament/core/types.js';
import { makeParliamentResolvers } from '../../../src/modules/parliament/shell/graphql/resolvers.js';

type VoteSubjectResolver = (parent: { attrs?: Record<string, unknown> | null }) => string | null;

function voteSubjectResolver(): VoteSubjectResolver {
  const resolvers = makeParliamentResolvers({} as Parameters<typeof makeParliamentResolvers>[0]);
  const vote = resolvers['ParliamentVote'] as Record<string, unknown>;
  return vote['voteSubject'] as VoteSubjectResolver;
}

describe('ParliamentVote.voteSubject', () => {
  it('serves the label the chamber printed', () => {
    const resolve = voteSubjectResolver();
    expect(resolve({ attrs: { vote_action: 'Raport de respingere (a legii)' } })).toBe(
      'Raport de respingere (a legii)'
    );
    expect(
      resolve({ attrs: { vote_action: 'Retragerea de pe ordinea de zi a votului final' } })
    ).toBe('Retragerea de pe ordinea de zi a votului final');
  });

  it('returns null rather than an empty or missing label', () => {
    // Many divisions carry no readable label at all.
    // Null is the honest answer; '' would render as a blank line that looks like
    // a label the chamber never printed.
    const resolve = voteSubjectResolver();
    expect(resolve({ attrs: {} })).toBeNull();
    expect(resolve({ attrs: null })).toBeNull();
    expect(resolve({})).toBeNull();
    expect(resolve({ attrs: { vote_action: '' } })).toBeNull();
    expect(resolve({ attrs: { vote_action: '   ' } })).toBeNull();
  });

  it('ignores a non-string value instead of coercing one', () => {
    const resolve = voteSubjectResolver();
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
