import type { Clock, IdGenerator, LoggerPort } from '../../shared/ports.js';
import type { Page } from '../../shared/types.js';
import type { InboxError } from '../errors.js';
import type { LogicalNotificationRepo } from '../ports.js';
import type { InboxView, LogicalNotification } from '../types.js';
import type { Result } from 'neverthrow';

export interface ListInboxDeps {
  logicalNotifications: LogicalNotificationRepo;
  clock: Clock;
  ids: IdGenerator;
  logger: LoggerPort;
}

export interface ListInboxInput {
  userId: string;
  view?: InboxView;
  cursor?: string;
  limit?: number;
}

export type ListInboxResult = Page<LogicalNotification>;
export type ListInboxError = InboxError;

export const listInbox = async (
  deps: ListInboxDeps,
  input: ListInboxInput
): Promise<Result<ListInboxResult, ListInboxError>> => {
  return deps.logicalNotifications.listForUser({
    userId: input.userId,
    view: input.view ?? 'all',
    cursor: input.cursor ?? null,
    limit: input.limit ?? 50,
  });
};
