/**
 * Whole-request memo in front of a `GroupedSeriesProvider` (review N/M2).
 *
 * A public map view re-ran the full grouped-series aggregation (tens of
 * seconds on the fact tables) on every GET. The native provider has no
 * per-series cache like the legacy one, and a public map is the same request
 * for every viewer, so the answer is memoised per request shape:
 *
 *  - key = granularity + series + groups (canonical, via the shared key
 *    builder); `requestUserId` is NOT part of the key — the served data does
 *    not depend on who asks once uploaded datasets are out of the picture;
 *  - requests naming an uploaded dataset are never cached here: they are
 *    user-owned, mutable, and already resolved per reader by the route;
 *  - only `ok` answers are stored (an error is never replayed for a TTL);
 *  - identical concurrent requests share ONE in-flight computation, so a
 *    burst of viewers on a fresh map does not fan out into N aggregations;
 *  - the kernel cache stores the output BY REFERENCE: vectors carry
 *    `Map`s, which the serialising infra cache would flatten to `{}` (Codex
 *    P1 on the first cut). Consumers only read the output.
 */
import { ok } from 'neverthrow';

import { CacheNamespace, type KeyBuilder } from '@/infra/cache/index.js';

import type { GroupedSeriesProvider } from '../../core/ports.js';
import type { GroupedSeriesDataRequest, GroupedSeriesProviderOutput } from '../../core/types.js';
import type { KernelCache } from '@/modules/shared/index.js';

export interface CachedGroupedSeriesProviderDeps {
  readonly inner: GroupedSeriesProvider;
  /** Reference store with its own TTL/size; never a serialising cache. */
  readonly cache: KernelCache;
  readonly keyBuilder: KeyBuilder;
}

/** Cacheable = no user-owned series in the request. Exported for the unit test. */
export const isCacheableGroupedSeriesRequest = (request: GroupedSeriesDataRequest): boolean =>
  request.series.every((series) => series.type !== 'uploaded-map-dataset');

const keyOf = (keyBuilder: KeyBuilder, request: GroupedSeriesDataRequest): string =>
  keyBuilder.fromFilter(CacheNamespace.ADVANCED_MAP_ANALYTICS_REQUEST, {
    granularity: request.granularity,
    series: request.series,
    groups: request.groups ?? [],
  });

export const makeCachedGroupedSeriesProvider = (
  deps: CachedGroupedSeriesProviderDeps
): GroupedSeriesProvider => {
  const inFlight = new Map<
    string,
    ReturnType<GroupedSeriesProvider['fetchGroupedSeriesVectors']>
  >();
  return {
    async fetchGroupedSeriesVectors(request) {
      if (!isCacheableGroupedSeriesRequest(request)) {
        return deps.inner.fetchGroupedSeriesVectors(request);
      }
      const key = keyOf(deps.keyBuilder, request);
      const cached = deps.cache.get(key) as GroupedSeriesProviderOutput | undefined;
      if (cached !== undefined) return ok(cached);
      const pending = inFlight.get(key);
      if (pending !== undefined) return pending;
      const computation = (async () => {
        const result = await deps.inner.fetchGroupedSeriesVectors(request);
        if (result.isOk()) deps.cache.set(key, result.value);
        return result;
      })().finally(() => {
        inFlight.delete(key);
      });
      inFlight.set(key, computation);
      return computation;
    },
  };
};
