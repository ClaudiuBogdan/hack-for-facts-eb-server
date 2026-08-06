/**
 * `listCommitteeLinkedBills` — the committee → bills predicate (2026-08-06).
 *
 * The read used to be documents-only (`committee_bill_links` via
 * `committee_documents`) with an `is_canonical` filter on the edge's own bill and
 * an `order by bill_key asc`. Each of those three is a way to lose real rows, and
 * on live Senate data they lost nearly all of them:
 *
 *  - documents-only covers 4% of Senate committee documents, so committees with
 *    197 and 701 bills served ZERO;
 *  - `is_canonical` on the edge's bill drops the 194,269 edges that legitimately
 *    anchor on a referred (suppressed) twin — 197 bills become 10;
 *  - `bill_key asc` is a TEXT sort, so all 20,748 numeric CDep keys precede every
 *    `senat:` key: under a cap, the Senate half of a committee is hidden by sort
 *    order rather than by absence.
 *
 * These pin the shape, not the data: the union arms, the coalesce join, the sort,
 * and — the one that keeps the cap honest — that the rows read and the count read
 * carry the SAME predicate text, so the total always names the set the cap cut.
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

import { COMMITTEE_LINKED_BILLS_CAP } from '@/modules/parliament/core/usecases.js';
import { makeParliamentRepo } from '@/modules/parliament/shell/repo/parliament-repo.js';

import type { ProdDatabase } from '@/modules/shared/index.js';

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

/** The shared predicate, lifted out of whichever statement carries it. */
const predicateOf = (sqlText: string): string => {
  const start = sqlText.indexOf('b.bill_key in (');
  expect(start, 'the union predicate is present').toBeGreaterThan(-1);
  // The rows statement continues into ORDER BY / LIMIT; the count statement ends
  // at the predicate. Compare the predicate itself, not the tail behind it.
  const end = sqlText.indexOf(') order by', start);
  return end === -1 ? sqlText.slice(start) : sqlText.slice(start, end + 1);
};

const KEY = 'senate:ef36e8b3-2fb2-43e8-bd6d-1ad040db24b3';

/**
 * ONE statement — the page and its total are read together. Two statements could
 * straddle a loader commit and report a total the page provably contradicts, and
 * would cost a second ~23 ms round trip to do it.
 */
const run = async (): Promise<Captured> => {
  const captured: Captured[] = [];
  const repo = makeParliamentRepo(makeDb(captured, []));
  const res = await repo.listCommitteeLinkedBills(KEY, COMMITTEE_LINKED_BILLS_CAP);
  expect(res.isOk()).toBe(true);
  expect(captured).toHaveLength(1);
  return captured[0]!;
};

describe('listCommitteeLinkedBills — the committee → bills predicate', () => {
  it('unions the referral step-links with the document links (UNION, never UNION ALL)', async () => {
    const text = flat((await run()).sql);

    expect(text).toContain('from parliament.bill_step_links l');
    expect(text).toContain("l.link_kind = 'committee'");
    expect(text).toContain('from parliament.committee_bill_links cbl');
    expect(text).toContain('join parliament.committee_documents cd');

    // The arms overlap on 26,661 edges. UNION ALL would double-count every one of
    // them into the total while the rows read stayed distinct.
    expect(text).toContain(' union select ');
    expect(text).not.toContain('union all');
  });

  it('joins through coalesce(canonical_bill_key, bill_key) and never filters is_canonical', async () => {
    const stmt = await run();

    {
      const label = 'rows';
      const text = flat(stmt.sql);
      expect(text, label).toContain('coalesce(src.canonical_bill_key, src.bill_key)');
      // The load-bearing negative, scoped to the PREDICATE. `is_canonical` is a
      // legitimate BILL_SELECT column (the client renders canonicality); what must
      // never come back is canonicality as a FILTER. A referral anchor sits on the
      // twin that was referred while B1 makes the CDep row canonical, so filtering
      // the edge's own bill on it is what turned 197 served bills into 10.
      expect(predicateOf(text), label).not.toContain('is_canonical');
      expect(text, label).not.toContain('and b.is_canonical');
      expect(text, label).not.toContain('where b.is_canonical');
    }
  });

  it('orders by the shared bill sort (updated_desc), not by bill_key', async () => {
    const text = flat((await run()).sql);

    // billOrderBy('updated_desc') — last_event_date desc nulls last, key as tiebreak.
    expect(text).toContain('order by case when jsonb_typeof("b"."attrs"->\'last_event_date\')');
    expect(text).toContain('desc nulls last, b.bill_key asc');
    // …and NOT the bare text sort it replaced (Kysely's `.orderBy('b.bill_key')`,
    // which quotes the identifier — the shape this regression test exists for).
    expect(text).not.toContain('order by "b"."bill_key" asc');
  });

  it('measures the total in the SAME statement as the page it describes', async () => {
    const stmt = await run();
    const text = flat(stmt.sql);

    // A WINDOW count, not a second statement: a window is computed before LIMIT,
    // so it names the whole matching set, and being in the same statement it is
    // necessarily the same snapshot as the rows. The predicate is therefore ONE
    // predicate by construction — there is no second copy that could drift.
    expect(text).toContain('count(*) over () as "total"');
    expect(predicateOf(text)).toContain('$1');
    expect(predicateOf(text)).toContain('$2');
    expect(stmt.parameters).toEqual([KEY, KEY, COMMITTEE_LINKED_BILLS_CAP]);
    // …and the predicate appears exactly once in the statement.
    expect(text.split('b.bill_key in (').length - 1).toBe(1);
  });

  it('gates the document arm on privacy — restricted rows are stored, never served', async () => {
    const text = flat((await run()).sql);

    // Both sides of the document arm: a restricted DOCUMENT must not surface its
    // bill, and neither must a restricted LINK. Strict equality, never
    // coalesce(privacy_class,'public') — that is the fail-open no-op this file's
    // speech-privacy section already documents.
    expect(text).toContain("cd.privacy_class = 'public'");
    expect(text).toContain("cbl.privacy_class = 'public'");
    expect(text).not.toContain('coalesce(cd.privacy_class');
    expect(text).not.toContain('coalesce(cbl.privacy_class');
  });

  it('bounds the page at the measured cap, and the cap is the only limit', async () => {
    const stmt = await run();

    expect(COMMITTEE_LINKED_BILLS_CAP).toBe(500);
    expect(flat(stmt.sql)).toContain('limit $3');
    expect(stmt.parameters[2]).toBe(COMMITTEE_LINKED_BILLS_CAP);
    // The window count is evaluated BEFORE the limit, so the cap bounds the rows
    // served without bounding the total that reports the truncation.
    expect(flat(stmt.sql).indexOf('count(*) over ()')).toBeLessThan(
      flat(stmt.sql).indexOf('limit $3')
    );
  });
});
