import { type Result } from 'neverthrow';

import type { Clock, IdGenerator, LoggerPort } from '../../shared/ports.js';
import type { InboxError } from '../errors.js';
import type { LogicalNotificationRepo } from '../ports.js';

export interface SetArchivedStateDeps {
  logicalNotifications: LogicalNotificationRepo;
  clock: Clock;
  ids: IdGenerator;
  logger: LoggerPort;
}

export interface SetArchivedStateInput {
  userId: string;
  notificationId: string;
  archived: boolean;
}

export interface SetArchivedStateResult {
  updated: boolean;
}

export type SetArchivedStateError = InboxError;

export const setArchivedState = async (
  deps: SetArchivedStateDeps,
  input: SetArchivedStateInput
): Promise<Result<SetArchivedStateResult, SetArchivedStateError>> => {
  const updated = await deps.logicalNotifications.setArchivedState({
    id: input.notificationId,
    userId: input.userId,
    archivedAt: input.archived ? deps.clock.now() : null,
  });
  return updated.map((value) => ({ updated: value }));
};
