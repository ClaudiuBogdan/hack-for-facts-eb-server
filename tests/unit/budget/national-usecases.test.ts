import { ok } from 'neverthrow';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  budgetApprovedRecords,
  budgetApprovedTotals,
  budgetNationalExecutionSeries,
  type NationalUsecaseDeps,
} from '@/modules/budget/core/national/usecases.js';
import { makeNationalApprovedReader } from '@/modules/budget/shell/repo/national-approved-repo.js';
import { makeNationalExecutionReader } from '@/modules/budget/shell/repo/national-execution-repo.js';
import {
  makeNationalReadPort,
  makeNationalResponseCache,
  type NationalResponseCacheOptions,
} from '@/modules/budget/shell/repo/national-read-port.js';

import { makeCapturingDb, type CapturedQuery } from '../../fixtures/capturing-db.js';
import {
  makeSourceWorld,
  type SourceWorldOptions,
} from '../../fixtures/national-budget/source-world.js';

import type { NationalReadPort } from '@/modules/budget/core/national/ports.js';

const E2025 = '2025:law_2025_as_sent_to_monitorul_oficial';

const NEW_LOAD = {
  extraFormRows: [
    {
      budget_year: 2025,
      publication: 'law_2025_as_sent_to_monitorul_oficial',
      fund: 'health_insurance',
      form: 'health_insurance_synthesis',
      interpretation_id: 'budget-law-approved:fixture-new-load',
      line_count: 1,
      record_count: 1,
      credit_types: [],
      sources: [],
      authorities: [],
    },
  ],
} satisfies SourceWorldOptions;

const harness = (cached: boolean | NationalResponseCacheOptions = true) => {
  let world = makeSourceWorld();
  let transactions = 0;
  const captured: CapturedQuery[] = [];
  const sets: string[] = [];
  const cache = makeNationalResponseCache(typeof cached === 'object' ? cached : {});
  const db = makeCapturingDb(captured, {
    respond: (sql, parameters) => world.respond(sql, parameters),
    onBeginTransaction: () => {
      transactions += 1;
    },
  });
  const deps: NationalUsecaseDeps = {
    port: makeNationalReadPort(db, (trx) => ({
      approved: makeNationalApprovedReader(trx),
      execution: makeNationalExecutionReader(trx),
    })),
    ...(cached === false
      ? {}
      : {
          cache: {
            ...cache,
            set: (key, value, stamp) => {
              sets.push(key);
              cache.set(key, value, stamp);
            },
          },
        }),
  };
  return {
    deps,
    transactions: () => transactions,
    /** Keys offered to the response cache (admitted or not). */
    sets,
    /** Batched national-series view statements run so far. */
    seriesViewReads: () =>
      captured.filter((query) => query.sql.includes('execution_national_budget_series_v1')).length,
    move: (options: SourceWorldOptions) => {
      world = makeSourceWorld(options);
    },
  };
};

const totalsInput = {
  totals: ['EXPENDITURE_5001_STATE_BUDGET'],
  creditTypes: ['BUDGET_CREDITS'],
  editionIds: [E2025],
  measureYears: [2025],
};

afterEach(() => {
  vi.useRealTimers();
});

