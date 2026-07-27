/**
 * Parliament unit tests — usecases over a MOCKED port (no DB). Covers the
 * cross-field guards (cohesion mode/cap, votes q-only bound, control bound), the
 * marquee lineage assembly, the dangling-loader tolerance, and graceful degrade.
 */

import { err, ok, type Result } from 'neverthrow';
import { describe, expect, it, vi } from 'vitest';

import { COHESION_VOTE_CAP } from '@/modules/parliament/core/types.js';
import {
  COMMITTEE_LINKED_BILLS_CAP,
  getCommittee,
  getDataFreshness,
  getLineageForAct,
  getMemberSpeechActivity,
  getMemberSpeechesConnection,
  getMemberVoteActivity,
  getMemberVotes,
  listControlItems,
  listVotes,
  normalizeSpeechQ,
  rankVoteCohesion,
  type ParliamentUsecaseDeps,
} from '@/modules/parliament/core/usecases.js';
import { memberSpeechesFhash } from '@/modules/parliament/index.js';

import type { LineageVoteRow, ParliamentRepo } from '@/modules/parliament/core/ports.js';
import type { ApiError } from '@/modules/shared/index.js';

const okp = <T>(v: T): Promise<Result<T, ApiError>> => Promise.resolve(ok(v));

/** A repo stub: every method rejects unless explicitly overridden (so a test that
 * hits an unexpected method fails loudly). */
const makeRepo = (over: Partial<ParliamentRepo>): ParliamentRepo => {
  const notImpl = (name: string) => (): never => {
    throw new Error(`unexpected repo call: ${name}`);
  };
  const base = new Proxy({} as ParliamentRepo, {
    get(_t, prop: string) {
      return over[prop as keyof ParliamentRepo] ?? notImpl(prop);
    },
  });
  return base;
};

const deps = (repo: ParliamentRepo): ParliamentUsecaseDeps => ({ repo, meili: null });

const fakeVote = (voteKey: string) => ({
  voteKey,
  chamber: 'camera_deputatilor',
  voteDate: '2022-05-04',
  title: null,
  tally: { pentru: 275, impotriva: 0, abtinere: 1, nuAVotat: 1, present: 277 },
  outcome: 'adoptat',
  divisionNumber: null,
  billKey: '12760',
  lawReference: null,
  sourceUrl: null,
  tallyMismatch: false,
  attrs: {},
});

describe('rankVoteCohesion — mode + cap guards (Codex BLOCKER #1)', () => {
  it('rejects when neither mode is provided', async () => {
    const r = await rankVoteCohesion(deps(makeRepo({})), {});
    expect(r.isErr()).toBe(true);
    if (r.isErr()) expect(r.error.type).toBe('InvalidInput');
  });

  it('rejects when BOTH billKey and window are provided', async () => {
    const r = await rankVoteCohesion(deps(makeRepo({})), {
      billKey: '1',
      chamber: 'senat',
      from: '2020-01-01',
      to: '2020-12-31',
    });
    expect(r.isErr()).toBe(true);
  });

  it('rejects a window whose vote set OVERFLOWS the cap before any vote_records fan-in', async () => {
    const voteKeysForWindow = vi.fn(() => okp({ voteKeys: [], overflow: true }));
    const cohesionForVoteKeys = vi.fn(() => okp([]));
    const r = await rankVoteCohesion(deps(makeRepo({ voteKeysForWindow, cohesionForVoteKeys })), {
      chamber: 'camera_deputatilor',
      from: '2020-01-01',
      to: '2024-12-31',
    });
    expect(r.isErr()).toBe(true);
    expect(voteKeysForWindow).toHaveBeenCalledOnce();
    // CRITICAL: cohesion (the vote_records fan-in) is NEVER reached on overflow.
    expect(cohesionForVoteKeys).not.toHaveBeenCalled();
  });

  it('passes the cap value to voteKeysForWindow', async () => {
    const voteKeysForWindow = vi.fn(() => okp({ voteKeys: ['cdep:1'], overflow: false }));
    const cohesionForVoteKeys = vi.fn(() => okp([]));
    await rankVoteCohesion(deps(makeRepo({ voteKeysForWindow, cohesionForVoteKeys })), {
      chamber: 'senat',
      from: '2020-01-01',
      to: '2020-12-31',
    });
    expect(voteKeysForWindow).toHaveBeenCalledWith(
      'senat',
      '2020-01-01',
      '2020-12-31',
      COHESION_VOTE_CAP
    );
  });

  it('rejects a bill whose vote set exceeds the cap', async () => {
    const many = Array.from({ length: COHESION_VOTE_CAP + 1 }, (_, i) => `cdep:${String(i)}`);
    const voteKeysForBill = vi.fn(() => okp(many as readonly string[]));
    const cohesionForVoteKeys = vi.fn(() => okp([]));
    const r = await rankVoteCohesion(deps(makeRepo({ voteKeysForBill, cohesionForVoteKeys })), {
      billKey: 'b1',
    });
    expect(r.isErr()).toBe(true);
    expect(cohesionForVoteKeys).not.toHaveBeenCalled();
  });
});

