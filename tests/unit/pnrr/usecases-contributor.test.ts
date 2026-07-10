/**
 * PNRR usecases + contributor with a mocked `PnrrRepository` (no live DB).
 * Asserts: usecases delegate to the repo; the contributor wraps the rich profile
 * into the kernel's open `EntityProfileSlice` (single source of truth, §14.7);
 * `presenceFor` badges + the grain note; error propagation.
 */

import { ok, err, type Result } from 'neverthrow';
import { describe, expect, it, vi } from 'vitest';

import { PNRR_GRAIN_NOTE, type PnrrEntityProfile } from '@/modules/pnrr/core/types.js';
import { getPnrrEntityProfile, listPnrrPayments } from '@/modules/pnrr/core/usecases.js';
import { makePnrrContributor, toProfileSlice } from '@/modules/pnrr/shell/contributor.js';
import { databaseError, type ApiError } from '@/modules/shared/index.js';

import type { PnrrRepository } from '@/modules/pnrr/core/ports.js';

const PROFILE: PnrrEntityProfile = {
  cui: '16054368',
  payments: {
    count: 1229,
    totalLei: '6210010594.17',
    totalEur: '1256053436.75',
    firstDate: '2022-09-29',
    lastDate: '2026-05-11',
    byComponent: [{ componentCode: 'C4', count: 1229, totalLei: '6210010594.17' }],
  },
  commitments: {
    count: 32,
    totalValue: '100.00',
    euValue: '80.00',
    avgFinancialProgress: 50,
    avgPhysicalProgress: 40,
  },
  procurement: {
    acquisitionsAsBeneficiary: 0,
    acquisitionsValue: null,
    wonAsContractor: 0,
    wonValue: null,
  },
  grainNote: PNRR_GRAIN_NOTE,
  dataAsOf: '2026-05-19T00:00:00.000Z',
};

const repoStub = (overrides: Partial<PnrrRepository> = {}): PnrrRepository =>
  ({
    getEntityProfile: vi.fn(
      async (): Promise<Result<PnrrEntityProfile | null, ApiError>> => ok(PROFILE)
    ),
    listPayments: vi.fn(async () => ok({ items: [], next: null })),
    ...overrides,
  }) as unknown as PnrrRepository;

describe('pnrr usecases delegate to the repo', () => {
  it('getPnrrEntityProfile returns the repo profile', async () => {
    const repo = repoStub();
    const res = await getPnrrEntityProfile(repo, '16054368');
    expect(res.isOk()).toBe(true);
    if (res.isOk()) expect(res.value?.payments.count).toBe(1229);
  });

  it('listPnrrPayments forwards filter + page to the repo', async () => {
    const listPayments = vi.fn(async () => ok({ items: [], next: null }));
    const repo = repoStub({ listPayments });
    await listPnrrPayments(repo, { beneficiaryCui: { eq: '16054368' } }, { first: 10 });
    expect(listPayments).toHaveBeenCalledWith(
      { beneficiaryCui: { eq: '16054368' } },
      { first: 10 }
    );
  });
});

describe('toProfileSlice — grain-safe projection', () => {
  it('wraps the rich profile into the open EntityProfileSlice with data carried verbatim', () => {
    const slice = toProfileSlice(PROFILE);
    expect(slice.source).toBe('pnrr');
    expect(slice.kind).toBe('pnrr_entity_profile');
    expect(slice.data).toBe(PROFILE); // same object — no second query / divergent path
    expect(slice.summary).toContain('1229 PNRR payment(s)');
  });

  it('the summary never sums payments with commitments (grain separation)', () => {
    const slice = toProfileSlice(PROFILE);
    // 1229 + 32 = 1261 must NOT appear as a combined count anywhere.
    expect(slice.summary).not.toContain('1261');
  });
});

describe('contributor', () => {
  it('presenceFor marks present + emits the beneficiary badge', async () => {
    const repo = repoStub();
    const contributor = makePnrrContributor(repo);
    const res = await contributor.presenceFor('16054368');
    expect(res.isOk()).toBe(true);
    if (res.isOk()) {
      expect(res.value?.present).toBe(true);
      expect(res.value?.label).toBe('PNRR');
      expect(res.value?.badges).toContain('pnrr-beneficiary');
      expect(res.value?.count).toBe(1229);
    }
  });

  it('profileSlice goes through getEntityProfile (single source of truth)', async () => {
    const getEntityProfile = vi.fn(
      async (): Promise<Result<PnrrEntityProfile | null, ApiError>> => ok(PROFILE)
    );
    const repo = repoStub({ getEntityProfile });
    const contributor = makePnrrContributor(repo);
    const res = await contributor.profileSlice!('16054368');
    expect(getEntityProfile).toHaveBeenCalledOnce();
    if (res.isOk())
      expect((res.value?.data as unknown as PnrrEntityProfile).payments.count).toBe(1229);
  });

  it('presence is null when the entity is absent', async () => {
    const repo = repoStub({ getEntityProfile: vi.fn(async () => ok(null)) });
    const contributor = makePnrrContributor(repo);
    const res = await contributor.presenceFor('00000000');
    expect(res.isOk()).toBe(true);
    if (res.isOk()) expect(res.value).toBeNull();
  });

  it('propagates a repo error as Err (never throws)', async () => {
    const repo = repoStub({ getEntityProfile: vi.fn(async () => err(databaseError('boom'))) });
    const contributor = makePnrrContributor(repo);
    const res = await contributor.presenceFor('16054368');
    expect(res.isErr()).toBe(true);
  });
});
