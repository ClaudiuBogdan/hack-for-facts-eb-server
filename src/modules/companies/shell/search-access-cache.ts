import { performance } from 'node:perf_hooks';

import { sql, type Kysely } from 'kysely';

import { createLogger } from '@/infra/logger/index.js';

import { isPublished, registryScopeKey } from '../core/registry.js';
import { captureRegistryScope } from './repo/registry-sql.js';

import type { ProdDatabase, SearchAccessSnapshot } from '@/modules/shared/index.js';

/** User decision: access changes may propagate for at most three minutes. */
export const SEARCH_ACCESS_MAX_AGE_MS = 180_000;
export const SEARCH_ACCESS_REFRESH_MS = 60_000;
const CLOCK_DISCONTINUITY_MS = 5_000;
const CANONICAL_CUI = /^[1-9][0-9]{0,9}$/u;

export interface SearchAccessCache {
  read(): SearchAccessSnapshot | null;
  refresh(): Promise<void>;
  close(): void;
}

/** Singleflight background reads. Search/final confirmation only read memory. */
export function makeSearchAccessCache(
  load: () => Promise<SearchAccessSnapshot>,
  options: {
    readonly monotonicNow?: () => number;
    readonly wallNow?: () => number;
    readonly autoStart?: boolean;
    readonly onError?: () => void;
  } = {}
): SearchAccessCache {
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  const wallNow = options.wallNow ?? (() => Date.now());
  let saved: { value: SearchAccessSnapshot; monotonic: number; wall: number } | null = null;
  let inFlight: Promise<void> | null = null;
  let closed = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const refresh = (): Promise<void> => {
    if (closed) return Promise.resolve();
    if (inFlight !== null) return inFlight;
    // Count all connection/transaction/read time; completion never freshens a stale read.
    const started = monotonicNow();
    const wallStarted = wallNow();
    inFlight = Promise.resolve()
      .then(load)
      .then((value) => {
        if (!closed) saved = { value, monotonic: started, wall: wallStarted };
        return undefined;
      })
      .catch(() => {
        // Preserve only the previous bounded-age policy; never install an empty policy.
        options.onError?.();
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };
  if (options.autoStart !== false) {
    void refresh();
    timer = setInterval(() => {
      void refresh();
    }, SEARCH_ACCESS_REFRESH_MS);
    timer.unref();
  }
  return {
    refresh,
    read: () => {
      if (closed || saved === null) return null;
      const elapsed = monotonicNow() - saved.monotonic;
      const wallElapsed = wallNow() - saved.wall;
      if (
        elapsed < 0 ||
        Math.abs(elapsed - wallElapsed) > CLOCK_DISCONTINUITY_MS ||
        Math.max(elapsed, wallElapsed) >= SEARCH_ACCESS_MAX_AGE_MS
      )
        return null;
      return saved.value;
    },
    close: () => {
      closed = true;
      saved = null;
      if (timer !== undefined) clearInterval(timer);
    },
  };
}

/** Existing read-only role; no DDL, writes, or new service/credential required. */
export function makeDatabaseSearchAccessCache(db: Kysely<ProdDatabase>): SearchAccessCache {
  const logger = createLogger({ name: 'search-access-refresh', pretty: false });
  return makeSearchAccessCache(
    () =>
      db
        .transaction()
        .setIsolationLevel('repeatable read')
        .execute(async (transaction) => {
          await sql`set transaction read only`.execute(transaction);
          await sql`set local statement_timeout = '30s'`.execute(transaction);
          const target = await sql<{ recovering: boolean }>`/* search-access-refresh */
        select pg_is_in_recovery() as recovering`.execute(transaction);
          if (target.rows[0]?.recovering !== false)
            throw new Error('Search access requires the primary');
          const scope = await captureRegistryScope(transaction);
          if (scope.isErr()) throw new Error('Search access scope could not be captured');
          const denied = await sql<{ cui: string }>`
        /* search-access-refresh */ select o.cui from core.organizations o
        where o.cui is not null and o.privacy_class is distinct from 'public'
      `.execute(transaction);
          const privateInstitutions = await sql<{ cui: string }>`
        /* search-access-refresh */ select pe.cui from core.public_entities pe
        left join core.territories t on t.id = pe.territory_id
        where t.id is null or t.privacy_class is distinct from 'public'
      `.execute(transaction);
          return {
            scopeKey: registryScopeKey(scope.value),
            published: isPublished(scope.value),
            privateCuis: new Set(
              denied.rows.map((row) => row.cui).filter((cui) => CANONICAL_CUI.test(cui))
            ),
            privateInstitutionCuis: new Set(
              privateInstitutions.rows
                .map((row) => row.cui)
                .filter((cui) => CANONICAL_CUI.test(cui))
            ),
          };
        }),
    {
      onError: () => {
        logger.warn(
          { component: 'search-access-refresh' },
          'Search access refresh failed; previous snapshot retains its original expiry'
        );
      },
    }
  );
}
