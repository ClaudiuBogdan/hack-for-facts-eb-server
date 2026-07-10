import type { InboxError } from './errors.js';
import type { CreateLogicalNotificationInput, InboxView, LogicalNotification } from './types.js';
import type { Page } from '../shared/types.js';
import type { Result } from 'neverthrow';

export interface LogicalNotificationRepo {
  insertBatchIdempotent(
    rows: CreateLogicalNotificationInput[]
  ): Promise<Result<{ createdIds: string[]; duplicateCount: number }, InboxError>>;
  findByIdForUser(
    id: string,
    userId: string
  ): Promise<Result<LogicalNotification | null, InboxError>>;
  listForUser(input: {
    userId: string;
    view: InboxView;
    cursor: string | null;
    limit: number;
  }): Promise<Result<Page<LogicalNotification>, InboxError>>;
  countUnread(userId: string): Promise<Result<number, InboxError>>;
  setReadState(input: {
    id: string;
    userId: string;
    readAt: Date | null;
  }): Promise<Result<boolean, InboxError>>;
  markAllRead(input: { userId: string; now: Date }): Promise<Result<number, InboxError>>;
  setArchivedState(input: {
    id: string;
    userId: string;
    archivedAt: Date | null;
  }): Promise<Result<boolean, InboxError>>;
  listByEvent(eventId: string): Promise<Result<LogicalNotification[], InboxError>>;
}
