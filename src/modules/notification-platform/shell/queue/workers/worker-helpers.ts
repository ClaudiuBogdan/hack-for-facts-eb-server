import { UnrecoverableError } from 'bullmq';

import { isRetryableError } from '../../../core/shared/errors.js';

import type { LoggerPort } from '../../../core/shared/ports.js';
import type { Result } from 'neverthrow';

interface WorkerError {
  type: string;
  message?: string;
  retryable?: boolean;
}

const errorMessage = (error: WorkerError): string => error.message ?? error.type;

export const unwrapWorkerResult = <T>(
  result: Result<T, WorkerError>,
  logger: LoggerPort,
  message: string,
  data: Record<string, unknown>
): T => {
  if (result.isOk()) {
    return result.value;
  }

  logger.error(message, { ...data, error: result.error });
  const messageText = errorMessage(result.error);
  if (isRetryableError(result.error)) {
    throw new Error(messageText);
  }
  throw new UnrecoverableError(messageText);
};
