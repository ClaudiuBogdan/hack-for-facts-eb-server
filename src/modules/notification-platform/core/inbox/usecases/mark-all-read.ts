import { type Result } from 'neverthrow';

import type { Clock, IdGenerator, LoggerPort } from '../../shared/ports.js';
import type { InboxError } from '../errors.js';
import type { LogicalNotificationRepo } from '../ports.js';

export interface MarkAllReadDeps {
  logicalNotifications: LogicalNotificationRepo;
  clock: Clock;
  ids: IdGenerator;
  logger: LoggerPort;
}

export interface MarkAllReadInput {
  userId: string;
}

export interface MarkAllReadResult {
  updated: number;
}

export type MarkAllReadError = InboxError;

export const markAllRead = async (
  deps: MarkAllReadDeps,
  input: MarkAllReadInput
): Promise<Result<MarkAllReadResult, MarkAllReadError>> => {
  const updated = await deps.logicalNotifications.markAllRead({
    userId: input.userId,
    now: deps.clock.now(),
  });
  return updated.map((value) => ({ updated: value }));
};