describe('listVotes — q-only bound guard', () => {
  it('rejects a q-only query when the search engine is down and no bound is given', async () => {
    const r = await listVotes(deps(makeRepo({})), {
      filter: { q: { contains: 'lege' } },
      sort: 'voteDate',
      dir: 'desc',
      page: { first: 20 },
      searchEngineUp: false,
    });
    expect(r.isErr()).toBe(true);
    if (r.isErr()) expect(r.error.type).toBe('InvalidInput');
  });

  it('allows a q query WITH a chamber bound', async () => {
    const listVotesFn = vi.fn(() =>
      okp({ items: [], next: null, total: 0, totalEstimated: false })
    );
    const r = await listVotes(deps(makeRepo({ listVotes: listVotesFn })), {
      filter: { q: { contains: 'lege' }, chamber: { eq: 'senat' } },
      sort: 'voteDate',
      dir: 'desc',
      page: { first: 20 },
      searchEngineUp: false,
    });
    expect(r.isOk()).toBe(true);
    expect(listVotesFn).toHaveBeenCalledOnce();
  });

  it('an EMPTY chamber object does NOT count as a bound (Codex BLOCKER #1)', async () => {
    const r = await listVotes(deps(makeRepo({})), {
      filter: { q: { contains: 'lege' }, chamber: {} },
      sort: 'voteDate',
      dir: 'desc',
      page: { first: 20 },
      searchEngineUp: false,
    });
    expect(r.isErr()).toBe(true);
  });

  it('allows a q-only query when the search engine is UP', async () => {
    const listVotesFn = vi.fn(() =>
      okp({ items: [], next: null, total: 0, totalEstimated: false })
    );
    const r = await listVotes(deps(makeRepo({ listVotes: listVotesFn })), {
      filter: { q: { contains: 'lege' } },
      sort: 'voteDate',
      dir: 'desc',
      page: { first: 20 },
      searchEngineUp: true,
    });
    expect(r.isOk()).toBe(true);
  });
});

describe('listControlItems — bound guard (§3.2)', () => {
  it('rejects an unbounded control-items list', async () => {
    const r = await listControlItems(
      deps(makeRepo({})),
      { controlType: { eq: 'question' } },
      { first: 20 }
    );
    expect(r.isErr()).toBe(true);
  });

  it('rejects an EMPTY-object bound (Codex BLOCKER #1): {recipient:{}} / {itemDate:{}} is not a real bound', async () => {
    const r1 = await listControlItems(deps(makeRepo({})), { recipient: {} }, { first: 20 });
    expect(r1.isErr()).toBe(true);
    const r2 = await listControlItems(deps(makeRepo({})), { itemDate: {} }, { first: 20 });
    expect(r2.isErr()).toBe(true);
    // An empty contains string is also not a bound (would compile to LIKE '%%').
    const r3 = await listControlItems(
      deps(makeRepo({})),
      { author: { contains: '' } },
      { first: 20 }
    );
    expect(r3.isErr()).toBe(true);
  });

  it('allows a control list bounded by a date window', async () => {
    const listControlItemsFn = vi.fn(() => okp({ items: [], next: null }));
    const r = await listControlItems(
      deps(makeRepo({ listControlItems: listControlItemsFn })),
      { itemDate: { between: { from: '2024-01-01', to: '2024-12-31' } } },
      { first: 20 }
    );
    expect(r.isOk()).toBe(true);
  });

  it('allows a control list bounded by recipient', async () => {
    const listControlItemsFn = vi.fn(() => okp({ items: [], next: null }));
    const r = await listControlItems(
      deps(makeRepo({ listControlItems: listControlItemsFn })),
      { recipient: { eq: 'Ministerul Sănătății' } },
      { first: 20 }
    );
    expect(r.isOk()).toBe(true);
  });
});

