/**
 * Companies module — the `companyHubStats` cache (shell; the only place a clock
 * enters this answer).
 *
 * Why a module-local provider and not the kernel `KernelCache`: that cache is a
 * single-TTL LRU with no singleflight and no stale-while-revalidate. The hub
 * aggregate costs tens of seconds to compute (sequential full-population legs),
 * so:
 *
 *  - **singleflight per scope** — N concurrent misses of one registry scope
 *    share ONE in-flight compute.
 *  - **stale-while-revalidate within one scope** — once warm, an expired entry
 *    of the CURRENT scope is served immediately and refreshed in the
 *    background.
 *  - **fresh scope on every read** — every `get()` captures the registry scope
 *    first (one cheap statement). A cached entry is served only when its scope
 *    key equals the current one: any publish, rollback, access withdrawal or
 *    access-epoch move makes the old entry unservable (never shown stale), and
 *    an unpublished/withdrawn/unavailable registry is an error, never a
 *    previous edition's figures. The cached value is metadata-free data; the
 *    capture, not the cache, is the access check.
 *  - **never cache an `err`** — a transient DB failure must not pin a hole in the
 *    cache for the whole TTL; the next caller retries.
 *
 * `now` is injected so the tests drive the TTL with a fake clock rather than sleeping.
 * Precedent for a module-local TTL closure: `src/modules/legal/mo/index.ts`.
 */

import { err, ok, type Result } from 'neverthrow';

import {
  isPublished,
  registryNotPublished,
  registryScopeKey,
  type CompanyRegistryEnvelope,
} from '../core/registry.js';

import type { CompanyHubStats } from '../core/types.js';
import type { CompanyHubStatsData } from '../core/usecases.js';
import type { ApiError } from '@/modules/shared/index.js';

/** 6h: editions move on a weekly-at-best cadence; a scope change invalidates at once. */
export const HUB_STATS_DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;

export interface HubStatsProviderOptions {
  readonly ttlMs?: number;
  /** Injected clock (ms since epoch). Defaults to `Date.now`. */
  readonly now?: () => number;
}

export interface HubStatsProvider {
  /** Cached hub stats of the CURRENT registry scope. Computes on a miss; serves stale + refreshes within one scope. */
  get(): Promise<Result<CompanyHubStats, ApiError>>;
}

export interface HubStatsSources {
  /** The fresh scope capture (every call). */
  readonly captureScope: () => Promise<Result<CompanyRegistryEnvelope, ApiError>>;
  /** The legs under one scope (rechecked inside; a moved scope is an error). */
  readonly compute: (
    scope: CompanyRegistryEnvelope
  ) => Promise<Result<CompanyHubStatsData, ApiError>>;
}

interface Entry {
  readonly key: string;
  readonly value: CompanyHubStats;
  readonly at: number;
}

export const makeHubStatsProvider = (
  sources: HubStatsSources,
  options: HubStatsProviderOptions = {}
): HubStatsProvider => {
  const ttlMs = options.ttlMs ?? HUB_STATS_DEFAULT_TTL_MS;
  const now = options.now ?? Date.now;

  let entry: Entry | null = null;
  const inFlight = new Map<string, Promise<Result<CompanyHubStats, ApiError>>>();

  /**
   * One compute per scope key, shared by every concurrent caller of that
   * scope. `computedAt` is stamped HERE — core stays clock-free. The clock is
   * read on COMPLETION, not on entry: anchoring the TTL at the start of a long
   * compute would shorten every window by that much.
   */
  const runOnce = (scope: CompanyRegistryEnvelope): Promise<Result<CompanyHubStats, ApiError>> => {
    const key = registryScopeKey(scope);
    const pending = inFlight.get(key);
    if (pending !== undefined) return pending;
    const promise = sources
      .compute(scope)
      .then((res): Result<CompanyHubStats, ApiError> => {
        // NB: an `err` is propagated but NEVER stored.
        if (res.isErr()) return err(res.error);
        const at = now();
        const value: CompanyHubStats = { ...res.value, computedAt: new Date(at).toISOString() };
        // A late result of an older scope may land here; `get` compares keys
        // against a fresh capture, so it is never served.
        entry = { key, value, at };
        return ok(value);
      })
      .finally(() => {
        inFlight.delete(key);
      });
    inFlight.set(key, promise);
    return promise;
  };

  return {
    async get(): Promise<Result<CompanyHubStats, ApiError>> {
      const captured = await sources.captureScope();
      if (captured.isErr()) return err(captured.error);
      const scope = captured.value;
      // Never a previous edition's figures for an unpublished, withdrawn or
      // unreadable registry.
      if (!isPublished(scope)) return err(registryNotPublished(scope, 'company hub statistics'));
      const key = registryScopeKey(scope);
      const current = entry;
      if (current?.key !== key) {
        // Cold, or the scope moved: the old entry is never served.
        return runOnce(scope);
      }
      if (now() - current.at < ttlMs) return ok(current.value);

      // Stale within the same scope: serve it NOW, refresh behind the request.
      // A background failure is swallowed — the stale value stands and the
      // next call retries. Nothing here may reject (an unhandled rejection
      // would take the process down).
      if (!inFlight.has(key)) void runOnce(scope).catch(() => undefined);
      return ok(current.value);
    },
  };
};
