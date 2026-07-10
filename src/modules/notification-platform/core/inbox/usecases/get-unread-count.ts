import { type Result } from 'neverthrow';

import type { Clock, IdGenerator, LoggerPort } from '../../shared/ports.js';
import type { InboxError } from '../errors.js';
import type { LogicalNotificationRepo } from '../ports.js';

export interface GetUnreadCountDeps {
  logicalNotifications: LogicalNotificationRepo;
  clock: Clock;
  ids: IdGenerator;
  logger: LoggerPort;
}

export interface GetUnreadCountInput {
  userId: string;
}

export interface GetUnreadCountResult {
  count: number;
}

export type GetUnreadCountError = InboxError;

export const getUnreadCount = async (
  deps: GetUnreadCountDeps,
  input: GetUnreadCountInput
): Promise<Result<GetUnreadCountResult, GetUnreadCountError>> => {
  const count = await deps.logicalNotifications.countUnread(input.userId);
  return count.map((value) => ({ count: value }));
};
