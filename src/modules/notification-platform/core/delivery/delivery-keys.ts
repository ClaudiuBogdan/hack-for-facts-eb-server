import type { ExternalChannel } from '../shared/types.js';

export const buildImmediateDeliveryKey = (
  logicalNotificationId: string,
  channel: ExternalChannel,
  destinationGeneration: number
): string => {
  return `logical:${logicalNotificationId}:${channel}:${String(destinationGeneration)}`;
};

export const buildDigestDeliveryKey = (batchId: string): string => {
  return `digest:${batchId}`;
};
