/**
 * Result pattern utilities
 * Re-exports neverthrow for explicit error handling
 */

export {
  ok,
  err,
  Ok,
  Err,
  Result,
  ResultAsync,
  okAsync,
  errAsync,
  fromPromise,
  fromThrowable,
} from 'neverthrow';