describe('getMemberVotes — forwards the filter to the repo', () => {
  it('threads the filter through to listMemberVotes', async () => {
    const listMemberVotes = vi.fn(() => okp({ items: [], next: null, total: 0 }));
    const filter = { choice: { eq: 'pentru' } };
    const r = await getMemberVotes(
      deps(makeRepo({ listMemberVotes })),
      '1:2024:1',
      { first: 20 },
      filter
    );
    expect(r.isOk()).toBe(true);
    expect(listMemberVotes).toHaveBeenCalledWith('1:2024:1', { first: 20 }, filter);
  });
});

describe('getMemberVoteActivity — voteDate + year guards (never hits the repo on a guard error)', () => {
  it('rejects a filter carrying a voteDate value and NEVER calls the repo', async () => {
    const memberVoteActivity = vi.fn(() => okp({ year: 2026, days: [], availableYears: [] }));
    const r = await getMemberVoteActivity(
      deps(makeRepo({ memberVoteActivity })),
      '1:2024:1',
      2026,
      {
        voteDate: { gte: '2026-01-01' },
      }
    );
    expect(r.isErr()).toBe(true);
    if (r.isErr()) expect(r.error.type).toBe('InvalidInput');
    expect(memberVoteActivity).not.toHaveBeenCalled();
  });

  it('rejects an out-of-range year (123) BEFORE the repo', async () => {
    const memberVoteActivity = vi.fn(() => okp({ year: 123, days: [], availableYears: [] }));
    const r = await getMemberVoteActivity(
      deps(makeRepo({ memberVoteActivity })),
      '1:2024:1',
      123,
      {}
    );
    expect(r.isErr()).toBe(true);
    if (r.isErr()) expect(r.error.type).toBe('InvalidInput');
    expect(memberVoteActivity).not.toHaveBeenCalled();
  });

  it('passes a valid (mandate, year, filter) through to the repo', async () => {
    const memberVoteActivity = vi.fn(() => okp({ year: 2026, days: [], availableYears: [2026] }));
    const filter = { choice: { eq: 'pentru' } };
    const r = await getMemberVoteActivity(
      deps(makeRepo({ memberVoteActivity })),
      '1:2024:1',
      2026,
      filter
    );
    expect(r.isOk()).toBe(true);
    expect(memberVoteActivity).toHaveBeenCalledWith('1:2024:1', 2026, filter);
  });
});

describe('normalizeSpeechQ — trim + lower-case + empty→undefined (idempotent)', () => {
  it('trims, maps empty/whitespace to undefined, and is idempotent', () => {
    expect(normalizeSpeechQ('  lege  ')).toBe('lege');
    expect(normalizeSpeechQ('')).toBeUndefined();
    expect(normalizeSpeechQ('   ')).toBeUndefined();
    expect(normalizeSpeechQ(null)).toBeUndefined();
    expect(normalizeSpeechQ(undefined)).toBeUndefined();
    // idempotent: normalizing an already-normalized value is a no-op.
    expect(normalizeSpeechQ(normalizeSpeechQ('  lege  '))).toBe('lege');
  });

  it('lower-cases so case variants collapse to ONE cursor identity (ILIKE is case-insensitive)', () => {
    expect(normalizeSpeechQ('Lege')).toBe('lege');
    expect(normalizeSpeechQ('  LEGE ')).toBe('lege');
    expect(normalizeSpeechQ('Lege')).toBe(normalizeSpeechQ('lege'));
    // diacritics are preserved (the predicate is diacritic-sensitive); only case folds.
    expect(normalizeSpeechQ('Întrebare')).toBe('întrebare');
  });
});

describe('memberSpeechesFhash — case-insensitivity of q (shared cursor identity)', () => {
  it("'Lege' and 'lege' produce the SAME fhash via the normalized token", () => {
    // The fhash consumes the normalized value, so case variants must not fork cursors.
    expect(memberSpeechesFhash('1:2024:79', {}, normalizeSpeechQ('Lege'), 'LEGACY')).toEqual(
      memberSpeechesFhash('1:2024:79', {}, normalizeSpeechQ('lege'), 'LEGACY')
    );
  });
});

