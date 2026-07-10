import { inspect } from 'node:util';

import { type Result, type ResultAsync } from 'neverthrow';

const failureMessage = (
  context: string | undefined,
  expectation: string,
  unexpected: unknown
): string => {
  const prefix = context === undefined ? '' : `${context}: `;
  return `${prefix}${expectation}; received ${inspect(unexpected, { depth: null })}`;
};

/** Return the Ok value, or throw with the inspected Err value. */
export function expectOk<T, E>(result: Result<T, E>, context?: string): T {
  if (result.isOk()) {
    return result.value;
  }

  const error = new Error(failureMessage(context, 'expected Ok', result.error));
  Error.captureStackTrace(error, expectOk);
  throw error;
}

/** Return the Err value, or throw with the inspected Ok value. */
export function expectErr<T, E>(result: Result<T, E>, context?: string): E {
  if (result.isErr()) {
    return result.error;
  }

  const error = new Error(failureMessage(context, 'expected Err', result.value));
  Error.captureStackTrace(error, expectErr);
  throw error;
}

/** Await a ResultAsync or Promise<Result>, then return its Ok value. */
export async function expectOkAsync<T, E>(
  result: ResultAsync<T, E> | Promise<Result<T, E>>,
  context?: string
): Promise<T> {
  const resolved = await result;
  if (resolved.isOk()) {
    return resolved.value;
  }

  const error = new Error(failureMessage(context, 'expected Ok', resolved.error));
  Error.captureStackTrace(error, expectOkAsync);
  throw error;
}

/** Await a ResultAsync or Promise<Result>, then return its Err value. */
export async function expectErrAsync<T, E>(
  result: ResultAsync<T, E> | Promise<Result<T, E>>,
  context?: string
): Promise<E> {
  const resolved = await result;
  if (resolved.isErr()) {
    return resolved.error;
  }

  const error = new Error(failureMessage(context, 'expected Err', resolved.value));
  Error.captureStackTrace(error, expectErrAsync);
  throw error;
}
