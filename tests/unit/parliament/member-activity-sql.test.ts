/**
 * SQL-shape regressions for the member-activity repository paths. These compile
 * and execute the REAL Kysely queries against a capturing driver, so the
 * assertions hold without a live database.
 *
 * Covered:
 *  - `memberActivityCounts` is ONE statement (the fan-out that amplified the
 *    false-404 blocker), mandate-bounded, and mirrors the predicates of the lists
 *    it counts — so a total can never disagree with its connection/page `total`.
 *  - B2-F1: offset-paginated member activity sorts on a UNIQUE tiebreak, so pages
 *    partition the set instead of skipping/duplicating rows with a tied date.
 *  - Strict `privacy_class = 'public'` — never fail-open `coalesce(…, 'public')`.
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

import { makeParliamentRepo } from '@/modules/parliament/shell/repo/parliament-repo.js';

import type { ProdDatabase } from '@/modules/shared/index.js';

interface Captured {
  readonly sql: string;
  readonly parameters: readonly unknown[];
}

const makeCapturingDb = (
  captured: Captured[],
  rows: readonly unknown[] = []
): Kysely<ProdDatabase> => {
  const connection: DatabaseConnection = {
    executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
      captured.push({ sql: query.sql, parameters: query.parameters });
      return Promise.resolve({ rows: rows as R[] });
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

/** Collapse whitespace so multi-line raw SQL can be asserted on substrings. */
const flat = (s: string): string => s.replace(/\s+/gu, ' ').trim();

/**
 * Capability probes are `limit 0` schema checks, not counted reads: the repo must know
 * whether the additive canonical columns/relations are queryable BEFORE it may emit the
 * canonical-preference predicate (a missing column fails at PARSE time). They return no
 * rows by construction, so they are excluded from the assertions below, which are about
 * the counting statement itself.
 */
const isCapabilityProbe = (query: Captured): boolean => /\blimit 0\b/u.test(query.sql);

describe('memberActivityCounts — one statement, mirrored predicates', () => {
  const runCounts = async (): Promise<Captured[]> => {
    const captured: Captured[] = [];
    const repo = makeParliamentRepo(
      makeCapturingDb(captured, [
        {
          votes: '1084',
          control_items: '0',
          speeches: '6252',
          initiatives: '31',
          declarations: '0',
        },
      ])
    );
    const r = await repo.memberActivityCounts('1:2024:7');
    expect(r.isOk()).toBe(true);
    expect(r._unsafeUnwrap()).toEqual({
      votes: 1084,
      controlItems: 0,
      speeches: 6252,
      initiatives: 31,
      declarations: 0,
    });
    return captured.filter((q) => !isCapabilityProbe(q));
  };

  it('issues exactly ONE query for all five totals', async () => {
    const captured = await runCounts();
    expect(captured).toHaveLength(1);
  });

  it('binds every sub-count to the mandate (vote_records is never scanned unparented)', async () => {
    const captured = await runCounts();
    const q = captured[0];
    expect(q?.parameters).toEqual(['1:2024:7', '1:2024:7', '1:2024:7', '1:2024:7', '1:2024:7']);
    const text = flat(q?.sql ?? '');
    expect(text).toContain('from parliament.vote_records vr');
    expect(text).toContain('where vr.mandate_key = $1');
  });

  it('mirrors the control-list predicates (no motions, strict public)', async () => {
    const text = flat((await runCounts())[0]?.sql ?? '');
    expect(text).toContain("c.control_type is distinct from 'motion'");
    expect(text).toContain("c.privacy_class = 'public'");
  });

  it('mirrors the speech-list predicates (not quarantined, strict public)', async () => {
    const text = flat((await runCounts())[0]?.sql ?? '');
    expect(text).toContain('s.quarantined = false');
    expect(text).toContain("s.privacy_class = 'public'");
    expect(text).not.toContain('coalesce(s.privacy_class');
  });

  it('strictly gates every other counted activity table', async () => {
    const text = flat((await runCounts())[0]?.sql ?? '');
    expect(text).toContain("vr.privacy_class = 'public'");
    expect(text).toContain("v.privacy_class = 'public'");
    expect(text).toContain("mi.privacy_class = 'public'");
    expect(text).toContain("d.privacy_class = 'public'");
    expect(text).not.toContain('coalesce(');
  });
});

