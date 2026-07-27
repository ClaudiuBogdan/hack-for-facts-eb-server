/**
 * `parliamentVotes(dir:)` — the sort DIRECTION, and the one thing that makes it
 * safe to expose: it is part of the CURSOR IDENTITY, not a display toggle.
 *
 * The resolver used to hardcode `desc` while the usecase and the repo already took
 * a direction, so "oldest first" was unreachable from GraphQL. Exposing it is two
 * lines; what needs pinning is everything around them:
 *
 *   1. DESC stays the default, so every existing caller keeps its order.
 *   2. A cursor minted under DESC replayed under ASC is a clean INVALID_INPUT
 *      ("restart pagination") — the SAME refusal the group-case-mismatch produces.
 *      Silently accepting it would page the reversed keyset from a key that means
 *      the opposite end of the list: not an error the client can see, just wrong
 *      rows.
 *   3. The keyset predicate and the ORDER BY flip TOGETHER, for BOTH sorts —
 *      `voteKey` (a single-column keyset) as much as `voteDate` (a two-column one).
 *      A half-flipped pair is the classic way an ascending page repeats or skips.
 *
 * The SQL is compiled by the REAL Kysely query against a capturing driver, so what
 * is asserted here is what ships.
 */

import { buildSchema } from 'graphql';
import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type Driver,
  type QueryResult,
} from 'kysely';
import { ok, type Result } from 'neverthrow';
import { describe, expect, it, vi } from 'vitest';

import { votesFilterSpec } from '@/modules/parliament/shell/filters/specs.js';
import { makeParliamentResolvers } from '@/modules/parliament/shell/graphql/resolvers.js';
import { parliamentTypeDefs } from '@/modules/parliament/shell/graphql/typedefs.js';
import { makeParliamentRepo } from '@/modules/parliament/shell/repo/parliament-repo.js';
import {
  buildNextCursor,
  decodeCursor,
  fhashFor,
  type ApiError,
  type CursorPage,
  type FilterInput,
  type ProdDatabase,
} from '@/modules/shared/index.js';

import type { ParliamentRepo } from '@/modules/parliament/core/ports.js';
import type { ParliamentVote } from '@/modules/parliament/core/types.js';

interface Captured {
  readonly sql: string;
  readonly parameters: readonly unknown[];
}

const makeCapturingDb = (captured: Captured[]): Kysely<ProdDatabase> => {
  const connection: DatabaseConnection = {
    executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
      captured.push({ sql: query.sql, parameters: query.parameters });
      return Promise.resolve({ rows: [] as R[] });
    },
    streamQuery(): AsyncIterableIterator<QueryResult<never>> {
      throw new Error('streamQuery not supported in the capturing db');
    },
  };
  const driver: Driver = {
    init: () => Promise.resolve(),
    acquireConnection: () => Promise.resolve(connection),
    beginTransaction: () => Promise.resolve(),
    commitTransaction: () => Promise.resolve(),
    rollbackTransaction: () => Promise.resolve(),
    releaseConnection: () => Promise.resolve(),
    destroy: () => Promise.resolve(),
  };
  return new Kysely<ProdDatabase>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (db) => new PostgresIntrospector(db),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
};

/** Collapse whitespace so the raw keyset predicate can be asserted on substrings. */
const flat = (s: string): string => s.replace(/\s+/gu, ' ').trim();

const FILTER: FilterInput = { chamber: { eq: 'senat' } };

/**
 * Compile the real listVotes PAGE query (it issues the page and the capped total
 * concurrently, so the page is picked by its `order by`).
 */
const compileVotes = async (
  sort: string,
  dir: 'asc' | 'desc',
  after?: string
): Promise<Captured> => {
  const captured: Captured[] = [];
  const repo = makeParliamentRepo(makeCapturingDb(captured));
  const res = await repo.listVotes(FILTER, sort, dir, {
    first: 20,
    ...(after !== undefined && { after }),
  });
  expect(res.isOk()).toBe(true);
  const query = captured.find((c) => c.sql.includes('order by'));
  if (query === undefined) throw new Error('no page query captured');
  return { sql: flat(query.sql), parameters: query.parameters };
};

