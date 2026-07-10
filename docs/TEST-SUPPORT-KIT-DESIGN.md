# Test Support Kit — Design

**Status:** Design — no implementation
**Companion documents:** `NOTIFICATION-PLATFORM-MODULE-DESIGN.md` (the first consumer), `NOTIFICATION-PLATFORM-ARCHITECTURE.md`

## 1. Why this exists

The current test-double infrastructure works but has verified structural gaps that would hurt the notification platform, whose correctness rests on deterministic time (digest windows, retry backoff, expiry, watermark scans) and deterministic identity (idempotency keys):

- `tests/fixtures/fakes.ts` is a 4,166-line monolith; every fake re-implements Map CRUD, cloning, and secondary indexes by hand.
- Fakes mint `crypto.randomUUID()` internally, so records created through a fake cannot be asserted by value.
- Builder IDs come from module-global monotonic counters that are never reset — IDs depend on test execution order.
- No neverthrow assertion helpers: 178 files inline `expect(result.isOk()).toBe(true); if (result.isOk()) {…}`; 68 use `_unsafeUnwrap()` (opaque failures).
- No `Clock` port anywhere; ~9 files rely on global `vi.useFakeTimers()` + `setSystemTime`.
- No reusable queue fake: BullMQ queues are stubbed inline as one-method `{ add } as unknown as Queue` casts, and no fake can actually _run_ enqueued jobs, so enqueue→process flows are untestable without Redis.
- Testcontainers covers Postgres only; there is no Redis in any test tier.

This kit fixes those gaps for new code. **Adoption is gradual**: legacy fixtures and tests are untouched; the notification platform uses the kit from day one; legacy tests migrate opportunistically.

## 2. Key decisions

**D1 — Ports in `src/common/ports/`, production adapters in `src/infra/`.**
The ESLint `boundaries/dependencies` rules allow `core → common` and forbid `core → infra|shell|app`. The `Clock` and `IdGenerator` **interfaces** therefore live in `src/common/` so any module's core can type its deps. The **impure adapters** (`systemClock` wrapping `new Date()`, `uuidIds` wrapping `crypto.randomUUID()`) deliberately live in `src/infra/`: if they lived in common, core could silently import them and reintroduce nondeterminism; placing them in infra makes accidental use inside core a CI lint failure. The shell composes infra adapters into core deps — exactly the shell's job.

**D2 — Queue fakes at the domain-port seam, never a BullMQ `Queue` class fake.**
(a) Core is lint-banned from importing `bullmq`, so usecases only ever see narrow scheduler ports (`enqueue(...) => Promise<Result<...>>`) — that is the seam tests exercise. (b) BullMQ's `Queue`/`Worker` surface is enormous (events, repeatables, Lua semantics, Redis connections); a class fake would be brittle vendor coupling. (c) The existing `makeInMemoryAdminEventQueue` (`tests/fixtures/admin-events.ts`) proves the domain-port model works; this kit generalizes it and adds the missing half — actually **running** registered handlers deterministically. The thin BullMQ shell adapters remain covered by the `createApp({ deps })` runtime-factory seam (`src/app/build-plan.ts`) and e2e.

**D3 — Composition over inheritance.** `makeKeyedStore` is a data-structure utility that fakes close over — no base classes, matching the existing factory-function style.

**D4 — Contract suites defined once, executed per tier.** Unit files run cases against the fake; e2e files (separate `vitest.e2e.config.ts`, Docker-gated) run the same cases against the real Kysely repo on the existing Testcontainers Postgres singleton. The case file imports neither tier's infrastructure.

## 3. File tree

```
src/common/ports/
  clock.ts                 # Clock port interface (pure type, core-importable)
  id-generator.ts          # IdGenerator port interface
  index.ts                 # re-exports both

src/infra/clock/
  index.ts                 # systemClock production adapter (new Date())
src/infra/ids/
  index.ts                 # uuidIds production adapter (crypto.randomUUID())

tests/support/
  index.ts                 # barrel: single import surface @/tests/support
  clock.ts                 # makeFixedClock / makeTestClock (advance/set)
  ids.ts                   # makeSequentialIds — deterministic, per-instance, resettable
  result.ts                # expectOk / expectErr / expectOkAsync / expectErrAsync
  store.ts                 # makeKeyedStore — generic keyed store with secondary indexes
  faults.ts                # makeFaultPlan — typed per-method / per-call fault injection
  jobs.ts                  # makeInMemoryJobRuntime — enqueue + register + deterministic drain
  contract.ts              # describePortContract harness (fake / real backends)

tests/contracts/           # NEW convention: tier-agnostic contract case definitions
  notification-platform/
    delivery-repo.contract.ts    # exported case suite; imported by unit AND e2e runner files
    event-repo.contract.ts
    logical-notification-repo.contract.ts
    digest-batch-repo.contract.ts

tests/fixtures/notification-platform/   # module-scoped fakes (NOT added to legacy fakes.ts)
  fakes.ts                 # makeFake<Port> factories composing makeKeyedStore + FaultPlan
  builders.ts              # data builders taking { ids, clock } — no module-global counters
```

