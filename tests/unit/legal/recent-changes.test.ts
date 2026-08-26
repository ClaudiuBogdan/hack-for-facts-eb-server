/**
 * legalRecentChanges — the global date-ordered status-event feed.
 *
 * Three layers, each tested with the tool that can actually see it:
 *  - SQL shape (DummyDriver capture): the acts join, `desc nulls last` order,
 *    the `(effective_date, event_id)` keyset predicate with its null section
 *    and `::bigint` tiebreak, filter binds, and the count/list shared WHERE.
 *  - Cursor behaviour (a row-feeding fake driver + the REAL repo): the minted
 *    `next` encodes the LAST SERVED row's keys and the resumed statement binds
 *    exactly those keys — the strict `<` plus the `=`+tiebreak clause is what
 *    makes "no repeat, no skip" across a shared-date boundary.
 *  - The GraphQL connection: `endCursor` is a REAL cursor (the last edge's),
 *    never a hardcoded null — the defect class living in LegalAct.links today,
 *    which can never page past its first window. Not reproduced here.
 */

import { makeExecutableSchema } from '@graphql-tools/schema';
import { buildSchema, graphql } from 'graphql';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type Driver,
  type QueryResult,
} from 'kysely';
import { ok, err } from 'neverthrow';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  countRecentChanges,
  getRecentChanges,
  normalizeRecentChangesFilter,
} from '@/modules/legal/core/usecases.js';
import { makeLegalResolvers } from '@/modules/legal/shell/graphql/resolvers.js';
import { legalTypeDefs } from '@/modules/legal/shell/graphql/typedefs.js';
import { makeLegalActsRepo } from '@/modules/legal/shell/repo/acts-repo.js';
import {
  RECENT_CHANGES_SORT,
  recentChangesFhash,
} from '@/modules/legal/shell/repo/filter-helpers.js';
import { mapRecentChange, type RecentChangeRow } from '@/modules/legal/shell/repo/mappers.js';
import {
  buildNextCursor,
  databaseError,
  decodeCursor,
  type CursorPage,
  type ProdDatabase,
} from '@/modules/shared/index.js';

import type { LegalActsRepo, LegalRecentChangesQuery } from '@/modules/legal/core/ports.js';
import type { LegalRecentChange } from '@/modules/legal/core/types.js';

interface Captured {
  sql: string;
  parameters: readonly unknown[];
}

// ── a capture-only db (DummyDriver: every query answers zero rows) ───────────

let statements: Captured[] = [];

const makeDb = (): Kysely<ProdDatabase> =>
  new Kysely<ProdDatabase>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (db) => new PostgresIntrospector(db),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
    log: (event) => {
      statements.push({ sql: event.query.sql, parameters: event.query.parameters });
    },
  });

const lastSql = (): string => {
  const captured = statements[statements.length - 1];
  expect(captured).toBeDefined();
  return (captured?.sql ?? '').replace(/\s+/gu, ' ').trim();
};

const lastParams = (): readonly unknown[] => statements[statements.length - 1]?.parameters ?? [];

/** The WHERE body up to order by / group by, or to the end for a bare count. */
const whereOf = (sql: string): string => {
  const match = /where (?<body>.*?)(?: order by| group by|$)/u.exec(sql);
  expect(match).not.toBeNull();
  return match?.groups?.['body'] ?? '';
};

// ── a row-feeding db: the REAL repo over queued fake result sets ─────────────

