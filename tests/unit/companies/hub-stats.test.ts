/**
 * Companies unit tests — the `companyHubStats` usecase (leg composition under ONE
 * pinned registry scope, the separately counted active population, fail-fast,
 * the post-leg recheck) and its shell cache provider (fresh scope capture on
 * every read, per-scope singleflight, TTL, stale-while-revalidate within one
 * scope, never serving across a scope change or a withdrawal, never caching
 * an `err`).
 *
 * Hand-rolled fakes only (no mocking library): a repo stub and an injected
 * clock, so the TTL is driven deterministically instead of by sleeping.
 */

import { err, ok, type Result } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import {
  makeCompanyHubStats,
  type CompanyHubStatsData,
} from '@/modules/companies/core/usecases.js';
import { makeHubStatsProvider } from '@/modules/companies/shell/hub-stats-cache.js';

import {
  MOVED_SCOPE,
  NEXT_EDITION_SCOPE,
  PUBLISHED_SCOPE,
  UNPUBLISHED_SCOPE,
  WITHDRAWN_SCOPE,
  recheckOf,
} from './registry-fixtures.js';

import type { CompaniesRepository, CompanyCountByResult } from '@/modules/companies/core/ports.js';
import type { CompanyRegistryEnvelope } from '@/modules/companies/core/registry.js';
import type { CompanyCoverage, CompanyGroupBy } from '@/modules/companies/core/types.js';
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

type CountByResult = Result<CompanyCountByResult, ApiError>;

/** Records every leg (kind, groupBy, filter, scope) so the test can assert ORDER + args. */
interface LegCall {
  readonly leg: CompanyGroupBy | 'countCompanies';
  readonly filter: FilterInput;
  readonly scope: CompanyRegistryEnvelope;
}

const dbErr = (message: string): ApiError => ({ type: 'Database', message });

const makeRepoFake = (
  results: Readonly<Record<CompanyGroupBy, CountByResult>>,
  options: {
    active?: Result<number, ApiError>;
    recheck?: CompanyRegistryEnvelope;
  } = {}
): { repo: CompaniesRepository; calls: LegCall[] } => {
  const calls: LegCall[] = [];
  const repo = {
    captureRegistryScope: () => Promise.resolve(ok(PUBLISHED_SCOPE)),
    confirmRegistryScope: () => Promise.resolve(ok(recheckOf(options.recheck ?? PUBLISHED_SCOPE))),
    countBy: (groupBy: CompanyGroupBy, filter: FilterInput, scope: CompanyRegistryEnvelope) => {
      calls.push({ leg: groupBy, filter, scope });
      return Promise.resolve(results[groupBy]);
    },
    countCompanies: (filter: FilterInput, scope: CompanyRegistryEnvelope) => {
      calls.push({ leg: 'countCompanies', filter, scope });
      return Promise.resolve(options.active ?? ok(1_731_000));
    },
  } as unknown as CompaniesRepository;
  return { calls, repo };
};

const okLegs = (): Readonly<Record<CompanyGroupBy, CountByResult>> => ({
  status: ok({
    groups: [
      { key: '1084', label: 'radiată', count: 2_017_899, basis: null },
      { key: '1048', label: 'funcțiune', count: 1_724_391, basis: null },
      // A conflicting company is a basis bucket, not a 1048 consensus.
      { key: '(multiple_values)', label: null, count: 6_609, basis: 'multiple_values' },
      { key: '(not_in_edition)', label: null, count: 236_268, basis: 'not_in_edition' },
    ],
    denominator: 3_985_167,
    coverage: { territoryMatched: 0, territoryUnmatched: 0, note: 'status-leg coverage' },
  }),
  county: ok({
    groups: [
      { key: '(missing)', label: null, count: 677_879, basis: 'missing' },
      { key: '(multiple_values)', label: null, count: 1_000, basis: 'multiple_values' },
      ...Array.from({ length: 12 }, (_, i) => ({
        key: `C${String(i)}`,
        label: `County${String(i)}`,
        count: 1000 - i,
        basis: null,
      })),
    ],
    denominator: 1_731_000,
    coverage,
  }),
  caenDivision: ok({
    groups: [
      { key: 'rev2:47', label: null, count: 300_000, basis: null },
      { key: 'rev3:47', label: null, count: 200_000, basis: null },
      { key: 'unknown:62', label: null, count: 10, basis: 'unknown_revision' },
    ],
    denominator: 1_731_000,
    coverage: { territoryMatched: null, territoryUnmatched: null, note: 'n/a' },
  }),
});

