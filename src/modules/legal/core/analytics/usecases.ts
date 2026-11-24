/**
 * Legislation analytics: the one usecase layer REST, GraphQL and MCP call.
 *
 * A request is answered in two steps. `prepare` validates the arguments
 * against the published layer's head (read in its own read-only snapshot and
 * kept a short while) and yields the layer-keyed cache key, so a REST caller
 * can answer `If-None-Match` before any statement runs. `answer` then reads
 * the view in ONE read-only repeatable-read snapshot that first checks the
 * pointer still names the head's layer: if a newer layer was published in
 * between, the head is dropped and the request is prepared again once.
 *
 * Aggregate answers are cached by layer id and canonical arguments. A layer
 * never changes once published (retained history), so an entry is never
 * stale for its key; the TTL only bounds memory. Failures are never cached.
 * The views that NAME acts (acts, links) are never cached: an act restricted
 * after the build must stop being named at once, and the repo decides that in
 * the view's own transaction.
 *
 * Load: identical reads in flight share one promise, and at most
 * ANALYTICS_SLOTS reads run at once across the three surfaces; a read that
 * waits longer than SLOT_WAIT_MS for a slot is refused (503, retry).
 */

import { err, ok, type Result } from 'neverthrow';

import {
  invalidInput,
  serviceUnavailable,
  type ApiError,
  type KernelCache,
} from '@/modules/shared/index.js';

import { isLegalAnalyticsView, parseLegalAnalyticsRequest } from './request.js';

import type {
  LegalAnalyticsAnswer,
  LegalAnalyticsArgs,
  LegalAnalyticsData,
  LegalAnalyticsHead,
  LegalAnalyticsRequest,
} from './types.js';

/** The pointer moved between the head read and the view read. */
export const LAYER_CHANGED = 'layer_changed' as const;

export type LegalAnalyticsViewRequest = Exclude<LegalAnalyticsRequest, { view: 'head' }>;

export interface LegalAnalyticsRepo {
  /** The published head in its own read-only snapshot; ServiceUnavailable when none is published or deployed. */
  readHead(): Promise<Result<LegalAnalyticsHead, ApiError>>;
  /**
   * One view in one read-only repeatable-read snapshot pinned to `head.layer`:
   * LAYER_CHANGED when the pointer names another layer by then.
   */
  read(
    request: LegalAnalyticsViewRequest,
    head: LegalAnalyticsHead
  ): Promise<Result<LegalAnalyticsData | typeof LAYER_CHANGED, ApiError>>;
}

/** At most this many analytics reads run at once; a read waits at most SLOT_WAIT_MS for a slot. */
export const ANALYTICS_SLOTS = 4;
export const SLOT_WAIT_MS = 2_000;
/** The message of the refusal when no slot came free in time (REST adds Retry-After). */
export const ANALYTICS_BUSY = 'Legislation analytics are busy; retry shortly.';

/** A counting semaphore with a bounded wait: `acquire` resolves to a release, or null past the wait. */
export interface LegalAnalyticsGate {
  acquire(waitMs: number): Promise<(() => void) | null>;
}

export const makeLegalAnalyticsGate = (slots: number): LegalAnalyticsGate => {
  let free = slots;
  const waiting: ((release: () => void) => void)[] = [];
  const release = (): void => {
    const next = waiting.shift();
    if (next === undefined) free += 1;
    else next(release);
  };
  return {
    acquire: (waitMs) => {
      if (free > 0) {
        free -= 1;
        return Promise.resolve(release);
      }
      return new Promise((resolve) => {
        const grant = (r: () => void): void => {
          clearTimeout(timer);
          resolve(r);
        };
        const timer = setTimeout(() => {
          const at = waiting.indexOf(grant);
          if (at >= 0) waiting.splice(at, 1);
          resolve(null);
        }, waitMs);
        waiting.push(grant);
      });
    },
  };
};

export interface LegalAnalyticsDeps {
  readonly repo: LegalAnalyticsRepo;
  /** Caps concurrent reads (all three surfaces share it). */
  readonly gate: LegalAnalyticsGate;
  /** Reads in flight by cache key: identical requests share one read. */
  readonly inflight: Map<
    string,
    Promise<Result<LegalAnalyticsData | typeof LAYER_CHANGED, ApiError>>
  >;
  /** Holds the head under HEAD_KEY (a short TTL: how long a new layer may wait to be noticed). */
  readonly heads: KernelCache;
  /** Holds answers under `<layer id>:<request key>`. */
  readonly answers: KernelCache;
}

