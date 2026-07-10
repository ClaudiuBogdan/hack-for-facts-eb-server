import type { ExternalChannel } from '../shared/types.js';

export type DigestBatchStatus = 'open' | 'materializing' | 'rendered' | 'cancelled';

export interface DigestWindow {
  windowStartUtc: Date;
  windowEndUtc: Date;
  dispatchAtUtc: Date;
}

export interface DigestBatch {
  id: string;
  userId: string;
  channel: ExternalChannel;
  cadence: 'daily' | 'weekly';
  windowStartUtc: Date;
  windowEndUtc: Date;
  dispatchAtUtc: Date;
  status: DigestBatchStatus;
  renderedItemIds: string[] | null;
  overflowCount: number | null;
  deliveryId: string | null;
  claimToken: string | null;
  claimExpiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