const makeRowsDb = (): {
  db: Kysely<ProdDatabase>;
  executed: Captured[];
  results: unknown[][];
} => {
  const executed: Captured[] = [];
  const results: unknown[][] = [];
  const connection: DatabaseConnection = {
    executeQuery: <R>(compiled: CompiledQuery): Promise<QueryResult<R>> => {
      executed.push({ sql: compiled.sql, parameters: compiled.parameters });
      return Promise.resolve({ rows: (results.shift() ?? []) as R[] });
    },
    streamQuery: () => {
      throw new Error('streamQuery is not under test');
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
  return { db, executed, results };
};

const row = (
  eventId: string,
  date: string | null,
  over: Partial<RecentChangeRow> = {}
): RecentChangeRow => ({
  event_id: eventId,
  event_kind: 'modificare',
  effective_date: date,
  source_act_id: null,
  evidence: { note: 'x' },
  event_source: 'portal',
  act_id: '10',
  act_natural_key: 'lege:10:2015:',
  display_citation: 'Legea nr. 10/2015',
  status: 'in-vigoare',
  ...over,
});

beforeEach(() => {
  statements = [];
});

// ── SQL shape ────────────────────────────────────────────────────────────────

describe('listRecentChanges — SQL shape', () => {
  it('joins acts for identity and orders (effective_date desc nulls last, event_id desc)', async () => {
    const repo = makeLegalActsRepo(makeDb());
    await repo.listRecentChanges({ page: { first: 20 } });

    const sql = lastSql();
    expect(sql).toContain(
      'from legal.act_status_events e join legal.acts a on a.act_id = e.act_id'
    );
    expect(sql).toContain('order by e.effective_date desc nulls last, e.event_id desc');
    // limit+1 probe: hasNextPage is a fact, not a guess.
    expect(sql).toContain('limit $');
    expect(lastParams()).toContain(21);
  });

  it('serves event_source and evidence — the two pipelines are exposed, never merged', async () => {
    const repo = makeLegalActsRepo(makeDb());
    await repo.listRecentChanges({ page: { first: 20 } });

    const sql = lastSql();
    expect(sql).toContain('e.event_source');
    expect(sql).toContain('e.evidence');
    expect(sql).toContain('e.effective_date::text as effective_date');
    expect(sql).toContain('a.act_natural_key');
    expect(sql).toContain('a.display_citation');
  });

  it('binds since/until as inclusive ::date bounds and kinds as an in-list', async () => {
    const repo = makeLegalActsRepo(makeDb());
    await repo.listRecentChanges({
      since: '2026-01-01',
      until: '2026-08-23',
      kinds: ['abrogare-totala', 'modificare'],
      page: { first: 20 },
    });

    const sql = lastSql();
    expect(sql).toContain('e.effective_date >= $1::date');
    expect(sql).toContain('e.effective_date <= $2::date');
    expect(sql).toContain('e.event_kind in ($3, $4)');
    expect(lastParams()).toEqual(['2026-01-01', '2026-08-23', 'abrogare-totala', 'modificare', 21]);
  });

  it('binds eventSource as an equality and undatedOnly as IS NULL', async () => {
    const repo = makeLegalActsRepo(makeDb());
    await repo.listRecentChanges({ eventSource: 'monitorul-oficial', page: { first: 20 } });
    expect(lastSql()).toContain('e.event_source = $1');
    expect(lastParams()).toEqual(['monitorul-oficial', 21]);

    await repo.listRecentChanges({ undatedOnly: true, page: { first: 20 } });
    expect(lastSql()).toContain('e.effective_date is null');
    expect(lastParams()).toEqual([21]);
  });

  it('a resumed cursor compiles the keyset predicate: strict <, the NULL section, ::bigint tiebreak', async () => {
    const repo = makeLegalActsRepo(makeDb());
    const after = buildNextCursor({
      sort: RECENT_CHANGES_SORT,
      dir: 'desc',
      fhash: recentChangesFhash({}),
      lastKeys: ['2026-08-01', '777'],
    });
    await repo.listRecentChanges({ page: { first: 20, after } });

    const sql = lastSql();
    expect(sql).toContain(
      '(e.effective_date < $1::date or e.effective_date is null or (e.effective_date = $2::date and e.event_id < $3::bigint))'
    );
    expect(lastParams()).toEqual(['2026-08-01', '2026-08-01', '777', 21]);
  });

  it("the '' sentinel resumes INSIDE the trailing null-date section", async () => {
    const repo = makeLegalActsRepo(makeDb());
    const after = buildNextCursor({
      sort: RECENT_CHANGES_SORT,
      dir: 'desc',
      fhash: recentChangesFhash({}),
      lastKeys: ['', '777'],
    });
    await repo.listRecentChanges({ page: { first: 20, after } });

    const sql = lastSql();
    expect(sql).toContain('(e.effective_date is null and e.event_id < $1::bigint)');
    expect(sql).not.toContain('e.effective_date <');
  });

  it('rejects a cursor minted under DIFFERENT filters (fhash binding)', async () => {
    const repo = makeLegalActsRepo(makeDb());
    const foreign = buildNextCursor({
      sort: RECENT_CHANGES_SORT,
      dir: 'desc',
      fhash: recentChangesFhash({ kinds: ['modificare'] }),
      lastKeys: ['2026-08-01', '7'],
    });
    const result = await repo.listRecentChanges({ page: { first: 5, after: foreign } });

    expect(result.isErr()).toBe(true);
    expect(result.isErr() && result.error.message).toContain('cursor/filter mismatch');
    expect(statements).toHaveLength(0); // rejected before any SQL
  });

  it('rejects malformed cursor keys instead of letting a cast 500 downstream', async () => {
    const repo = makeLegalActsRepo(makeDb());
    const mint = (lastKeys: readonly string[]): string =>
      buildNextCursor({
        sort: RECENT_CHANGES_SORT,
        dir: 'desc',
        fhash: recentChangesFhash({}),
        lastKeys,
      });

    const badEvent = await repo.listRecentChanges({
      page: { first: 5, after: mint(['2026-08-01', 'abc']) },
    });
    expect(badEvent.isErr() && badEvent.error.message).toContain('non-numeric event key');

    const badDate = await repo.listRecentChanges({
      page: { first: 5, after: mint(['01/08/2026', '7']) },
    });
    expect(badDate.isErr() && badDate.error.message).toContain('malformed date key');
    expect(statements).toHaveLength(0);
  });

  it("countRecentChanges runs the list's exact FROM and WHERE (no drift)", async () => {
    const repo = makeLegalActsRepo(makeDb());
    const filter = { since: '2026-01-01', kinds: ['modificare'] };

    await repo.listRecentChanges({ ...filter, page: { first: 20 } });
    const listWhere = whereOf(lastSql());
    const listParams = lastParams();

    await repo.countRecentChanges(filter);
    const countSql = lastSql();

    expect(countSql).toContain('select count(*) as cnt');
    expect(countSql).toContain(
      'from legal.act_status_events e join legal.acts a on a.act_id = e.act_id'
    );
    expect(listWhere.length).toBeGreaterThan(0);
    expect(whereOf(countSql)).toBe(listWhere);
    // Same binds, minus the list's trailing limit param.
    expect(lastParams()).toEqual(listParams.slice(0, -1));
  });
});

// ── cursor behaviour over real repo + fed rows ───────────────────────────────

describe('listRecentChanges — paging mints and honours real cursors', () => {
  it('encodes the LAST SERVED row and resumes strictly after it across a shared date', async () => {
    const { db, executed, results } = makeRowsDb();
    const repo = makeLegalActsRepo(db);

    // first=2, three rows back → the probe row proves more exist. Rows 200 and
    // 100 SHARE a date: the boundary where a naive date-only cursor repeats or
    // skips.
    results.push([row('300', '2026-08-20'), row('200', '2026-08-15'), row('100', '2026-08-15')]);
    const page1 = (await repo.listRecentChanges({ page: { first: 2 } }))._unsafeUnwrap();

    expect(page1.items.map((i) => i.eventId)).toEqual(['300', '200']);
    expect(page1.next).not.toBeNull();
    const decoded = decodeCursor(page1.next ?? '', {
      sort: RECENT_CHANGES_SORT,
      dir: 'desc',
      fhash: recentChangesFhash({}),
    });
    // The cursor is the last SERVED row's keys — not the probe row's.
    expect(decoded._unsafeUnwrap().keys).toEqual(['2026-08-15', '200']);

    results.push([row('100', '2026-08-15')]);
    const page2 = (
      await repo.listRecentChanges({ page: { first: 2, after: page1.next ?? '' } })
    )._unsafeUnwrap();

    expect(page2.items.map((i) => i.eventId)).toEqual(['100']);
    expect(page2.next).toBeNull(); // one row, no probe → genuinely exhausted
    // The resumed statement binds exactly the page-1 tail keys: strict `<`
    // forbids re-serving row 200 (no repeat) and the `=`+tiebreak clause keeps
    // same-date row 100 reachable (no skip).
    const second = executed[executed.length - 1];
    expect(second?.parameters).toEqual(['2026-08-15', '2026-08-15', '200', 3]);
  });

  it('a null-date tail row mints the "" sentinel and resumes in the null section', async () => {
    const { db, executed, results } = makeRowsDb();
    const repo = makeLegalActsRepo(db);

    results.push([row('300', '2026-08-20'), row('200', null), row('100', null)]);
    const page1 = (await repo.listRecentChanges({ page: { first: 2 } }))._unsafeUnwrap();

    expect(page1.items[1]?.effectiveDate).toBeNull();
    const decoded = decodeCursor(page1.next ?? '', {
      sort: RECENT_CHANGES_SORT,
      dir: 'desc',
      fhash: recentChangesFhash({}),
    });
    expect(decoded._unsafeUnwrap().keys).toEqual(['', '200']);

    results.push([row('100', null)]);
    await repo.listRecentChanges({ page: { first: 2, after: page1.next ?? '' } });
    const second = executed[executed.length - 1];
    expect((second?.sql ?? '').replace(/\s+/gu, ' ')).toContain(
      '(e.effective_date is null and e.event_id < $1::bigint)'
    );
    expect(second?.parameters).toEqual(['200', 3]);
  });
});

// ── filter normalization (the usecase gate all surfaces share) ───────────────

describe('normalizeRecentChangesFilter', () => {
  it('trims, dedupes and sorts kinds; blank ENTRIES drop while survivors remain', () => {
    const norm = normalizeRecentChangesFilter({
      kinds: [' modificare ', 'abrogare-totala', 'modificare', ''],
    });
    expect(norm._unsafeUnwrap()).toEqual({ kinds: ['abrogare-totala', 'modificare'] });
  });

  it('CAPS kinds at 64, refusing rather than failing as a masked internal error', () => {
    // Nothing upstream bounds the list: the SDL types it [String!] and the MCP
    // schema z.array(z.string()), and every entry becomes a bind parameter. Past
    // PostgreSQL's 65,535-parameter protocol limit the query dies as a masked
    // "Internal server error" instead of a clear refusal, so the boundary is
    // enforced here. 64 is far above real use — the table holds 12 kinds.
    const at = normalizeRecentChangesFilter({
      kinds: Array.from({ length: 64 }, (_, i) => `k${String(i)}`),
    });
    expect(at.isOk()).toBe(true);

    const over = normalizeRecentChangesFilter({
      kinds: Array.from({ length: 65 }, (_, i) => `k${String(i)}`),
    });
    expect(over.isErr()).toBe(true);
    expect(over.isErr() && over.error.message).toContain('at most 64');
  });

  it('REJECTS an explicit empty or blank-only kinds — never widened to the whole corpus', () => {
    // kernel filters read `in: []` as "match nothing"; silently reading [] as
    // "match everything" here would give one API two opposite emptinesses, and
    // a UI text input bound to kinds would serve all 84k rows on a space.
    for (const kinds of [[], [''], ['  ', ' ']]) {
      const result = normalizeRecentChangesFilter({ kinds });
      expect(result.isErr(), JSON.stringify(kinds)).toBe(true);
      expect(result.isErr() && result.error.message).toContain('kinds');
    }
  });

  it('validates eventSource membership and refuses undatedOnly + a date window', () => {
    expect(normalizeRecentChangesFilter({ eventSource: 'portal' })._unsafeUnwrap()).toEqual({
      eventSource: 'portal',
    });
    const badSource = normalizeRecentChangesFilter({ eventSource: 'scraper' as never });
    expect(badSource.isErr() && badSource.error.message).toContain('eventSource');
    // 'necunoscut' is the OUTPUT-ONLY unknown token (grok r5, 2026-08-26): a
    // row from a third writer surfaces as it, but nobody may FILTER by it —
    // the filter vocabulary stays the two real pipelines.
    const unknownToken = normalizeRecentChangesFilter({ eventSource: 'necunoscut' });
    expect(unknownToken.isErr() && unknownToken.error.message).toContain('eventSource');

    expect(normalizeRecentChangesFilter({ undatedOnly: true })._unsafeUnwrap()).toEqual({
      undatedOnly: true,
    });
    // undated events fail every date comparison — the combination matches
    // nothing by construction, so it is refused, not served as a confident 0.
    const conflict = normalizeRecentChangesFilter({ undatedOnly: true, since: '2026-01-01' });
    expect(conflict.isErr() && conflict.error.message).toContain('undatedOnly');
  });

  it('is idempotent, so repo and resolver derive the SAME cursor fhash', () => {
    const once = normalizeRecentChangesFilter({ kinds: ['b', ' a ', 'b'] })._unsafeUnwrap();
    const twice = normalizeRecentChangesFilter(once)._unsafeUnwrap();
    expect(recentChangesFhash(once)).toBe(recentChangesFhash(twice));
    expect(recentChangesFhash(once)).toBe(recentChangesFhash({ kinds: ['a', 'b'] }));
    // and the hash actually distinguishes filters — including the new axes:
    expect(recentChangesFhash(once)).not.toBe(recentChangesFhash({}));
    expect(recentChangesFhash({ eventSource: 'portal' })).not.toBe(recentChangesFhash({}));
    expect(recentChangesFhash({ undatedOnly: true })).not.toBe(recentChangesFhash({}));
  });

  it('rejects non-dates AND calendar rollover (V8 parses 2026-02-31 as March 3rd)', () => {
    for (const since of ['yesterday', '2026-13-01', '2026-02-31', '2026-8-1']) {
      const result = normalizeRecentChangesFilter({ since });
      expect(result.isErr(), since).toBe(true);
      expect(result.isErr() && result.error.message).toContain('since');
    }
    expect(normalizeRecentChangesFilter({ until: '2026-02-28' }).isOk()).toBe(true);
  });

  it('getRecentChanges refuses an invalid window before any repo call', async () => {
    const listRecentChanges = vi.fn();
    const repo = { listRecentChanges } as unknown as LegalActsRepo;
    const result = await getRecentChanges(repo, { since: '2026-02-31', page: { first: 5 } });
    expect(result.isErr()).toBe(true);
    expect(listRecentChanges).not.toHaveBeenCalled();
  });
});

// ── row mapper ───────────────────────────────────────────────────────────────

describe('mapRecentChange', () => {
  it('coerces status to the closed vocab, evidence to an object, source verbatim', () => {
    const mapped = mapRecentChange(
      row('1', '2026-01-01', {
        status: 'not-a-status',
        evidence: null as unknown as Record<string, unknown>,
        event_source: 'monitorul-oficial',
        source_act_id: '99',
      })
    );
    expect(mapped.status).toBe('necunoscut');
    expect(mapped.evidence).toEqual({});
    expect(mapped.eventSource).toBe('monitorul-oficial');
    expect(mapped.sourceActId).toBe('99');
    expect(mapped.displayCitation).toBe('Legea nr. 10/2015');
  });
});

// ── the GraphQL connection (endCursor must be REAL — the links defect class) ─

type QueryResolver = (root: unknown, args: Record<string, unknown>) => Promise<unknown>;

interface RecentChangeConnection {
  edges: { node: LegalRecentChange; cursor: string }[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  totalCount: null | (() => Promise<number | null>);
}

const change = (eventId: string, date: string | null): LegalRecentChange => ({
  eventId,
  eventKind: 'modificare',
  effectiveDate: date,
  eventSource: 'portal',
  sourceActId: null,
  evidence: {},
  actId: '10',
  actNaturalKey: 'lege:10:2015:',
  displayCitation: 'Legea nr. 10/2015',
  status: 'in-vigoare',
});

const resolversWith = (
  repo: LegalActsRepo
): {
  query: Record<string, QueryResolver>;
  connection: { totalCount: (p: unknown) => Promise<number | null> };
} => {
  const r = makeLegalResolvers({
    acts: repo,
    graph: {} as never,
    outline: {} as never,
    render: {} as never,
    searchDeps: {} as never,
    resolveDeps: {} as never,
  });
  return {
    query: (r as { Query: Record<string, QueryResolver> }).Query,
    connection: (
      r as { LegalRecentChangeConnection: { totalCount: (p: unknown) => Promise<number | null> } }
    ).LegalRecentChangeConnection,
  };
};

describe('Query.legalRecentChanges — the connection', () => {
  it('endCursor is the LAST EDGE’s real cursor while more pages exist', async () => {
    const page: CursorPage<LegalRecentChange> = {
      items: [change('300', '2026-08-20'), change('200', '2026-08-15')],
      next: 'opaque-repo-next',
    };
    const repo = { listRecentChanges: async () => ok(page) } as unknown as LegalActsRepo;
    const conn = (await resolversWith(repo).query['legalRecentChanges']?.(undefined, {
      first: 2,
    })) as RecentChangeConnection;

    expect(conn.pageInfo.hasNextPage).toBe(true);
    expect(conn.pageInfo.endCursor).not.toBeNull();
    expect(conn.pageInfo.endCursor).toBe(conn.edges[1]?.cursor);
    // The edge cursor is decodable and carries that node's keyset tuple.
    const decoded = decodeCursor(conn.edges[1]?.cursor ?? '', {
      sort: RECENT_CHANGES_SORT,
      dir: 'desc',
      fhash: recentChangesFhash({}),
    });
    expect(decoded._unsafeUnwrap().keys).toEqual(['2026-08-15', '200']);
  });

  it('endCursor stays REAL on the final page too — never the links hardcoded null', async () => {
    const page: CursorPage<LegalRecentChange> = {
      items: [change('100', '2026-08-01')],
      next: null,
    };
    const repo = { listRecentChanges: async () => ok(page) } as unknown as LegalActsRepo;
    const conn = (await resolversWith(repo).query['legalRecentChanges']?.(
      undefined,
      {}
    )) as RecentChangeConnection;

    expect(conn.pageInfo.hasNextPage).toBe(false);
    expect(conn.pageInfo.endCursor).toBe(conn.edges[0]?.cursor);
    expect(conn.pageInfo.endCursor).not.toBeNull();
  });

  it('an empty feed answers endCursor null and hasNextPage false', async () => {
    const repo = {
      listRecentChanges: async () => ok({ items: [], next: null }),
    } as unknown as LegalActsRepo;
    const conn = (await resolversWith(repo).query['legalRecentChanges']?.(
      undefined,
      {}
    )) as RecentChangeConnection;

    expect(conn.edges).toHaveLength(0);
    expect(conn.pageInfo).toEqual({ hasNextPage: false, endCursor: null });
  });

  it('normalizes raw args ONCE: repo sees canonical kinds, edge cursors hash the same filter', async () => {
    const seen: LegalRecentChangesQuery[] = [];
    const repo = {
      listRecentChanges: async (q: LegalRecentChangesQuery) => {
        seen.push(q);
        return ok({ items: [change('300', '2026-08-20')], next: null });
      },
    } as unknown as LegalActsRepo;

    const conn = (await resolversWith(repo).query['legalRecentChanges']?.(undefined, {
      kinds: ['modificare', ' modificare '],
      after: 'pass-through-cursor',
      first: 2,
    })) as RecentChangeConnection;

    expect(seen[0]?.kinds).toEqual(['modificare']);
    expect(seen[0]?.page).toEqual({ first: 2, after: 'pass-through-cursor' });
    // A repo-minted next cursor (normalized fhash) must decode against the
    // resolver's per-edge fhash — one canonical filter, one hash.
    const decoded = decodeCursor(conn.edges[0]?.cursor ?? '', {
      sort: RECENT_CHANGES_SORT,
      dir: 'desc',
      fhash: recentChangesFhash(
        normalizeRecentChangesFilter({ kinds: ['modificare'] })._unsafeUnwrap()
      ),
    });
    expect(decoded.isOk()).toBe(true);
  });

  it('totalCount is lazy: counted only when the field resolver is invoked', async () => {
    const countFn = vi.fn(async () => ok(42));
    const repo = {
      listRecentChanges: async () => ok({ items: [change('1', '2026-01-01')], next: null }),
      countRecentChanges: countFn,
    } as unknown as LegalActsRepo;
    const { query, connection } = resolversWith(repo);

    const conn = (await query['legalRecentChanges']?.(undefined, {})) as RecentChangeConnection;
    expect(countFn).not.toHaveBeenCalled(); // list alone never pays for a count

    await expect(connection.totalCount(conn)).resolves.toBe(42);
    expect(countFn).toHaveBeenCalledTimes(1);
  });

  it('a failed count THROWS the ApiError instead of swallowing it', async () => {
    const failing = {
      listRecentChanges: async () => ok({ items: [], next: null }),
      countRecentChanges: async () => err(databaseError('count timed out')),
    } as unknown as LegalActsRepo;
    const { query, connection } = resolversWith(failing);
    const conn = (await query['legalRecentChanges']?.(undefined, {})) as RecentChangeConnection;
    await expect(connection.totalCount(conn)).rejects.toThrow('count timed out');
  });

  it('under the executor: the nullable field nulls AND an errors entry says why', async () => {
    // Real graphql-js execution over the module SDL. The deployed stack is
    // makeExecutableSchema + mercurius (graphql-js semantics; no jit option in
    // build-redesign-app.ts), but under vitest @graphql-tools/schema and a
    // direct `graphql` import are DIFFERENT module instances (dual-package
    // interop), so the schema is built with buildSchema from THIS instance and
    // the connection travels as rootValue: the default field resolver invokes
    // the totalCount thunk exactly as the explicit connection resolver does,
    // and what is under test is the ENGINE's contract — a rejected resolver on
    // a nullable field yields data:null for that field plus an errors entry,
    // never a swallowed reason and never a feed-level failure.
    const failing = {
      listRecentChanges: async () => ok({ items: [change('9', '2026-05-01')], next: null }),
      countRecentChanges: async () => err(databaseError('count timed out')),
    } as unknown as LegalActsRepo;
    const { query } = resolversWith(failing);
    const schema = buildSchema(`
      scalar BigInt
      scalar JSON
      scalar Date
      type PageInfo { hasNextPage: Boolean!, endCursor: String }
      type Query { _root: String }
      ${legalTypeDefs}
    `);
    const result = await graphql({
      schema,
      source: '{ legalRecentChanges { totalCount edges { node { eventId } } } }',
      rootValue: {
        legalRecentChanges: (args: Record<string, unknown>) =>
          query['legalRecentChanges']?.(undefined, args),
      },
    });

    // The feed itself survives; the nullable field nulls; the reason is IN the
    // response — not swallowed, not a feed-level failure.
    const data = result.data?.['legalRecentChanges'] as {
      totalCount: number | null;
      edges: readonly { node: { eventId: string } }[];
    };
    expect(data.totalCount).toBeNull();
    expect(data.edges[0]?.node.eventId).toBe('9');
    expect(result.errors).toHaveLength(1);
    expect(result.errors?.[0]?.path).toEqual(['legalRecentChanges', 'totalCount']);
    expect(result.errors?.[0]?.message).toContain('count timed out');
  });

  it('the resolver map BINDS to the SDL under the deployed construction', () => {
    // makeExecutableSchema (the app's builder, build-redesign-app.ts) THROWS
    // at build time when a resolver names a type/field the SDL does not carry
    // — the one check that catches a resolver block like
    // LegalRecentChange.sourceAct landing without its SDL field. The throw
    // happens entirely inside the tools' own graphql instance, so the vitest
    // dual-instance split (see above) does not apply here.
    const repo = {} as unknown as LegalActsRepo;
    expect(() =>
      makeExecutableSchema({
        typeDefs: `
          scalar BigInt
          scalar JSON
          scalar Date
          type PageInfo { hasNextPage: Boolean!, endCursor: String }
          type Query { _root: String }
          ${legalTypeDefs}
        `,
        resolvers: makeLegalResolvers({
          acts: repo,
          graph: {} as never,
          outline: {} as never,
          render: {} as never,
          searchDeps: {} as never,
          resolveDeps: {} as never,
        }) as unknown as Record<string, never>,
      })
    ).not.toThrow();
    // Negative control: the mismatch check is LIVE in this environment — a
    // resolver naming a field the SDL lacks throws, so the green above is a
    // real binding, not a vacuous pass.
    expect(() =>
      makeExecutableSchema({
        typeDefs: `
          scalar BigInt
          scalar JSON
          scalar Date
          type PageInfo { hasNextPage: Boolean!, endCursor: String }
          type Query { _root: String }
          ${legalTypeDefs}
        `,
        resolvers: {
          LegalRecentChange: { notAField: () => null },
        },
      })
    ).toThrow(/notAField/u);
  });

  it('sourceAct resolves through the batched act loader; null id never touches the repo', async () => {
    const findActsByIds = vi.fn(async (ids: readonly string[]) =>
      ok(
        ids.map((actId) => ({
          actId,
          actNaturalKey: `lege:${actId}:2019:`,
          actType: 'lege',
          actNumber: '77',
          actYear: 2019,
          issuerSlug: 'parlamentul',
          canonicalDocumentId: null,
          displayCitation: `Legea nr. ${actId}/2019`,
          status: 'in-vigoare',
          statusEvidence: {},
          entryIntoForce: null,
          inDegree: 0,
        }))
      )
    );
    const repo = { findActsByIds } as unknown as LegalActsRepo;
    const r = makeLegalResolvers({
      acts: repo,
      graph: {} as never,
      outline: {} as never,
      render: {} as never,
      searchDeps: {} as never,
      resolveDeps: {} as never,
    }) as {
      LegalRecentChange: {
        sourceAct: (p: { sourceActId: string | null }) => Promise<{ actId: string } | null>;
      };
    };

    await expect(r.LegalRecentChange.sourceAct({ sourceActId: null })).resolves.toBeNull();
    expect(findActsByIds).not.toHaveBeenCalled();

    const act = await r.LegalRecentChange.sourceAct({ sourceActId: '77' });
    expect(act?.actId).toBe('77');
    expect(findActsByIds).toHaveBeenCalledTimes(1);
  });

  it('usecase countRecentChanges normalizes exactly like the list path', async () => {
    const seen: unknown[] = [];
    const repo = {
      countRecentChanges: async (f: unknown) => {
        seen.push(f);
        return ok(7);
      },
    } as unknown as LegalActsRepo;
    await countRecentChanges(repo, { kinds: ['b', ' a ', 'b'] });
    expect(seen[0]).toEqual({ kinds: ['a', 'b'] });
  });
});

describe('Query.legalActCounts — dimension mapping', () => {
  it('maps the SDL enum to the repo dimension and passes the filter through', async () => {
    const seen: unknown[] = [];
    const repo = {
      countActsBy: async (dim: unknown, filter: unknown) => {
        seen.push([dim, filter]);
        return ok([{ key: 'lege', label: null, count: 5 }]);
      },
    } as unknown as LegalActsRepo;

    const result = await resolversWith(repo).query['legalActCounts']?.(undefined, {
      groupBy: 'ACT_TYPE',
      filter: { status: { in: ['in-vigoare'] } },
    });

    expect(seen[0]).toEqual(['act_type', { status: { in: ['in-vigoare'] } }]);
    expect(result).toEqual({
      buckets: [{ key: 'lege', label: null, count: 5 }],
      bucketsTruncated: false,
      otherCount: 0,
    });
  });

  it('rejects an out-of-range topN instead of clamping it silently', async () => {
    const repo = {
      countActsBy: async () => ok([{ key: 'lege', label: null, count: 5 }]),
    } as unknown as LegalActsRepo;
    await expect(
      resolversWith(repo).query['legalActCounts']?.(undefined, { groupBy: 'ACT_TYPE', topN: 0 })
    ).rejects.toThrow(/topN/u);
  });

  it('refuses an unknown groupBy value', async () => {
    const repo = {} as unknown as LegalActsRepo;
    await expect(
      resolversWith(repo).query['legalActCounts']?.(undefined, { groupBy: 'BOGUS' })
    ).rejects.toThrow(/invalid groupBy/u);
  });
});