`@/tests/support` resolves via the existing `@/tests/*` alias (`tsconfig.test.json`, `vitest.config.ts`). `src/common/ports/` sits alongside common's existing `constants/`, `schemas/`, `types/`, `utils/`.

## 4. Contracts

### 4.1 Ports and production adapters

```ts
// src/common/ports/clock.ts
export interface Clock {
  now(): Date;
}

// src/common/ports/id-generator.ts
export interface IdGenerator {
  newId(): string;
}

// src/infra/clock/index.ts
export const systemClock: Clock; // { now: () => new Date() }

// src/infra/ids/index.ts
export const uuidIds: IdGenerator; // { newId: () => crypto.randomUUID() }
```

### 4.2 `tests/support/clock.ts`

```ts
export interface TestClock extends Clock {
  /** Move time forward by ms. Returns the new current Date. */
  advance(ms: number): Date;
  /** Jump to an absolute instant. */
  set(date: Date): void;
}

/** Clock frozen at start; convenience wrapper over makeTestClock. */
export function makeFixedClock(start: Date): Clock;

/** Controllable clock; defaults to 2024-01-01T00:00:00.000Z. */
export function makeTestClock(start?: Date): TestClock;
```

`now()` returns a **new** `Date` on every call (no aliasing). No interaction with `vi.useFakeTimers()` — this is a port, not a global patch; the legacy fake-timer files are unaffected.

### 4.3 `tests/support/ids.ts`

```ts
export interface SequentialIds extends IdGenerator {
  /** Next id without consuming it — assert "the id the usecase will mint". */
  peek(): string;
  /** All ids issued so far, in order. */
  issued(): readonly string[];
  reset(): void;
}

/** Yields `${prefix}-1`, `${prefix}-2`, … Default prefix "id".
 *  Per-instance counter — fixes the order-coupled global counters. */
export function makeSequentialIds(prefix?: string): SequentialIds;
```

### 4.4 `tests/support/result.ts`

```ts
/** Returns the Ok value or throws an Error whose message includes `context`
 *  and the inspected Err value. TypeScript narrowing: caller receives T. */
export function expectOk<T, E>(result: Result<T, E>, context?: string): T;

/** Returns the Err value or throws with the inspected Ok value in the message. */
export function expectErr<T, E>(result: Result<T, E>, context?: string): E;

/** Awaitable variants for ResultAsync / Promise<Result>. */
export function expectOkAsync<T, E>(
  result: ResultAsync<T, E> | Promise<Result<T, E>>,
  context?: string
): Promise<T>;
export function expectErrAsync<T, E>(
  result: ResultAsync<T, E> | Promise<Result<T, E>>,
  context?: string
): Promise<E>;
```

Thrown errors carry clean stacks so vitest points at the test line, not the helper. Replaces both the inline four-line dance and `_unsafeUnwrap()`.

### 4.5 `tests/support/store.ts`

```ts
export type IndexKey = string | number;

export interface KeyedStoreOptions<K, V> {
  keyOf(value: V): K;
  /** Named secondary indexes: value → index key(s). Multi-valued supported. */
  indexes?: Record<string, (value: V) => IndexKey | IndexKey[] | null>;
  /** Clone applied on write AND read to prevent aliasing. Default: structuredClone.
   *  CAVEAT: structuredClone rejects class instances and functions — fakes holding
   *  rich objects must supply a custom clone. */
  clone?(value: V): V;
}

export interface KeyedStore<K, V> {
  get(key: K): V | undefined; // clone
  has(key: K): boolean;
  put(value: V): V; // upsert; stores a clone; reindexes
  update(key: K, fn: (current: V) => V): V | undefined; // undefined if absent
  delete(key: K): boolean;
  list(): V[]; // insertion order, clones
  filter(pred: (v: V) => boolean): V[];
  find(pred: (v: V) => boolean): V | undefined;
  byIndex(name: string, key: IndexKey): V[]; // throws on unknown index name
  size(): number;
  clear(): void;
  seed(values: Iterable<V>): void;
  /** Point-in-time deep copy for before/after assertions. */
  snapshot(): V[];
}

export function makeKeyedStore<K, V>(options: KeyedStoreOptions<K, V>): KeyedStore<K, V>;
```

