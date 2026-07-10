import { err, ok, type Result } from 'neverthrow';

import { type IdGenerator } from '@/common/ports/id-generator.js';

import { type TestClock } from './clock.js';
import { makeFaultPlan, type FaultPlan } from './faults.js';
import { makeSequentialIds } from './ids.js';

export interface JobOptions {
  delayMs?: number;
  attempts?: number;
  backoff?: { type: 'fixed' | 'exponential'; delayMs: number };
  dedupeId?: string;
}

export type JobState = 'waiting' | 'delayed' | 'active' | 'completed' | 'failed';

export interface PendingJob<P = unknown> {
  id: string;
  name: string;
  payload: P;
  opts: Readonly<JobOptions>;
  enqueuedAt: Date;
  runAt: Date;
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
  enqueuer<P>(
    name: string
  ): (payload: P, opts?: JobOptions) => Promise<Result<PendingJob<P>, JobRuntimeError>>;
  register<P>(name: string, handler: JobHandler<P>): void;
  runNext(): Promise<RunOutcome | undefined>;
  runAll(opts?: { maxSteps?: number }): Promise<RunOutcome[]>;
  pending(): readonly PendingJob[];
  jobs(state?: JobState): readonly PendingJob[];
  faults: FaultPlan<'enqueue', JobRuntimeError>;
}

interface StoredJob extends PendingJob {
  readonly enqueueOrder: number;
}

const copyOptions = (options: JobOptions): JobOptions => {
  const copy: JobOptions = {};
  if (options.delayMs !== undefined) {
    copy.delayMs = options.delayMs;
  }
  if (options.attempts !== undefined) {
    copy.attempts = options.attempts;
  }
  if (options.backoff !== undefined) {
    copy.backoff = { ...options.backoff };
  }
  if (options.dedupeId !== undefined) {
    copy.dedupeId = options.dedupeId;
  }
  return copy;
};

const copyJob = (job: StoredJob): PendingJob => {
  const copy: PendingJob = {
    id: job.id,
    name: job.name,
    payload: job.payload,
    opts: copyOptions(job.opts),
    enqueuedAt: new Date(job.enqueuedAt.getTime()),
    runAt: new Date(job.runAt.getTime()),
    attemptsMade: job.attemptsMade,
    state: job.state,
  };
  if (Object.hasOwn(job, 'lastError')) {
    copy.lastError = job.lastError;
  }
  return copy;
};

const isPending = (job: StoredJob): boolean => job.state === 'waiting' || job.state === 'delayed';

const comparePending = (left: StoredJob, right: StoredJob): number => {
  const timeDifference = left.runAt.getTime() - right.runAt.getTime();
  return timeDifference === 0 ? left.enqueueOrder - right.enqueueOrder : timeDifference;
};

const retryDelay = (job: StoredJob): number => {
  const backoff = job.opts.backoff;
  if (backoff === undefined) {
    return 0;
  }
  if (backoff.type === 'fixed') {
    return backoff.delayMs;
  }
  return backoff.delayMs * 2 ** Math.max(0, job.attemptsMade - 1);
};

export function makeInMemoryJobRuntime(deps: {
  clock: TestClock;
  ids?: IdGenerator;
}): InMemoryJobRuntime {
  const ids = deps.ids ?? makeSequentialIds('job');
  const faults = makeFaultPlan<'enqueue', JobRuntimeError>();
  const handlers = new Map<string, unknown>();
  const storedJobs: StoredJob[] = [];
  let enqueueOrder = 0;

  const orderedPending = (): StoredJob[] => storedJobs.filter(isPending).sort(comparePending);

  const enqueuer = <P>(
    name: string
  ): ((payload: P, opts?: JobOptions) => Promise<Result<PendingJob<P>, JobRuntimeError>>) => {
    return (payload: P, opts: JobOptions = {}): Promise<Result<PendingJob<P>, JobRuntimeError>> => {
      const fault = faults.intercept('enqueue');
      if (fault !== undefined) {
        return Promise.resolve(err<PendingJob<P>, JobRuntimeError>(fault));
      }

      const options = copyOptions(opts);
      if (options.dedupeId !== undefined) {
        const duplicate = orderedPending().find(
          (job) => job.name === name && job.opts.dedupeId === options.dedupeId
        );
        if (duplicate !== undefined) {
          return Promise.resolve(
            ok<PendingJob<P>, JobRuntimeError>(copyJob(duplicate) as PendingJob<P>)
          );
        }
      }

      const enqueuedAt = deps.clock.now();
      const delayMs = options.delayMs ?? 0;
      const runAt = new Date(enqueuedAt.getTime() + delayMs);
      enqueueOrder += 1;
      const job: StoredJob = {
        id: ids.newId(),
        name,
        payload,
        opts: options,
        enqueuedAt,
        runAt,
        attemptsMade: 0,
        state: runAt.getTime() > enqueuedAt.getTime() ? 'delayed' : 'waiting',
        enqueueOrder,
      };
      storedJobs.push(job);
      return Promise.resolve(ok<PendingJob<P>, JobRuntimeError>(copyJob(job) as PendingJob<P>));
    };
  };

  const register = <P>(name: string, handler: JobHandler<P>): void => {
    handlers.set(name, handler);
  };

  const runNext = async (): Promise<RunOutcome | undefined> => {
    const job = orderedPending()[0];
    if (job === undefined) {
      return undefined;
    }

    const now = deps.clock.now();
    if (job.runAt.getTime() > now.getTime()) {
      deps.clock.set(job.runAt);
    }
    job.state = 'active';
    job.attemptsMade += 1;

    let failed = false;
    let failure: unknown;
    const registered = handlers.get(job.name);
    if (registered === undefined) {
      failed = true;
      failure = new Error(`No handler registered for job: ${job.name}`);
    } else {
      try {
        const handler = registered as JobHandler<unknown>;
        const result = await handler(copyJob(job));
        if (result?.isErr() === true) {
          failed = true;
          failure = result.error;
        }
      } catch (error: unknown) {
        failed = true;
        failure = error;
      }
    }

    if (!failed) {
      job.state = 'completed';
      return { job: copyJob(job), outcome: 'completed' };
    }

    job.lastError = failure;
    const attempts = job.opts.attempts ?? 1;
    if (job.attemptsMade < attempts) {
      const delayMs = retryDelay(job);
      const retriedAt = deps.clock.now();
      job.runAt = new Date(retriedAt.getTime() + delayMs);
      job.state = job.runAt.getTime() > retriedAt.getTime() ? 'delayed' : 'waiting';
      return { job: copyJob(job), outcome: 'retried', error: failure };
    }

    job.state = 'failed';
    return { job: copyJob(job), outcome: 'failed', error: failure };
  };

  const runAll = async (options: { maxSteps?: number } = {}): Promise<RunOutcome[]> => {
    const maxSteps = options.maxSteps ?? 100;
    const outcomes: RunOutcome[] = [];

    while (orderedPending().length > 0) {
      if (outcomes.length >= maxSteps) {
        throw new Error(`In-memory job runtime reached maxSteps (${String(maxSteps)})`);
      }
      const outcome = await runNext();
      if (outcome === undefined) {
        return outcomes;
      }
      outcomes.push(outcome);
    }
    return outcomes;
  };

  return {
    enqueuer,
    register,
    runNext,
    runAll,
    pending: (): readonly PendingJob[] => orderedPending().map((job) => copyJob(job)),
    jobs: (state?: JobState): readonly PendingJob[] =>
      storedJobs
        .filter((job) => state === undefined || job.state === state)
        .map((job) => copyJob(job)),
    faults,
  };
}