describe('national usecases: one transaction per root and bounded-stale cache', () => {
  it('answers a repeated plain request from the cache keyed by its snapshot', async () => {
    const h = harness();
    const first = (await budgetApprovedTotals(h.deps, { input: totalsInput }))._unsafeUnwrap();
    expect(h.transactions()).toBe(1);
    const second = (await budgetApprovedTotals(h.deps, { input: totalsInput }))._unsafeUnwrap();
    expect(h.transactions()).toBe(1);
    expect(second).toEqual(first);
    // The same arguments in another list order are the same canonical key.
    await budgetApprovedTotals(h.deps, {
      input: { ...totalsInput, totals: ['EXPENDITURE_5001_STATE_BUDGET'], measureYears: [2025] },
    });
    expect(h.transactions()).toBe(1);
  });

  it('bypasses the probe for explicit snapshot preconditions and cursor continuations', async () => {
    const h = harness();
    const first = (await budgetApprovedTotals(h.deps, { input: totalsInput }))._unsafeUnwrap();
    await budgetApprovedTotals(h.deps, { input: totalsInput, expectedSnapshot: first.snapshot });
    expect(h.transactions()).toBe(2);
    const input = {
      source: { edition: { editionId: E2025, form: 'STATE_BUDGET_AUTHORITY_DETAIL' } },
    };
    const page = (await budgetApprovedRecords(h.deps, { input, first: 2 }))._unsafeUnwrap();
    expect(h.transactions()).toBe(3);
    await budgetApprovedRecords(h.deps, { input, first: 2 });
    expect(h.transactions()).toBe(3);
    await budgetApprovedRecords(h.deps, { input, first: 2, after: page.pageInfo.endCursor });
    expect(h.transactions()).toBe(4);
  });

  it('never replays a continuation page as the first page', async () => {
    const h = harness();
    const input = {
      source: { edition: { editionId: E2025, form: 'STATE_BUDGET_AUTHORITY_DETAIL' } },
    };
    const first = (await budgetApprovedRecords(h.deps, { input, first: 2 }))._unsafeUnwrap();
    const second = (
      await budgetApprovedRecords(h.deps, { input, first: 2, after: first.pageInfo.endCursor })
    )._unsafeUnwrap();
    expect(second.edges.map((edge) => edge.node.recordIndex)).toEqual([12, 13]);
    const again = (await budgetApprovedRecords(h.deps, { input, first: 2 }))._unsafeUnwrap();
    expect(again.edges.map((edge) => edge.node.recordIndex)).toEqual([10, 11]);
  });

  it('is stale for at most the 30 s probe window, never past an explicit precondition', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-03T10:00:00Z') });
    const h = harness();
    const before = (await budgetApprovedTotals(h.deps, { input: totalsInput }))._unsafeUnwrap();
    h.move(NEW_LOAD);
    // Within the probe window the last observed snapshot may still answer.
    const stale = (await budgetApprovedTotals(h.deps, { input: totalsInput }))._unsafeUnwrap();
    expect(stale.snapshot).toBe(before.snapshot);
    // An explicit precondition always reads the current lane.
    const precondition = await budgetApprovedTotals(h.deps, {
      input: totalsInput,
      expectedSnapshot: before.snapshot,
    });
    expect(precondition._unsafeUnwrapErr()).toMatchObject({
      type: 'InvalidInput',
      field: 'expectedSnapshot',
      reason: 'SNAPSHOT_CHANGED',
    });
    vi.advanceTimersByTime(31_000);
    const fresh = (await budgetApprovedTotals(h.deps, { input: totalsInput }))._unsafeUnwrap();
    expect(fresh.snapshot).not.toBe(before.snapshot);
  });

  it('keys the national series by the requested item order and keeps that order', async () => {
    const h = harness();
    const input = (itemIds: string[]) => ({
      input: {
        itemIds,
        basis: 'PERIOD_DIFFERENCE',
        period: { type: 'QUARTER', selection: { dates: ['2025-Q2'] } },
      },
    });
    const forward = (
      await budgetNationalExecutionSeries(
        h.deps,
        input(['mfin.bgc.revenue.total', 'mfin.bgc.expenditure.total'])
      )
    )._unsafeUnwrap();
    const reverse = (
      await budgetNationalExecutionSeries(
        h.deps,
        input(['mfin.bgc.expenditure.total', 'mfin.bgc.revenue.total'])
      )
    )._unsafeUnwrap();
    expect(h.transactions()).toBe(2);
    expect(forward.results.map((r) => r.item.itemId)).toEqual([
      'mfin.bgc.revenue.total',
      'mfin.bgc.expenditure.total',
    ]);
    expect(reverse.results.map((r) => r.item.itemId)).toEqual([
      'mfin.bgc.expenditure.total',
      'mfin.bgc.revenue.total',
    ]);
  });

  it('never caches failures and validates arguments before opening a transaction', async () => {
    const h = harness();
    const invalid = await budgetApprovedTotals(h.deps, { input: { totals: [] } });
    expect(invalid._unsafeUnwrapErr()).toMatchObject({
      type: 'InvalidInput',
      field: 'input.totals',
    });
    const badFirst = await budgetApprovedRecords(h.deps, {
      input: { source: { interpretationId: 'x' } },
      first: 101,
    });
    expect(badFirst._unsafeUnwrapErr()).toMatchObject({ field: 'first' });
    expect(h.transactions()).toBe(0);
    const missing = await budgetNationalExecutionSeries(h.deps, {
      input: {
        itemIds: ['mfin.bgc.revenue.total'],
        basis: 'YTD',
        period: { type: 'MONTH', selection: { dates: ['2025-07'] } },
      },
    });
    expect(missing._unsafeUnwrapErr().type).toBe('ServiceUnavailable');
    await budgetNationalExecutionSeries(h.deps, {
      input: {
        itemIds: ['mfin.bgc.revenue.total'],
        basis: 'YTD',
        period: { type: 'MONTH', selection: { dates: ['2025-07'] } },
      },
    });
    expect(h.transactions()).toBe(2);
  });

  it('works without a cache (every request reads)', async () => {
    const h = harness(false);
    await budgetApprovedTotals(h.deps, { input: totalsInput });
    await budgetApprovedTotals(h.deps, { input: totalsInput });
    expect(h.transactions()).toBe(2);
  });
});

