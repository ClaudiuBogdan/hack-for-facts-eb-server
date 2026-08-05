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
 * WHAT CHANGED 2026-08-05: the value used to be dug out of the `attrs` bag by a
 * dedicated resolver — the last reason the bag was shipped across the wire at all.
 * It is now extracted by name in `VOTE_SELECT` and arrives on the domain object,
 * so the default resolver serves it and the custom one is gone.
 *
 * The two properties that resolver owned still have to hold, and they moved into
 * SQL rather than disappearing. This file pins them there:
 *   - an empty or whitespace-only label is published as NULL, never as '';
 *   - a value that is not a JSON string is not coerced into one.
 * Both now come from the shared `attrText` helper, so this file also guards every
 * other key that helper extracts.
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

import { makeParliamentResolvers } from '../../../src/modules/parliament/shell/graphql/resolvers.js';
import { makeParliamentRepo } from '../../../src/modules/parliament/shell/repo/parliament-repo.js';
import { type ProdDatabase } from '../../../src/modules/shared/index.js';

/** Compiles queries without a database; captures the SQL each one emits. */
const captureVoteSql = async (): Promise<string> => {
  const sqls: string[] = [];
  const connection: DatabaseConnection = {
    executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
      sqls.push(query.sql);
      return Promise.resolve({ rows: [] as R[] });
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
  const db = new Kysely<ProdDatabase>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (d) => new PostgresIntrospector(d),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  await makeParliamentRepo(db).findVote('cdep:29892');
  return sqls.join('\n');
};

describe('ParliamentVote.voteSubject', () => {
  it('is served straight off the domain object — no attrs-digging resolver', () => {
    const resolvers = makeParliamentResolvers({} as Parameters<typeof makeParliamentResolvers>[0]);
    const vote = resolvers['ParliamentVote'] as Record<string, unknown>;
    // A custom resolver here would mean the field is being recomputed from
    // something other than the column, which is what this change removed.
    expect(vote['voteSubject']).toBeUndefined();
  });

  it('is reachable at all — the SQL must extract vote_action', async () => {
    // The old guard asserted vote_action stayed on the attrs whitelist, because
    // dropping it would have silently nulled the field for every vote rather than
    // failing anything. The same hazard exists for the SELECT list, so the same
    // guard applies to it.
    expect(await captureVoteSql()).toContain("'vote_action'");
  });

  it('publishes NULL rather than an empty or whitespace-only label', async () => {
    // Null is the honest answer for the many divisions carrying no readable
    // label; '' would render as a blank line that looks like a label the chamber
    // never printed. `nullif(btrim(…), '')` is where that now lives.
    expect(await captureVoteSql()).toContain('nullif(btrim(');
  });

  it('does not coerce a non-string value into a label', async () => {
    // `->>` stringifies whatever it finds, so a numeric or object value would be
    // published as '42' or as raw JSON. The jsonb_typeof guard reproduces the old
    // resolver's `typeof value === 'string'` check inside the query.
    expect(await captureVoteSql()).toContain(
      'jsonb_typeof("v"."attrs"->\'vote_action\') = \'string\''
    );
  });
});
