/**
 * What SQL `countActsBy` (Query.legalActCounts) actually sends.
 *
 * The property that matters is NON-divergence: the grid's number for a cell
 * must be a count over exactly the set `legalActs` would list for the same
 * filter. So these tests do not only pin per-dimension fragments (unnest,
 * distinct, null-key drop) — they compile `listActs` and `countActsBy` with
 * the SAME filter and assert the count's WHERE is the list's kernel WHERE plus
 * only the null-key guard, with identical bind values. Delete the shared
 * `kernelConditions`/`actsListFrom` reuse and this fails — which is the point.
 */

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
import { ok } from 'neverthrow';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  LEGAL_COUNTS_TOPN_DEFAULT,
  LEGAL_COUNTS_TOPN_MAX,
  LEGAL_COUNTS_TOPN_YEAR_MAX,
  countLegalActs,
} from '@/modules/legal/core/usecases.js';
import { makeLegalActsRepo } from '@/modules/legal/shell/repo/acts-repo.js';

import type { LegalActsRepo } from '@/modules/legal/core/ports.js';
import type { LegalCountBucket } from '@/modules/legal/core/types.js';
import type { ProdDatabase } from '@/modules/shared/index.js';

interface Captured {
  sql: string;
  parameters: readonly unknown[];
}

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

/** Normalised to one line so assertions do not depend on formatting. */
const lastSql = (): string => {
  const captured = statements[statements.length - 1];
  expect(captured).toBeDefined();
  return (captured?.sql ?? '').replace(/\s+/gu, ' ').trim();
};

const lastParams = (): readonly unknown[] => statements[statements.length - 1]?.parameters ?? [];

/** The WHERE clause body, whatever follows it (group by / order by / limit). */
const whereOf = (sql: string): string => {
  const match = /where (?<body>.*?) (?:group by|order by)/u.exec(sql);
  expect(match).not.toBeNull();
  return match?.groups?.['body'] ?? '';
};

beforeEach(() => {
  statements = [];
});

describe('countActsBy — per-dimension SQL shape', () => {
  it('DOMAIN unnests the summary text[] and counts DISTINCT acts', async () => {
    const repo = makeLegalActsRepo(makeDb());
    await repo.countActsBy('domain', {});

    const sql = lastSql();
    expect(sql).toContain('cross join lateral unnest(s.domains) as dom(domain)');
    expect(sql).toContain('count(distinct a.act_id)');
    expect(sql).toContain('group by dom.domain');
    // NULL is not a filter value, so it is never served as a bucket key.
    expect(sql).toContain('dom.domain is not null');
  });

  it('every dimension keeps the FIXED canonical-join FROM of the acts list', async () => {
    // The domain/category filter fields live on alias `s`; dropping the joins
    // would make a filtered count silently ignore those filters.
    const repo = makeLegalActsRepo(makeDb());
    for (const dim of ['domain', 'act_type', 'status', 'issuer', 'year'] as const) {
      await repo.countActsBy(dim, {});
      const sql = lastSql();
      expect(sql).toContain('legal.acts a');
      expect(sql).toContain('left join legal.act_documents d on d.act_id = a.act_id');
      expect(sql).toContain('left join legal.document_summaries s');
    }
  });

  it('YEAR serves a text key (bucket keys are strings) grouped on the same cast', async () => {
    const repo = makeLegalActsRepo(makeDb());
    await repo.countActsBy('year', {});

    const sql = lastSql();
    expect(sql).toContain('a.act_year::text as key');
    expect(sql).toContain('group by a.act_year::text');
    expect(sql).toContain('a.act_year::text is not null');
  });

  it('orders buckets count desc with a deterministic key tiebreak', async () => {
    const repo = makeLegalActsRepo(makeDb());
    await repo.countActsBy('status', {});

    expect(lastSql()).toContain('order by count(*) desc, a.status asc');
  });

  it('refuses an unknown dimension instead of guessing a column', async () => {
    const repo = makeLegalActsRepo(makeDb());
    const result = await repo.countActsBy('bogus' as never, {});

    expect(result.isErr()).toBe(true);
    expect(result.isErr() && result.error.message).toContain("invalid dimension 'bogus'");
    expect(statements).toHaveLength(0); // refused before any SQL
  });
});

describe('countActsBy — the filter is the SAME legalActsSpec compilation as legalActs', () => {
  const FILTER = { status: { in: ['in-vigoare'] }, yearFrom: { gte: 2000 } };

  it("the count's WHERE is the list's kernel WHERE plus only the null-key guard", async () => {
    const repo = makeLegalActsRepo(makeDb());
    await repo.listActs({ filter: FILTER, sort: 'in_degree', dir: 'desc', page: { first: 20 } });
    const listSql = lastSql();
    const listWhere = whereOf(listSql);
    const listParams = lastParams();

    await repo.countActsBy('act_type', FILTER);
    const countWhere = whereOf(lastSql());

    // Byte-identical kernel conditions + the same bind values, so a filtered
    // count can never diverge from the filtered list it annotates.
    expect(listWhere.length).toBeGreaterThan(0);
    expect(countWhere).toBe(`${listWhere} and a.act_type is not null`);
    expect(lastParams()).toEqual(listParams.slice(0, lastParams().length));
    expect(lastParams()).toContain('in-vigoare');
    expect(lastParams()).toContain(2000);
  });

  it('a DOMAIN grouping still honours a domain filter (containment + unnest coexist)', async () => {
    const repo = makeLegalActsRepo(makeDb());
    await repo.countActsBy('domain', { domain: { in: ['fiscal-si-bugetar'] } });

    const sql = lastSql();
    // The spec-compiled array-membership condition on s.domains…
    expect(sql).toContain('"s"."domains"');
    // …AND the grouping unnest, independently.
    expect(sql).toContain('cross join lateral unnest(s.domains)');
    expect(lastParams()).toContain('fiscal-si-bugetar');
  });
});