Clone-on-read is what makes fakes behave like a real database: mutating a returned row must not mutate the store. That aliasing bug is what the hand-rolled clone logic in legacy fakes guards against — centralized once here.

### 4.6 `tests/support/faults.ts`

```ts
/** M = union of the fake's method names; E = the port's error type. */
export interface FaultRule<E> {
  error: E;
  /** 'once' (default) | 'always' | exact number of consecutive failures. */
  times?: number | 'once' | 'always';
  /** 1-indexed call number at which the fault starts (e.g. fail only the 3rd call). */
  onCall?: number;
}

export interface FaultPlan<M extends string, E> {
  fail(method: M, rule: FaultRule<E>): void;
  clear(method?: M): void;
  /** Called by fakes as the first line of each method: records the call and
   *  returns the scheduled error if this call should fail. */
  intercept(method: M): E | undefined;
  callCount(method: M): number;
}

export function makeFaultPlan<M extends string, E>(): FaultPlan<M, E>;
```

Convention (replaces ad-hoc `simulateDbError` booleans): every fake factory accepts `faults?: FaultPlan<MethodName, PortError>` and begins each method with:

```ts
const fault = faults?.intercept('claimForSending');
if (fault !== undefined) return err(fault);
```

Tests get call-count observability (`plan.callCount(...)`) without a mocking library.

### 4.7 `tests/support/jobs.ts`

```ts
export interface JobOptions {
  delayMs?: number;
  attempts?: number; // default 1
  backoff?: { type: 'fixed' | 'exponential'; delayMs: number };
  /** Dedupe key: enqueue with an existing pending dedupeId is a no-op (BullMQ jobId semantics). */
  dedupeId?: string;
}

export type JobState = 'waiting' | 'delayed' | 'active' | 'completed' | 'failed';

export interface PendingJob<P = unknown> {
  id: string;
  name: string; // queue/handler name
  payload: P;
  opts: Readonly<JobOptions>;
  enqueuedAt: Date;
  runAt: Date; // enqueuedAt + delayMs (or retry backoff)
  attemptsMade: number;
  state: JobState;
  lastError?: unknown;
}

export interface JobRuntimeError {
  message: string;
  retryable: boolean;
}

export interface RunOutcome {
  job: PendingJob;
  outcome: 'completed' | 'retried' | 'failed';
  error?: unknown;
}

export type JobHandler<P> = (job: PendingJob<P>) => Promise<Result<void, unknown> | void>;

export interface InMemoryJobRuntime {
  /** Returns an enqueue function bound to a job name — the building block for
   *  module port fakes: wrap it to implement any XSchedulerPort. */
  enqueuer<P>(
    name: string
  ): (payload: P, opts?: JobOptions) => Promise<Result<PendingJob<P>, JobRuntimeError>>;

  /** Register the handler that runNext/runAll dispatch to for `name`. */
  register<P>(name: string, handler: JobHandler<P>): void;

  /** Run the single next due job (earliest runAt; advances the injected TestClock
   *  to runAt if in the future). undefined when nothing pending. */
  runNext(): Promise<RunOutcome | undefined>;

  /** Drain deterministically: run jobs (including retries scheduled by failures)
   *  until none remain or maxSteps (default 100) — throws on the cap so infinite
   *  retry loops fail loudly. */
  runAll(opts?: { maxSteps?: number }): Promise<RunOutcome[]>;

  /** pending = waiting + delayed, ordered by runAt. */
  pending(): readonly PendingJob[];
  jobs(state?: JobState): readonly PendingJob[];

  /** Enqueue-side fault injection (worker faults belong in handlers/fakes). */
  faults: FaultPlan<'enqueue', JobRuntimeError>;
}

export function makeInMemoryJobRuntime(deps: {
  clock: TestClock; // REQUIRED — delay/backoff are driven by the test clock
  ids?: IdGenerator; // default makeSequentialIds('job')
}): InMemoryJobRuntime;
```

