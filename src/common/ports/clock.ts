/**
 * Time source port. Core use-cases receive a Clock instead of calling
 * `new Date()` / `Date.now()` so time-dependent logic (digest windows,
 * retry backoff, expiry, watermark scans) is deterministically testable.
 *
 * Production adapter: `systemClock` in `src/infra/clock` (core cannot
 * import it — the infra boundary keeps core pure).
 */
export interface Clock {
  now(): Date;
}