describe('getMemberSpeechesConnection — forwards filter + normalized q; length guard', () => {
  it('threads mandate/page/filter and the NORMALIZED q to the repo', async () => {
    // `population` is what the repo reports back so the shell can fold the APPLIED
    // served population into per-edge cursors; pre-migration that is 'LEGACY'.
    const listMemberSpeechesCursor = vi.fn(() =>
      okp({ items: [], next: null, total: 0, population: 'LEGACY' as const })
    );
    const filter = { chamber: { eq: 'senat' } };
    const r = await getMemberSpeechesConnection(
      deps(makeRepo({ listMemberSpeechesCursor })),
      '1:2024:79',
      { first: 20 },
      filter,
      '  lege  '
    );
    expect(r.isOk()).toBe(true);
    expect(listMemberSpeechesCursor).toHaveBeenCalledWith(
      '1:2024:79',
      { first: 20 },
      filter,
      'lege'
    );
  });

  it('rejects a q longer than the max BEFORE the repo', async () => {
    // `population` is what the repo reports back so the shell can fold the APPLIED
    // served population into per-edge cursors; pre-migration that is 'LEGACY'.
    const listMemberSpeechesCursor = vi.fn(() =>
      okp({ items: [], next: null, total: 0, population: 'LEGACY' as const })
    );
    const r = await getMemberSpeechesConnection(
      deps(makeRepo({ listMemberSpeechesCursor })),
      '1:2024:79',
      { first: 20 },
      {},
      'x'.repeat(201)
    );
    expect(r.isErr()).toBe(true);
    if (r.isErr()) expect(r.error.type).toBe('InvalidInput');
    expect(listMemberSpeechesCursor).not.toHaveBeenCalled();
  });

  it('passes q=undefined when the token normalizes to empty', async () => {
    // `population` is what the repo reports back so the shell can fold the APPLIED
    // served population into per-edge cursors; pre-migration that is 'LEGACY'.
    const listMemberSpeechesCursor = vi.fn(() =>
      okp({ items: [], next: null, total: 0, population: 'LEGACY' as const })
    );
    await getMemberSpeechesConnection(
      deps(makeRepo({ listMemberSpeechesCursor })),
      '1:2024:79',
      { first: 20 },
      {},
      '   '
    );
    expect(listMemberSpeechesCursor).toHaveBeenCalledWith(
      '1:2024:79',
      { first: 20 },
      {},
      undefined
    );
  });
});

describe('getMemberSpeechActivity — spokenAt + year guards (never hits the repo on a guard error)', () => {
  it('rejects a filter carrying a spokenAt value and NEVER calls the repo', async () => {
    const memberSpeechActivity = vi.fn(() => okp({ year: 2025, days: [], availableYears: [] }));
    const r = await getMemberSpeechActivity(
      deps(makeRepo({ memberSpeechActivity })),
      '1:2024:79',
      2025,
      { spokenAt: { gte: '2025-01-01' } }
    );
    expect(r.isErr()).toBe(true);
    if (r.isErr()) expect(r.error.type).toBe('InvalidInput');
    expect(memberSpeechActivity).not.toHaveBeenCalled();
  });

  it('rejects an out-of-range year (123) BEFORE the repo', async () => {
    const memberSpeechActivity = vi.fn(() => okp({ year: 123, days: [], availableYears: [] }));
    const r = await getMemberSpeechActivity(
      deps(makeRepo({ memberSpeechActivity })),
      '1:2024:79',
      123,
      {}
    );
    expect(r.isErr()).toBe(true);
    if (r.isErr()) expect(r.error.type).toBe('InvalidInput');
    expect(memberSpeechActivity).not.toHaveBeenCalled();
  });

  it('passes a valid (mandate, year, filter, normalized q) through to the repo', async () => {
    const memberSpeechActivity = vi.fn(() => okp({ year: 2025, days: [], availableYears: [2025] }));
    const filter = { chamber: { eq: 'senat' } };
    const r = await getMemberSpeechActivity(
      deps(makeRepo({ memberSpeechActivity })),
      '1:2024:79',
      2025,
      filter,
      ' întrebare '
    );
    expect(r.isOk()).toBe(true);
    expect(memberSpeechActivity).toHaveBeenCalledWith('1:2024:79', 2025, filter, 'întrebare');
  });
});

