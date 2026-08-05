/**
 * `parliamentBillActivity` — the bills-hub heatmap root the CLIENT shipped
 * first (PARLIAMENT_BILL_ACTIVITY_QUERY, 2026-08) and the server never served:
 * every parliament-hub load fired two 400s ("Cannot query field
 * 'parliamentBillActivity'"). This file pins the contract the client wrote
 * against:
 *
 *  - a day counts BILLS by `attrs.last_event_date` — the same key the default
 *    `updated_desc` list sort reads — under the SAME `buildBillConditions` +
 *    canonical-only predicate as `parliamentBills`, so chart and list answer
 *    the same question;
 *  - `availableYears` drives the year picker: NOT bounded by the year argument
 *    and NOT filter-bounded (a navigable year must not vanish while typing a
 *    search) — canonical-only is the one predicate it keeps;
 *  - `filter.year` stays the bill REGISTRATION year (orthogonal facet), so the
 *    usecase accepts it — unlike `voteDate` on the vote analog.
 */
import { buildSchema, parse, validate } from 'graphql';
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

import { getParliamentBillActivity } from '@/modules/parliament/core/usecases.js';
import { makeParliamentResolvers } from '@/modules/parliament/shell/graphql/resolvers.js';
import { parliamentTypeDefs } from '@/modules/parliament/shell/graphql/typedefs.js';
import { makeParliamentRepo } from '@/modules/parliament/shell/repo/parliament-repo.js';
import { type ApiError, type ProdDatabase } from '@/modules/shared/index.js';

import type { ParliamentRepo } from '@/modules/parliament/core/ports.js';
import type { ParliamentBillActivity } from '@/modules/parliament/core/types.js';

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

interface Captured {
  readonly sql: string;
  readonly parameters: readonly unknown[];
}

/** Captures every query; answers each with the given canned rows. */
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

const ACTIVITY: ParliamentBillActivity = {
  year: 2026,
  days: [{ date: '2026-03-04', total: 7 }],
  availableYears: [2025, 2026],
};

describe('getParliamentBillActivity — usecase bounds', () => {
  it('rejects a non-integer or out-of-range year without touching the repo', async () => {
    for (const year of [1989, 2101, 2026.5, Number.NaN]) {
      const r = await getParliamentBillActivity({ repo: makeRepo({}), meili: null }, year);
      expect(r.isErr()).toBe(true);
      expect(r._unsafeUnwrapErr().type).toBe('InvalidInput');
    }
  });

  it('passes the filter through — including year, the REGISTRATION-year facet', async () => {
    const billActivity = vi.fn((_y: number, _f: unknown) => okp(ACTIVITY));
    const filter = { year: { eq: 2020 }, q: { contains: 'pensii' } };
    const r = await getParliamentBillActivity(
      { repo: makeRepo({ billActivity }), meili: null },
      2026,
      filter
    );
    expect(r._unsafeUnwrap()).toEqual(ACTIVITY);
    expect(billActivity).toHaveBeenCalledWith(2026, filter);
  });
});