// ── bucket mapping over fed rows (labels + count coercion) ───────────────────

/** A minimal db whose next query answers the queued rows (real repo above it). */
const makeRowsDb = (rows: unknown[]): Kysely<ProdDatabase> => {
  const connection: DatabaseConnection = {
    executeQuery: <R>(_compiled: CompiledQuery): Promise<QueryResult<R>> =>
      Promise.resolve({ rows: rows as R[] }),
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
  return new Kysely<ProdDatabase>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (d) => new PostgresIntrospector(d),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
};

describe('countActsBy — bucket mapping', () => {
  it('ISSUER buckets carry the de-hyphenated display label (vocab-repo precedent)', async () => {
    const repo = makeLegalActsRepo(
      makeRowsDb([
        { key: 'ministerul-sanatatii', cnt: '1200' },
        { key: 'guvernul', cnt: '900' },
      ])
    );
    const result = (await repo.countActsBy('issuer', {}))._unsafeUnwrap();

    expect(result).toEqual([
      { key: 'ministerul-sanatatii', label: 'ministerul sanatatii', count: 1200 },
      { key: 'guvernul', label: 'guvernul', count: 900 },
    ]);
  });

  it('enum/year keys are their own display value — label stays null; int8 counts become numbers', async () => {
    const repo = makeLegalActsRepo(makeRowsDb([{ key: 'fiscal-si-bugetar', cnt: '31415' }]));
    const result = (await repo.countActsBy('domain', {}))._unsafeUnwrap();

    expect(result).toEqual([{ key: 'fiscal-si-bugetar', label: null, count: 31415 }]);
  });
});

// ── the usecase topN clamp (BLOCKER 2: 6,005 ISSUER buckets = 1.8 MB) ────────

describe('countLegalActs — the topN clamp is served, never silent', () => {
  const bucketsOf = (count: number): LegalCountBucket[] =>
    Array.from({ length: count }, (_, i) => ({
      key: `k${String(i).padStart(4, '0')}`,
      label: null,
      count: count - i,
    }));
  const repoWith = (buckets: readonly LegalCountBucket[]): LegalActsRepo =>
    ({ countActsBy: async () => ok(buckets) }) as unknown as LegalActsRepo;

  it('default truncates an open dimension and reports the EXACT unserved remainder', async () => {
    const result = (await countLegalActs(repoWith(bucketsOf(25)), 'issuer', {}))._unsafeUnwrap();

    expect(result.buckets).toHaveLength(LEGAL_COUNTS_TOPN_DEFAULT);
    expect(result.bucketsTruncated).toBe(true);
    // tail counts are 5,4,3,2,1 → the flag rides with the exact remainder, so
    // a partition dimension still sums to its total (buckets + otherCount).
    expect(result.otherCount).toBe(15);
  });

  it('DOMAIN (16) and STATUS (7) arrive complete under the default', async () => {
    for (const [dim, size] of [
      ['domain', 16],
      ['status', 7],
    ] as const) {
      const result = (await countLegalActs(repoWith(bucketsOf(size)), dim, {}))._unsafeUnwrap();
      expect(result.buckets).toHaveLength(size);
      expect(result.bucketsTruncated).toBe(false);
      expect(result.otherCount).toBe(0);
    }
  });

  it('rejects an out-of-range topN (procurement normalizeTopN pattern) — no silent clamp', async () => {
    const repo = repoWith(bucketsOf(5));
    for (const topN of [0, -1, 2.5, LEGAL_COUNTS_TOPN_MAX + 1]) {
      const result = await countLegalActs(repo, 'issuer', {}, topN);
      expect(result.isErr(), String(topN)).toBe(true);
      expect(result.isErr() && result.error.message).toContain('topN');
    }
    expect((await countLegalActs(repo, 'issuer', {}, LEGAL_COUNTS_TOPN_MAX)).isOk()).toBe(true);
  });

  it('YEAR is a histogram: its ceiling admits the full span, and only YEAR gets it', async () => {
    const repo = repoWith(bucketsOf(5));
    expect((await countLegalActs(repo, 'year', {}, LEGAL_COUNTS_TOPN_YEAR_MAX)).isOk()).toBe(true);
    expect((await countLegalActs(repo, 'year', {}, LEGAL_COUNTS_TOPN_YEAR_MAX + 1)).isErr()).toBe(
      true
    );
    expect((await countLegalActs(repo, 'issuer', {}, LEGAL_COUNTS_TOPN_YEAR_MAX)).isErr()).toBe(
      true
    );
  });

  it('an explicit small topN truncates even a closed vocabulary — honestly flagged', async () => {
    const result = (await countLegalActs(repoWith(bucketsOf(16)), 'domain', {}, 5))._unsafeUnwrap();
    expect(result.buckets).toHaveLength(5);
    expect(result.bucketsTruncated).toBe(true);
    expect(result.otherCount).toBe(11 + 10 + 9 + 8 + 7 + 6 + 5 + 4 + 3 + 2 + 1);
  });
});
