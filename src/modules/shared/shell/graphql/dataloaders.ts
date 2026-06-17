/**
 * Shared Kernel — DataLoaders keyed by CUI (foundation §6.2, §14.1).
 *
 * A tiny dependency-free batching loader (no `dataloader` package needed): it
 * coalesces same-tick `.load(cui)` calls into one batched fetch, preventing
 * N+1 on `Entity` fan-out. Keys are CUI strings (§14.1 — the cross-source link
 * key is CUI, not org_id). One loader set per GraphQL request.
 */

import type { IdentityRepo } from '../../core/ports.js';
import type { Cui, Organization } from '../../core/types.js';

export interface BatchLoader<K, V> {
  load(key: K): Promise<V>;
}

/** Build a batching loader from a batch function. Batches per microtask tick. */
export const makeBatchLoader = <V>(
  batchFn: (keys: readonly string[]) => Promise<ReadonlyMap<string, V>>,
  missing: V
): BatchLoader<string, V> => {
  let queue: { key: string; resolve: (v: V) => void; reject: (e: unknown) => void }[] = [];
  let scheduled = false;

  const flush = (): void => {
    const batch = queue;
    queue = [];
    scheduled = false;
    const keys = [...new Set(batch.map((b) => b.key))];
    batchFn(keys)
      .then((result) => {
        for (const item of batch) item.resolve(result.get(item.key) ?? missing);
        return undefined;
      })
      .catch((error: unknown) => {
        for (const item of batch) item.reject(error);
      });
  };

  return {
    load(key: string): Promise<V> {
      return new Promise<V>((resolve, reject) => {
        queue.push({ key, resolve, reject });
        if (!scheduled) {
          scheduled = true;
          queueMicrotask(flush);
        }
      });
    },
  };
};

export interface KernelLoaders {
  readonly organizationByCui: BatchLoader<Cui, Organization | null>;
}

/**
 * Per-request kernel loaders. `organizationByCui` batches identity lookups so a
 * list of `Entity` resolves orgs in one round trip. (The identity repo currently
 * resolves per-CUI; the loader still de-dupes within a request.)
 */
export const makeKernelLoaders = (identityRepo: IdentityRepo): KernelLoaders => {
  const organizationByCui = makeBatchLoader<Organization | null>(async (keys) => {
    const entries = await Promise.all(
      keys.map(async (cui): Promise<[string, Organization | null]> => {
        const res = await identityRepo.findByCui(cui);
        return [cui, res.isOk() ? res.value : null];
      })
    );
    return new Map(entries);
  }, null);

  return { organizationByCui };
};