describe('bounded response admission', () => {
  const seriesInput = {
    input: {
      itemIds: ['mfin.bgc.revenue.total'],
      basis: 'PERIOD_DIFFERENCE',
      period: { type: 'MONTH', selection: { dates: ['2025-05', '2025-06', '2025-12'] } },
    },
  };

  it('reads an over-limit response every time and returns it whole, from one batched view query', async () => {
    const reference = (
      await budgetNationalExecutionSeries(harness(false).deps, seriesInput)
    )._unsafeUnwrap();
    const size = Buffer.byteLength(JSON.stringify(reference), 'utf8');
    // A downward override makes the real full DTO "too large" for this cache.
    const h = harness({ maxResponseBytes: size - 1 });
    const first = (await budgetNationalExecutionSeries(h.deps, seriesInput))._unsafeUnwrap();
    expect([h.transactions(), h.seriesViewReads()]).toEqual([1, 1]);
    const second = (await budgetNationalExecutionSeries(h.deps, seriesInput))._unsafeUnwrap();
    expect([h.transactions(), h.seriesViewReads()]).toEqual([2, 2]);
    expect(first).toEqual(reference);
    expect(second).toEqual(reference);
    const result = second.results[0];
    expect(result?.series.data).toEqual([{ date: '2025-12', value: '70789094792.50003' }]);
    // Dense period metadata: every requested month, the gaps explained.
    expect(result?.periods.map((period) => [period.date, period.status === 'AVAILABLE'])).toEqual([
      ['2025-05', false],
      ['2025-06', false],
      ['2025-12', true],
    ]);
    // At the limit it is admitted and the repeat is a hit.
    const fits = harness({ maxResponseBytes: size });
    await budgetNationalExecutionSeries(fits.deps, seriesInput);
    await budgetNationalExecutionSeries(fits.deps, seriesInput);
    expect(fits.transactions()).toBe(1);
  });

  it('re-reads a measured-size (2,183,313-byte) payload and returns it unchanged', async () => {
    const h = harness();
    const reference = (
      await budgetNationalExecutionSeries(harness(false).deps, seriesInput)
    )._unsafeUnwrap();
    // The reference DTO with its dense grid widened to the measured full-grid size.
    const target = 2_183_313;
    const grid = structuredClone(reference) as unknown as {
      results: { item: { sourceLabel: string }; series: { data: unknown[] } }[];
    };
    const widened = grid.results[0];
    if (widened === undefined) throw new Error('fixture series has no result');
    const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8');
    let size = bytes(grid);
    for (let index = 0; ; index++) {
      const point = {
        date: `${String(1990 + (index % 30))}-01`,
        value: index % 7 === 0 ? null : '1234567.89',
      };
      const added = bytes(point) + 1; // the separating comma
      if (size + added > target - 64) break;
      widened.series.data.push(point);
      size += added;
    }
    widened.item.sourceLabel += 'x'.repeat(target - size);
    expect(bytes(grid)).toBe(target);
    const snapshotBefore = structuredClone(grid);
    let reads = 0;
    const deps: NationalUsecaseDeps = {
      ...h.deps,
      port: {
        read: <T>() => {
          reads += 1;
          return Promise.resolve(ok(grid as unknown as T));
        },
      },
    };
    const first = (await budgetNationalExecutionSeries(deps, seriesInput))._unsafeUnwrap();
    const second = (await budgetNationalExecutionSeries(deps, seriesInput))._unsafeUnwrap();
    expect(reads).toBe(2);
    expect(h.sets).toHaveLength(2); // offered twice, admitted never
    expect(first).toBe(grid);
    expect(second).toEqual(snapshotBefore);
  });

  it('hits a small repeated plain request', async () => {
    const h = harness();
    await budgetNationalExecutionSeries(h.deps, seriesInput);
    await budgetNationalExecutionSeries(h.deps, seriesInput);
    expect([h.transactions(), h.seriesViewReads()]).toEqual([1, 1]);
  });

  it('never offers a continuation page to the response cache', async () => {
    const h = harness();
    const input = {
      source: { edition: { editionId: E2025, form: 'STATE_BUDGET_AUTHORITY_DETAIL' } },
    };
    const page = (await budgetApprovedRecords(h.deps, { input, first: 2 }))._unsafeUnwrap();
    expect(h.sets).toHaveLength(1);
    await budgetApprovedRecords(h.deps, { input, first: 2, after: page.pageInfo.endCursor });
    await budgetApprovedRecords(h.deps, { input, first: 2, after: page.pageInfo.endCursor });
    expect(h.transactions()).toBe(3);
    expect(h.sets).toHaveLength(1);
  });

  it('lets a passed expectedSnapshot populate the reusable entry, never a mismatch or an error', async () => {
    const current = (
      await budgetApprovedTotals(harness(false).deps, { input: totalsInput })
    )._unsafeUnwrap().snapshot;
    const h = harness();
    await budgetApprovedTotals(h.deps, { input: totalsInput, expectedSnapshot: current });
    expect([h.transactions(), h.sets.length]).toEqual([1, 1]);
    await budgetApprovedTotals(h.deps, { input: totalsInput });
    expect(h.transactions()).toBe(1); // the plain request reuses it

    const m = harness();
    m.move(NEW_LOAD);
    const mismatch = await budgetApprovedTotals(m.deps, {
      input: totalsInput,
      expectedSnapshot: current,
    });
    expect(mismatch._unsafeUnwrapErr()).toMatchObject({ reason: 'SNAPSHOT_CHANGED' });
    const failed = await budgetNationalExecutionSeries(m.deps, {
      input: {
        itemIds: ['mfin.bgc.revenue.total'],
        basis: 'YTD',
        period: { type: 'MONTH', selection: { dates: ['2025-07'] } },
      },
    });
    expect(failed.isErr()).toBe(true);
    expect(m.sets).toEqual([]);
    await budgetApprovedTotals(m.deps, { input: totalsInput });
    expect(m.transactions()).toBe(3);
  });
});