Determinism guarantees: job IDs from sequential ids; ordering by `runAt` then enqueue order; `runAll` advances the shared `TestClock`, so a usecase stamping `clock.now()` during processing sees time consistent with the delay it was enqueued with. A module scheduler-port fake is then one line per method:

```ts
export const makeFakeSendScheduler = (rt: InMemoryJobRuntime): SendJobScheduler => {
  const enqueue = rt.enqueuer<SendJobPayload>('np-delivery-send');
  return {
    enqueue: (p, opts) =>
      enqueue(p, { delayMs: opts?.delayMs }).then((r) =>
        r.map(() => undefined).mapErr(toQueueError)
      ),
  };
};
```

### 4.8 `tests/support/contract.ts`

```ts
export interface PortFixture<Port> {
  port: Port;
  /** Restore pristine state between tests (clear maps / truncate tables). */
  reset?(): Promise<void> | void;
  /** After the whole suite (close pools; NOT the shared container). */
  teardown?(): Promise<void> | void;
}

export type PortFixtureFactory<Port> = () => Promise<PortFixture<Port>> | PortFixture<Port>;

export interface PortContractContext<Port> {
  /** Valid inside test bodies (fixture built in beforeAll, reset in beforeEach). */
  getPort(): Port;
  backend: 'fake' | 'real';
}

/** Case suite defined ONCE, shared by unit and e2e runner files. */
export type PortContractCases<Port> = (ctx: PortContractContext<Port>) => void;

export function describePortContract<Port>(
  name: string,
  cases: PortContractCases<Port>,
  backends: {
    fake?: PortFixtureFactory<Port>;
    real?: {
      make: PortFixtureFactory<Port>;
      /** Extra gate on top of tier config, e.g. docker availability. */
      when?: () => boolean;
    };
  } // at least one backend required
): void;
```

Emits `describe('<name> contract [fake]')` / `describe.skipIf(!when())('<name> contract [real]')` blocks with `beforeAll`(make) → `beforeEach`(reset) → `afterAll`(teardown). Tier split: the unit runner passes only `fake`; the e2e runner (under `tests/e2e/`, picked up only by the Docker-gated e2e config) passes only `real`, using `setupTestDatabase()` from `tests/infra/test-db.ts`.

## 5. Worked examples

### (a) Unit test — time-dependent usecase with fixed clock, sequential ids, store-composed fake

```ts
import { makeTestClock, makeSequentialIds, expectOk, expectErr } from '@/tests/support';
import { makeFakeDigestBatchRepo, builders } from '@/tests/fixtures/notification-platform';

it('assigns to the next daily window after 08:00 Bucharest', async () => {
  const clock = makeTestClock(new Date('2026-07-01T06:30:00Z')); // 09:30 Bucharest
  const ids = makeSequentialIds('batch');
  const digests = makeFakeDigestBatchRepo();

  const result = expectOk(
    await assignToDigest(
      { clock, ids, digests, logger },
      {
        logicalNotificationId: 'logical-1',
        userId: 'u1',
        channel: 'email',
        cadence: 'daily',
      }
    )
  );

  expect(result.batchId).toBe('batch-1'); // deterministic, order-independent
  const [batch] = digests.store.byIndex('byUser', 'u1');
  expect(batch.dispatchAtUtc).toEqual(new Date('2026-07-02T05:00:00Z')); // next 08:00 EEST
});
```

### (b) Queue flow — enqueue → drain without Redis

```ts
it('a transient send failure schedules a delayed retry and succeeds on drain', async () => {
  const clock = makeTestClock();
  const rt = makeInMemoryJobRuntime({ clock });
  const sendScheduler = makeFakeSendScheduler(rt);
  rt.register('np-delivery-send', async (job) => {
    expectOk(await dispatchDelivery(deps, job.payload));
  });

  adapterFaults.fail('send', { error: transientProviderError, times: 1 });
  expectOk(await dispatchDelivery({ ...deps, sendScheduler }, { deliveryId: 'delivery-1' }));

  const [pending] = rt.pending();
  expect(pending.opts.delayMs).toBeGreaterThan(0); // backoff applied

  const outcomes = await rt.runAll(); // advances clock past the delay
  expect(outcomes.at(-1)?.outcome).toBe('completed');
  expect(expectOk(await deps.deliveries.findById('delivery-1'))?.status).toBe('accepted');
});
```