describe('billActivity — repo SQL contract', () => {
  const run = async (filter: Parameters<ParliamentRepo['billActivity']>[1]) => {
    const captured: Captured[] = [];
    const repo = makeParliamentRepo(
      makeDb(captured, [{ date: '2026-03-04', total: '7', year: 2026 }])
    );
    const res = await repo.billActivity(2026, filter);
    expect(res.isOk()).toBe(true);
    const days = captured.find((c) => c.sql.includes('group by'));
    const years = captured.find((c) => !c.sql.includes('group by'));
    if (days === undefined || years === undefined) throw new Error('expected two queries');
    return { res: res._unsafeUnwrap(), days, years };
  };

  it('days: canonical-only, well-formed ISO guard, year-bounded, grouped by last_event_date', async () => {
    const { days } = await run({});
    const sqlText = flat(days.sql);
    expect(sqlText).toContain('where b.is_canonical');
    expect(sqlText).toContain("(b.attrs->>'last_event_date') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'");
    expect(sqlText).toContain("group by (b.attrs->>'last_event_date')");
    expect(days.parameters).toEqual(['2026-01-01', '2026-12-31']);
  });

  it('availableYears: NOT filter-bounded, NOT year-bounded — canonical-only', async () => {
    // A q filter binds parameters on the days query but must not reach the
    // years query: the year picker would otherwise empty while typing.
    const { days, years } = await run({ q: { contains: 'pensii' } });
    expect(days.parameters.length).toBeGreaterThan(2);
    expect(flat(years.sql)).toContain('where b.is_canonical');
    expect(years.parameters).toEqual([]);
    expect(flat(years.sql)).toContain('distinct');
  });

  it('availableYears never advertises a year the usecase would then reject', async () => {
    // The usecase serves 1990..2100 only; a stray archival row ('1889-…') must
    // not surface a picker year that 400s when clicked.
    const { years } = await run({});
    const sqlText = flat(years.sql);
    expect(sqlText).toContain(">= '1990-01-01'");
    expect(sqlText).toContain("<= '2100-12-31'");
  });

  it('maps rows: totals to numbers, availableYears as ints', async () => {
    const { res } = await run({});
    expect(res.days).toEqual([{ date: '2026-03-04', total: 7 }]);
    expect(res.availableYears).toEqual([2026]);
    expect(res.year).toBe(2026);
  });

  it('surfaces an invalid filter as InvalidInput, before any query runs', async () => {
    const captured: Captured[] = [];
    const repo = makeParliamentRepo(makeDb(captured, []));
    const res = await repo.billActivity(2026, { actId: { eq: 'not-numeric' } });
    expect(res.isErr()).toBe(true);
    expect(res._unsafeUnwrapErr().type).toBe('InvalidInput');
    expect(captured).toHaveLength(0);
  });

  it('wraps a REAL connection failure as a Database error (repo catch path)', async () => {
    const connection: DatabaseConnection = {
      executeQuery: () => Promise.reject(new Error('connection reset')),
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
    const repo = makeParliamentRepo(
      new Kysely<ProdDatabase>({
        dialect: {
          createAdapter: () => new PostgresAdapter(),
          createDriver: () => driver,
          createIntrospector: (db) => new PostgresIntrospector(db),
          createQueryCompiler: () => new PostgresQueryCompiler(),
        },
      })
    );
    const r = await repo.billActivity(2026, {});
    expect(r.isErr()).toBe(true);
    expect(r._unsafeUnwrapErr().type).toBe('Database');
    expect(r._unsafeUnwrapErr().message).toBe('billActivity failed');
  });
});

describe('parliamentBillActivity — the runtime resolver, end to end', () => {
  const resolverDeps = (repo: ParliamentRepo) => ({
    repo,
    meili: null,
    legalActLoader: undefined,
    searchEngineUp: false,
    isApiKeyAuthorized: (): boolean => false,
    transcriptSearch: null,
  });
  type RootResolver = (parent: unknown, args: unknown, context?: unknown) => Promise<unknown>;
  const queryFields = (repo: ParliamentRepo): Record<string, RootResolver> =>
    (makeParliamentResolvers(resolverDeps(repo)) as Record<string, Record<string, RootResolver>>)[
      'Query'
    ]!;

  it('is wired: invokes the usecase and returns the activity shape', async () => {
    const billActivity = vi.fn((_y: number, _f: unknown) => okp(ACTIVITY));
    const result = await queryFields(makeRepo({ billActivity }))['parliamentBillActivity']?.(null, {
      year: 2026,
      filter: { year: { eq: 2020 } },
    });
    expect(result).toEqual(ACTIVITY);
    expect(billActivity).toHaveBeenCalledWith(2026, { year: { eq: 2020 } });
  });

  it('strips null filter fields before the usecase (sansNull law shared by every root)', async () => {
    const billActivity = vi.fn((_y: number, _f: unknown) => okp(ACTIVITY));
    await queryFields(makeRepo({ billActivity }))['parliamentBillActivity']?.(null, {
      year: 2026,
      filter: { q: null, status: { in: ['promulgated'] } },
    });
    expect(billActivity).toHaveBeenCalledWith(2026, { status: { in: ['promulgated'] } });
  });

  it('surfaces an invalid year as a GraphQL error, not a null', async () => {
    await expect(
      queryFields(makeRepo({}))['parliamentBillActivity']?.(null, { year: 1889 })
    ).rejects.toMatchObject({ message: expect.stringContaining('year') as string });
  });
});

describe('client↔server contract — the client document validates against the built schema', () => {
  // A string assertion on parliamentTypeDefs would be same-producer
  // corroboration (asserting the SDL contains what its author wrote). This
  // instead builds the schema and validates the CLIENT'S verbatim document —
  // the exact artifact that 400'd on every hub load before this root existed
  // (pattern: client-speeches-contract.test.ts).
  const KERNEL_STUBS = `
    scalar Date
    scalar DateTime
    scalar BigInt
    scalar JSON
    type PageInfo { hasNextPage: Boolean!  endCursor: String }
    type Entity { cui: String! }
    type Query { _root: Boolean }
  `;

  /** Verbatim from the client's parliament-queries.ts (PARLIAMENT_BILL_ACTIVITY_QUERY). */
  const CLIENT_BILL_ACTIVITY_QUERY = `
    query ParliamentBillActivity($year: Int!, $filter: ParliamentBillsFilter) {
      parliamentBillActivity(year: $year, filter: $filter) {
        year
        availableYears
        days {
          date
          total
        }
      }
    }
  `;

  it("the client's verbatim hub query validates with zero errors", () => {
    const schema = buildSchema(`${KERNEL_STUBS}\n${parliamentTypeDefs}`);
    const errors = validate(schema, parse(CLIENT_BILL_ACTIVITY_QUERY));
    expect(errors).toEqual([]);
  });
});