describe('getLineageForAct — marquee assembly + ballots gate', () => {
  const lineageRow = (voteKey: string, role = 'final_adoption'): LineageVoteRow => ({
    vote: fakeVote(voteKey),
    billKey: '12760',
    role,
    resolutionStatus: 'linked',
    confidenceLabel: 'high',
  });

  it('assembles act → bills → votes and includes ballot counts only when requested', async () => {
    const billsForActId = vi.fn(() => okp([{ billKey: '12760' } as never]));
    const votesForActId = vi.fn(() => okp([lineageRow('cdep:29892')]));
    const ballotResolution = vi.fn(() => okp({ total: 277, resolved: 277 }));
    const r = await getLineageForAct(
      deps(makeRepo({ billsForActId, votesForActId, ballotResolution })),
      {
        actId: '145905',
        includeBallots: true,
      }
    );
    expect(r.isOk()).toBe(true);
    if (r.isOk() && r.value !== null) {
      expect(r.value.actId).toBe('145905');
      expect(r.value.bills).toHaveLength(1);
      expect(r.value.votes[0]?.voteKey).toBe('cdep:29892');
      expect(r.value.votes[0]?.ballotsTotal).toBe(277);
      expect(r.value.votes[0]?.ballotsResolved).toBe(277);
    }
    expect(ballotResolution).toHaveBeenCalledOnce();
  });

  it('does NOT call ballotResolution when includeBallots is false', async () => {
    const billsForActId = vi.fn(() => okp([{ billKey: '12760' } as never]));
    const votesForActId = vi.fn(() => okp([lineageRow('cdep:29892')]));
    const ballotResolution = vi.fn(() => okp({ total: 0, resolved: 0 }));
    await getLineageForAct(deps(makeRepo({ billsForActId, votesForActId, ballotResolution })), {
      actId: '145905',
    });
    expect(ballotResolution).not.toHaveBeenCalled();
  });

  it('returns null (not an empty object) when the act has no parliamentary mapping', async () => {
    const billsForActId = vi.fn(() => okp([]));
    const votesForActId = vi.fn(() => okp([]));
    const r = await getLineageForAct(deps(makeRepo({ billsForActId, votesForActId })), {
      actId: '999999999',
    });
    expect(r.isOk()).toBe(true);
    if (r.isOk()) expect(r.value).toBeNull();
  });

  it('fetches ALL linked votes and filters to final roles by default, reporting the omitted ones (H14/M15)', async () => {
    const billsForActId = vi.fn(() => okp([{ billKey: '12760' } as never]));
    const votesForActId = vi.fn(() =>
      okp([
        lineageRow('cdep:1', 'final_adoption'),
        lineageRow('cdep:2', 'amendment'),
        lineageRow('cdep:3', 'procedural'),
      ])
    );
    const r = await getLineageForAct(deps(makeRepo({ billsForActId, votesForActId })), {
      actId: '145905',
    });
    // The repo is called WITHOUT a role filter — filtering happens in TS so the omitted
    // non-default-role votes can be reported in caveats (instead of vanishing in SQL).
    expect(votesForActId).toHaveBeenCalledWith('145905', []);
    expect(r.isOk()).toBe(true);
    if (r.isOk() && r.value !== null) {
      expect(r.value.votes.map((v) => v.role)).toEqual(['final_adoption']); // default = final only
      expect(r.value.caveats.some((c) => c.includes('omitted'))).toBe(true);
    }
  });

  it('roles:["all"] widens lineage to every linked vote', async () => {
    const billsForActId = vi.fn(() => okp([{ billKey: '12760' } as never]));
    const votesForActId = vi.fn(() =>
      okp([lineageRow('cdep:1', 'final_adoption'), lineageRow('cdep:2', 'amendment')])
    );
    const r = await getLineageForAct(deps(makeRepo({ billsForActId, votesForActId })), {
      actId: '145905',
      roles: ['all'],
    });
    expect(r.isOk()).toBe(true);
    if (r.isOk() && r.value !== null) expect(r.value.votes).toHaveLength(2);
  });

  it('propagates a repo error', async () => {
    const billsForActId = vi.fn(() =>
      Promise.resolve(err<never, ApiError>({ type: 'Database', message: 'boom' }))
    );
    const votesForActId = vi.fn(() => okp([]));
    const r = await getLineageForAct(deps(makeRepo({ billsForActId, votesForActId })), {
      actId: '1',
    });
    expect(r.isErr()).toBe(true);
  });

  it('rejects a non-numeric actId with InvalidInput BEFORE hitting the repo (Codex SF)', async () => {
    const billsForActId = vi.fn(() => okp([]));
    const r = await getLineageForAct(deps(makeRepo({ billsForActId })), { actId: '1; drop table' });
    expect(r.isErr()).toBe(true);
    if (r.isErr()) expect(r.error.type).toBe('InvalidInput');
    expect(billsForActId).not.toHaveBeenCalled();
  });
});

