/**
 * Companies unit tests — the `companyHubStats` usecase (leg composition, fail-fast)
 * and its shell cache provider (singleflight, TTL, stale-while-revalidate, and the
 * rule that an `err` is never cached).
 *
 * Hand-rolled fakes only (no mocking library): a `countBy`-shaped repo stub and an
 * injected clock, so the TTL is driven deterministically instead of by sleeping.
 */

import { err, ok, type Result } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import {
  makeCompanyHubStats,
  type CompanyHubStatsData,
} from '@/modules/companies/core/usecases.js';
import { makeHubStatsProvider } from '@/modules/companies/shell/hub-stats-cache.js';

import type { CompaniesRepository } from '@/modules/companies/core/ports.js';
import type {
  CompanyCoverage,
  CompanyGroupBy,
  CompanyGroupCount,
} from '@/modules/companies/core/types.js';
import type { ApiError, FilterInput } from '@/modules/shared/index.js';

const unwrap = <T>(r: Result<T, ApiError>): T => {
  if (r.isErr()) throw new Error(`expected ok, got ${r.error.type}: ${r.error.message}`);
  return r.value;
};

const coverage: CompanyCoverage = {
  territoryMatched: 1_046_512,
  territoryUnmatched: 677_879,
  note: 'note',
};

type CountByResult = Result<
  { groups: readonly CompanyGroupCount[]; denominator: number; coverage: CompanyCoverage },
  ApiError
>;

/** Records the (groupBy, filter) of every leg so the test can assert ORDER + args. */
interface CountByCall {
  readonly groupBy: CompanyGroupBy;
  readonly filter: FilterInput;
}

const dbErr = (message: string): ApiError => ({ type: 'Database', message });

const makeRepoFake = (
  results: Readonly<Record<CompanyGroupBy, CountByResult>>
): { repo: Pick<CompaniesRepository, 'countBy'>; calls: CountByCall[] } => {
  const calls: CountByCall[] = [];
  return {
    calls,
    repo: {
      countBy: async (groupBy, filter): Promise<CountByResult> => {
        calls.push({ groupBy, filter });
        return Promise.resolve(results[groupBy]);
      },
    },
  };
};

const okLegs = (): Readonly<Record<CompanyGroupBy, CountByResult>> => ({
  // Shaped after the real prod values (measured 2026-07-09).
  status: ok({
    groups: [
      { key: '1084', label: 'radiată', count: 2_017_899 },
      { key: '1048', label: 'funcțiune', count: 1_724_391 },
      // A code whose registry label is NULL → the nomenclature fills it in.
      { key: '1070', label: null, count: 12_000 },
      { key: '9999', label: null, count: 7 },
    ],
    denominator: 3_985_167,
    coverage: { territoryMatched: 0, territoryUnmatched: 0, note: 'status-leg coverage' },
  }),
  county: ok({
    groups: [
      { key: '(none)', label: null, count: 677_879 },
      ...Array.from({ length: 12 }, (_, i) => ({
        key: `County${String(i)}`,
        label: null,
        count: 1000 - i,
      })),
    ],
    denominator: 1_724_391,
    coverage,
  }),
  caenDivision: ok({
    groups: [
      { key: '47', label: null, count: 300_000 },
      { key: '62', label: null, count: 100_000 },
      // The real repo emits this: left('', 2) over the 239,950 empty caen_code rows.
      { key: '', label: null, count: 50_000 },
    ],
    denominator: 450_000,
    coverage: { territoryMatched: null, territoryUnmatched: null, note: 'n/a' },
  }),
});

