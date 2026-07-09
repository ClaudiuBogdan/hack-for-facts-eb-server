/**
 * Companies module — the `companyHubStats` cache (shell; the only place a clock
 * enters this answer).
 *
 * Why a module-local provider and not the kernel `KernelCache`: that cache is a
 * single-TTL LRU with no singleflight and no stale-while-revalidate. The hub
 * aggregate costs ≈30s to compute (three sequential full-population scans, the
 * CAEN division leg alone is 23.6s), so:
 *
 *  - **singleflight** — N concurrent misses must share ONE in-flight compute, or a
 *    cold start under load fires N × 30s of scans and saturates the read pool.
 *  - **stale-while-revalidate** — once warm, an expired entry is served immediately
 *    and refreshed in the background; a reader never pays the 30s.
 *  - **never cache an `err`** — a transient DB failure must not pin a hole in the
 *    cache for the whole TTL; the next caller retries.
 *
 * `now` is injected so the tests drive the TTL with a fake clock rather than sleeping.
 * Precedent for a module-local TTL closure: `src/modules/legal/mo/index.ts`.
 */

import { err, ok, type Result } from 'neverthrow';

import type { CompanyHubStats } from '../core/types.js';
import type { CompanyHubStatsData } from '../core/usecases.js';
import type { ApiError } from '@/modules/shared/index.js';

/** 6h: the underlying registry snapshots move on a daily-at-best cadence. */
export const HUB_STATS_DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;

export interface HubStatsProviderOptions {
  readonly ttlMs?: number;
  /** Injected clock (ms since epoch). Defaults to `Date.now`. */
  readonly now?: () => number;
}

export interface HubStatsProvider {
  /** Cached hub stats. Computes on a cold miss; serves stale + refreshes otherwise. */
  get(): Promise<Result<CompanyHubStats, ApiError>>;
}

type Compute = () => Promise<Result<CompanyHubStatsData, ApiError>>;

interface Entry {
  readonly value: CompanyHubStats;
  readonly at: number;
}

export const makeHubStatsProvider = (
  compute: Compute,
  options: HubStatsProviderOptions = {}
): HubStatsProvider => {
  const ttlMs = options.ttlMs ?? HUB_STATS_DEFAULT_TTL_MS;
  const now = options.now ?? Date.now;

  let entry: Entry | null = null;
  let inFlight: Promise<Result<CompanyHubStats, ApiError>> | null = null;

  /**
   * One compute, shared by every concurrent caller. `computedAt` is stamped HERE —
   * core stays clock-free. A failure is propagated to all sharers and leaves the
   * previous (possibly stale) entry untouched.
   *
   * The clock is read on COMPLETION, not on entry: the compute takes ~30s, and
   * anchoring the TTL at its start silently shortens every window by that much.
   * (With a ttlMs at or below the compute time it would be worse than shortened —
   * each fill would land already-stale and the next read would kick off another
   * refresh forever.)
   */
  const runOnce = (): Promise<Result<CompanyHubStats, ApiError>> => {
    if (inFlight !== null) return inFlight;
    const promise = compute()
      .then((res): Result<CompanyHubStats, ApiError> => {
        // NB: an `err` is propagated but NEVER stored — a transient DB failure must
        // not pin a hole in the cache for the rest of the TTL window.
        if (res.isErr()) return err(res.error);
        const at = now();
        const value: CompanyHubStats = { ...res.value, computedAt: new Date(at).toISOString() };
        entry = { value, at };
        return ok(value);
      })
      .finally(() => {
        inFlight = null;
      });
    inFlight = promise;
    return promise;
  };

  return {
    async get(): Promise<Result<CompanyHubStats, ApiError>> {
      const current = entry;
      if (current === null) {
        // Cold: the caller waits (and shares the in-flight compute with its peers).
        return runOnce();
      }
      if (now() - current.at < ttlMs) return ok(current.value);

      // Stale: serve it NOW, refresh behind the request. A background failure is
      // swallowed — the stale value stands and the next call retries. Nothing here
      // may reject: an unhandled rejection would take the process down.
      if (inFlight === null) void runOnce().catch(() => undefined);
      return ok(current.value);
    },
  };
};
