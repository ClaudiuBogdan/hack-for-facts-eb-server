/**
 * The framework-role capability is a property of the ACTIVE build, probed
 * from the ClickHouse fact table once per build id (review M/M06) — never a
 * compile-time constant. Pins: the probe query, per-build caching, the
 * capability riding on `activeGeneration()`, and the contract-grain SQL
 * switching to purchases-only exactly when the column exists.
 */
import { ok } from 'neverthrow';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CAPABILITY_PROBE_TTL_MS,
  FRAMEWORK_ROLE_MIN_STAMPED_PERCENT,
  makeClickhouseAnalysisRepo,
} from '@/modules/procurement/shell/repo/clickhouse-analysis-repo.js';

import { compactResponse } from './clickhouse-response.js';

import type { PublishedGeneration } from '@/modules/procurement/core/ports.js';

const published = (buildId: string): PublishedGeneration => ({
  buildId,
  publishedAt: '2026-09-01T00:00:00Z',
  quality: {},
  matrixHash: null,
});

const statsRow = {
  rows: '1',
  with_value: '1',
  with_estimated: '0',
  awarded_bani_out: '100',
  estimated_bani_out: null,
  ceiling_bani_out: null,
  mod_adjusted_bani_out: null,
  awarded_matched_bani_out: null,
  min_month: '2025-01',
  max_month: '2025-12',
  undated_count: '0',
  undated_bani_out: null,
  withheld_bani_out: null,
};

/**
 * A fetch that answers the column probe per the flag, the coverage probe with
 * the given stamped/total counts, and every other query with one stats row.
 */
const fetchAnswering = (hasColumn: boolean, coverage = { stamped: '100', total: '100' }) =>
  vi.fn(async (_url: unknown, init?: { body?: string }) => {
    const body = init?.body ?? '';
    if (body.includes('system.columns')) {
      return compactResponse(hasColumn ? [{ name: 'framework_role' }] : [], ['name']);
    }
    if (body.includes('countIf(framework_role IS NOT NULL)')) {
      return compactResponse([coverage]);
    }
    return compactResponse([statsRow]);
  });

const isProbe = (body: string): boolean =>
  body.includes('system.columns') || body.includes('countIf(framework_role');

