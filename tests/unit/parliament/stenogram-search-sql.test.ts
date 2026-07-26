/**
 * The canonical full-history transcript SEARCH projection, at the SQL level.
 *
 * The four properties asserted here are the ones a reviewer cannot verify by reading
 * the port's return type, and each has a concrete failure mode behind it:
 *  1. grouping/ranking happen BEFORE the cap — else one long sitting crowds every other
 *     sitting out of the result and the user concludes only one sitting ever mentioned
 *     the term;
 *  2. `attrs.session_key` is the ONLY session attribution — the doc_id
 *     (`parliament:speech:canon:cdep:9043#00004`) is colon-rich and splitting it
 *     mis-attributes blocks;
 *  3. only canonical PUBLIC reading blocks are considered, on both the `visibility`
 *     column AND the mirrored `attrs.privacy_class`;
 *  4. an unavailable projection is reported as such — never as "no matches", and never
 *     degraded to a title-only query.
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

import { PARLIAMENT_TRANSCRIPT_SEARCH_DOC_TYPE } from '@/modules/parliament/core/types.js';
import { makeParliamentTranscriptSearch } from '@/modules/parliament/shell/search/transcript-search.js';

import type { ProdDatabase } from '@/modules/shared/index.js';

interface Captured {
  readonly sql: string;
  readonly parameters: readonly unknown[];
}

/**
 * A capturing driver. `rows` is what every statement returns (so the availability probe
 * can be made to succeed), and `throwOn` simulates an unreadable `search.documents`.
 */