/** A cursor for FILTER as the repo itself would mint it. */
const mintCursor = (sort: string, dir: 'asc' | 'desc'): string =>
  buildNextCursor({
    sort,
    dir,
    fhash: fhashFor(votesFilterSpec, FILTER),
    lastKeys: sort === 'voteKey' ? ['cdep:37014'] : ['2026-05-13', 'cdep:37014'],
  });

describe('parliamentVotes(dir:) — the SDL surface', () => {
  const schema = buildSchema(`
    scalar Date
    scalar DateTime
    scalar BigInt
    scalar JSON
    type PageInfo { hasNextPage: Boolean!  endCursor: String }
    type Entity { cui: String! }
    type Query { _root: Boolean }
    ${parliamentTypeDefs}
  `);

  it('exposes dir: ParliamentSortDir with DESC as the default (existing callers unaffected)', () => {
    const field = schema.getQueryType()?.getFields()['parliamentVotes'];
    expect(field).toBeDefined();
    const dir = field?.args.find((a) => a.name === 'dir');
    expect(dir).toBeDefined();
    expect(String(dir?.type)).toBe('ParliamentSortDir');
    // The default is what keeps this additive: no client that omits `dir` moves.
    expect(dir?.defaultValue).toBe('DESC');
  });

  it('reuses ONE asc/desc vocabulary — the module-local ASC/DESC enum, not a second convention', () => {
    const dirEnum = schema.getType('ParliamentSortDir');
    const values =
      dirEnum !== undefined && dirEnum !== null && 'getValues' in dirEnum
        ? dirEnum.getValues().map((v) => v.name)
        : [];
    expect(values).toEqual(['ASC', 'DESC']);
    // `sort` stays a separate key enum (voteDate/voteKey) rather than growing
    // `voteDate_asc`-style combined values — one direction vocabulary, not two.
    const sortEnum = schema.getType('ParliamentVoteSort');
    const sortValues =
      sortEnum !== undefined && sortEnum !== null && 'getValues' in sortEnum
        ? sortEnum.getValues().map((v) => v.name)
        : [];
    expect(sortValues).toEqual(['voteDate', 'voteKey']);
  });
});

describe('parliamentVotes(dir:) — the resolver threads it through', () => {
  const okp = <T>(v: T): Promise<Result<T, ApiError>> => Promise.resolve(ok(v));
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

  const VOTE = {
    voteKey: 'cdep:37014',
    voteDate: '2026-05-13',
  } as unknown as ParliamentVote;

  const runVotes = async (
    args: Record<string, unknown>
  ): Promise<{ dir: unknown; cursor: string }> => {
    const listVotes = vi.fn(
      (
        _f: FilterInput,
        _sort: string,
        _dir: 'asc' | 'desc'
      ): Promise<
        Result<CursorPage<ParliamentVote> & { total: number; totalEstimated: boolean }, ApiError>
      > => okp({ items: [VOTE], next: null, total: 1, totalEstimated: false })
    );
    const resolvers = makeParliamentResolvers({
      repo: makeRepo({ listVotes }),
      meili: null,
      legalActLoader: undefined,
      searchEngineUp: false,
      isApiKeyAuthorized: (): boolean => false,
      transcriptSearch: null,
    }) as Record<string, Record<string, (p: unknown, a: unknown) => Promise<unknown>>>;
    const conn = (await resolvers['Query']?.['parliamentVotes']?.(null, {
      filter: { chamber: { eq: 'senat' } },
      ...args,
    })) as { edges: readonly { cursor: string }[] };
    const call = listVotes.mock.calls[0];
    return { dir: call?.[2], cursor: conn.edges[0]?.cursor ?? '' };
  };

  it('defaults to desc when dir is omitted', async () => {
    expect((await runVotes({})).dir).toBe('desc');
  });

  it('maps ASC → asc', async () => {
    expect((await runVotes({ dir: 'ASC' })).dir).toBe('asc');
  });

  it('stamps the ACTIVE dir into every per-edge cursor, not the default', async () => {
    const fhash = fhashFor(votesFilterSpec, { chamber: { eq: 'senat' } });
    const { cursor } = await runVotes({ dir: 'ASC' });
    // An edge cursor that still said `desc` would be accepted by the next ASC page
    // and then read the keyset backwards — the failure this stamping prevents.
    expect(decodeCursor(cursor, { sort: 'voteDate', dir: 'asc', fhash }).isOk()).toBe(true);
    expect(decodeCursor(cursor, { sort: 'voteDate', dir: 'desc', fhash }).isErr()).toBe(true);
  });
});

