/**
 * Legal — the ONE act a user-facing reference names (I-21). Only an input that
 * is wholly one identity names an act: one bare citation or one alias, held by
 * one act. Several holders are an ambiguity listed for the caller, never the
 * most-cited holder; any other input lists its candidates, even a single one.
 */

import { ok } from 'neverthrow';
import { describe, expect, it, vi } from 'vitest';

import { getAct, resolveCitedAct } from '@/modules/legal/core/usecases.js';

import type { LegalActsRepo } from '@/modules/legal/core/ports.js';
import type { LegalAct, LegalActCard } from '@/modules/legal/core/types.js';

const act = (
  actId: string,
  issuerSlug: string,
  displayCitation = 'Ordinul nr. 1/2020'
): LegalAct => ({
  actId,
  actNaturalKey: `ordin:1:2020:${issuerSlug}`,
  actType: 'ordin',
  actNumber: '1',
  actYear: 2020,
  issuerSlug,
  canonicalDocumentId: null,
  displayCitation,
  status: 'in-vigoare',
  statusEvidence: {},
  entryIntoForce: null,
  inDegree: 0,
});

// Production's seven holders of "Ordinul nr. 1/2020", in_degree desc then act_id.
const seven = [
  act('103577', 'ministerul-sanatatii'),
  act('103638', 'ministerul-finantelor-publice'),
  act('103694', 'ministerul-afacerilor-interne'),
  act('103756', 'anre'),
  act('103982', 'ministerul-agriculturii'),
  act('103990', 'ancpi'),
  act('105085', 'banca-nationala-a-romaniei'),
];

const law227 = act('70001', 'parlamentul', 'Legea nr. 227/2015');

/**
 * The repo's three reads, each answering from its own fixture: holders of the
 * exact citation number, holders of the whole input as an alias, and the
 * permissive candidate list (first number/year, alias, name fragment).
 */
const repo = (fixture: {
  byNumber?: readonly LegalAct[];
  byAlias?: readonly LegalAct[];
  candidates?: readonly LegalAct[];
}) => {
  const all = [
    ...(fixture.byNumber ?? []),
    ...(fixture.byAlias ?? []),
    ...(fixture.candidates ?? []),
  ];
  const getActCard = vi.fn(async (ref: { actId?: string }) =>
    ok({ ...all.find((a) => a.actId === ref.actId), summary: null } as unknown as LegalActCard)
  );
  return {
    getActCard,
    findActById: vi.fn(async (id: string) => ok(all.find((a) => a.actId === id) ?? null)),
    findActsByCitationNumber: vi.fn(async (_k: unknown, limit: number) =>
      ok((fixture.byNumber ?? []).slice(0, limit + 1))
    ),
    findActsByAlias: vi.fn(async (_alias: string, limit: number) =>
      ok((fixture.byAlias ?? []).slice(0, limit + 1))
    ),
    resolveActCandidates: vi.fn(async () => ok(fixture.candidates ?? [])),
  } as unknown as LegalActsRepo & {
    getActCard: typeof getActCard;
    findActsByCitationNumber: ReturnType<typeof vi.fn>;
    findActsByAlias: ReturnType<typeof vi.fn>;
    resolveActCandidates: ReturnType<typeof vi.fn>;
  };
};

describe('resolveCitedAct / getAct (I-21)', () => {
  it('an actId is that act, without resolving a citation', async () => {
    const r = repo({ byNumber: seven });
    const res = await resolveCitedAct(r, { actId: '103638' });
    expect(res._unsafeUnwrap()?.actId).toBe('103638');
    expect(r.findActsByCitationNumber).not.toHaveBeenCalled();
    expect(r.resolveActCandidates).not.toHaveBeenCalled();
  });

  it('a bare citation one act holds is that act', async () => {
    const r = repo({ byNumber: [seven[1]!] });
    const card = (await getAct(r, { citation: 'Ordinul nr. 1/2020' }))._unsafeUnwrap();
    expect(card?.actId).toBe('103638');
    expect(r.findActsByCitationNumber).toHaveBeenCalledWith(
      { actType: 'ordin', actNumber: '1', actYear: 2020, issuerSlug: '' },
      25
    );
  });

  it('a citation seven acts hold is an ambiguity naming them, not the most-cited one', async () => {
    const r = repo({ byNumber: seven });
    const res = await getAct(r, { citation: 'ordinul 1/2020' });
    expect(res.isErr()).toBe(true);
    const message = res._unsafeUnwrapErr().message;
    expect(message).toContain('matches 7 acts — pass actId');
    for (const a of seven) expect(message).toContain(a.actId);
    expect(r.getActCard).not.toHaveBeenCalled();
  });

  it('a capped holder read is a lower bound, not a count', async () => {
    const many = Array.from({ length: 26 }, (_, i) =>
      act(String(200000 + i), `emitent-${String(i)}`)
    );
    const res = await getAct(repo({ byNumber: many }), { citation: 'ordinul 1/2020' });
    expect(res._unsafeUnwrapErr().message).toContain('matches at least 25 acts');
  });

  it('issuer words are refused even when one act is returned for the number', async () => {
    // The audit's witness. The words name the Finance ministry; no key checks them.
    const r = repo({ candidates: [seven[0]!] });
    const res = await getAct(r, { citation: 'ordinul ministrului finanțelor nr. 1/2020' });
    expect(res.isErr()).toBe(true);
    expect(res._unsafeUnwrapErr().message).toContain('is not exactly one citation');
    expect(res._unsafeUnwrapErr().message).toContain('103577');
    expect(r.findActsByCitationNumber).not.toHaveBeenCalled();
    expect(r.getActCard).not.toHaveBeenCalled();
  });

  it('a second citation is refused, not dropped (Sol r2)', async () => {
    const r = repo({ candidates: [law227] });
    const res = await getAct(r, { citation: 'legea 227/2015 și legea 95/2006' });
    expect(res.isErr()).toBe(true);
    expect(res._unsafeUnwrapErr().message).toContain('1 candidate(s) returned');
    expect(r.getActCard).not.toHaveBeenCalled();
  });

  it('a name fragment one act matches is a candidate, not an identity', async () => {
    const r = repo({ candidates: [law227] });
    const res = await getAct(r, { citation: 'privind codul' });
    expect(res.isErr()).toBe(true);
    expect(r.getActCard).not.toHaveBeenCalled();
  });

  it('an alias one act holds is that act; one several hold is an ambiguity', async () => {
    const fiscal = act('80001', 'parlamentul', 'Legea nr. 227/2015');
    expect(
      (await getAct(repo({ byAlias: [fiscal] }), { citation: 'codul fiscal' }))._unsafeUnwrap()
        ?.actId
    ).toBe('80001');
    const muncii = [act('80010', 'a'), act('80011', 'b'), act('80012', 'c')];
    const res = await getAct(repo({ byAlias: muncii }), { citation: 'codul muncii' });
    expect(res._unsafeUnwrapErr().message).toContain('matches 3 acts — pass actId');
  });

  it('no candidate is no act', async () => {
    expect((await getAct(repo({}), { citation: 'legea 99999/2099' }))._unsafeUnwrap()).toBeNull();
    expect((await getAct(repo({}), { citation: '   ' }))._unsafeUnwrap()).toBeNull();
  });
});
