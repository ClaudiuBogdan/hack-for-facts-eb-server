/**
 * Regression: an ANCILLARY read must never turn a real member into a false 404.
 *
 * Live blocker (reproduced 2026-07-26 against the local prod-DB tunnel):
 *
 *   query { parliamentMember(mandateKey: "1:2024:7") { mandateKey fullName } }
 *   → { "parliamentMember": null, errors: ["listMemberInitiatives failed"] }
 *
 * The row existed. `getMember` eagerly fanned out to `findPerson` +
 * `listGroupIntervals` + FIVE count queries (seven concurrent DB round trips) and
 * returned `err` if ANY of them failed, so a single flaky ancillary query nulled
 * the whole member — after several seconds of loading. The identity fields the
 * deep-link actually asked for need exactly ONE query.
 *
 * These tests pin the two invariants:
 *   1. the member root reads ONLY `findMember` (the stub repo throws on any other
 *      call, so an eager fan-out fails the test loudly), and
 *   2. `activityCounts` degrades to `null` — "unavailable" — never to fabricated
 *      zeros (indistinguishable from a member who genuinely never voted) and never
 *      to a throw (which non-null propagation would turn back into a null member).
 */

import { err, ok, type Result } from 'neverthrow';
import { describe, expect, it, vi } from 'vitest';

import { getMember, getMemberActivityCounts } from '@/modules/parliament/core/usecases.js';
import { makeParliamentResolvers } from '@/modules/parliament/shell/graphql/resolvers.js';
import { databaseError, type ApiError } from '@/modules/shared/index.js';

import type { ParliamentRepo } from '@/modules/parliament/core/ports.js';
import type {
  ParliamentActivityCounts,
  ParliamentMember,
} from '@/modules/parliament/core/types.js';

const okp = <T>(v: T): Promise<Result<T, ApiError>> => Promise.resolve(ok(v));
const errp = <T>(message: string): Promise<Result<T, ApiError>> =>
  Promise.resolve(err(databaseError(message)));

/** Every method throws unless overridden — an unexpected eager read fails loudly. */
const makeRepo = (over: Partial<ParliamentRepo>): ParliamentRepo =>
  new Proxy({} as ParliamentRepo, {
    get(_t, prop: string) {
      return (
        over[prop as keyof ParliamentRepo] ??
        ((): never => {
          throw new Error(`unexpected repo call: ${prop}`);
        })
      );
    },
  });

const MEMBER: ParliamentMember = {
  mandateKey: '1:2024:7',
  chamber: 'senat',
  legislature: '2024',
  fullName: 'Barcari Dorina',
  normalizedName: 'barcari dorina',
  groupName: 'AUR',
  groupId: 'aur-senat',
  constituencyName: 'BRAŞOV',
  birthDate: null,
  profileUrl: null,
  cvPdfUrl: null,
  isCurrent: true,
  mandateEndDate: null,
  mandateEndReason: null,
  personId: '4242',
  attrs: {},
};

const COUNTS: ParliamentActivityCounts = {
  votes: 1084,
  controlItems: 0,
  speeches: 6252,
  initiatives: 31,
  declarations: 0,
};

const resolverDeps = (repo: ParliamentRepo) => ({
  repo,
  meili: null,
  legalActLoader: undefined,
  searchEngineUp: false,
  isApiKeyAuthorized: (): boolean => false,
});

type FieldResolver = (parent: unknown, args: unknown) => Promise<unknown>;
const memberFields = (repo: ParliamentRepo): Record<string, FieldResolver> =>
  (makeParliamentResolvers(resolverDeps(repo)) as Record<string, Record<string, FieldResolver>>)[
    'ParliamentMember'
  ]!;
const queryFields = (repo: ParliamentRepo): Record<string, FieldResolver> =>
  (makeParliamentResolvers(resolverDeps(repo)) as Record<string, Record<string, FieldResolver>>)[
    'Query'
  ]!;