describe('parliamentVotes(dir:) — the keyset and the ORDER BY flip together', () => {
  it('voteDate/asc orders ascending and walks the keyset FORWARD', async () => {
    const captured = await compileVotes('voteDate', 'asc', mintCursor('voteDate', 'asc'));
    expect(captured.sql).toContain(`order by coalesce(v.vote_date::text, '') asc, v.vote_key asc`);
    // `>` against the last row, matching the ascending order — a `<` here would
    // re-serve page 1 forever.
    expect(captured.sql).toContain(`(coalesce(v.vote_date::text, ''), v.vote_key) > ($2, $3)`);
    expect(captured.parameters).toContain('2026-05-13');
  });

  it('voteDate/desc is unchanged (the default path)', async () => {
    const captured = await compileVotes('voteDate', 'desc', mintCursor('voteDate', 'desc'));
    expect(captured.sql).toContain(
      `order by coalesce(v.vote_date::text, '') desc, v.vote_key desc`
    );
    expect(captured.sql).toContain(`(coalesce(v.vote_date::text, ''), v.vote_key) < ($2, $3)`);
  });

  it('voteKey/asc pages too — the single-column keyset flips with it', async () => {
    const captured = await compileVotes('voteKey', 'asc', mintCursor('voteKey', 'asc'));
    expect(captured.sql).toContain('order by v.vote_key asc');
    expect(captured.sql).toContain('v.vote_key > $2');
    // The date is projected but never sorted or seeked on under this sort.
    expect(captured.sql).not.toContain(`coalesce(v.vote_date::text, '')`);
    expect(captured.parameters).toContain('cdep:37014');
  });

  it('voteKey/desc keeps its own pairing', async () => {
    const captured = await compileVotes('voteKey', 'desc', mintCursor('voteKey', 'desc'));
    expect(captured.sql).toContain('order by v.vote_key desc');
    expect(captured.sql).toContain('v.vote_key < $2');
  });
});

describe('parliamentVotes(dir:) — dir is CURSOR IDENTITY, exactly like sort', () => {
  const replay = async (
    minted: 'asc' | 'desc',
    replayed: 'asc' | 'desc',
    sort = 'voteDate'
  ): Promise<Result<unknown, ApiError>> => {
    const repo = makeParliamentRepo(makeCapturingDb([]));
    return repo.listVotes(FILTER, sort, replayed, {
      first: 20,
      after: mintCursor(sort, minted),
    });
  };

  it('REFUSES a desc cursor replayed under asc (the same clean INVALID_INPUT as a filter mismatch)', async () => {
    const r = await replay('desc', 'asc');
    expect(r.isErr()).toBe(true);
    if (r.isErr()) {
      expect(r.error.type).toBe('InvalidInput');
      expect(r.error.message).toContain('cursor');
      // "restart pagination" is the actionable half — the client resets to page 1.
      expect(r.error.message).toContain('restart pagination');
    }
  });

  it('REFUSES an asc cursor replayed under desc, and on the voteKey sort too', async () => {
    for (const [minted, replayed] of [
      ['asc', 'desc'],
      ['desc', 'asc'],
    ] as const) {
      for (const sort of ['voteDate', 'voteKey']) {
        const r = await replay(minted, replayed, sort);
        expect(r.isErr(), `${sort} ${minted}→${replayed}`).toBe(true);
      }
    }
  });

  it('ACCEPTS a cursor replayed under the direction it was minted with', async () => {
    for (const dir of ['asc', 'desc'] as const) {
      for (const sort of ['voteDate', 'voteKey']) {
        expect((await replay(dir, dir, sort)).isOk(), `${sort} ${dir}`).toBe(true);
      }
    }
  });
});