const makeCapturingDb = (
  captured: Captured[],
  opts: { rows?: readonly Record<string, unknown>[]; throwOn?: RegExp } = {}
): Kysely<ProdDatabase> => {
  const connection: DatabaseConnection = {
    async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
      captured.push({ sql: query.sql, parameters: query.parameters });
      if (opts.throwOn?.test(query.sql) === true) {
        throw new Error('relation "search.documents" does not exist');
      }
      return { rows: (opts.rows ?? []) as R[] };
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

describe('transcript search — availability is honest about WHICH way it is missing', () => {
  it('reports doc_type_unbuilt when search.documents is readable but holds no such doc', async () => {
    const captured: Captured[] = [];
    const search = makeParliamentTranscriptSearch(makeCapturingDb(captured));

    const probe = await search.available();
    expect(probe).toEqual({ available: false, reason: 'doc_type_unbuilt' });
    // The probe requires an ATTRIBUTABLE public doc, not merely a row.
    const sql = captured.at(-1)?.sql ?? '';
    expect(sql).toContain('doc_type');
    expect(sql).toContain('visibility');
    expect(sql).toContain('deleted_at');
    expect(sql).toContain("attrs->>'session_key'");
    expect(captured.at(-1)?.parameters).toContain(PARLIAMENT_TRANSCRIPT_SEARCH_DOC_TYPE);
  });

  it('reports relation_unavailable when search.documents cannot be read at all', async () => {
    const captured: Captured[] = [];
    const search = makeParliamentTranscriptSearch(
      // Kysely quotes the schema-qualified table it builds: "search"."documents".
      makeCapturingDb(captured, { throwOn: /"search"\."documents"/u })
    );
    expect(await search.available()).toEqual({
      available: false,
      reason: 'relation_unavailable',
    });
  });

  it('reports ok once the projection holds an attributable public doc', async () => {
    const search = makeParliamentTranscriptSearch(makeCapturingDb([], { rows: [{ one: 1 }] }));
    expect(await search.available()).toEqual({ available: true, reason: 'ok' });
  });

  it('memoizes a negative probe instead of re-probing on every call', async () => {
    const captured: Captured[] = [];
    const search = makeParliamentTranscriptSearch(makeCapturingDb(captured));

    await search.available();
    const afterFirst = captured.length;
    await search.available();
    await search.available();
    expect(captured.length).toBe(afterFirst);
  });

  it('pins the doc type to the data layer constant', () => {
    const search = makeParliamentTranscriptSearch(makeCapturingDb([]));
    expect(search.docType).toBe('parliament_speech_segment');
    expect(search.docType).toBe(PARLIAMENT_TRANSCRIPT_SEARCH_DOC_TYPE);
  });
});

describe('transcript search — grouping and ranking happen in SQL, before the cap', () => {
  const runSearch = async (
    q: string,
    limit = 50
  ): Promise<{ captured: Captured[]; sql: string }> => {
    const captured: Captured[] = [];
    const search = makeParliamentTranscriptSearch(makeCapturingDb(captured, { rows: [] }));
    await search.searchSessionKeys(q, limit);
    return { captured, sql: captured.at(-1)?.sql ?? '' };
  };

  it('GROUPs BY the session and orders by aggregates — so the cap counts SITTINGS', async () => {
    const { sql } = await runSearch('buget');
    expect(sql).toContain("group by attrs->>'session_key'");
    // Aggregates, not per-row columns: a sitting is ranked by its best block and its
    // recency, and the `limit` therefore truncates sittings, never blocks.
    expect(sql).toContain('max(rank_boost) desc nulls last');
    expect(sql).toContain('max(doc_date) desc nulls last');
    expect(sql).toContain('count(*) desc');
    // A total order, so the same q resolves the same sittings run to run.
    expect(sql).toContain("attrs->>'session_key' asc");
    // The cap is applied AFTER the grouping (`limit` follows `group by` in the text).
    expect(sql.indexOf('group by')).toBeLessThan(sql.lastIndexOf('limit'));
  });

  it('attributes a doc to a sitting ONLY via attrs.session_key — never by parsing doc_id', async () => {
    const { sql } = await runSearch('buget');
    expect(sql).toContain("attrs->>'session_key'");
    // A canonical speech key is `canon:<session_key>#<pos>` and a session key is itself
    // colon-bearing, so `parliament:speech:canon:cdep:9043#00004` has five colons and a
    // source-dependent shape. Any attempt to split it is a mis-attribution waiting to
    // happen — so none of these appear.
    expect(sql).not.toContain('split_part');
    expect(sql).not.toContain('doc_id');
  });

  it('restricts to canonical PUBLIC reading blocks on both privacy signals', async () => {
    const { sql, captured } = await runSearch('buget');
    expect(sql).toContain('visibility');
    expect(sql).toContain('deleted_at');
    // `visibility` is DERIVED from the block's privacy_class by the loader; requiring
    // BOTH means a projection bug that sets one without the other cannot leak a block.
    expect(sql).toContain("attrs->>'privacy_class' = 'public'");
    // Only reading blocks — not some future doc that reuses the doc type.
    expect(sql).toContain("attrs->>'unit_kind' = 'stenogram-reading-block'");
    expect(captured.at(-1)?.parameters).toContain(PARLIAMENT_TRANSCRIPT_SEARCH_DOC_TYPE);
  });

  it('matches title + body and ESCAPES LIKE wildcards in the user token', async () => {
    const { sql, captured } = await runSearch('100%_buget');
    expect(sql).toContain('title ilike');
    expect(sql).toContain('body ilike');
    expect(sql).toContain("escape '\\'");
    // A `%` or `_` typed by a user must not widen the search.
    expect(captured.at(-1)?.parameters).toContain('%100\\%\\_buget%');
  });

  it('never queries the database for an empty q', async () => {
    const captured: Captured[] = [];
    const search = makeParliamentTranscriptSearch(makeCapturingDb(captured, { rows: [] }));
    const r = await search.searchSessionKeys('   ', 50);
    expect(r._unsafeUnwrap()).toEqual({ sessions: [], truncated: false });
    expect(captured).toHaveLength(0);
  });

  it('returns per-sitting hit counts and flags truncation past the cap', async () => {
    const rows = [
      { session_key: 'cdep:9043', matched_blocks: '2400', best_rank: 9, latest_doc_date: null },
      { session_key: 'cdep:9100', matched_blocks: '3', best_rank: 4, latest_doc_date: null },
    ];
    const search = makeParliamentTranscriptSearch(makeCapturingDb([], { rows }));

    const two = await search.searchSessionKeys('buget', 2);
    expect(two._unsafeUnwrap().sessions).toEqual([
      { sessionKey: 'cdep:9043', matchedBlocks: 2400 },
      { sessionKey: 'cdep:9100', matchedBlocks: 3 },
    ]);
    expect(two._unsafeUnwrap().truncated).toBe(false);

    // The driver returns 2 rows for a cap of 1 → cap+1 fetched → more sittings exist.
    const one = await search.searchSessionKeys('buget', 1);
    expect(one._unsafeUnwrap().truncated).toBe(true);
    expect(one._unsafeUnwrap().sessions).toHaveLength(1);
    // The long sitting takes ONE slot, not 2,400 — the crowd-out failure is impossible.
    expect(one._unsafeUnwrap().sessions[0]?.sessionKey).toBe('cdep:9043');
  });

  it('surfaces a read failure as a Database error, not as an empty hit set', async () => {
    const search = makeParliamentTranscriptSearch(
      makeCapturingDb([], { rows: [{ one: 1 }], throwOn: /group by/u })
    );
    const r = await search.searchSessionKeys('buget', 50);
    expect(r.isErr()).toBe(true);
    expect(r._unsafeUnwrapErr().type).toBe('Database');
  });
});
