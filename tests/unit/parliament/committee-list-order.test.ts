/**
 * `parliamentCommittees` ordering (2026-08-05).
 *
 * The list used to be ordered by `committee_key` — an opaque per-chamber id
 * (`cdep:2:2024:11`, or a Senate UUID). That scattered each chamber's
 * committees arbitrarily: on live data the two Senate rows named
 * "Comisia pentru comunicații…" landed at #54 and #172 of 191, so a client
 * holding a bounded prefix showed one and not the other, which read to a
 * reader as the committee not existing.
 *
 * These pin the two properties a caller depends on: the ORDER (name, with the
 * key as tiebreak) and the CURSOR (both keys, so duplicate names — 38 names
 * repeat on live Senate data, one of them 9 times — page deterministically).
 */
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
import { describe, expect, it } from 'vitest';

import { makeParliamentResolvers } from '@/modules/parliament/shell/graphql/resolvers.js';
import { makeParliamentRepo } from '@/modules/parliament/shell/repo/parliament-repo.js';
import {
  buildNextCursor,
  decodeCursor,
  filterHash,
  type ProdDatabase,
} from '@/modules/shared/index.js';

interface Captured {
  readonly sql: string;
  readonly parameters: readonly unknown[];
}

const makeDb = (captured: Captured[], rows: readonly unknown[]): Kysely<ProdDatabase> => {
  const connection: DatabaseConnection = {
    executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
      captured.push({ sql: query.sql, parameters: query.parameters });
      return Promise.resolve({ rows: rows as R[] });
    },
    streamQuery(): AsyncIterableIterator<QueryResult<never>> {
      throw new Error('streamQuery not supported');
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

const flat = (s: string): string => s.replace(/\s+/gu, ' ').trim();

const row = (key: string, name: string) => ({
  committee_key: key,
  chamber: 'senate',
  name,
  legislature: null,
  committee_type: 'permanent',
  source_url: 'https://www.senat.ro/EnumComisii.aspx?Permanenta=1',
});

describe('listCommittees — ordering', () => {
  it('orders by name, with committee_key as the tiebreak (never by key alone)', async () => {
    const captured: Captured[] = [];
    const repo = makeParliamentRepo(makeDb(captured, [row('senate:a', 'Comisia A')]));

    const res = await repo.listCommittees(undefined, undefined, { first: 10 });

    expect(res.isOk()).toBe(true);
    const sqlText = flat(captured[0]!.sql);
    expect(sqlText).toContain('order by "co"."name" asc, "co"."committee_key" asc');
  });

  it('mints a two-key cursor carrying the name AND the key', async () => {
    const captured: Captured[] = [];
    // limit+1 rows -> hasMore, so a cursor is minted off the LAST served row.
    const repo = makeParliamentRepo(
      makeDb(captured, [row('senate:a', 'Comisia A'), row('senate:b', 'Comisia B')])
    );

    const res = await repo.listCommittees(undefined, undefined, { first: 1 });

    const next = res._unsafeUnwrap().next;
    expect(next).not.toBeNull();
    // Decoded through the PRODUCTION helper, so the assertion also proves the
    // envelope this repo mints is one `decodeCursor` accepts under the new sort.
    const dec = decodeCursor(next!, {
      sort: 'committeeName',
      dir: 'asc',
      fhash: filterHash('committees::'),
    });
    expect(dec.isOk()).toBe(true);
    expect(dec._unsafeUnwrap().keys).toEqual(['Comisia A', 'senate:a']);
  });

  it('pages DUPLICATE names on the tiebreak, so an identical name cannot stall', async () => {
    // Both rows carry the SAME name — the case that actually exercises the
    // tiebreak (38 Senate names repeat on live data, one of them 9 times). A
    // cursor carrying only the name would emit `name > 'Comisia X'` and skip the
    // twin; one carrying only the key would not match the ORDER BY. Both keys,
    // in that order, is the only shape that pages this correctly.
    //
    // Execution-level proof is separate, and was run against LIVE prod: all 191
    // Senate committees over 2 pages came back byte-sorted across the page seam
    // with zero duplicates and zero skips.
    const captured: Captured[] = [];
    const repo = makeParliamentRepo(
      makeDb(captured, [row('senate:a', 'Comisia X'), row('senate:b', 'Comisia X')])
    );
    const first = await repo.listCommittees('senat', undefined, { first: 1 });
    const cursor = first._unsafeUnwrap().next!;

    captured.length = 0;
    const second = await repo.listCommittees('senat', undefined, { first: 1, after: cursor });

    expect(second.isOk()).toBe(true);
    const sqlText = flat(captured[0]!.sql);
    // Raw `sql` fragments render UNQUOTED — assert what Kysely actually emits.
    expect(sqlText).toContain('(co.name, co.committee_key) > ($2, $3)');
    // The SHARED name plus the served row's own key: the twin at
    // ('Comisia X', 'senate:b') is strictly greater, so it comes next.
    expect(captured[0]!.parameters).toEqual(['senate', 'Comisia X', 'senate:a', 2]);
  });

  it('the EDGE cursor the GraphQL layer mints is one the repo can replay', async () => {
    // `committeeConnection` mints a per-edge cursor independently of the repo's
    // `pageInfo.endCursor`. It was left on the old `committeeKey`/1-key shape,
    // so every caller resuming from an edge cursor (rather than endCursor) got
    // InvalidInput — invisible to our own client, which reads endCursor.
    const captured: Captured[] = [];
    const repo = makeParliamentRepo(
      makeDb(captured, [row('senate:a', 'Comisia X'), row('senate:b', 'Comisia X')])
    );
    const resolvers = makeParliamentResolvers({
      repo,
      meili: null,
      legalActLoader: undefined,
      searchEngineUp: false,
      isApiKeyAuthorized: (): boolean => false,
      transcriptSearch: null,
    }) as Record<string, Record<string, (p: unknown, a: unknown) => Promise<unknown>>>;

    const conn = (await resolvers['Query']!['parliamentCommittees']!(null, {
      chamber: 'senat',
      first: 1,
    })) as { edges: readonly { cursor: string }[] };
    const edgeCursor = conn.edges[0]!.cursor;

    captured.length = 0;
    const replay = await repo.listCommittees('senat', undefined, { first: 1, after: edgeCursor });

    expect(replay.isOk()).toBe(true);
    expect(captured[0]!.parameters).toEqual(['senate', 'Comisia X', 'senate:a', 2]);
  });

  it('rejects a cursor minted under the OLD committee_key sort (graceful restart)', async () => {
    const captured: Captured[] = [];
    const repo = makeParliamentRepo(makeDb(captured, []));
    // The fhash is the CORRECT one, so the ONLY thing wrong with this cursor is
    // its sort id + arity. A junk fhash would make this pass for the wrong
    // reason — it would be rejected as a filter mismatch, proving nothing about
    // the sort change.
    const stale = buildNextCursor({
      sort: 'committeeKey',
      dir: 'asc',
      fhash: filterHash('committees::'),
      lastKeys: ['senate:a'],
    });

    const res = await repo.listCommittees(undefined, undefined, { first: 10, after: stale });

    expect(res.isErr()).toBe(true);
    expect(res._unsafeUnwrapErr().type).toBe('InvalidInput');
    expect(captured).toHaveLength(0);
  });

  it('a cursor with the right sort but ONE key is rejected on arity, not misread', async () => {
    // Guards the other half of the migration: same sort id, old single key.
    const captured: Captured[] = [];
    const repo = makeParliamentRepo(makeDb(captured, []));
    const wrongArity = buildNextCursor({
      sort: 'committeeName',
      dir: 'asc',
      fhash: filterHash('committees::'),
      lastKeys: ['senate:a'],
    });

    const res = await repo.listCommittees(undefined, undefined, { first: 10, after: wrongArity });

    expect(res.isErr()).toBe(true);
    expect(res._unsafeUnwrapErr().type).toBe('InvalidInput');
    expect(captured).toHaveLength(0);
  });
});