describe('getMember — identity is ONE query, never a fan-out', () => {
  it('reads only findMember (the stub throws on any ancillary call)', async () => {
    const findMember = vi.fn(() => okp<ParliamentMember | null>(MEMBER));
    const r = await getMember({ repo: makeRepo({ findMember }), meili: null }, '1:2024:7');

    expect(r.isOk()).toBe(true);
    expect(r._unsafeUnwrap()).toEqual(MEMBER);
    expect(findMember).toHaveBeenCalledTimes(1);
  });

  it('returns null (a real not-found) when the row is absent — still one query', async () => {
    const findMember = vi.fn(() => okp<ParliamentMember | null>(null));
    const r = await getMember({ repo: makeRepo({ findMember }), meili: null }, '9:9999:99999');

    expect(r.isOk()).toBe(true);
    expect(r._unsafeUnwrap()).toBeNull();
  });

  it('propagates a genuine identity-read failure as an error, not as not-found', async () => {
    const findMember = vi.fn(() => errp<ParliamentMember | null>('findMember failed'));
    const r = await getMember({ repo: makeRepo({ findMember }), meili: null }, '1:2024:7');

    expect(r.isErr()).toBe(true);
    expect(r._unsafeUnwrapErr().type).toBe('Database');
  });
});

describe('parliamentMember root — an ancillary failure cannot 404 a valid member', () => {
  it('returns the identity even when every ancillary read is broken', async () => {
    // The repo exposes ONLY findMember; person / intervals / counts all throw.
    const repo = makeRepo({ findMember: () => okp<ParliamentMember | null>(MEMBER) });

    const member = await queryFields(repo)['parliamentMember']?.(null, {
      mandateKey: '1:2024:7',
    });

    expect(member).toEqual(MEMBER);
  });
});

describe('ParliamentMember.activityCounts — honest unavailable, never invented zeros', () => {
  it('resolves the counts in a single repo call', async () => {
    const memberActivityCounts = vi.fn(() => okp(COUNTS));
    const counts = await memberFields(makeRepo({ memberActivityCounts }))['activityCounts']?.(
      { mandateKey: '1:2024:7' },
      {}
    );

    expect(counts).toEqual(COUNTS);
    expect(memberActivityCounts).toHaveBeenCalledTimes(1);
    expect(memberActivityCounts).toHaveBeenCalledWith('1:2024:7');
  });

  it('returns null — not a zero-filled object — when the counts read fails', async () => {
    const memberActivityCounts = vi.fn(() =>
      errp<ParliamentActivityCounts>('memberActivityCounts failed')
    );
    const counts = await memberFields(makeRepo({ memberActivityCounts }))['activityCounts']?.(
      { mandateKey: '1:2024:7' },
      {}
    );

    expect(counts).toBeNull();
    // The old fallback fabricated all-zero counts, which a client cannot tell
    // apart from a member who genuinely never voted or spoke.
    expect(counts).not.toEqual({
      votes: 0,
      controlItems: 0,
      speeches: 0,
      initiatives: 0,
      declarations: 0,
    });
  });

  it('never throws out of the field resolver (a throw would null the member)', async () => {
    const memberActivityCounts = vi.fn(() =>
      errp<ParliamentActivityCounts>('memberActivityCounts failed')
    );
    await expect(
      memberFields(makeRepo({ memberActivityCounts }))['activityCounts']?.(
        { mandateKey: '1:2024:7' },
        {}
      )
    ).resolves.toBeNull();
  });

  it('passes through a pre-seeded value without a second read', async () => {
    const counts = await memberFields(makeRepo({}))['activityCounts']?.(
      { mandateKey: '1:2024:7', activityCounts: COUNTS },
      {}
    );

    expect(counts).toEqual(COUNTS);
  });
});

describe('getMemberActivityCounts — one bounded round trip', () => {
  it('delegates straight to the repo', async () => {
    const memberActivityCounts = vi.fn(() => okp(COUNTS));
    const r = await getMemberActivityCounts(
      { repo: makeRepo({ memberActivityCounts }), meili: null },
      '2:2024:100'
    );

    expect(r._unsafeUnwrap()).toEqual(COUNTS);
    expect(memberActivityCounts).toHaveBeenCalledWith('2:2024:100');
  });
});