describe('getCommittee — detail assembly (B2)', () => {
  const committee = {
    committeeKey: 'cdep:2:2024:1',
    chamber: 'camera_deputatilor',
    name: 'Comisia pentru buget',
    legislature: '2024',
    committeeType: 'permanent',
    sourceUrl: 'https://cdep.ro/comisii/buget',
  };
  const membership = {
    membershipKey: 'm1',
    role: 'membru',
    joinedDate: '2024-02-01',
    leftDate: null,
    isBureau: false,
    sourceUrl: 'https://cdep.ro/comisii/buget',
    committee: null,
    member: null,
  };

  it('returns null when the committee does not exist (never an empty object)', async () => {
    const findCommittee = vi.fn(() => okp(null));
    const r = await getCommittee(deps(makeRepo({ findCommittee })), 'nope');
    expect(r.isOk()).toBe(true);
    if (r.isOk()) expect(r.value).toBeNull();
  });

  it('assembles committee + roster + linked bills (with cap) + meetings count', async () => {
    const findCommittee = vi.fn(() => okp(committee));
    const listCommitteeRoster = vi.fn(() => okp([membership]));
    const listCommitteeLinkedBills = vi.fn(() =>
      okp({ bills: [{ billKey: '12760' } as never], total: 3 })
    );
    const committeeMeetingsCount = vi.fn(() => okp(42));
    const r = await getCommittee(
      deps(
        makeRepo({
          findCommittee,
          listCommitteeRoster,
          listCommitteeLinkedBills,
          committeeMeetingsCount,
        })
      ),
      'cdep:2:2024:1'
    );
    expect(r.isOk()).toBe(true);
    if (r.isOk() && r.value !== null) {
      expect(r.value.committee.committeeKey).toBe('cdep:2:2024:1');
      expect(r.value.members).toHaveLength(1);
      expect(r.value.linkedBills).toHaveLength(1);
      expect(r.value.linkedBillsTotal).toBe(3);
      expect(r.value.meetingsCount).toBe(42);
    }
    // linked bills are fetched with the bounded cap.
    expect(listCommitteeLinkedBills).toHaveBeenCalledWith(
      'cdep:2:2024:1',
      COMMITTEE_LINKED_BILLS_CAP
    );
  });

  it('propagates a repo error from the roster', async () => {
    const findCommittee = vi.fn(() => okp(committee));
    const listCommitteeRoster = vi.fn(() =>
      Promise.resolve(err<never, ApiError>({ type: 'Database', message: 'boom' }))
    );
    const listCommitteeLinkedBills = vi.fn(() => okp({ bills: [], total: 0 }));
    const committeeMeetingsCount = vi.fn(() => okp(0));
    const r = await getCommittee(
      deps(
        makeRepo({
          findCommittee,
          listCommitteeRoster,
          listCommitteeLinkedBills,
          committeeMeetingsCount,
        })
      ),
      'cdep:2:2024:1'
    );
    expect(r.isErr()).toBe(true);
  });
});

describe('getDataFreshness — passthrough (B4)', () => {
  it('returns the repo freshness signals', async () => {
    const dataFreshness = vi.fn(() =>
      okp({ latestVoteDate: '2026-06-30', lastLoadedAt: '2026-07-01T00:00:00Z' })
    );
    const r = await getDataFreshness(deps(makeRepo({ dataFreshness })));
    expect(r.isOk()).toBe(true);
    if (r.isOk()) {
      expect(r.value.latestVoteDate).toBe('2026-06-30');
      expect(r.value.lastLoadedAt).toBe('2026-07-01T00:00:00Z');
    }
  });
});