describe('B2-F1 — offset member activity has a UNIQUE tiebreak', () => {
  it('orders control items by item_date DESC then item_key DESC', async () => {
    const captured: Captured[] = [];
    const repo = makeParliamentRepo(makeCapturingDb(captured));

    const r = await repo.listMemberControlItems('2:2024:100', { page: 2, pageSize: 20 });
    expect(r.isOk()).toBe(true);

    const rowQuery = captured.find((q) => q.sql.includes('order by'));
    expect(rowQuery?.sql).toContain('order by "c"."item_date" desc, "c"."item_key" desc');
    // Offset pagination without a total order is exactly the skip/duplicate bug.
    expect(rowQuery?.sql).toContain('offset');
  });

  it('orders legacy member speeches by spoken_at DESC then speech_key DESC', async () => {
    const captured: Captured[] = [];
    const repo = makeParliamentRepo(makeCapturingDb(captured));

    const r = await repo.listMemberSpeeches('2:2024:100', { page: 2, pageSize: 20 });
    expect(r.isOk()).toBe(true);

    const rowQuery = captured.find((q) => q.sql.includes('order by'));
    expect(rowQuery?.sql).toContain('order by "s"."spoken_at" desc, "s"."speech_key" desc');
    expect(rowQuery?.sql).toContain('offset');
  });

  it('keeps the already-correct initiatives tiebreak', async () => {
    const captured: Captured[] = [];
    const repo = makeParliamentRepo(makeCapturingDb(captured));

    const r = await repo.listMemberInitiatives('2:2024:100', { page: 2, pageSize: 20 });
    expect(r.isOk()).toBe(true);

    const rowQuery = captured.find((q) => q.sql.includes('order by'));
    expect(rowQuery?.sql).toContain('"mi"."initiative_key" desc');
  });
});

describe('control-items privacy — strict, on every served read', () => {
  it('gates the member control page and its total', async () => {
    const captured: Captured[] = [];
    const repo = makeParliamentRepo(makeCapturingDb(captured));

    const r = await repo.listMemberControlItems('2:2024:100', { page: 1, pageSize: 20 });
    expect(r.isOk()).toBe(true);
    expect(captured.length).toBeGreaterThan(0);
    for (const q of captured) {
      expect(q.sql).toContain("c.privacy_class = 'public'");
      expect(q.sql).not.toContain('coalesce(c.privacy_class');
    }
  });

  it('gates the standalone control-items cursor list', async () => {
    const captured: Captured[] = [];
    const repo = makeParliamentRepo(makeCapturingDb(captured));

    const r = await repo.listControlItems({ controlType: { eq: 'question' } }, { first: 20 });
    expect(r.isOk()).toBe(true);
    expect(captured.length).toBeGreaterThan(0);
    for (const q of captured) expect(q.sql).toContain("c.privacy_class = 'public'");
  });
});

describe('other member activity privacy — strict and count/list aligned', () => {
  it('gates member votes on both the ballot and parent vote', async () => {
    const captured: Captured[] = [];
    const repo = makeParliamentRepo(makeCapturingDb(captured));

    const r = await repo.listMemberVotes('2:2024:100', { first: 20 });
    expect(r.isOk()).toBe(true);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.sql).toContain("vr.privacy_class = 'public'");
    expect(captured[0]?.sql).toContain("v.privacy_class = 'public'");
  });

  it('gates initiative rows and totals with the same predicate', async () => {
    const captured: Captured[] = [];
    const repo = makeParliamentRepo(makeCapturingDb(captured));

    const r = await repo.listMemberInitiatives('2:2024:100', { page: 1, pageSize: 20 });
    expect(r.isOk()).toBe(true);
    expect(captured).toHaveLength(2);
    for (const query of captured) {
      expect(query.sql).toContain("mi.privacy_class = 'public'");
    }
  });

  it('gates declaration rows', async () => {
    const captured: Captured[] = [];
    const repo = makeParliamentRepo(makeCapturingDb(captured));

    const r = await repo.listMemberDeclarations('2:2024:100');
    expect(r.isOk()).toBe(true);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.sql).toContain("d.privacy_class = 'public'");
  });
});

describe('source-traceability — the existing prod source_url columns are selected', () => {
  it('projects control_items.source_url on the member page', async () => {
    const captured: Captured[] = [];
    const repo = makeParliamentRepo(makeCapturingDb(captured));

    await repo.listMemberControlItems('2:2024:100', { page: 1, pageSize: 20 });
    expect(captured[0]?.sql).toContain('"c"."source_url"');
  });

  it('projects persons.source_url on the person read', async () => {
    const captured: Captured[] = [];
    const repo = makeParliamentRepo(makeCapturingDb(captured));

    await repo.findPerson('4242');
    expect(captured[0]?.sql).toContain('"p"."source_url"');
  });
});
