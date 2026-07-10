import type { DigestError } from './errors.js';
import type { DigestBatch, DigestWindow } from './types.js';
import type { LogicalNotification } from '../inbox/types.js';
import type { ExternalChannel } from '../shared/types.js';
import type { Result } from 'neverthrow';

export interface DigestBatchRepo {
  findById(id: string): Promise<Result<DigestBatch | null, DigestError>>;
  findOrCreateOpen(input: {
    id: string;
    userId: string;
    channel: ExternalChannel;
    cadence: 'daily' | 'weekly';
    window: DigestWindow;
    now: Date;
  }): Promise<Result<DigestBatch, DigestError>>;
  addMemberIdempotent(input: {
    batchId: string;
    logicalNotificationId: string;
    now: Date;
  }): Promise<Result<'added' | 'duplicate' | 'batch_closed', DigestError>>;
  claimDue(input: {
    now: Date;
    limit: number;
    claimToken: string;
    leaseSeconds: number;
  }): Promise<Result<DigestBatch[], DigestError>>;
  listMembersNewestFirst(input: {
    batchId: string;
    limit: number;
  }): Promise<Result<{ items: LogicalNotification[]; totalCount: number }, DigestError>>;
  markRendered(input: {
    batchId: string;
    expectedClaimToken: string;
    renderedItemIds: string[];
    overflowCount: number;
    deliveryId: string;
    now: Date;
  }): Promise<Result<boolean, DigestError>>;
  cancelWholeBatch(input: {
    batchId: string;
    reason: string;
    now: Date;
  }): Promise<Result<boolean, DigestError>>;
}
