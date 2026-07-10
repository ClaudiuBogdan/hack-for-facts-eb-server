const MAX_ATTEMPTS = 5;
const BASE_DELAY_MS = 30_000;
const BACKOFF_FACTOR = 4;
const MAX_DELAY_MS = 4 * 60 * 60 * 1000;
/** Architecture §13.1: the retry window is bounded to 24h from the first attempt. */
const RETRY_WINDOW_MS = 24 * 60 * 60 * 1000;
const MIN_JITTER_BASIS_POINTS = 8_000;
const JITTER_SPAN_BASIS_POINTS = 4_001;
const BASIS_POINTS = 10_000;

const deterministicJitterBasisPoints = (seed: number): number => {
  const normalizedSeed = Math.trunc(seed);
  const mixed = (Math.imul(normalizedSeed, 1_664_525) + 1_013_904_223) >>> 0;
  return MIN_JITTER_BASIS_POINTS + (mixed % JITTER_SPAN_BASIS_POINTS);
};

export const computeNextAttemptAt = (input: {
  attemptNumber: number;
  now: Date;
  firstAttemptAt: Date;
  retryAfterMs?: number;
  expiresAt?: Date | null;
  jitterSeed: number;
}): { nextAttemptAt: Date } | { exhausted: true } => {
  if (input.attemptNumber >= MAX_ATTEMPTS) {
    return { exhausted: true };
  }

  const exponent = Math.max(0, input.attemptNumber - 1);
  const backoffMs = Math.min(BASE_DELAY_MS * BACKOFF_FACTOR ** exponent, MAX_DELAY_MS);
  const jitteredBackoffMs = Math.min(
    Math.trunc((backoffMs * deterministicJitterBasisPoints(input.jitterSeed)) / BASIS_POINTS),
    MAX_DELAY_MS
  );
  const delayMs =
    input.retryAfterMs === undefined
      ? jitteredBackoffMs
      : Math.max(jitteredBackoffMs, input.retryAfterMs);
  const nextAttemptAt = new Date(input.now.getTime() + delayMs);

  const retryWindowEndsAt = input.firstAttemptAt.getTime() + RETRY_WINDOW_MS;
  if (nextAttemptAt.getTime() > retryWindowEndsAt) {
    return { exhausted: true };
  }

  if (input.expiresAt !== undefined && input.expiresAt !== null) {
    if (nextAttemptAt.getTime() > input.expiresAt.getTime()) {
      return { exhausted: true };
    }
  }

  return { nextAttemptAt };
};
