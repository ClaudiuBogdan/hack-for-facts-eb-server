import { ok, type Result } from 'neverthrow';
import { describe, expect, it, vi } from 'vitest';

import { PARLIAMENT_BALLOT_PAGE_LIMIT } from '@/modules/parliament/core/constants.js';
import { makeParliamentResolvers } from '@/modules/parliament/shell/graphql/resolvers.js';

import type { ParliamentRepo } from '@/modules/parliament/core/ports.js';
import type {
  ParliamentBallot,
  ParliamentVote,
  ParliamentVoteGroupBreakdown,
} from '@/modules/parliament/core/types.js';
import type { ApiError, CursorPage } from '@/modules/shared/index.js';

const okp = <T>(value: T): Promise<Result<T, ApiError>> => Promise.resolve(ok(value));

const makeRepo = (overrides: Partial<ParliamentRepo>): ParliamentRepo =>
  new Proxy({} as ParliamentRepo, {
    get(_target, property: string) {
      return (
        overrides[property as keyof ParliamentRepo] ??
        ((): never => {
          throw new Error(`unexpected repo call: ${property}`);
        })
      );
    },
  });

const resolverDeps = (repo: ParliamentRepo) => ({
  repo,
  meili: null,
  legalActLoader: undefined,
  searchEngineUp: false,
  isApiKeyAuthorized: (): boolean => false,
  transcriptSearch: null,
});

type FieldResolver = (parent: unknown, args: unknown) => Promise<unknown>;
const fields = (repo: ParliamentRepo, typeName: 'Query' | 'ParliamentVote') =>
  (makeParliamentResolvers(resolverDeps(repo)) as Record<string, Record<string, FieldResolver>>)[
    typeName
  ]!;

const VOTE = { voteKey: 'cdep:37100' } as ParliamentVote;

describe('parliamentVote root', () => {
  it('reads only vote identity so selected child fields can resolve concurrently', async () => {
    const findVote = vi.fn(() => okp<ParliamentVote | null>(VOTE));
    const vote = await fields(makeRepo({ findVote }), 'Query')['parliamentVote']?.(null, {
      voteKey: VOTE.voteKey,
    });

    expect(vote).toEqual(VOTE);
    expect(findVote).toHaveBeenCalledTimes(1);
  });
});

describe('ParliamentVote fields', () => {
  it('loads group breakdown only when the field is selected', async () => {
    const breakdown: readonly ParliamentVoteGroupBreakdown[] = [];
    const voteGroupBreakdown = vi.fn(() => okp(breakdown));
    const value = await fields(makeRepo({ voteGroupBreakdown }), 'ParliamentVote')[
      'groupBreakdown'
    ]?.(VOTE, {});

    expect(value).toEqual(breakdown);
    expect(voteGroupBreakdown).toHaveBeenCalledWith(VOTE.voteKey);
  });

  it('clamps a ballot request to the measured 500-row bound', async () => {
    const page: CursorPage<ParliamentBallot> = { items: [], next: null };
    const listVoteRecords = vi.fn(() => okp(page));
    const value = (await fields(makeRepo({ listVoteRecords }), 'ParliamentVote')['ballots']?.(
      VOTE,
      { first: 999 }
    )) as { readonly edges: readonly unknown[] };

    expect(value.edges).toEqual([]);
    expect(listVoteRecords).toHaveBeenCalledWith(VOTE.voteKey, {
      first: PARLIAMENT_BALLOT_PAGE_LIMIT,
    });
  });
});