describe('makeCompanyHubStats (usecase)', () => {
  it('runs every leg sequentially under the ONE given scope, active-filtered where it matters', async () => {
    const { repo, calls } = makeRepoFake(okLegs());
    const stats = unwrap(await makeCompanyHubStats({ repo }, PUBLISHED_SCOPE));

    // Leg ORDER is part of the contract: concurrent heavy scans saturate the pool (M7).
    expect(calls.map((c) => c.leg)).toEqual(['status', 'countCompanies', 'county', 'caenDivision']);
    expect(calls.every((c) => c.scope === PUBLISHED_SCOPE)).toBe(true);
    expect(calls[0]?.filter).toEqual({});
    for (const c of calls.slice(1)) expect(c.filter).toEqual({ status: { eq: '1048' } });

    expect(stats.totalCompanies).toBe(3_985_167);
    expect(stats.coverage).toEqual(coverage); // the COUNTY leg's coverage.
    expect(stats.registry).toBe(PUBLISHED_SCOPE);
  });

  it('counts the active population on its own, never from the consensus 1048 bucket', async () => {
    const { repo } = makeRepoFake(okLegs(), { active: ok(1_731_000) });
    const stats = unwrap(await makeCompanyHubStats({ repo }, PUBLISHED_SCOPE));
    // 1,724,391 consensus 1048 + conflicting companies with an original 1048.
    expect(stats.activeCompanies).toBe(1_731_000);
    expect(stats.statusMix.find((g) => g.key === '1048')?.count).toBe(1_724_391);
    expect(stats.statusMix.find((g) => g.key === '(multiple_values)')?.basis).toBe(
      'multiple_values'
    );
  });

  it('keeps revision-qualified CAEN buckets (overlapping) and the unknown-revision bucket explicit', async () => {
    const { repo } = makeRepoFake(okLegs());
    const stats = unwrap(await makeCompanyHubStats({ repo }, PUBLISHED_SCOPE));
    expect(stats.caenDivisions.map((d) => d.key)).toEqual(['rev2:47', 'rev3:47', 'unknown:62']);
  });

  it('drops basis buckets from topCounties (they are not counties) and caps it at 10', async () => {
    const { repo } = makeRepoFake(okLegs());
    const stats = unwrap(await makeCompanyHubStats({ repo }, PUBLISHED_SCOPE));
    expect(stats.topCounties).toHaveLength(10);
    expect(stats.topCounties.every((c) => c.basis === null)).toBe(true);
    expect(stats.topCounties[0]?.key).toBe('C0');
  });

  it.each([UNPUBLISHED_SCOPE, WITHDRAWN_SCOPE])(
    'a non-published registry ($state) is ServiceUnavailable, never zeros, and runs no leg',
    async (scope) => {
      const { repo, calls } = makeRepoFake(okLegs());
      const res = await makeCompanyHubStats({ repo }, scope);
      expect(res.isErr() && res.error.type).toBe('ServiceUnavailable');
      expect(calls).toEqual([]);
    }
  );

  it('a scope that moved during the legs is an error (never a mixed or stale hub)', async () => {
    const { repo } = makeRepoFake(okLegs(), { recheck: MOVED_SCOPE });
    const res = await makeCompanyHubStats({ repo }, PUBLISHED_SCOPE);
    expect(res.isErr() && res.error.type).toBe('ServiceUnavailable');
  });

  it('fails fast on the first failing leg and does not run the rest', async () => {
    const legs = { ...okLegs(), county: err(dbErr('county boom')) as CountByResult };
    const { repo, calls } = makeRepoFake(legs);
    const res = await makeCompanyHubStats({ repo }, PUBLISHED_SCOPE);
    expect(res.isErr()).toBe(true);
    if (res.isErr()) expect(res.error.message).toBe('county boom');
    expect(calls.map((c) => c.leg)).toEqual(['status', 'countCompanies', 'county']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

const data = (total: number, registry = PUBLISHED_SCOPE): CompanyHubStatsData => ({
  totalCompanies: total,
  activeCompanies: 1,
  statusMix: [],
  topCounties: [],
  caenDivisions: [],
  coverage,
  registry,
});

/**
 * A controllable compute: counts invocations (and the scope of each) and
 * settles only when the test says so. `rejectWith` models a compute that
 * THROWS (not an `err` Result) — the path whose rejection the provider must
 * swallow on a background refresh.
 */
const makeCompute = () => {
  const scopes: CompanyRegistryEnvelope[] = [];
  let release: ((r: Result<CompanyHubStatsData, ApiError>) => void) | null = null;
  let fail: ((e: Error) => void) | null = null;
  return {
    calls: () => scopes.length,
    scopes,
    resolveWith: (r: Result<CompanyHubStatsData, ApiError>) => {
      const fn = release;
      release = null;
      fail = null;
      fn?.(r);
    },
    rejectWith: (e: Error) => {
      const fn = fail;
      release = null;
      fail = null;
      fn?.(e);
    },
    compute: (scope: CompanyRegistryEnvelope): Promise<Result<CompanyHubStatsData, ApiError>> => {
      scopes.push(scope);
      return new Promise((resolve, reject) => {
        release = resolve;
        fail = reject;
      });
    },
  };
};

/** A capture whose answer the test can change between reads. */
const makeCapture = (initial: CompanyRegistryEnvelope = PUBLISHED_SCOPE) => {
  let current: Result<CompanyRegistryEnvelope, ApiError> = ok(initial);
  let reads = 0;
  return {
    set: (next: Result<CompanyRegistryEnvelope, ApiError>) => {
      current = next;
    },
    reads: () => reads,
    captureScope: () => {
      reads += 1;
      return Promise.resolve(current);
    },
  };
};

/** Let queued microtasks (the capture and the background refresh chain) settle. */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

describe('makeHubStatsProvider (shell cache)', () => {
  it('captures the scope fresh on EVERY read, cache hits included', async () => {
    const cap = makeCapture();
    const c = makeCompute();
    const provider = makeHubStatsProvider(
      { captureScope: cap.captureScope, compute: c.compute },
      { ttlMs: 1000, now: () => 0 }
    );
    const first = provider.get();
    await flush();
    c.resolveWith(ok(data(10)));
    await first;
    await provider.get();
    await provider.get();
    expect(cap.reads()).toBe(3);
    expect(c.calls()).toBe(1);
  });

  it('anchors computedAt and the TTL to compute COMPLETION, not to its start', async () => {
    let clock = 1_000_000;
    const cap = makeCapture();
    const c = makeCompute();
    const provider = makeHubStatsProvider(
      { captureScope: cap.captureScope, compute: c.compute },
      { ttlMs: 1000, now: () => clock }
    );

    const first = provider.get();
    await flush();
    clock += 30_000; // the long legs
    c.resolveWith(ok(data(10)));
    const a = unwrap(await first);
    expect(a.totalCompanies).toBe(10);
    expect(a.computedAt).toBe(new Date(1_030_000).toISOString());
    expect(c.calls()).toBe(1);

    clock += 999;
    expect(unwrap(await provider.get()).totalCompanies).toBe(10);
    expect(c.calls()).toBe(1);
  });

  it('shares ONE in-flight compute between concurrent cold misses of one scope (singleflight)', async () => {
    const cap = makeCapture();
    const c = makeCompute();
    const provider = makeHubStatsProvider(
      { captureScope: cap.captureScope, compute: c.compute },
      { ttlMs: 1000, now: () => 0 }
    );

    const all = Promise.all([provider.get(), provider.get(), provider.get()]);
    await flush();
    expect(c.calls()).toBe(1);
    c.resolveWith(ok(data(42)));
    const results = await all;
    expect(results.map((r) => unwrap(r).totalCompanies)).toEqual([42, 42, 42]);
    expect(c.calls()).toBe(1);
  });

  it('serves the stale value of the SAME scope immediately and refreshes in the background', async () => {
    let clock = 0;
    const cap = makeCapture();
    const c = makeCompute();
    const provider = makeHubStatsProvider(
      { captureScope: cap.captureScope, compute: c.compute },
      { ttlMs: 1000, now: () => clock }
    );

    const first = provider.get();
    await flush();
    c.resolveWith(ok(data(1)));
    await first;

    clock = 2000; // past the TTL
    const stale = unwrap(await provider.get());
    expect(stale.totalCompanies).toBe(1);
    expect(c.calls()).toBe(2);

    c.resolveWith(ok(data(2)));
    await flush();
    expect(unwrap(await provider.get()).totalCompanies).toBe(2);
    expect(c.calls()).toBe(2);
  });

  it('NEVER serves an entry of another scope: a new edition (or epoch) recomputes and waits', async () => {
    const cap = makeCapture();
    const c = makeCompute();
    const provider = makeHubStatsProvider(
      { captureScope: cap.captureScope, compute: c.compute },
      { ttlMs: 60_000, now: () => 0 }
    );
    const first = provider.get();
    await flush();
    c.resolveWith(ok(data(1)));
    await first;

    for (const next of [NEXT_EDITION_SCOPE, MOVED_SCOPE]) {
      cap.set(ok(next));
      const read = provider.get();
      await flush();
      // Fresh (well inside the TTL) — yet the old figures are not served.
      expect(c.scopes.at(-1)).toBe(next);
      c.resolveWith(ok(data(next === MOVED_SCOPE ? 3 : 2, next)));
      const value = unwrap(await read);
      expect(value.registry).toBe(next);
    }
  });

  it.each([WITHDRAWN_SCOPE, UNPUBLISHED_SCOPE])(
    'after a cached read, a $state registry is an error — the previous edition is never served',
    async (scope) => {
      const cap = makeCapture();
      const c = makeCompute();
      const provider = makeHubStatsProvider(
        { captureScope: cap.captureScope, compute: c.compute },
        { ttlMs: 60_000, now: () => 0 }
      );
      const first = provider.get();
      await flush();
      c.resolveWith(ok(data(5)));
      await first;

      cap.set(ok(scope));
      const res = await provider.get();
      expect(res.isErr() && res.error.type).toBe('ServiceUnavailable');
      expect(c.calls()).toBe(1);
    }
  );

  it('a failing capture is an error, never a cached value', async () => {
    const cap = makeCapture();
    const c = makeCompute();
    const provider = makeHubStatsProvider(
      { captureScope: cap.captureScope, compute: c.compute },
      { ttlMs: 60_000, now: () => 0 }
    );
    const first = provider.get();
    await flush();
    c.resolveWith(ok(data(5)));
    await first;
    cap.set(err(dbErr('capture failed')));
    expect((await provider.get()).isErr()).toBe(true);
  });

  it('never caches an err — the next caller retries', async () => {
    const cap = makeCapture();
    const c = makeCompute();
    const provider = makeHubStatsProvider(
      { captureScope: cap.captureScope, compute: c.compute },
      { ttlMs: 1000, now: () => 0 }
    );

    const first = provider.get();
    await flush();
    c.resolveWith(err(dbErr('boom')));
    expect((await first).isErr()).toBe(true);
    expect(c.calls()).toBe(1);

    const second = provider.get();
    await flush();
    expect(c.calls()).toBe(2);
    c.resolveWith(ok(data(7)));
    expect(unwrap(await second).totalCompanies).toBe(7);
  });

  it('keeps serving stale (same scope) after a failed background refresh, and RETRIES on the next read', async () => {
    let clock = 0;
    const cap = makeCapture();
    const c = makeCompute();
    const provider = makeHubStatsProvider(
      { captureScope: cap.captureScope, compute: c.compute },
      { ttlMs: 1000, now: () => clock }
    );

    const first = provider.get();
    await flush();
    c.resolveWith(ok(data(5)));
    await first;

    clock = 5000;
    await provider.get(); // triggers background refresh #2
    expect(c.calls()).toBe(2);
    c.resolveWith(err(dbErr('refresh failed')));
    await flush();

    expect(unwrap(await provider.get()).totalCompanies).toBe(5);
    expect(c.calls()).toBe(3);

    c.resolveWith(ok(data(6)));
    await flush();
    expect(unwrap(await provider.get()).totalCompanies).toBe(6);
  });

  it('swallows a REJECTED background refresh (an unhandled rejection would kill the process)', async () => {
    let clock = 0;
    const cap = makeCapture();
    const c = makeCompute();
    const provider = makeHubStatsProvider(
      { captureScope: cap.captureScope, compute: c.compute },
      { ttlMs: 1000, now: () => clock }
    );

    const first = provider.get();
    await flush();
    c.resolveWith(ok(data(3)));
    await first;

    clock = 5000;
    expect(unwrap(await provider.get()).totalCompanies).toBe(3);
    c.rejectWith(new Error('compute threw'));
    await flush();

    expect(unwrap(await provider.get()).totalCompanies).toBe(3);
    expect(c.calls()).toBe(3);
    c.resolveWith(ok(data(4)));
    await flush();
    expect(unwrap(await provider.get()).totalCompanies).toBe(4);
  });
});