describe('makeCompanyHubStats (usecase)', () => {
  it('composes the three legs sequentially, active-filtered where it matters', async () => {
    const { repo, calls } = makeRepoFake(okLegs());
    const stats = unwrap(await makeCompanyHubStats({ repo: repo as CompaniesRepository }));

    // Leg ORDER is part of the contract: concurrent heavy scans saturate the pool (M7).
    expect(calls.map((c) => c.groupBy)).toEqual(['status', 'county', 'caenDivision']);
    // The STATUS leg is unfiltered (its denominator is the whole spine)…
    expect(calls[0]?.filter).toEqual({});
    // …the other two are scoped to the ACTIVE population.
    expect(calls[1]?.filter).toEqual({ status: { eq: '1048' } });
    expect(calls[2]?.filter).toEqual({ status: { eq: '1048' } });

    expect(stats.totalCompanies).toBe(3_985_167);
    expect(stats.activeCompanies).toBe(1_724_391);
    expect(stats.coverage).toEqual(coverage); // the COUNTY leg's coverage, not status'.
  });

  it('drops the empty-code bucket from caenDivisions (every key is a 2-digit division)', async () => {
    const { repo } = makeRepoFake(okLegs());
    const stats = unwrap(await makeCompanyHubStats({ repo: repo as CompaniesRepository }));
    expect(stats.caenDivisions.map((d) => d.key)).toEqual(['47', '62']);
    expect(stats.caenDivisions.every((d) => d.key.length === 2)).toBe(true);
  });

  it('labels a NULL-label status code from the nomenclature, leaves unknown codes null', async () => {
    const { repo } = makeRepoFake(okLegs());
    const stats = unwrap(await makeCompanyHubStats({ repo: repo as CompaniesRepository }));
    expect(stats.statusMix.find((g) => g.key === '1070')?.label).toBe('faliment');
    expect(stats.statusMix.find((g) => g.key === '9999')?.label).toBeNull();
    // The registry label still wins where present.
    expect(stats.statusMix.find((g) => g.key === '1048')?.label).toBe('funcțiune');
  });

  it('drops the (none) bucket from topCounties and caps it at 10', async () => {
    const { repo } = makeRepoFake(okLegs());
    const stats = unwrap(await makeCompanyHubStats({ repo: repo as CompaniesRepository }));
    expect(stats.topCounties).toHaveLength(10);
    expect(stats.topCounties.map((c) => c.key)).not.toContain('(none)');
    expect(stats.topCounties[0]?.key).toBe('County0');
  });

  it('reports 0 active companies when the 1048 group is absent', async () => {
    const legs = { ...okLegs(), status: ok({ groups: [], denominator: 0, coverage }) };
    const { repo } = makeRepoFake(legs);
    const stats = unwrap(await makeCompanyHubStats({ repo: repo as CompaniesRepository }));
    expect(stats.activeCompanies).toBe(0);
    expect(stats.totalCompanies).toBe(0);
  });

  it('fails fast on the first failing leg and does not run the rest', async () => {
    const legs = { ...okLegs(), county: err(dbErr('county boom')) as CountByResult };
    const { repo, calls } = makeRepoFake(legs);
    const res = await makeCompanyHubStats({ repo: repo as CompaniesRepository });
    expect(res.isErr()).toBe(true);
    if (res.isErr()) expect(res.error.message).toBe('county boom');
    // caenDivision (the 23.6s leg) must never run once an earlier leg failed.
    expect(calls.map((c) => c.groupBy)).toEqual(['status', 'county']);
  });

  it('propagates a failing caenDivision leg', async () => {
    const legs = { ...okLegs(), caenDivision: err(dbErr('caen timeout')) as CountByResult };
    const { repo } = makeRepoFake(legs);
    const res = await makeCompanyHubStats({ repo: repo as CompaniesRepository });
    expect(res.isErr()).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

const data = (total: number): CompanyHubStatsData => ({
  totalCompanies: total,
  activeCompanies: 1,
  statusMix: [],
  topCounties: [],
  caenDivisions: [],
  coverage,
});

/**
 * A controllable compute: counts invocations and settles only when the test says
 * so. `rejectWith` models a compute that THROWS (not an `err` Result) — the path
 * whose rejection the provider must swallow on a background refresh.
 */
const makeCompute = (): {
  compute: () => Promise<Result<CompanyHubStatsData, ApiError>>;
  calls: () => number;
  resolveWith: (r: Result<CompanyHubStatsData, ApiError>) => void;
  rejectWith: (e: Error) => void;
} => {
  let count = 0;
  let release: ((r: Result<CompanyHubStatsData, ApiError>) => void) | null = null;
  let fail: ((e: Error) => void) | null = null;
  return {
    calls: () => count,
    resolveWith: (r) => {
      const fn = release;
      release = null;
      fail = null;
      fn?.(r);
    },
    rejectWith: (e) => {
      const fn = fail;
      release = null;
      fail = null;
      fn?.(e);
    },
    compute: () => {
      count += 1;
      return new Promise((resolve, reject) => {
        release = resolve;
        fail = reject;
      });
    },
  };
};

/** Let queued microtasks (the background refresh chain) settle. */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

describe('makeHubStatsProvider (shell cache)', () => {
  it('anchors computedAt and the TTL to compute COMPLETION, not to its start', async () => {
    let clock = 1_000_000;
    const c = makeCompute();
    const provider = makeHubStatsProvider(c.compute, { ttlMs: 1000, now: () => clock });

    const first = provider.get();
    clock += 30_000; // the ~30s the real legs take
    c.resolveWith(ok(data(10)));
    const a = unwrap(await first);
    expect(a.totalCompanies).toBe(10);
    // Completion (1_030_000), NOT start — anchoring at the start would silently
    // shorten every TTL window by the compute duration.
    expect(a.computedAt).toBe(new Date(1_030_000).toISOString());
    expect(c.calls()).toBe(1);

    // The window runs from completion: 999ms later is still a pure cache hit.
    clock += 999;
    expect(unwrap(await provider.get()).totalCompanies).toBe(10);
    expect(c.calls()).toBe(1);
  });

  it('shares ONE in-flight compute between concurrent cold misses (singleflight)', async () => {
    const c = makeCompute();
    const provider = makeHubStatsProvider(c.compute, { ttlMs: 1000, now: () => 0 });

    const all = Promise.all([provider.get(), provider.get(), provider.get()]);
    expect(c.calls()).toBe(1); // three callers, one 30s scan
    c.resolveWith(ok(data(42)));

    const results = await all;
    expect(results.map((r) => unwrap(r).totalCompanies)).toEqual([42, 42, 42]);
    expect(c.calls()).toBe(1);
  });

  it('serves the stale value immediately and refreshes in the background', async () => {
    let clock = 0;
    const c = makeCompute();
    const provider = makeHubStatsProvider(c.compute, { ttlMs: 1000, now: () => clock });

    const first = provider.get();
    c.resolveWith(ok(data(1)));
    await first;

    clock = 2000; // past the TTL
    const stale = unwrap(await provider.get());
    expect(stale.totalCompanies).toBe(1); // served WITHOUT waiting for the refresh
    expect(c.calls()).toBe(2); // …but a refresh was kicked off

    c.resolveWith(ok(data(2)));
    await flush(); // let the background refresh settle

    expect(unwrap(await provider.get()).totalCompanies).toBe(2);
    expect(c.calls()).toBe(2);
  });

  it('singleflights the STALE path too: many stale reads share one background refresh', async () => {
    let clock = 0;
    const c = makeCompute();
    const provider = makeHubStatsProvider(c.compute, { ttlMs: 1000, now: () => clock });

    const first = provider.get();
    c.resolveWith(ok(data(1)));
    await first;

    clock = 5000; // stale
    const reads = await Promise.all([provider.get(), provider.get(), provider.get()]);
    // All three served the stale value instantly, and only ONE refresh was started.
    expect(reads.map((r) => unwrap(r).totalCompanies)).toEqual([1, 1, 1]);
    expect(c.calls()).toBe(2);

    c.resolveWith(ok(data(9)));
    await flush();
    expect(unwrap(await provider.get()).totalCompanies).toBe(9);
    expect(c.calls()).toBe(2);
  });

  it('never caches an err — the next caller retries', async () => {
    const c = makeCompute();
    const provider = makeHubStatsProvider(c.compute, { ttlMs: 1000, now: () => 0 });

    const first = provider.get();
    c.resolveWith(err(dbErr('boom')));
    const failed = await first;
    expect(failed.isErr()).toBe(true);
    expect(c.calls()).toBe(1);

    // A second call must recompute (an err left NO entry behind) and can succeed.
    const second = provider.get();
    expect(c.calls()).toBe(2);
    c.resolveWith(ok(data(7)));
    expect(unwrap(await second).totalCompanies).toBe(7);
  });

  it('keeps serving stale after a failed background refresh, and RETRIES on the next read', async () => {
    let clock = 0;
    const c = makeCompute();
    const provider = makeHubStatsProvider(c.compute, { ttlMs: 1000, now: () => clock });

    const first = provider.get();
    c.resolveWith(ok(data(5)));
    await first;

    clock = 5000;
    await provider.get(); // triggers background refresh #2
    expect(c.calls()).toBe(2);
    c.resolveWith(err(dbErr('refresh failed')));
    await flush();

    // The stale entry survives a failed refresh; the reader never sees the error.
    expect(unwrap(await provider.get()).totalCompanies).toBe(5);
    // …and `inFlight` was cleared, so that read started a THIRD compute (a stuck
    // inFlight would look identical from the value alone — this is the real check).
    expect(c.calls()).toBe(3);

    c.resolveWith(ok(data(6)));
    await flush();
    expect(unwrap(await provider.get()).totalCompanies).toBe(6);
  });

  it('swallows a REJECTED background refresh (an unhandled rejection would kill the process)', async () => {
    let clock = 0;
    const c = makeCompute();
    const provider = makeHubStatsProvider(c.compute, { ttlMs: 1000, now: () => clock });

    const first = provider.get();
    c.resolveWith(ok(data(3)));
    await first;

    clock = 5000;
    const stale = unwrap(await provider.get()); // kicks off the refresh
    expect(stale.totalCompanies).toBe(3);

    c.rejectWith(new Error('compute threw')); // a throw, not an err Result
    await flush();

    // No unhandled rejection, stale value intact, and the provider retries.
    expect(unwrap(await provider.get()).totalCompanies).toBe(3);
    expect(c.calls()).toBe(3);
    c.resolveWith(ok(data(4)));
    await flush();
    expect(unwrap(await provider.get()).totalCompanies).toBe(4);
  });
});