const HEAD_KEY = 'legal:analytics:head';
/** Lineages the head view lists (most acts first; joint orders keep long raw names, so the full list is large). */
export const HEAD_ISSUERS = 300;

export interface LegalAnalyticsPrepared {
  readonly head: LegalAnalyticsHead;
  readonly request: LegalAnalyticsRequest;
  /** `<layer id>:<request key>`: the answer cache key and the validator's input. */
  readonly cacheKey: string;
}

const readHead = (deps: LegalAnalyticsDeps): Promise<Result<LegalAnalyticsHead, ApiError>> =>
  deps.heads.wrap(
    HEAD_KEY,
    () => deps.repo.readHead(),
    (r) => r.isOk()
  );

/** Validate a request against the current head; no view statement runs. */
export const prepareLegalAnalytics = async (
  deps: LegalAnalyticsDeps,
  view: string,
  args: LegalAnalyticsArgs
): Promise<Result<LegalAnalyticsPrepared, ApiError>> => {
  if (!isLegalAnalyticsView(view)) return err(invalidInput('unknown analytics view', 'view'));
  const head = await readHead(deps);
  if (head.isErr()) return err(head.error);
  const request = parseLegalAnalyticsRequest(view, args, head.value);
  if (request.isErr()) return err(request.error);
  return ok({
    head: head.value,
    request: request.value,
    cacheKey: `${head.value.layer.layerId}:${request.value.key}`,
  });
};

const toAnswer = (
  prepared: LegalAnalyticsPrepared,
  data: LegalAnalyticsData
): LegalAnalyticsAnswer => ({
  view: prepared.request.view,
  layer: prepared.head.layer,
  args: prepared.request.args,
  data,
  cacheKey: prepared.cacheKey,
});

/** Answer a prepared request (from the cache when the layer and arguments were answered before). */
export const answerLegalAnalytics = async (
  deps: LegalAnalyticsDeps,
  prepared: LegalAnalyticsPrepared,
  view: string,
  args: LegalAnalyticsArgs,
  retried = false
): Promise<Result<LegalAnalyticsAnswer, ApiError>> => {
  const { request } = prepared;
  if (request.view === 'head') {
    const head = prepared.head;
    return ok(toAnswer(prepared, { ...head, issuers: head.issuers.slice(0, HEAD_ISSUERS) }));
  }
  const compute = () =>
    readOnce(deps, prepared.cacheKey, () => deps.repo.read(request, prepared.head));
  const read = NAMING_VIEWS.has(request.view)
    ? await compute()
    : await deps.answers.wrap(
        prepared.cacheKey,
        compute,
        (r) => r.isOk() && r.value !== LAYER_CHANGED
      );
  if (read.isErr()) return err(read.error);
  if (read.value !== LAYER_CHANGED) return ok(toAnswer(prepared, read.value));
  // A newer layer was published after the head was read: read the head again, once.
  deps.heads.invalidateByPrefix(HEAD_KEY);
  if (retried)
    return err(serviceUnavailable('the analytics layer changed twice during one request; retry'));
  const again = await prepareLegalAnalytics(deps, view, args);
  if (again.isErr()) return err(again.error);
  return answerLegalAnalytics(deps, again.value, view, args, true);
};

/** The views that name acts: never cached, validated over what they name (REST: no-store). */
export const NAMING_VIEWS: ReadonlySet<string> = new Set(['acts', 'links']);

/** One read per key in flight, under a slot of the gate. */
const readOnce = (
  deps: LegalAnalyticsDeps,
  key: string,
  read: () => Promise<Result<LegalAnalyticsData | typeof LAYER_CHANGED, ApiError>>
): Promise<Result<LegalAnalyticsData | typeof LAYER_CHANGED, ApiError>> => {
  const running = deps.inflight.get(key);
  if (running !== undefined) return running;
  const started = (async () => {
    const release = await deps.gate.acquire(SLOT_WAIT_MS);
    if (release === null) return err(serviceUnavailable(ANALYTICS_BUSY));
    try {
      return await read();
    } finally {
      release();
    }
  })();
  deps.inflight.set(key, started);
  void started.finally(() => deps.inflight.delete(key));
  return started;
};

/** Prepare and answer in one call (GraphQL and MCP, which have no validators). */
export const getLegalAnalytics = async (
  deps: LegalAnalyticsDeps,
  view: string,
  args: LegalAnalyticsArgs
): Promise<Result<LegalAnalyticsAnswer, ApiError>> => {
  const prepared = await prepareLegalAnalytics(deps, view, args);
  if (prepared.isErr()) return err(prepared.error);
  return answerLegalAnalytics(deps, prepared.value, view, args);
};