/**
 * A harness whose reads complete only when released: each read takes its
 * snapshot when it runs (as the RR transaction does), then waits at a gate,
 * so a slow computation and a source change can overlap. The cache clock is
 * injected (milliseconds).
 */
const gatedHarness = () => {
  let now = 0;
  let world = makeSourceWorld();
  let transactions = 0;
  let holding = false;
  const gates: (() => void)[] = [];
  const db = makeCapturingDb([], {
    respond: (sql, parameters) => world.respond(sql, parameters),
    onBeginTransaction: () => {
      transactions += 1;
    },
  });
  const real = makeNationalReadPort(db, (run) => ({
    approved: makeNationalApprovedReader(run),
    execution: makeNationalExecutionReader(run),
  }));
  const port: NationalReadPort = {
    read: async (work, options) => {
      const result = await real.read(work, options);
      if (holding) await new Promise<void>((resolve) => gates.push(resolve));
      return result;
    },
  };
  return {
    deps: {
      port,
      cache: makeNationalResponseCache({ clock: () => now }),
    } satisfies NationalUsecaseDeps,
    at: (ms: number) => {
      now = ms;
    },
    move: (options: SourceWorldOptions) => {
      world = makeSourceWorld(options);
    },
    hold: (value: boolean) => {
      holding = value;
    },
    /** Release the n-th held read and let its continuation run. */
    release: async (index: number) => {
      gates[index]?.();
      await Promise.resolve();
    },
    transactions: () => transactions,
  };
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('cache freshness is measured from the read start', () => {
  it('never replays a snapshot more than 30 s after its read started (delayed completion)', async () => {
    const h = gatedHarness();
    h.at(0);
    h.hold(true);
    const pending = budgetApprovedTotals(h.deps, { input: totalsInput });
    await flush(); // snapshot A taken at t=0
    h.at(1);
    h.move(NEW_LOAD); // the source changes while A is still computing
    h.at(4_000);
    await h.release(0);
    const a = (await pending)._unsafeUnwrap();
    h.hold(false);
    h.at(32_000);
    const before = h.transactions();
    const later = (await budgetApprovedTotals(h.deps, { input: totalsInput }))._unsafeUnwrap();
    expect(h.transactions()).toBe(before + 1);
    expect(later.snapshot).not.toBe(a.snapshot);
  });

  it('does not remember a computation that consumed the whole window', async () => {
    const h = gatedHarness();
    h.at(0);
    h.hold(true);
    const pending = budgetApprovedTotals(h.deps, { input: totalsInput });
    await flush();
    h.at(31_000);
    await h.release(0);
    (await pending)._unsafeUnwrap();
    h.hold(false);
    const before = h.transactions();
    await budgetApprovedTotals(h.deps, { input: totalsInput });
    expect(h.transactions()).toBe(before + 1);
  });

  it('keeps the newer probe when an older read (same millisecond start) completes last', async () => {
    const h = gatedHarness();
    h.at(100);
    h.hold(true);
    const olderRead = budgetApprovedTotals(h.deps, { input: totalsInput });
    await flush(); // older read observes snapshot A
    h.move(NEW_LOAD);
    const newerRead = budgetApprovedTotals(h.deps, { input: totalsInput });
    await flush(); // newer read (same ms) observes snapshot B
    await h.release(1);
    const newer = (await newerRead)._unsafeUnwrap();
    await h.release(0);
    const older = (await olderRead)._unsafeUnwrap();
    expect(older.snapshot).not.toBe(newer.snapshot);
    h.hold(false);
    h.at(200);
    const before = h.transactions();
    const replay = (await budgetApprovedTotals(h.deps, { input: totalsInput }))._unsafeUnwrap();
    expect(h.transactions()).toBe(before);
    expect(replay.snapshot).toBe(newer.snapshot);
  });

  it('still bypasses a fresh probe for preconditions and continuations', async () => {
    const h = gatedHarness();
    h.at(0);
    const first = (await budgetApprovedTotals(h.deps, { input: totalsInput }))._unsafeUnwrap();
    const reads = h.transactions();
    (
      await budgetApprovedTotals(h.deps, { input: totalsInput, expectedSnapshot: first.snapshot })
    )._unsafeUnwrap();
    expect(h.transactions()).toBe(reads + 1);
    const input = {
      source: { edition: { editionId: E2025, form: 'STATE_BUDGET_AUTHORITY_DETAIL' } },
    };
    const page = (await budgetApprovedRecords(h.deps, { input, first: 2 }))._unsafeUnwrap();
    await budgetApprovedRecords(h.deps, { input, first: 2, after: page.pageInfo.endCursor });
    expect(h.transactions()).toBe(reads + 3);
  });
});
