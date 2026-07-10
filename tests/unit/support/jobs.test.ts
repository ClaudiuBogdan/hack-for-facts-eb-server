import { err, ok } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import { expectErr, expectOk, makeInMemoryJobRuntime, makeTestClock } from '../../support/index.js';

interface Payload {
  label: string;
}

describe('makeInMemoryJobRuntime', () => {
  it('runs by runAt then enqueue order and advances the shared clock for delays', async () => {
    const clock = makeTestClock();
    const runtime = makeInMemoryJobRuntime({ clock });
    const enqueue = runtime.enqueuer<Payload>('work');
    const seen: string[] = [];
    runtime.register<Payload>('work', async (job) => {
      seen.push(`${job.payload.label}@${clock.now().toISOString()}`);
    });

    expectOk(await enqueue({ label: 'delayed' }, { delayMs: 1_000 }));
    expectOk(await enqueue({ label: 'first' }));
    expectOk(await enqueue({ label: 'second' }));
    const outcomes = await runtime.runAll();

    expect(seen).toEqual([
      'first@2024-01-01T00:00:00.000Z',
      'second@2024-01-01T00:00:00.000Z',
      'delayed@2024-01-01T00:00:01.000Z',
    ]);
    expect(outcomes.map((outcome) => outcome.outcome)).toEqual([
      'completed',
      'completed',
      'completed',
    ]);
    expect(runtime.pending()).toEqual([]);
    expect(runtime.jobs('completed')).toHaveLength(3);
  });

  it('retries handler Err results with fixed backoff before completing', async () => {
    const clock = makeTestClock();
    const runtime = makeInMemoryJobRuntime({ clock });
    const enqueue = runtime.enqueuer<Payload>('fixed');
    let calls = 0;
    runtime.register<Payload>('fixed', async () => {
      calls += 1;
      return calls < 3 ? err(`failure-${String(calls)}`) : ok(undefined);
    });
    expectOk(
      await enqueue({ label: 'retry' }, { attempts: 3, backoff: { type: 'fixed', delayMs: 500 } })
    );

    const outcomes = await runtime.runAll();

    expect(outcomes.map((outcome) => outcome.outcome)).toEqual(['retried', 'retried', 'completed']);
    expect(outcomes.map((outcome) => outcome.job.attemptsMade)).toEqual([1, 2, 3]);
    expect(clock.now()).toEqual(new Date('2024-01-01T00:00:01.000Z'));
  });

  it('uses exponential backoff based on the completed attempt number', async () => {
    const clock = makeTestClock();
    const runtime = makeInMemoryJobRuntime({ clock });
    const enqueue = runtime.enqueuer<Payload>('exponential');
    runtime.register<Payload>('exponential', async () => err('still unavailable'));
    expectOk(
      await enqueue(
        { label: 'retry' },
        { attempts: 3, backoff: { type: 'exponential', delayMs: 100 } }
      )
    );

    const outcomes = await runtime.runAll();

    expect(outcomes.map((outcome) => outcome.job.runAt.toISOString())).toEqual([
      '2024-01-01T00:00:00.100Z',
      '2024-01-01T00:00:00.300Z',
      '2024-01-01T00:00:00.300Z',
    ]);
    expect(outcomes.at(-1)?.outcome).toBe('failed');
  });

  it('counts thrown handler errors as failures and exhausts attempts', async () => {
    const runtime = makeInMemoryJobRuntime({ clock: makeTestClock() });
    const enqueue = runtime.enqueuer<Payload>('throws');
    runtime.register<Payload>('throws', async () => {
      throw new Error('handler exploded');
    });
    expectOk(await enqueue({ label: 'throw' }, { attempts: 2 }));

    const outcomes = await runtime.runAll();

    expect(outcomes.map((outcome) => outcome.outcome)).toEqual(['retried', 'failed']);
    expect(outcomes[1]?.job.lastError).toBeInstanceOf(Error);
    expect(runtime.jobs('failed')).toHaveLength(1);
  });

  it('deduplicates pending jobs and allows the same key after completion', async () => {
    const runtime = makeInMemoryJobRuntime({ clock: makeTestClock() });
    const enqueue = runtime.enqueuer<Payload>('dedupe');
    runtime.register<Payload>('dedupe', async () => undefined);

    const first = expectOk(await enqueue({ label: 'first' }, { dedupeId: 'same' }));
    const duplicate = expectOk(await enqueue({ label: 'ignored' }, { dedupeId: 'same' }));
    expect(duplicate.id).toBe(first.id);
    expect(duplicate.payload).toEqual({ label: 'first' });
    expect(runtime.pending()).toHaveLength(1);

    await runtime.runNext();
    const afterCompletion = expectOk(await enqueue({ label: 'second' }, { dedupeId: 'same' }));
    expect(afterCompletion.id).toBe('job-2');
    expect(runtime.jobs()).toHaveLength(2);
  });

  it('exposes enqueue-side faults without consuming a job id', async () => {
    const runtime = makeInMemoryJobRuntime({ clock: makeTestClock() });
    const enqueue = runtime.enqueuer<Payload>('faulted');
    const queueError = { message: 'queue offline', retryable: true };
    runtime.faults.fail('enqueue', { error: queueError });

    expect(expectErr(await enqueue({ label: 'first' }))).toEqual(queueError);
    expect(expectOk(await enqueue({ label: 'second' })).id).toBe('job-1');
    expect(runtime.faults.callCount('enqueue')).toBe(2);
  });

  it('fails loudly at maxSteps when draining leaves more pending work', async () => {
    const runtime = makeInMemoryJobRuntime({ clock: makeTestClock() });
    const enqueue = runtime.enqueuer<number>('loop');
    runtime.register<number>('loop', async (job) => {
      expectOk(await enqueue(job.payload + 1));
    });
    expectOk(await enqueue(0));

    await expect(runtime.runAll({ maxSteps: 3 })).rejects.toThrow(
      'In-memory job runtime reached maxSteps (3)'
    );
    expect(runtime.jobs('completed')).toHaveLength(3);
    expect(runtime.pending()).toHaveLength(1);
  });

  it('drains exactly maxSteps jobs without throwing when no work remains', async () => {
    const runtime = makeInMemoryJobRuntime({ clock: makeTestClock() });
    const enqueue = runtime.enqueuer<number>('finite');
    runtime.register<number>('finite', async () => undefined);
    expectOk(await enqueue(1));
    expectOk(await enqueue(2));

    const outcomes = await runtime.runAll({ maxSteps: 2 });

    expect(outcomes).toHaveLength(2);
    expect(runtime.pending()).toEqual([]);
  });
});