const bodiesOf = (fetchSpy: ReturnType<typeof fetchAnswering>): string[] =>
  fetchSpy.mock.calls.map((c) => (c[1] as { body?: string } | undefined)?.body ?? '');

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('generation capabilities from the live ClickHouse build', () => {
  it('probes system.columns for the contract table once per build and reports the result', async () => {
    const fetchSpy = fetchAnswering(false);
    vi.stubGlobal('fetch', fetchSpy);
    const repo = makeClickhouseAnalysisRepo({ url: 'http://ch.test', database: 'proto' }, () =>
      Promise.resolve(ok(published('8')))
    );

    const first = await repo.activeGeneration();
    const second = await repo.activeGeneration();
    expect(first._unsafeUnwrap()).toMatchObject({
      buildId: '8',
      capabilities: { frameworkRole: false },
    });
    expect(second._unsafeUnwrap()?.capabilities).toEqual({ frameworkRole: false });

    const probes = bodiesOf(fetchSpy).filter((b) => b.includes('system.columns'));
    expect(probes).toHaveLength(1);
    expect(probes[0]).toContain("table = 'facts_contracts_v2'");
    expect(probes[0]).toContain("name = 'framework_role'");
    expect(probes[0]).toContain('currentDatabase()');
  });

  it('re-probes when a different build becomes active', async () => {
    const fetchSpy = fetchAnswering(true);
    vi.stubGlobal('fetch', fetchSpy);
    let active = published('8');
    const repo = makeClickhouseAnalysisRepo({ url: 'http://ch.test', database: 'proto' }, () =>
      Promise.resolve(ok(active))
    );
    await repo.activeGeneration();
    active = published('9');
    const gen = await repo.activeGeneration();
    expect(gen._unsafeUnwrap()?.capabilities).toEqual({ frameworkRole: true });
    expect(bodiesOf(fetchSpy).filter((b) => b.includes('system.columns'))).toHaveLength(2);
  });

  it('keeps the legacy contract population when the column is absent', async () => {
    const fetchSpy = fetchAnswering(false);
    vi.stubGlobal('fetch', fetchSpy);
    const repo = makeClickhouseAnalysisRepo({ url: 'http://ch.test', database: 'proto' }, () =>
      Promise.resolve(ok(published('8')))
    );
    const r = await repo.statsFor(
      { grain: 'contract' },
      {},
      (await repo.activeGeneration())._unsafeUnwrap()!
    );
    expect(r.isOk()).toBe(true);
    const stats = bodiesOf(fetchSpy).filter((b) => b.startsWith('SELECT') && !isProbe(b));
    expect(stats).toHaveLength(1);
    expect(stats[0]).not.toContain('framework_role');
  });

  it('switches the contract grain to purchases-only once the column exists', async () => {
    const fetchSpy = fetchAnswering(true);
    vi.stubGlobal('fetch', fetchSpy);
    const repo = makeClickhouseAnalysisRepo({ url: 'http://ch.test', database: 'proto' }, () =>
      Promise.resolve(ok(published('9')))
    );
    const r = await repo.statsFor(
      { grain: 'contract' },
      {},
      (await repo.activeGeneration())._unsafeUnwrap()!
    );
    expect(r.isOk()).toBe(true);
    const stats = bodiesOf(fetchSpy).filter((b) => b.startsWith('SELECT') && !isProbe(b));
    expect(stats[0]).toContain("(framework_role IS NULL OR framework_role = 'standalone')");
  });

  it('re-asks the table after the probe window, so a late ClickHouse swap is picked up', async () => {
    // The Postgres pointer can land before the ClickHouse table swap; the
    // first probe under the new build id then sees the OLD table. A permanent
    // cache would pin legacy mode for the life of the process.
    vi.useFakeTimers();
    try {
      let hasColumn = false;
      const fetchSpy = vi.fn(async (_url: unknown, init?: { body?: string }) => {
        const body = init?.body ?? '';
        if (body.includes('system.columns')) {
          return compactResponse(hasColumn ? [{ name: 'framework_role' }] : [], ['name']);
        }
        if (body.includes('countIf(framework_role')) {
          return compactResponse([{ stamped: '100', total: '100' }]);
        }
        return compactResponse([statsRow]);
      });
      vi.stubGlobal('fetch', fetchSpy);
      const repo = makeClickhouseAnalysisRepo({ url: 'http://ch.test', database: 'proto' }, () =>
        Promise.resolve(ok(published('9')))
      );
      expect((await repo.activeGeneration())._unsafeUnwrap()?.capabilities.frameworkRole).toBe(
        false
      );
      hasColumn = true;
      // Inside the window: the cached answer stands.
      vi.advanceTimersByTime(CAPABILITY_PROBE_TTL_MS - 1);
      expect((await repo.activeGeneration())._unsafeUnwrap()?.capabilities.frameworkRole).toBe(
        false
      );
      // Past it: the table is asked again and the column is seen.
      vi.advanceTimersByTime(2);
      expect((await repo.activeGeneration())._unsafeUnwrap()?.capabilities.frameworkRole).toBe(
        true
      );
      expect(bodiesOf(fetchSpy).filter((b) => b.includes('system.columns'))).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not turn on for a column that exists but is not loaded yet (all NULL)', async () => {
    // The scrapper DDL adds the nullable column before the data load: a
    // column with no stamped rows is a build in the middle of an upgrade.
    const fetchSpy = fetchAnswering(true, { stamped: '0', total: '3300000' });
    vi.stubGlobal('fetch', fetchSpy);
    const repo = makeClickhouseAnalysisRepo({ url: 'http://ch.test', database: 'proto' }, () =>
      Promise.resolve(ok(published('9')))
    );
    expect((await repo.activeGeneration())._unsafeUnwrap()?.capabilities).toEqual({
      frameworkRole: false,
    });
  });

  it('does not turn on below the stamped-share bar, and does at it', async () => {
    const below = fetchAnswering(true, { stamped: '94', total: '100' });
    vi.stubGlobal('fetch', below);
    const repoBelow = makeClickhouseAnalysisRepo({ url: 'http://ch.test', database: 'proto' }, () =>
      Promise.resolve(ok(published('9')))
    );
    expect((await repoBelow.activeGeneration())._unsafeUnwrap()?.capabilities.frameworkRole).toBe(
      false
    );
    const at = fetchAnswering(true, { stamped: '95', total: '100' });
    vi.stubGlobal('fetch', at);
    const repoAt = makeClickhouseAnalysisRepo({ url: 'http://ch.test', database: 'proto' }, () =>
      Promise.resolve(ok(published('9')))
    );
    expect((await repoAt.activeGeneration())._unsafeUnwrap()?.capabilities.frameworkRole).toBe(
      true
    );
    expect(FRAMEWORK_ROLE_MIN_STAMPED_PERCENT).toBe(95n);
  });

  it('never caches a failed probe', async () => {
    const fetchSpy = vi.fn(async (_url: unknown, init?: { body?: string }) => {
      const body = init?.body ?? '';
      if (body.includes('system.columns') && fetchSpy.mock.calls.length === 1) {
        return new Response('boom', { status: 500 });
      }
      if (body.includes('system.columns')) return compactResponse([{ name: 'framework_role' }]);
      if (body.includes('countIf(framework_role')) {
        return compactResponse([{ stamped: '100', total: '100' }]);
      }
      return compactResponse([statsRow]);
    });
    vi.stubGlobal('fetch', fetchSpy);
    const repo = makeClickhouseAnalysisRepo({ url: 'http://ch.test', database: 'proto' }, () =>
      Promise.resolve(ok(published('9')))
    );
    expect((await repo.activeGeneration()).isErr()).toBe(true);
    expect((await repo.activeGeneration())._unsafeUnwrap()?.capabilities).toEqual({
      frameworkRole: true,
    });
  });
});
