import { type Result } from 'neverthrow';

import { type UserDataError } from '../errors.js';
import { type UserDataMutationPort } from '../ports.js';
import { type LoggerPort } from './shared.js';

export interface CleanupReceiptsDeps {
  mutationPort: UserDataMutationPort;
  logger: LoggerPort;
}

export const cleanupReceipts = (
  deps: CleanupReceiptsDeps,
  input: { now: Date }
): Promise<Result<number, UserDataError>> => deps.mutationPort.deleteExpiredReceipts(input.now);
