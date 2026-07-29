/**
 * `parliamentVoteActivity` — the votes-hub heatmap.
 *
 * The design (`prod-db/PARLIAMENT_VOTE_ACTIVITY.md`) names three ways this field
 * can be wrong while looking right, and each has a test here:
 *
 *  1. It could count BALLOTS instead of DIVISIONS, filling the same pixels with a
 *     number two orders of magnitude larger that answers a different question.
 *  2. It could drift from the list beneath it by rebuilding the predicate instead
 *     of reusing `buildVoteConditions`.
 *  3. It could reuse the list's `hasVoteBound` guard and reject every q-search on
 *     the chart while the list beside it answers happily — the year argument IS
 *     the bound, and it has deliberately been removed from the filter.
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

import { getParliamentVoteActivity } from '@/modules/parliament/core/usecases.js';
import { makeParliamentRepo } from '@/modules/parliament/shell/repo/parliament-repo.js';

import type { ParliamentRepo } from '@/modules/parliament/core/ports.js';
import type { FilterInput, ProdDatabase } from '@/modules/shared/index.js';

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

const flat = (s: string): string => s.replace(/\s+/gu, ' ').trim();
const isCapabilityProbe = (q: Captured): boolean => /\blimit 0\b/u.test(q.sql);

const run = async (filter: FilterInput = {}): Promise<Captured[]> => {
  const captured: Captured[] = [];
  const repo = makeParliamentRepo(makeCapturingDb(captured));
  const r = await repo.voteActivity(2024, filter);
  expect(r.isOk()).toBe(true);
  return captured.filter((q) => !isCapabilityProbe(q));
};

const dayQuery = (captured: Captured[]): Captured => {
  const hit = captured.find((q) => /group by/iu.test(q.sql));
  if (hit === undefined) throw new Error('no per-day query captured');
  return hit;
};

describe('voteActivity — grain and predicate', () => {
  it('counts DIVISIONS: it never touches vote_records', async () => {
    const captured = await run();
    for (const q of captured) {
      expect(q.sql).not.toMatch(/vote_records/u);
    }
  });

  it('groups the votes table by vote_date', async () => {
    const sql = flat(dayQuery(await run()).sql);
    expect(sql).toMatch(/from "parliament"\."votes"/u);
    expect(sql).toMatch(/group by "v"\."vote_date"/u);
  });

  it('applies the privacy predicate — never fail-open', async () => {
    const sql = flat(dayQuery(await run()).sql);
    expect(sql).toMatch(/v\.privacy_class = 'public'/u);
  });

  /** Both partitions of `total`, off one scan. */
  it('emits the outcome split AND the chamber split', async () => {
    const sql = flat(dayQuery(await run()).sql);
    for (const fragment of [
      "filter (where v.outcome = 'adoptat')",
      "filter (where v.outcome = 'respins')",
      'filter (where v.outcome is null)',
      "filter (where v.chamber = 'camera_deputatilor')",
      "filter (where v.chamber = 'senat')",
      "filter (where v.chamber = 'comun')",
    ]) {
      expect(sql).toContain(fragment);
    }
  });

  /**
   * The list's own q predicate, reached through `buildVoteConditions`. If the
   * aggregate ever grew its own copy, the chart and the list would answer
   * different questions under the same search box.
   */
  it('reuses the list q predicate rather than rebuilding one', async () => {
    const sql = flat(dayQuery(await run({ q: { contains: 'buget' } })).sql);
    expect(sql).toMatch(/attrs->>'source_title'/u);
    expect(sql).toMatch(/translate/u);
  });

  it('bounds the per-day query by the requested year', async () => {
    const q = dayQuery(await run());
    expect(q.parameters).toContain('2024-01-01');
    expect(q.parameters).toContain('2024-12-31');
  });

  /** availableYears must survive its own year bound, or it can never grow. */
  it('does NOT year-bound availableYears', async () => {
    const captured = await run();
    const years = captured.find((c) => /distinct/iu.test(c.sql) && /extract/iu.test(c.sql));
    expect(years).toBeDefined();
    expect(years?.parameters).not.toContain('2024-01-01');
  });
});

