import type { ExternalChannel, SenderMode } from '../shared/types.js';

export type DeliveryState =
  | 'pending_render'
  | 'scheduled'
  | 'ready'
  | 'sending'
  | 'retry_wait'
  | 'accepted'
  | 'delivered'
  | 'bounced'
  | 'complained'
  | 'suppressed'
  | 'cancelled'
  | 'expired'
  | 'permanent_failed'
  | 'dead_letter'
  | 'unknown';

export const DELIVERY_STATES: readonly DeliveryState[] = [
  'pending_render',
  'scheduled',
  'ready',
  'sending',
  'retry_wait',
  'accepted',
  'delivered',
  'bounced',
  'complained',
  'suppressed',
  'cancelled',
  'expired',
  'permanent_failed',
  'dead_letter',
  'unknown',
];

export const TERMINAL_DELIVERY_STATES: readonly DeliveryState[] = [
  'delivered',
  'bounced',
  'complained',
  'suppressed',
  'cancelled',
  'expired',
  'permanent_failed',
  'dead_letter',
  'unknown',
];

export interface Delivery {
  id: string;
  deliveryKey: string;
  logicalNotificationId: string | null;
  digestBatchId: string | null;
  kindId: string;
  userId: string;
  channel: ExternalChannel;
  destinationFingerprint: string | null;
  destinationGeneration: number | null;
  templateId: string | null;
  templateVersion: string | null;
  renderedSubject: string | null;
  renderedHtml: string | null;
  renderedText: string | null;
  contentHash: string | null;
  status: DeliveryState;
  notBefore: Date | null;
  expiresAt: Date | null;
  streamKey: string | null;
  streamSequence: number | null;
  attemptCount: number;
  nextAttemptAt: Date | null;
  claimToken: string | null;
  claimExpiresAt: Date | null;
  providerIdempotencyKey: string | null;
  providerRef: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  senderMode: Exclude<SenderMode, 'legacy'>;
  createdAt: Date;
  updatedAt: Date;
  acceptedAt: Date | null;
  terminalAt: Date | null;
  retentionExpiresAt: Date;
}

export interface CreateDeliveryInput {
  id: string;
  deliveryKey: string;
  logicalNotificationId: string | null;
  digestBatchId: string | null;
  kindId: string;
  userId: string;
  channel: ExternalChannel;
  destinationFingerprint: string | null;
  destinationGeneration: number | null;
  templateId: string | null;
  templateVersion: string | null;
  status: 'pending_render';
  notBefore: Date | null;
  expiresAt: Date | null;
  streamKey: string | null;
  streamSequence: number | null;
  senderMode: 'shadow' | 'active';
  now: Date;
  retentionExpiresAt: Date;
}

export interface DeliveryPatch {
  notBefore?: Date | null;
  nextAttemptAt?: Date | null;
  destinationFingerprint?: string | null;
  destinationGeneration?: number | null;
  providerIdempotencyKey?: string | null;
  providerRef?: string | null;
  lastErrorCode?: string | null;
  lastErrorMessage?: string | null;
  acceptedAt?: Date | null;
  terminalAt?: Date | null;
  attemptCount?: number;
  claimToken?: string | null;
  claimExpiresAt?: Date | null;
}

export type AttemptResult = 'accepted' | 'transient_failure' | 'permanent_failure' | 'ambiguous';

export interface DeliveryAttempt {
  id: string;
  deliveryId: string;
  attemptNumber: number;
  startedAt: Date;
  completedAt: Date | null;
  providerIdempotencyKey: string;
  requestCorrelationId: string | null;
  destinationFingerprint: string | null;
  result: AttemptResult | null;
  errorCode: string | null;
  errorMessage: string | null;
  providerRef: string | null;
  latencyMs: number | null;
  retryAfterMs: number | null;
}

export interface ChannelDestination {
  id: string;
  userId: string;
  channel: ExternalChannel;
  fingerprint: string;
  generation: number;
  isCurrent: boolean;
  suppressedAt: Date | null;
  suppressionReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ResolvedDestination {
  address: string;
}