### (c) Contract suite — one definition, fake (unit) + real Postgres (e2e)

```ts
// tests/contracts/notification-platform/delivery-repo.contract.ts
export const deliveryRepoCases: PortContractCases<DeliveryRepo> = ({ getPort }) => {
  it('claim is exclusive: second concurrent claim of the same delivery loses', async () => {
    const repo = getPort();
    await seedReadyDelivery(repo, 'd1');
    const [a, b] = await Promise.all([
      repo.claimForSending({ deliveryId: 'd1', claimToken: 'w-a', leaseSeconds: 60, now: NOW }),
      repo.claimForSending({ deliveryId: 'd1', claimToken: 'w-b', leaseSeconds: 60, now: NOW }),
    ]);
    const winners = [a, b].filter((r) => r.isOk() && r.value !== null);
    expect(winners).toHaveLength(1);
  });

  it('stream successor is not claimable while predecessor is non-terminal', async () => {
    /* seed seq 1 (ready) and seq 2 (ready) in one stream; claim of seq 2 returns null */
  });

  it('shadow-mode rows are never claimable', async () => {
    /* seed sender_mode=shadow ready row; claim returns null */
  });

  it('rejects backward state transitions', async () => {
    /* transition accepted → ready returns ok(false) / err; state unchanged */
  });
};

// tests/unit/notification-platform/delivery-repo.contract.test.ts
describePortContract('DeliveryRepo', deliveryRepoCases, {
  fake: () => {
    const fake = makeFakeDeliveryRepo();
    return { port: fake, reset: () => fake.store.clear() };
  },
});

// tests/e2e/notification-platform/delivery-repo.contract.test.ts
describePortContract('DeliveryRepo', deliveryRepoCases, {
  real: {
    make: async () => {
      const clients = await setupTestDatabase(); // existing Testcontainers singleton
      return {
        port: makeDeliveryRepo(clients.userDb),
        reset: () => truncatePlatformTables(clients.userDb),
      };
    },
  },
});
```

The concurrent-claim case is the payoff: on real Postgres it genuinely races two transactions (validating the conditional-UPDATE claim SQL), while the fake must exhibit the same observable semantics — keeping the fake honest.

## 6. Naming, adoption, sequencing

- **Naming:** kebab-case files; `makeX` factories; fakes `makeFake<PortName>`; contract cases `*.contract.ts` under `tests/contracts/`; runners `*.contract.test.ts` in their tier directory.
- **Implementation order:** (1) `src/common/ports/` + `src/infra/clock|ids` (unblocks the platform module's dep types); (2) `result.ts`, `clock.ts`, `ids.ts` (zero-dependency, highest leverage); (3) `store.ts` + `faults.ts`; (4) `jobs.ts`; (5) `contract.ts`; (6) notification-platform fakes/builders.
- **Gradual adoption:** legacy `tests/fixtures/fakes.ts`, `builders.ts`, and the fake-timer files are not modified. New tests import `@/tests/support`. The first mechanical legacy win, when someone wants it, is `expectOk` across the 178 inline-assert files — a pure improvement with no behavior change.
- **Production wiring:** composition passes `systemClock`/`uuidIds` through the platform runtime factory / `AppDeps` seam in `src/app/build-plan.ts`, same as existing runtime factories.

## 7. Explicitly not included, and risks

**Not included:** no refactor or deletion of the legacy `fakes.ts`/`builders.ts`; no Redis Testcontainer and no BullMQ `Queue`/`Worker` class fake (thin shell adapters stay covered via the runtime-factory seam and e2e); no codemod of existing assertion styles; no vitest config changes (aliases already exist); no generic transaction/unit-of-work simulation in `makeKeyedStore`.

**Risks:**

1. `structuredClone` default rejects class instances/functions — fakes holding rich objects must pass a custom `clone` (documented on `KeyedStoreOptions`).
2. The in-memory job runtime's retry/backoff is an approximation of BullMQ; drift is bounded by keeping shell adapters thin and asserting `attempts`/`backoff` options in integration tests via the runtime-factory seam.
3. Contract `real` backends share the singleton Postgres container — `reset` must truncate precisely or e2e suites become order-coupled; the harness makes `reset` first-class to mitigate this.
4. A fake can pass concurrency cases for the wrong reason (single-threaded JS). The real-backend run is the authority for locking semantics — **never ship claim-SQL changes on fake-green alone.**