describe('voteActivity — coverage', () => {
  it('reads coverage and its typed gaps', async () => {
    const captured = await run();
    const cov = captured.find((c) => c.sql.includes('vote_capture_coverage'));
    expect(cov).toBeDefined();
    expect(flat(cov?.sql ?? '')).toMatch(/vote_capture_gaps/u);
  });

  /**
   * Postgres canonicalises daterange to half-open [from, to+1). Surfacing
   * `upper()` verbatim would publish one day of coverage the crawl never made —
   * the precise off-by-one the coverage table exists to prevent.
   */
  it('converts the half-open upper bound back to an inclusive day', async () => {
    const captured = await run();
    const cov = captured.find((c) => c.sql.includes('vote_capture_coverage'));
    expect(flat(cov?.sql ?? '')).toContain('upper(r) - 1');
  });

  it('is NOT bounded by the requested year', async () => {
    const captured = await run();
    const cov = captured.find((c) => c.sql.includes('vote_capture_coverage'));
    expect(cov?.parameters).not.toContain('2024-01-01');
  });

  it('scopes coverage to the chambers actually asked for', async () => {
    const captured = await run({ chamber: { eq: 'senat' } });
    const cov = captured.find((c) => c.sql.includes('vote_capture_coverage'));
    expect(cov?.parameters).toContainEqual(['senat']);
  });

  it('returns every chamber when the filter names none', async () => {
    const captured = await run();
    const cov = captured.find((c) => c.sql.includes('vote_capture_coverage'));
    expect(flat(cov?.sql ?? '')).not.toMatch(/c\.chamber = any/u);
  });
});

describe('getParliamentVoteActivity — boundedness', () => {
  const depsWith = (repo: Partial<ParliamentRepo>) => ({ repo, meili: null }) as never;

  const okRepo = (spy: { called: boolean }) =>
    depsWith({
      voteActivity: () => {
        spy.called = true;
        return Promise.resolve({
          isOk: () => true,
          isErr: () => false,
          value: { year: 2024, days: [], availableYears: [], coverage: [] },
        }) as never;
      },
    });

  it('rejects a voteDate inside the filter — the year is the bound', async () => {
    const spy = { called: false };
    const r = await getParliamentVoteActivity(okRepo(spy), 2024, {
      voteDate: { from: '2024-01-01', to: '2024-02-01' },
    });
    expect(r.isErr()).toBe(true);
    expect(spy.called).toBe(false);
  });

  it('rejects a year outside the plausible range', async () => {
    const spy = { called: false };
    expect((await getParliamentVoteActivity(okRepo(spy), 1200)).isErr()).toBe(true);
    expect((await getParliamentVoteActivity(okRepo(spy), 2.5)).isErr()).toBe(true);
    expect(spy.called).toBe(false);
  });

  /**
   * THE regression this field is most likely to grow. `listVotes` refuses a
   * q-only request when the search engine is down; the chart must not inherit
   * that guard, because its mandatory `year` already bounds the scan.
   */
  it('ACCEPTS a q with no chamber or date facet', async () => {
    const spy = { called: false };
    const r = await getParliamentVoteActivity(okRepo(spy), 2024, {
      q: { contains: 'buget' },
    });
    expect(r.isErr()).toBe(false);
    expect(spy.called).toBe(true);
  });

  it('ACCEPTS a groupVote with no other bound', async () => {
    const spy = { called: false };
    const r = await getParliamentVoteActivity(okRepo(spy), 2024, {
      groupVote: { group: 'psd' },
    });
    expect(r.isErr()).toBe(false);
    expect(spy.called).toBe(true);
  });
});
