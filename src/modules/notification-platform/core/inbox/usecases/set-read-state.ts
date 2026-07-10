import { type Result } from 'neverthrow';

import type { Clock, IdGenerator, LoggerPort } from '../../shared/ports.js';
import type { InboxError } from '../errors.js';
import type { LogicalNotificationRepo } from '../ports.js';

export interface SetReadStateDeps {
  logicalNotifications: LogicalNotificationRepo;
  clock: Clock;
  ids: IdGenerator;
  logger: LoggerPort;
}

export interface SetReadStateInput {
  userId: string;
  notificationId: string;
  read: boolean;
}

export interface SetReadStateResult {
  updated: boolean;
}

export type SetReadStateError = InboxError;

export const setReadState = async (
  deps: SetReadStateDeps,
  input: SetReadStateInput
): Promise<Result<SetReadStateResult, SetReadStateError>> => {
  const updated = await deps.logicalNotifications.setReadState({
    id: input.notificationId,
    userId: input.userId,
    readAt: input.read ? deps.clock.now() : null,
  });
  return updated.map((value) => ({ updated: value }));
};
