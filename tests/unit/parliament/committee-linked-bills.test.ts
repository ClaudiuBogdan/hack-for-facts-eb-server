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

const run = async (): Promise<{ rows: Captured; count: Captured }> => {
  const captured: Captured[] = [];
  const repo = makeParliamentRepo(makeDb(captured, []));
  const res = await repo.listCommitteeLinkedBills(KEY, COMMITTEE_LINKED_BILLS_CAP);
  expect(res.isOk()).toBe(true);
  expect(captured).toHaveLength(2);
  return { rows: captured[0]!, count: captured[1]! };
};

describe('listCommitteeLinkedBills — the committee → bills predicate', () => {
  it('unions the referral step-links with the document links (UNION, never UNION ALL)', async () => {
    const { rows } = await run();
    const text = flat(rows.sql);

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
    const { rows, count } = await run();

    for (const [label, stmt] of [
      ['rows', rows],
      ['count', count],
    ] as const) {
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
    const { rows } = await run();
    const text = flat(rows.sql);

    // billOrderBy('updated_desc') — last_event_date desc nulls last, key as tiebreak.
    expect(text).toContain('order by case when jsonb_typeof("b"."attrs"->\'last_event_date\')');
    expect(text).toContain('desc nulls last, b.bill_key asc');
    // …and NOT the bare text sort it replaced (Kysely's `.orderBy('b.bill_key')`,
    // which quotes the identifier — the shape this regression test exists for).
    expect(text).not.toContain('order by "b"."bill_key" asc');
  });

  it('reads the page and the total through the SAME predicate text and parameters', async () => {
    const { rows, count } = await run();

    // Byte-identical, placeholders included: BILL_SELECT and billOrderBy build with
    // sql.lit, so neither statement shifts the union's $1/$2 numbering. If a future
    // edit introduces a bound parameter ahead of the WHERE, this fails loudly
    // rather than letting the two reads drift into disagreeing about the total.
    expect(predicateOf(flat(count.sql))).toBe(predicateOf(flat(rows.sql)));
    expect(predicateOf(flat(rows.sql))).toContain('$1');
    expect(predicateOf(flat(rows.sql))).toContain('$2');
    expect(count.parameters).toEqual([KEY, KEY]);
    expect(rows.parameters).toEqual([KEY, KEY, COMMITTEE_LINKED_BILLS_CAP]);

    // The count is over `bills` under that predicate — the rows the cap could have
    // served — so `total >= served` holds by construction.
    expect(flat(count.sql)).toContain('select count(*) as "cnt" from "parliament"."bills" as "b"');
  });

  it('bounds the page at the measured cap, and the cap is the only limit', async () => {
    const { rows, count } = await run();

    expect(COMMITTEE_LINKED_BILLS_CAP).toBe(500);
    expect(flat(rows.sql)).toContain('limit $3');
    expect(rows.parameters[2]).toBe(COMMITTEE_LINKED_BILLS_CAP);
    // The total must not be bounded by anything — a capped count would report the
    // cap back as the truth and the truncation would become invisible.
    expect(flat(count.sql)).not.toContain('limit');
  });
});
